/**
 * AgentGuard PTY Interceptor  (Phase 1 — real PTY mode + shell wrapper)
 *
 * Spawns the agent inside a proper pseudo-terminal using node-pty so the
 * agent sees a real TTY (readline editing, colour output, curses, etc. all
 * work).  PTY output is forwarded to the user's terminal; detected shell
 * commands are classified and flagged for approval.
 *
 * Layered command detection:
 *   1. PTY-output decoder (Layer 1) — parses agent stdout/stderr for shell
 *      prompt prefixes ($ / % / > / #) or "Running:" annotations.  Brittle
 *      against agents that render tool calls in custom UI (Claude Code,
 *      Codex CLI).
 *   2. Shell wrapper + adjudication daemon (Layer 1.5) — agent's $SHELL is
 *      replaced with `agentguard-shell`, which forwards every `sh -c <cmd>`
 *      call to a Unix-socket daemon (src/shell-daemon.js) for classify +
 *      handleIncident before exec.  Catches commands regardless of how the
 *      agent prints them.
 *   3. File watcher (Layer 2) — chokidar-based watch over the working dir,
 *      catches the *effects* of any commands the first two layers miss.
 *
 * Concurrency:
 *   The shell daemon owns the single adjudication mutex.  Both Layer 1
 *   (PTY scanner) and Layer 1.5 (shell wrapper) route through
 *   `daemon.adjudicate(incident, runtime)` so two prompts can never race
 *   for the TTY.
 *
 * Graceful fallback:
 *   PTY_AVAILABLE is exported so callers can detect whether node-pty loaded
 *   and fall back to the log-based interceptor when it hasn't.  If the
 *   shell wrapper binary is missing, we log a warning and continue without
 *   Layer 1.5 — the rest of the session still works.
 */

import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import { classify, requiresApproval, scoreWithContext } from "./classifier.js";
import {
  logSessionEnd,
  logSnapshotRestore,
  sessionId,
} from "./logger.js";
import { restoreSnapshot } from "./snapshot.js";
import { isNotifierConfigured, sendTelegramAlert } from "./notifier.js";
import chalk from "chalk";
import { execSync } from "child_process";
import { decodeCommand } from "./decoder.js";
import { bus } from "./event-bus.js";
import { evaluate } from "./correlator.js";
import { filterFired, suppression } from "./suppression.js";
import { startShellDaemon } from "./shell-daemon.js";

/** Resolve a binary name to its full path using `which`. */
function resolveBin(name) {
  // If it's already a path, use as-is
  if (name.startsWith("/") || name.startsWith("./") || name.startsWith("../")) {
    return name;
  }
  try {
    return execSync(`which ${name}`, { encoding: "utf8" }).trim();
  } catch {
    return name; // fallback — let node-pty give the real error
  }
}

/**
 * Locate the agentguard-shell wrapper.
 *
 * Resolution order:
 *   1. `<repo>/shell-wrapper/agentguard-shell` (Go binary, preferred).
 *   2. `<repo>/shell-wrapper/agentguard-shell.sh` (POSIX fallback).
 *   3. Returns null — caller logs a warning and continues without Layer 1.5.
 *
 * @returns {string|null}  Absolute path to an executable wrapper, or null.
 */
function resolveWrapperPath() {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDir, "..");
  const candidates = [
    path.join(repoRoot, "shell-wrapper", "agentguard-shell"),
    path.join(repoRoot, "shell-wrapper", "agentguard-shell.sh"),
  ];
  for (const p of candidates) {
    try {
      const stat = fs.statSync(p);
      // Bit 0o111 = any execute bit (user / group / other).
      if (stat.isFile() && (stat.mode & 0o111)) return p;
    } catch {}
  }
  return null;
}

// ─── node-pty availability ───────────────────────────────────────────────────

/** True when node-pty native bindings loaded successfully. */
export let PTY_AVAILABLE = false;
let _nodePty = null;

try {
  _nodePty = await import("node-pty");
  PTY_AVAILABLE = true;
} catch {
  // node-pty not installed or native build failed — callers should fall back
  // to the log-based interceptor.
}

// ─── command extraction ──────────────────────────────────────────────────────

// Strip ANSI escape codes before trying to match shell-prompt patterns.
const ANSI_RE = /\x1B\[[0-9;]*[mGKHFABCDJsurh]/g;

/**
 * Return the bare command string if the line looks like an executed shell
 * command, otherwise return null.
 *
 * @param {string} line  Raw PTY output line (may contain ANSI codes).
 * @returns {string|null}
 */
function extractCommand(line) {
  const clean = line.replace(ANSI_RE, "").trim();

  // Shell prompt prefixes: "$ cmd", "% cmd", "> cmd", "# cmd"
  const promptMatch = clean.match(/^[>$%#]\s+(.+)$/);
  if (promptMatch) return promptMatch[1].trim();

  // Explicit execution labels: "Running: cmd", "Executing: cmd"
  const runningMatch = clean.match(/^(?:running|executing|exec|run):\s+(.+)$/i);
  if (runningMatch) return runningMatch[1].trim();

  return null;
}

// ─── core ────────────────────────────────────────────────────────────────────

/**
 * Launch the agent in a PTY and intercept its output.
 *
 * @param {Object}   options
 * @param {string}   options.agent       - Agent binary name (e.g. "codex")
 * @param {string[]} options.agentArgs   - Arguments forwarded to the agent
 * @param {string}   [options.stashRef]  - Snapshot stash ref (may be null)
 * @param {Object}   [options.config]    - Merged AgentGuard config object
 * @param {Object}   options.stats       - Shared stats object (mutated in place)
 *                                         { commandsSeen, intercepted, approved, blocked }
 * @returns {Promise<number>}  Agent exit code
 */
export async function runPtyInterceptor({
  agent,
  agentArgs,
  stashRef,
  config,
  stats,
}) {
  if (!PTY_AVAILABLE) {
    throw new Error(
      "node-pty is not available; use the log-based interceptor instead"
    );
  }

  const { spawn: ptySpawn } = _nodePty;

  // ── shared mutable state ─────────────────────────────────────────────────
  // Declared outside the Promise so the daemon (started before the Promise
  // body runs) can close over them.  All references resolve at call time —
  // pty / dataSub are assigned later, but the daemon only reads them when
  // it actually adjudicates an incident, by which point spawn has happened.
  let pty;          // node-pty handle, assigned after ptySpawn
  let dataSub;      // pty.onData subscription, assigned after binding
  let forwardingActive = false;
  let handlingApproval = false; // re-entrancy guard for the PTY data handler
  let lockHeld = false;
  let lockPoisoned = false;

  // ── stdin forwarding ─────────────────────────────────────────────────────
  // We toggle raw mode + forwarding on/off around the approval prompt so
  // readline can function properly while prompting.

  function enableForwarding() {
    if (forwardingActive) return;
    forwardingActive = true;
    if (process.stdin.isTTY && process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(true);
      } catch {}
    }
    process.stdin.resume();
  }

  function disableForwarding() {
    if (!forwardingActive) return;
    forwardingActive = false;
    if (process.stdin.setRawMode) {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
  }

  function stdinHandler(data) {
    if (forwardingActive) {
      pty.write(data.toString());
    }
  }

  // ── TTY lock ─────────────────────────────────────────────────────────────
  // Acquired before any approval prompt, released after.  Shared between
  // the PTY scanner (Layer 1) and the shell daemon (Layer 1.5) so two
  // adjudications never overlap on the same TTY.
  //
  // Poisoned after onTerminate so post-mortem releases don't try to
  // re-resume a dying PTY or re-enable raw mode after cleanup.
  const ttyLock = {
    get canPrompt() { return process.stdin.isTTY !== false; },
    acquire: async () => {
      if (lockPoisoned || lockHeld) return;
      lockHeld = true;
      handlingApproval = true;
      disableForwarding();
      try { pty.pause(); } catch {}
      // Yield once so any in-flight PTY data finishes draining before the
      // prompt UI takes over the terminal.
      await new Promise((r) => setImmediate(r));
    },
    release: () => {
      if (lockPoisoned || !lockHeld) return;
      lockHeld = false;
      try { pty.resume(); } catch {}
      enableForwarding();
      handlingApproval = false;
    },
    poison: () => { lockPoisoned = true; },
  };

  // ── resolve shell wrapper + start daemon ─────────────────────────────────
  // The daemon listens on a per-session Unix socket.  We start it BEFORE
  // spawning the agent so the wrapper can connect immediately on first
  // use.  Even if the wrapper binary isn't installed, we still start the
  // daemon — it owns the adjudication mutex that the PTY scanner uses.

  const wrapperPath = resolveWrapperPath();
  const socketPath = path.join(os.tmpdir(), `agentguard-${sessionId}.sock`);
  const daemon = await startShellDaemon({
    socketPath, config, stashRef, agent, stats, ttyLock,
  });

  return new Promise((resolve) => {

    // ── PTY incident runtime ─────────────────────────────────────────────
    // Used by the PTY scanner (Layer 1) when it routes through
    // daemon.adjudicate().  onResume is a no-op because ttyLock.release
    // handles the resume in adjudicate's `finally`; onTerminate poisons
    // the lock so subsequent releases are no-ops while the PTY is being
    // killed asynchronously.
    const ptyIncidentRuntime = {
      get canPrompt() { return process.stdin.isTTY !== false; },
      onRestore: () => {
        console.error(chalk.yellow("[AgentGuard] Restoring snapshot…"));
        const snap = restoreSnapshot(stashRef);
        console.error(
          snap.restored
            ? chalk.green(`[AgentGuard] ${snap.message}`)
            : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
        );
        logSnapshotRestore(snap, agent);
      },
      onTerminate: () => {
        // Poison FIRST so any concurrent ttyLock.release() (from another
        // queued adjudication) becomes a no-op while we tear down.
        ttyLock.poison();

        // Detach the onData handler first so no buffered PTY bytes reach
        // process.stdout after the deny decision — prevents a garbage flood
        // during the escalation window.
        try { dataSub?.dispose(); } catch {}
        console.error(chalk.red("\n[AgentGuard] Operation blocked."));
        cleanup();
        logSessionEnd(agent);
        const pid = pty.pid;
        const pgid = -pid; // negative pid = signal the whole process group
        try { pty.kill(); } catch {} // SIGHUP (node-pty default)

        // Full terminal reset (RIS — Reset to Initial State). Corrects
        // arbitrary corruption left by TUI agents (alt-screen, character
        // sets, scroll regions, SGR, cursor keys, etc.) — a targeted
        // \x1b[?1049l + \x1b[0m is not enough for agents like gh copilot.
        process.stderr.write("\x1Bc");

        // Escalate if the process group ignores SIGHUP: 500ms → SIGTERM →
        // 500ms → SIGKILL. process.kill(pid, 0) probes the session leader;
        // if it's already dead we skip further signals. Signals target the
        // whole group (-pid) so children forked off the agent are swept up.
        (async () => {
          await new Promise((r) => setTimeout(r, 500));
          try { process.kill(pid, 0); process.kill(pgid, "SIGTERM"); } catch {}
          await new Promise((r) => setTimeout(r, 500));
          try { process.kill(pid, 0); process.kill(pgid, "SIGKILL"); } catch {}
          if (daemon) { try { await daemon.stop(); } catch {} }
          resolve(1);
        })();
      },
      onResume: () => {
        // No-op: ttyLock.release in adjudicate's finally handles resume.
      },
    };

    // ── spawn PTY ─────────────────────────────────────────────────────────
    // Inject SHELL + session env so the agent's child shells route through
    // the wrapper.  If no wrapper was found, leave SHELL alone and warn —
    // Layer 1.5 is disabled but the session continues.
    const resolvedAgent = resolveBin(agent);

    const env = { ...process.env };
    if (wrapperPath) {
      env.SHELL = wrapperPath;
      env.AGENTGUARD_SOCKET = socketPath;
      env.AGENTGUARD_SESSION_ID = sessionId;
      console.error(
        chalk.gray(`[AgentGuard] Shell wrapper: ${wrapperPath}`)
      );
    } else {
      console.error(
        chalk.yellow(
          "[AgentGuard] Shell wrapper not found at shell-wrapper/agentguard-shell{,.sh} — " +
            "command interception falls back to PTY output scanning only."
        )
      );
    }

    pty = ptySpawn(resolvedAgent, agentArgs, {
      name: process.env.TERM || "xterm-256color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env,
    });

    // ── stdin / resize wiring ─────────────────────────────────────────────
    process.stdin.on("data", stdinHandler);
    enableForwarding();

    function onResize() {
      try {
        pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
      } catch {}
    }
    process.stdout.on("resize", onResize);

    function cleanup() {
      process.stdout.off("resize", onResize);
      process.stdin.off("data", stdinHandler);
      disableForwarding();
    }

    // ── PTY output handler ────────────────────────────────────────────────
    let lineBuf = "";

    dataSub = pty.onData(async (data) => {
      if (handlingApproval) return; // buffer scanning paused during prompt

      // Always forward raw PTY bytes to the user's terminal.
      process.stdout.write(data);

      lineBuf += data;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // keep incomplete trailing fragment

      for (const line of lines) {
        // ── Correlation layer ──────────────────────────────────────────────
        // Strip ANSI escape codes before decoding — PTY output contains them raw.
        const event = decodeCommand(line.replace(ANSI_RE, "").trim());
        if (event) {
          bus.push(event);
          const fired = filterFired(evaluate(bus), suppression);
          for (const rule of fired) {
            console.error(
              chalk.magenta(`\n[AgentGuard] ⚡ Correlation: ${rule.description} [${rule.level}]`)
            );

            const incident = {
              source: "correlation",
              level: rule.level,
              reason: rule.description,
              ruleId: rule.id,
            };

            const { outcome } = await daemon.adjudicate(incident, ptyIncidentRuntime);
            if (outcome === "denied") return; // PTY killed, stop processing this chunk
            // approved or deferred: ttyLock release already ran in adjudicate's finally.
          }
        }

        // ── Single-event classify / approval flow ──────────────────────────
        const cmd = extractCommand(line);
        if (!cmd) continue;

        stats.commandsSeen++;
        const result = classify(cmd);

        if (requiresApproval(result)) {
          // Telegram alert fires before adjudication — don't await so
          // the prompt isn't blocked on network latency.
          if (isNotifierConfigured(config)) {
            sendTelegramAlert(
              { command: cmd, level: result.level, reason: result.reason, sessionId, agent },
              config
            ).catch(() => {});
          }

          const contextResult = scoreWithContext(cmd);

          const incident = {
            source: "command",
            level: result.level,
            reason: result.reason,
            command: cmd,
            contextNotes: contextResult.contextNotes,
          };

          const { outcome } = await daemon.adjudicate(incident, ptyIncidentRuntime);
          if (outcome === "denied") return;
          // approved or deferred: ttyLock release already ran in adjudicate's finally.
        }
      }
    });

    // ── exit ──────────────────────────────────────────────────────────────
    pty.onExit(({ exitCode }) => {
      cleanup();
      (async () => {
        if (daemon) { try { await daemon.stop(); } catch {} }
        logSessionEnd(agent);
        resolve(exitCode ?? 0);
      })();
    });
  });
}
