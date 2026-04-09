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
import { promptApproval } from "./approval.js";
import {
  logIntercepted,
  logApproved,
  logDenied,
  logSessionEnd,
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

    // ── deny handler ──────────────────────────────────────────────────────
    async function handleDeny({ cmd, level }) {
      stats.blocked[level] = (stats.blocked[level] || 0) + 1;
      logDenied({ command: cmd, level, agent });

      console.error(chalk.red("\n[AgentGuard] Operation blocked."));

      if (stashRef && config?.snapshot?.restoreOnDeny !== false) {
        console.error(chalk.yellow("[AgentGuard] Restoring snapshot\u2026"));
        const snap = restoreSnapshot(stashRef);
        console.error(
          snap.restored
            ? chalk.green(`[AgentGuard] ${snap.message}`)
            : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
        );
      }

      cleanup();
      logSessionEnd(agent);
      try {
        pty.kill();
      } catch {}
      resolve(1);
    }

    // ── PTY output handler ────────────────────────────────────────────────
    let lineBuf = "";
    let handlingApproval = false; // prevent re-entrant prompts

    pty.onData(async (data) => {
      // Always forward raw PTY bytes to the user's terminal.
      process.stdout.write(data);

      if (handlingApproval) return; // buffer scanning paused during prompt

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

            const { outcome } = await handleIncident({
              incident,
              config,
              stashRef,
              agent,
              stats,
              runtime: {
                // PTY mode assumes an interactive terminal, but guard against
                // pipe/CI contexts where stdin may not be a TTY.
                canPrompt: process.stdin.isTTY !== false,
                onRestore: () => {
                  console.error(chalk.yellow("[AgentGuard] Restoring snapshot\u2026"));
                  const snap = restoreSnapshot(stashRef);
                  console.error(
                    snap.restored
                      ? chalk.green(`[AgentGuard] ${snap.message}`)
                      : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
                  );
                },
                onTerminate: () => {
                  console.error(chalk.red("\n[AgentGuard] Operation blocked."));
                  cleanup();
                  logSessionEnd(agent);
                  try { pty.kill(); } catch {}
                  resolve(1);
                },
                onResume: () => {
                  try { pty.resume(); } catch {}
                  enableForwarding();
                  handlingApproval = false;
                },
              },
            });

            if (outcome === "denied") {
              // onTerminate has resolved the promise and killed the PTY.
              // Stop processing remaining lines in this data chunk.
              return;
            }
            if (outcome === "deferred") {
              // Non-CRITICAL with no interactive TTY — resume and continue.
              try { pty.resume(); } catch {}
              enableForwarding();
              handlingApproval = false;
            }
            // outcome === "approved": onResume already handled resume + flag reset.
          }
        }

        // ── Single-event classify / approval flow ──────────────────────────────
        const cmd = extractCommand(line);
        if (!cmd) continue;

        stats.commandsSeen++;

        const result = classify(cmd);

        // ── config: autoDeny ─────────────────────────────────────────────
        if (config?.autoDeny?.includes(result.level)) {
          await handleDeny({ cmd, level: result.level });
          return; // PTY killed, stop processing
        }

        // ── config: autoApprove ──────────────────────────────────────────
        if (
          config?.autoApprove?.includes(result.level) &&
          requiresApproval(result)
        ) {
          stats.approved++;
          logApproved({ command: cmd, level: result.level, agent });
          continue;
        }

        // ── interactive approval ─────────────────────────────────────────
        if (requiresApproval(result)) {
          stats.intercepted++;
          logIntercepted({
            command: cmd,
            level: result.level,
            reason: result.reason,
            agent,
          });

          // Context scoring (adds contextNotes to the result for the prompt)
          const contextResult = scoreWithContext(cmd);
          const enrichedResult = {
            ...result,
            contextNotes: contextResult.contextNotes,
          };

          // Fire Telegram alert in parallel — don't await so it doesn't block
          // the interactive prompt.
          if (isNotifierConfigured(config)) {
            sendTelegramAlert(
              {
                command: cmd,
                level: result.level,
                reason: result.reason,
                sessionId,
                agent,
              },
              config
            ).catch(() => {});
          }

          handlingApproval = true;
          disableForwarding(); // hand stdin to the approval prompt
          try { pty.pause(); } catch {} // freeze PTY output while prompting

          const decision = await promptApproval(enrichedResult);

          try { pty.resume(); } catch {} // unfreeze PTY output
          enableForwarding(); // resume PTY input forwarding
          handlingApproval = false;

          if (decision === "approve") {
            stats.approved++;
            logApproved({ command: cmd, level: result.level, agent });
          } else {
            // deny or quit
            await handleDeny({ cmd, level: result.level });
            return;
          }
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
