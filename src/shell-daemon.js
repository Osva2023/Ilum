/**
 * AgentGuard Shell Daemon
 *
 * Adjudication endpoint for the agentguard-shell wrapper.  Listens on a Unix
 * domain socket; each connection sends one JSON request describing a command
 * the agent is about to run via `$SHELL -c`.  The daemon classifies the
 * command, runs it through the shared incident-enforcement pipeline, and
 * replies with `approved` or `denied`.  The wrapper then either execs the
 * real shell or exits non-zero so the agent sees a normal command failure.
 *
 * Why this exists:
 *   The PTY-output decoder in src/decoder.js only catches commands when the
 *   agent prints a recognisable shell-prompt prefix.  Agents like Claude Code
 *   and Codex render tool calls in their own UI format and slip through.  The
 *   shell wrapper sits below the agent's UI layer — every `sh -c` invocation
 *   (which is how Node's child_process.exec, libuv, execvp etc. dispatch
 *   shell commands) routes through us regardless of how the agent rendered it.
 *
 * Concurrency:
 *   This module owns the single mutex (`adjudicate`) that serialises every
 *   incident in the process — both shell-wrapper requests AND the existing
 *   PTY-output-triggered incidents.  Callers in pty-interceptor.js must route
 *   their `handleIncident` calls through `adjudicate()` so a wrapper request
 *   and a PTY-scanner hit can never overlap on the same TTY.
 *
 * Wire protocol (line-delimited JSON, one request per connection):
 *   →  {"v":1,"cmd":"rm -rf foo","cwd":"/path","ppid":12345}
 *   ←  {"v":1,"outcome":"approved"}
 *   ←  {"v":1,"outcome":"denied","reason":"rm -rf with sudo"}
 *
 * Per-command deny semantics:
 *   When a wrapper request is denied we DO NOT kill the PTY or restore the
 *   snapshot — the bad command never executed, so there is nothing to roll
 *   back, and the agent will see a normal exit-126 failure and proceed.
 *   This differs from PTY-output-triggered denies, which still kill the
 *   session because they catch commands mid-execution.
 */

import net from "net";
import fs from "fs";
import chalk from "chalk";
import { handleIncident } from "./enforcement.js";
import { classify, requiresApproval, scoreWithContext } from "./classifier.js";
import { logDetected } from "./logger.js";

/** Cap inbound request size — prevents an unbounded buffer if a misbehaving
 *  client streams data without a newline. */
const MAX_REQUEST_BYTES = 16 * 1024;

/** Exit code returned to the agent when a command is denied.  126 = found but
 *  not executable, the closest POSIX convention to "the shell refused". */
export const DENY_EXIT_CODE = 126;

/**
 * Start the shell-wrapper adjudication daemon.
 *
 * @param {Object}   options
 * @param {string}   options.socketPath   Unix socket path to listen on.
 * @param {Object}   [options.config]     Merged AgentGuard config object.
 * @param {string}   [options.stashRef]   Git stash ref for snapshot restore.
 * @param {string}   options.agent        Wrapped agent name (audit log).
 * @param {Object}   options.stats        Shared session stats object.
 * @param {Object}   options.ttyLock      TTY pause/resume primitive (provided
 *                                        by pty-interceptor.js).
 * @param {boolean}  options.ttyLock.canPrompt
 * @param {() => Promise<void>} options.ttyLock.acquire
 * @param {() => void}          options.ttyLock.release
 *
 * @returns {Promise<{
 *   stop: () => Promise<void>,
 *   adjudicate: (incident: object, runtime: object) => Promise<{outcome: string, incident: object}>,
 * }>}
 */
export async function startShellDaemon({
  socketPath,
  config,
  stashRef,
  agent,
  stats,
  ttyLock,
}) {
  // ── Mutex ──────────────────────────────────────────────────────────────────
  // Tail-promise serialisation.  Every adjudication awaits the previous one
  // before running.  This prevents two prompts from racing for the TTY.
  let inflight = Promise.resolve();

  function withMutex(fn) {
    const prev = inflight;
    let release;
    inflight = new Promise((r) => { release = r; });
    return prev.then(fn).finally(release);
  }

  /**
   * The single adjudication entry point.  pty-interceptor.js routes its
   * PTY-output-triggered handleIncident calls through here too — both
   * sources share one mutex and one TTY.
   *
   * @param {object} incident  Incident object (see enforcement.js).
   * @param {object} runtime   Runtime callbacks for handleIncident.
   * @returns {Promise<{outcome: "approved"|"denied"|"deferred", incident: object}>}
   */
  async function adjudicate(incident, runtime) {
    return withMutex(async () => {
      await ttyLock.acquire();
      try {
        return await handleIncident({
          incident, config, stashRef, agent, stats, runtime,
        });
      } finally {
        ttyLock.release();
      }
    });
  }

  // ── Connection handler ─────────────────────────────────────────────────────

  async function handleConnection(socket) {
    let buf = "";
    socket.setEncoding("utf8");

    // Read until newline, EOF, or size cap.
    const line = await new Promise((resolve) => {
      const onData = (chunk) => {
        buf += chunk;
        const nl = buf.indexOf("\n");
        if (nl !== -1) {
          socket.off("data", onData);
          resolve(buf.slice(0, nl));
          return;
        }
        if (buf.length > MAX_REQUEST_BYTES) {
          socket.off("data", onData);
          resolve(null); // overflow → treat as bad request
        }
      };
      socket.on("data", onData);
      socket.once("error", () => resolve(null));
      socket.once("end", () => resolve(buf || null));
    });

    function reply(payload) {
      try { socket.end(JSON.stringify(payload) + "\n"); } catch {}
    }

    if (!line) {
      reply({ v: 1, outcome: "denied", reason: "empty or oversized request" });
      return;
    }

    let req;
    try {
      req = JSON.parse(line);
    } catch {
      reply({ v: 1, outcome: "denied", reason: "malformed JSON" });
      return;
    }

    if (req.v !== 1 || typeof req.cmd !== "string") {
      reply({ v: 1, outcome: "denied", reason: "unsupported request shape" });
      return;
    }

    // ── Classify ────────────────────────────────────────────────────────────

    const cmd = req.cmd;
    const result = classify(cmd);

    // Audit-only mode: log but never deny.
    if (config?.auditOnly && requiresApproval(result)) {
      logDetected(
        { source: "command", level: result.level, reason: result.reason, command: cmd },
        agent
      );
      if (stats) stats.intercepted = (stats.intercepted ?? 0) + 1;
      reply({ v: 1, outcome: "approved" });
      return;
    }

    // Safe commands: bypass adjudication, count, return immediately.
    if (!requiresApproval(result)) {
      if (stats) stats.commandsSeen = (stats.commandsSeen ?? 0) + 1;
      reply({ v: 1, outcome: "approved" });
      return;
    }

    if (stats) stats.commandsSeen = (stats.commandsSeen ?? 0) + 1;

    // ── Risky command: route through the shared adjudication mutex ─────────

    const cwdForContext = typeof req.cwd === "string" ? req.cwd : process.cwd();
    const contextResult = scoreWithContext(cmd, cwdForContext);

    const incident = {
      source: "command",
      level: result.level,
      reason: result.reason,
      command: cmd,
      contextNotes: contextResult.contextNotes,
    };

    // Per-command deny semantics: no PTY kill, no snapshot restore.  We just
    // record the deny outcome and surface it back to the wrapper, which
    // exits 126 so the agent sees a normal command failure.
    const shellRuntime = {
      canPrompt: ttyLock.canPrompt,
      onRestore: () => {},
      onTerminate: () => {},
      onResume: () => {},
    };

    let result2;
    try {
      result2 = await adjudicate(incident, shellRuntime);
    } catch (err) {
      console.error(
        chalk.red(`[AgentGuard] shell-daemon adjudication error: ${err.message}`)
      );
      reply({ v: 1, outcome: "denied", reason: "internal error" });
      return;
    }

    // "deferred" happens for non-CRITICAL incidents when no TTY is attached.
    // Treat as approved — consistent with the existing PTY-path behaviour
    // (the incident is logged via logDetected inside handleIncident).
    const outcome = result2.outcome === "denied" ? "denied" : "approved";
    reply({ v: 1, outcome, reason: outcome === "denied" ? result.reason : undefined });
  }

  // ── Server lifecycle ───────────────────────────────────────────────────────

  // Clean up a stale socket from a previous crashed session.
  try { fs.unlinkSync(socketPath); } catch {}

  const server = net.createServer((socket) => {
    handleConnection(socket).catch((err) => {
      console.error(
        chalk.red(`[AgentGuard] shell-daemon connection error: ${err.message}`)
      );
      try { socket.destroy(); } catch {}
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      // Restrict the socket to the current user.  UDS permissions are the
      // ACL — anyone who can open the path can connect.
      try { fs.chmodSync(socketPath, 0o600); } catch {}
      resolve();
    });
  });

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    await new Promise((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch {}
  }

  return { stop, adjudicate };
}
