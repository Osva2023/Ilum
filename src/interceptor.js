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
import { logSessionEnd } from "./logger.js";
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
     *
     * Pipeline:
     *   1. decodeCommand() normalises the line into a canonical event (or null).
     *   2. The event is pushed to the shared event bus; correlation rules fire.
     *   3. Correlation incidents are routed through handleIncident().
     *   4. Single-event classify() result is also routed through handleIncident()
     *      for risky commands — autoDeny / autoApprove / prompt all handled there.
     */
    async function processLine(line, stream) {
      // ── Shared runtime factory ──────────────────────────────────────────────
      // Both the correlation path and the single-event path use the same
      // terminate/restore/resume callbacks — only onResume differs (command
      // path also forwards the line to the output stream).
      function makeRuntime(extraOnResume) {
        return {
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
            extraOnResume?.();
            child.stdout.resume();
            child.stderr.resume();
          },
        };
      }

      // ── Correlation layer ───────────────────────────────────────────────────
      const event = decodeCommand(line);
      const cmd = event ? event.command : null;

      if (event) {
        bus.push(event);
        const fired = filterFired(evaluate(bus), suppression);
        for (const rule of fired) {
          console.error(
            chalk.magenta(`\n[AgentGuard] ⚡ Correlation: ${rule.description} [${rule.level}]`)
          );

          child.stdout.pause();
          child.stderr.pause();

          const { outcome } = await handleIncident({
            incident: { source: "correlation", level: rule.level, reason: rule.description, ruleId: rule.id },
            config, stashRef, agent, stats,
            runtime: makeRuntime(),
          });

          if (outcome === "deferred") {
            child.stdout.resume();
            child.stderr.resume();
          }
          // approved: onResume already resumed.  denied: process already exited.
        }
      }

      // ── Single-event classify / approval flow ───────────────────────────────
      if (cmd) {
        stats.commandsSeen++;
        const result = classify(cmd);

        if (requiresApproval(result)) {
          child.stdout.pause();
          child.stderr.pause();

          const { outcome } = await handleIncident({
            incident: { source: "command", level: result.level, reason: result.reason, command: cmd },
            config, stashRef, agent, stats,
            runtime: makeRuntime(() => { stream.write(line + "\n"); }),
          });

          if (outcome === "denied") return;
          if (outcome === "deferred") {
            // Non-CRITICAL, no TTY — forward the line and resume.
            stream.write(line + "\n");
            child.stdout.resume();
            child.stderr.resume();
          }
          return; // approved: onResume already forwarded + resumed
        }
      }

      // SAFE or non-command line — pass through immediately
      stream.write(line + "\n");
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
