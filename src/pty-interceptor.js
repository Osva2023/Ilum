/**
 * AgentGuard PTY Interceptor  (Phase 1 — real PTY mode)
 *
 * Spawns the agent inside a proper pseudo-terminal using node-pty so the
 * agent sees a real TTY (readline editing, colour output, curses, etc. all
 * work).  PTY output is forwarded to the user's terminal; detected shell
 * commands are classified and flagged for approval exactly as the log-based
 * interceptor does.
 *
 * Key differences from Phase 0 interceptor:
 *   • Uses node-pty instead of child_process.spawn with piped stdio
 *   • Handles terminal resize (SIGWINCH → pty.resize)
 *   • Disables raw-mode stdin forwarding while showing the approval prompt
 *     so the prompt's own readline can work cleanly
 *   • Respects config.autoApprove and config.autoDeny arrays
 *
 * Graceful fallback:
 *   PTY_AVAILABLE is exported so callers can detect whether node-pty loaded
 *   and fall back to the log-based interceptor when it hasn't.
 */

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
import { handleIncident } from "./enforcement.js";

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

  return new Promise((resolve) => {
    // ── spawn PTY ─────────────────────────────────────────────────────────
    const resolvedAgent = resolveBin(agent);
    const pty = ptySpawn(resolvedAgent, agentArgs, {
      name: process.env.TERM || "xterm-256color",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });

    // ── stdin forwarding ──────────────────────────────────────────────────
    // We toggle raw mode + forwarding on/off around the approval prompt so
    // readline can function properly while prompting.

    let forwardingActive = false;

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

    process.stdin.on("data", stdinHandler);
    enableForwarding();

    // ── terminal resize ───────────────────────────────────────────────────
    function onResize() {
      try {
        pty.resize(process.stdout.columns || 80, process.stdout.rows || 24);
      } catch {}
    }
    process.stdout.on("resize", onResize);

    // ── cleanup ───────────────────────────────────────────────────────────
    function cleanup() {
      process.stdout.off("resize", onResize);
      process.stdin.off("data", stdinHandler);
      disableForwarding();
    }

    // ── Shared PTY runtime ────────────────────────────────────────────────
    // Both correlation and single-event paths use the same callbacks.
    const ptyRuntime = {
      canPrompt: process.stdin.isTTY !== false,
      onRestore: () => {
        console.error(chalk.yellow("[AgentGuard] Restoring snapshot\u2026"));
        const snap = restoreSnapshot(stashRef);
        console.error(
          snap.restored
            ? chalk.green(`[AgentGuard] ${snap.message}`)
            : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
        );
        logSnapshotRestore(snap, agent);
      },
      onTerminate: () => {
        console.error(chalk.red("\n[AgentGuard] Operation blocked."));
        cleanup();
        logSessionEnd(agent);
        const pid = pty.pid;
        const pgid = -pid;  // negative pid = signal the whole process group
        try { pty.kill(); } catch {}  // SIGHUP (node-pty default)

        // Exit alt-screen, reset SGR attributes, land on a fresh line so
        // the user sees a clean terminal immediately — even if children
        // take the full escalation window to die.
        process.stderr.write("\x1b[?1049l\x1b[0m\r\n");

        // Escalate if the process group ignores SIGHUP: 500ms → SIGTERM →
        // 500ms → SIGKILL. process.kill(pid, 0) probes the session leader;
        // if it's already dead we skip further signals. Signals target the
        // whole group (-pid) so children forked off the agent are swept up.
        (async () => {
          await new Promise((r) => setTimeout(r, 500));
          try { process.kill(pid, 0); process.kill(pgid, "SIGTERM"); } catch {}
          await new Promise((r) => setTimeout(r, 500));
          try { process.kill(pid, 0); process.kill(pgid, "SIGKILL"); } catch {}

          resolve(1);
        })();
      },
      onResume: () => {
        try { pty.resume(); } catch {}
        enableForwarding();
        handlingApproval = false;
      },
    };

    // ── PTY output handler ────────────────────────────────────────────────
    let lineBuf = "";
    let handlingApproval = false; // prevent re-entrant prompts

    pty.onData(async (data) => {
      if (handlingApproval) return; // buffer scanning paused during prompt

      // Always forward raw PTY bytes to the user's terminal.
      process.stdout.write(data);

      lineBuf += data;
      const lines = lineBuf.split("\n");
      lineBuf = lines.pop(); // keep incomplete trailing fragment

      for (const line of lines) {
        // ── Correlation layer ──────────────────────────────────────────────────
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

            handlingApproval = true;
            disableForwarding();
            try { pty.pause(); } catch {}
            await new Promise(r => setImmediate(r));

            const { outcome } = await handleIncident({
              incident,
              config, stashRef, agent, stats,
              runtime: ptyRuntime,
            });

            if (outcome === "denied") return; // PTY killed, stop processing this chunk
            if (outcome === "deferred") {
              try { pty.resume(); } catch {}
              enableForwarding();
              handlingApproval = false;
            }
            // approved: ptyRuntime.onResume already handled resume + flag reset
          }
        }

        // ── Single-event classify / approval flow ──────────────────────────────
        const cmd = extractCommand(line);
        if (!cmd) continue;

        stats.commandsSeen++;
        const result = classify(cmd);

        if (requiresApproval(result)) {
          // Telegram alert fires before pausing — don't await so prompt isn't blocked
          if (isNotifierConfigured(config)) {
            sendTelegramAlert(
              { command: cmd, level: result.level, reason: result.reason, sessionId, agent },
              config
            ).catch(() => {});
          }

          const contextResult = scoreWithContext(cmd);

          handlingApproval = true;
          disableForwarding();
          try { pty.pause(); } catch {}
          await new Promise(r => setImmediate(r));

          const { outcome } = await handleIncident({
            incident: {
              source: "command",
              level: result.level,
              reason: result.reason,
              command: cmd,
              contextNotes: contextResult.contextNotes,
            },
            config, stashRef, agent, stats,
            runtime: ptyRuntime,
          });

          if (outcome === "denied") return;
          if (outcome === "deferred") {
            try { pty.resume(); } catch {}
            enableForwarding();
            handlingApproval = false;
          }
          // approved: ptyRuntime.onResume already handled resume + flag reset
        }
      }
    });

    // ── exit ──────────────────────────────────────────────────────────────
    pty.onExit(({ exitCode }) => {
      cleanup();
      logSessionEnd(agent);
      resolve(exitCode ?? 0);
    });
  });
}
