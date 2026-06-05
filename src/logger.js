/**
 * AgentGuard Audit Logger
 *
 * Writes JSON-lines to ~/.agentguard/audit.log.
 * Each entry is a self-contained JSON object on a single line so the log is
 * trivially parseable with `jq` or any streaming parser.
 *
 * Log entry shape (command helpers):
 * {
 *   ts:        ISO-8601 timestamp
 *   sessionId: short random ID for the current agentguard session
 *   event:     "command_intercepted" | "command_approved" | "command_denied"
 *              | "session_start" | "session_end" | "snapshot_created"
 *              | "incident_detected" | "incident_approved" | "incident_denied"
 *              | "snapshot_restore"
 *   source:    origin of the incident ("command" | "correlation" | "filewatch")
 *              — omitted for command/session helpers
 *   level:     risk level (SAFE / WARN / HIGH / CRITICAL) — omitted for session events
 *   command:   the shell command string — present when the incident originated from
 *              command interception; omitted otherwise
 *   ruleId:    correlation rule id — present when the incident originated from a
 *              fired correlation rule; omitted otherwise
 *   reason:    rule reason string — omitted when SAFE or for session events
 *   watchPath: absolute watched root the file belongs to — present on
 *              file-watcher events (command_intercepted / incident_detected);
 *              lets the dashboard attribute a session to a project reliably
 *   agent:     name of the wrapped agent (e.g. "codex", "claude")
 * }
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// ─── paths ───────────────────────────────────────────────────────────────────

// Under test (NODE_ENV=test or AGENTGUARD_TEST=1) the audit log is redirected to
// a throwaway file in the OS temp dir so unit tests never pollute the user's real
// ~/.agentguard/audit.log. The temp file is per-process and safe to discard.
const IS_TEST = process.env.NODE_ENV === "test" || process.env.AGENTGUARD_TEST === "1";

const AGENTGUARD_DIR = IS_TEST
  ? path.join(os.tmpdir(), "agentguard-test")
  : path.join(os.homedir(), ".agentguard");
const LOG_FILE = IS_TEST
  ? path.join(AGENTGUARD_DIR, `audit-${crypto.randomBytes(6).toString("hex")}.log`)
  : path.join(AGENTGUARD_DIR, "audit.log");

// ─── session id ──────────────────────────────────────────────────────────────

// One random ID per process — survives for the lifetime of the agentguard run.
export const sessionId = crypto.randomBytes(4).toString("hex");

// ─── internals ───────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(AGENTGUARD_DIR)) {
    fs.mkdirSync(AGENTGUARD_DIR, { recursive: true });
  }
}

// Default write sink: append to the audit log file.
// Replaceable in tests via setSink() — avoids brittle filesystem assertions.
let _sink = (line) => {
  ensureDir();
  fs.appendFileSync(LOG_FILE, line, "utf8");
};

/**
 * Replace the write sink used by log().  Pass a function that receives each
 * JSON-lines string (including the trailing newline).  Intended for tests only.
 *
 * @param {(line: string) => void} fn
 */
export function setSink(fn) {
  _sink = fn;
}

/**
 * Append one JSON-lines entry to the audit log (sync, fire-and-forget style).
 *
 * @param {Object} fields - Arbitrary key/value pairs merged into the entry.
 * @returns {Object|null} The full entry that was written (so callers can forward
 *   the exact same object elsewhere, e.g. syncToServer), or null on failure.
 */
export function log(fields) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      ...fields,
    };
    _sink(JSON.stringify(entry) + "\n");
    return entry;
  } catch (err) {
    // Logging must never crash the main process.
    process.stderr.write(`[AgentGuard] logger error: ${err.message}\n`);
    return null;
  }
}

// ─── convenience helpers ─────────────────────────────────────────────────────

export function logSessionStart(agent) {
  log({ event: "session_start", agent });
}

export function logSessionEnd(agent) {
  log({ event: "session_end", agent });
}

export function logSnapshot(stashRef) {
  log({ event: "snapshot_created", stashRef });
}

export function logIntercepted({ command, level, reason, agent, watchPath }) {
  return log({
    event: "command_intercepted",
    command,
    level,
    reason,
    ...(watchPath !== undefined && { watchPath }),
    agent,
  });
}

export function logApproved({ command, level, agent }) {
  log({ event: "command_approved", command, level, agent });
}

export function logDenied({ command, level, agent }) {
  log({ event: "command_denied", command, level, agent });
}

// ─── incident lifecycle helpers ───────────────────────────────────────────────
// These helpers accept a full Incident object so correlation/source context is
// preserved.  Fields that are absent on the incident (e.g. ruleId for command
// incidents, command for correlation incidents) are omitted from the entry via
// the undefined-spread behaviour of JSON.stringify.

/**
 * Log that an incident was detected and is pending a decision.
 * Replaces logIntercepted() when the full Incident object is available.
 *
 * @param {{ source: string, level: string, reason: string, command?: string, ruleId?: string }} incident
 * @param {string} [agent]
 */
export function logDetected(incident, agent, extras = {}) {
  const { source, level, reason, command, ruleId, watchPath } = incident;
  return log({
    event: "incident_detected",
    source,
    level,
    reason,
    ...(command !== undefined && { command }),
    ...(ruleId !== undefined && { ruleId }),
    ...(watchPath !== undefined && { watchPath }),
    ...extras,
    agent,
  });
}

/**
 * Log that an incident was approved (auto or interactive).
 *
 * @param {{ source: string, level: string, reason: string, command?: string, ruleId?: string }} incident
 * @param {string} [agent]
 */
export function logIncidentApproved(incident, agent) {
  const { source, level, reason, command, ruleId } = incident;
  log({
    event: "incident_approved",
    source,
    level,
    reason,
    ...(command !== undefined && { command }),
    ...(ruleId !== undefined && { ruleId }),
    agent,
  });
}

/**
 * Log that an incident was denied (auto or interactive).
 *
 * @param {{ source: string, level: string, reason: string, command?: string, ruleId?: string }} incident
 * @param {string} [agent]
 */
export function logIncidentDenied(incident, agent) {
  const { source, level, reason, command, ruleId } = incident;
  log({
    event: "incident_denied",
    source,
    level,
    reason,
    ...(command !== undefined && { command }),
    ...(ruleId !== undefined && { ruleId }),
    agent,
  });
}

/**
 * Log the result of a snapshot restore attempt triggered by a deny action.
 *
 * @param {{ restored: boolean, message: string }} snap  Return value of restoreSnapshot()
 * @param {string} [agent]
 */
export function logSnapshotRestore(snap, agent) {
  log({
    event: "snapshot_restore",
    restored: snap.restored,
    message: snap.message,
    agent,
  });
}

/**
 * Log the result of a per-file restore triggered by a Telegram "Rollback"
 * action.  Distinct from snapshot_restore (which is session-wide).
 *
 * @param {{ restored: boolean, mode: string, message: string }} result  Return value of restoreFile()
 * @param {{ file: string, by?: string }} ctx
 * @param {string} [agent]
 */
export function logFileRestore(result, ctx, agent) {
  log({
    event: "file_restore",
    restored: result.restored,
    mode: result.mode,
    message: result.message,
    file: ctx.file,
    ...(ctx.by !== undefined && { by: ctx.by }),
    agent,
  });
}

// ─── team server sync (TASK-023) ──────────────────────────────────────────────

/**
 * Forward one logged event to the central team server (agentguard-server).
 *
 * Fire-and-forget: returns immediately, never throws, never blocks the caller.
 * No-op unless both config.team.serverUrl and config.team.token are set. The
 * POST is tagged with this machine's hostname so the team dashboard can show a
 * "machine" column. Aborts after 5s so a slow/unreachable server can't pile up.
 *
 * @param {Object} event   The exact entry returned by log()/logIntercepted()/logDetected().
 * @param {Object} config  Loaded config (reads config.team.serverUrl / token).
 */
export function syncToServer(event, config) {
  const team = config?.team;
  if (!team || !team.serverUrl || !team.token || !event) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  const url = team.serverUrl.replace(/\/+$/, "") + "/api/events";
  fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${team.token}`,
    },
    body: JSON.stringify({ ...event, machine: os.hostname() }),
    signal: controller.signal,
  })
    .catch((err) => {
      // Silent: a team-sync failure must never disrupt the daemon. Logged to
      // stderr only, for observability.
      process.stderr.write(`[AgentGuard] team sync failed: ${err.message}\n`);
    })
    .finally(() => clearTimeout(timeout));
}

export { LOG_FILE, AGENTGUARD_DIR };
