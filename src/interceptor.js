/**
 * AgentGuard Interceptor  (Phase 0 — log-based mode)
 *
 * Spawns the requested AI agent as a child process and taps its stdout/stderr
 * in real time.  Every line is scanned for shell-command-like strings; any
 * that match a risk rule are routed through the approval prompt before the
 * session continues.
 *
 * Phase 0 limitation:
 *   This is a "log-based" detection mode.  We parse the agent's textual
 *   output for command patterns rather than intercepting actual syscalls.
 *   True PTY / syscall interception is in Phase 1 (src/pty-interceptor.js).
 *
 * Phase 1 additions (backwards-compatible):
 *   • Accepts optional `config` and `stats` parameters so bin/agentguard can
 *     honour autoApprove / autoDeny config entries and collect session stats.
 *
 * How it works:
 *   1. The child agent is spawned with stdio: stdin inherited, stdout/stderr
 *      piped so we can read its output line-by-line.
 *   2. Each line is classified.  SAFE lines are forwarded immediately.
 *      Risky lines pause both streams and route to the approval prompt.
 *   3. On deny, the session exits and the snapshot (if any) is restored.
 */

import { spawn } from "child_process";
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
import { decodeCommand } from "./decoder.js";
import { bus } from "./event-bus.js";
import { evaluate } from "./correlator.js";
import { filterFired, suppression } from "./suppression.js";
import { handleIncident } from "./enforcement.js";

// ─── core ────────────────────────────────────────────────────────────────────

/**
 * Launch the agent and intercept its output.
 *
 * @param {Object}   options
 * @param {string}   options.agent       - Agent binary name (e.g. "codex")
 * @param {string[]} options.agentArgs   - Arguments to pass to the agent
 * @param {string}   [options.stashRef]  - Snapshot stash ref (may be null)
 * @param {Object}   [options.config]    - Merged AgentGuard config object
 * @param {Object}   [options.stats]     - Shared stats object (mutated in place)
 * @returns {Promise<number>}  Agent exit code
 */
export async function runInterceptor({ agent, agentArgs, stashRef, config, stats }) {
  // Provide a default stats object so callers don't have to.
  if (!stats) {
    stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(agent, agentArgs, {
      // stdin flows directly from the user's terminal
      stdio: ["inherit", "pipe", "pipe"],
      env: process.env,
    });

    // Buffer for incomplete lines across chunk boundaries
    let stdoutBuf = "";
    let stderrBuf = "";

    // ── line processors ────────────────────────────────────────────────────

    /**
     * Process a complete line from the agent's output stream.
     * Returns a promise so the stream can be paused while prompting.
     *
     * Pipeline:
     *   1. decodeCommand() normalises the line into a canonical event (or null).
     *   2. The event is pushed to the shared event bus.
     *   3. Correlation rules are evaluated; any newly-fired rules surface as
     *      informational notices (no blocking — single-event flow handles that).
     *   4. The existing classify() → requiresApproval() path runs unchanged.
     */
    async function processLine(line, stream) {
      // ── Rule-engine pipeline (correlation layer) ────────────────────────────
      const event = decodeCommand(line);
      const cmd = event ? event.command : null;

      if (event) {
        bus.push(event);
        const fired = filterFired(evaluate(bus), suppression);
        for (const rule of fired) {
          // Always print the correlation notice so the user can see which
          // pattern fired, regardless of whether enforcement blocks or not.
          console.error(
            chalk.magenta(`\n[AgentGuard] ⚡ Correlation: ${rule.description} [${rule.level}]`)
          );

          const incident = {
            source: "correlation",
            level: rule.level,
            reason: rule.description,
            ruleId: rule.id,
          };

          // Pause streams so the approval prompt (if shown) has a clean TTY.
          child.stdout.pause();
          child.stderr.pause();

          const { outcome } = await handleIncident({
            incident,
            config,
            stashRef,
            agent,
            stats,
            runtime: {
              canPrompt: process.stdout.isTTY ?? false,
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
                logSessionEnd(agent);
                child.kill("SIGTERM");
                process.exit(1);
              },
              onResume: () => {
                child.stdout.resume();
                child.stderr.resume();
              },
            },
          });

          if (outcome === "deferred") {
            // No TTY and non-CRITICAL — resume so the session can continue.
            child.stdout.resume();
            child.stderr.resume();
          }
          // outcome === "approved": onResume already resumed streams.
          // outcome === "denied":   onTerminate already killed the process.
        }
      }

      // ── Single-event classify / approval flow (unchanged) ───────────────────
      if (cmd) {
        stats.commandsSeen++;

        const result = classify(cmd);

        // ── config: autoDeny ───────────────────────────────────────────────
        if (config?.autoDeny?.includes(result.level)) {
          stats.blocked[result.level] = (stats.blocked[result.level] || 0) + 1;
          logDenied({ command: cmd, level: result.level, agent });
          console.error(
            chalk.red(`\n[AgentGuard] Auto-denied (${result.level}): ${cmd}`)
          );
          doBlock({ cmd, level: result.level });
          return;
        }

        // ── config: autoApprove ────────────────────────────────────────────
        if (
          config?.autoApprove?.includes(result.level) &&
          requiresApproval(result)
        ) {
          stats.approved++;
          logApproved({ command: cmd, level: result.level, agent });
          stream.write(line + "\n");
          return;
        }

        if (requiresApproval(result)) {
          stats.intercepted++;
          logIntercepted({ command: cmd, level: result.level, reason: result.reason, agent });

          // Pause data events while we wait for the user
          child.stdout.pause();
          child.stderr.pause();

          const decision = await promptApproval(result);

          if (decision === "approve") {
            stats.approved++;
            logApproved({ command: cmd, level: result.level, agent });
            // Forward the line and resume
            stream.write(line + "\n");
            child.stdout.resume();
            child.stderr.resume();
          } else {
            // deny or quit
            stats.blocked[result.level] = (stats.blocked[result.level] || 0) + 1;
            logDenied({ command: cmd, level: result.level, agent });
            doBlock({ cmd, level: result.level });
          }
          return;
        }
      }

      // SAFE or non-command line — pass through immediately
      stream.write(line + "\n");
    }

    function doBlock({ cmd, level }) {
      void cmd; // used by callers for logging before calling here
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

      logSessionEnd(agent);
      child.kill("SIGTERM");
      process.exit(1);
    }

    // ── stdout handler ─────────────────────────────────────────────────────

    child.stdout.on("data", async (chunk) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop(); // incomplete trailing line

      for (const line of lines) {
        await processLine(line, process.stdout);
      }
    });

    child.stdout.on("end", () => {
      if (stdoutBuf) process.stdout.write(stdoutBuf);
    });

    // ── stderr handler ─────────────────────────────────────────────────────

    child.stderr.on("data", async (chunk) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();

      for (const line of lines) {
        await processLine(line, process.stderr);
      }
    });

    child.stderr.on("end", () => {
      if (stderrBuf) process.stderr.write(stderrBuf);
    });

    // ── exit ───────────────────────────────────────────────────────────────

    child.on("error", (err) => {
      console.error(
        chalk.red(`[AgentGuard] Failed to start agent "${agent}": ${err.message}`)
      );
      reject(err);
    });

    child.on("close", (code) => {
      logSessionEnd(agent);
      resolve(code ?? 0);
    });
  });
}
