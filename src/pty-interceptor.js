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

import { classify, requiresApproval } from "./classifier.js";
import { promptApproval } from "./approval.js";
import {
  logIntercepted,
  logApproved,
  logDenied,
  logSessionEnd,
} from "./logger.js";
import { restoreSnapshot } from "./snapshot.js";
import chalk from "chalk";

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
    const pty = ptySpawn(agent, agentArgs, {
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

          handlingApproval = true;
          disableForwarding(); // hand stdin to the approval prompt

          const decision = await promptApproval(result);

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
