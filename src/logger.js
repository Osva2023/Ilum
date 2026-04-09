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
 *   source:    origin of the incident ("command" | "correlation" | "filewatch")
 *              — omitted for command/session helpers
 *   level:     risk level (SAFE / WARN / HIGH / CRITICAL) — omitted for session events
 *   command:   the shell command string — present when the incident originated from
 *              command interception; omitted otherwise
 *   ruleId:    correlation rule id — present when the incident originated from a
 *              fired correlation rule; omitted otherwise
 *   reason:    rule reason string — omitted when SAFE or for session events
 *   agent:     name of the wrapped agent (e.g. "codex", "claude")
 * }
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";

// ─── paths ───────────────────────────────────────────────────────────────────

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const LOG_FILE = path.join(AGENTGUARD_DIR, "audit.log");

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
 */
export function log(fields) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      sessionId,
      ...fields,
    };
    _sink(JSON.stringify(entry) + "\n");
  } catch (err) {
    // Logging must never crash the main process.
    process.stderr.write(`[AgentGuard] logger error: ${err.message}\n`);
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

export function logIntercepted({ command, level, reason, agent }) {
  log({ event: "command_intercepted", command, level, reason, agent });
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
export function logDetected(incident, agent) {
  const { source, level, reason, command, ruleId } = incident;
  log({
    event: "incident_detected",
    source,
    level,
    reason,
    ...(command !== undefined && { command }),
    ...(ruleId !== undefined && { ruleId }),
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

export { LOG_FILE, AGENTGUARD_DIR };
