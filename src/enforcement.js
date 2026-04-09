/**
 * AgentGuard Enforcement
 *
 * Unified approval/deny flow for all incident sources — command interception,
 * correlation rule fires, and file-watcher alerts.  Callers describe *what*
 * happened via an Incident object; this module decides *what to do* about it
 * and delegates every side-effect (stream resume, process termination, snapshot
 * restore) to injected runtime callbacks so the module stays testable and
 * free of PTY / child_process dependencies.
 *
 * Pipeline position:
 *   classifier / correlator / filewatcher
 *     → handleIncident()
 *       → log → autoDeny | autoApprove | prompt | deferred
 *         → runtime callbacks
 */

import { promptApproval } from "./approval.js";
import {
  logDetected,
  logIncidentApproved,
  logIncidentDenied,
} from "./logger.js";
import { buildIncidentPreview } from "./preview.js";

// ─── Types (JSDoc only) ───────────────────────────────────────────────────────

/**
 * A normalised description of one risky event, regardless of where it came from.
 *
 * @typedef {Object} Incident
 * @property {"command"|"correlation"|"filewatch"} source
 *   Where the incident originated.
 * @property {"WARN"|"HIGH"|"CRITICAL"} level
 *   Risk level; drives autoDeny / autoApprove lookups.
 * @property {string} reason
 *   Human-readable description shown in the approval UI and written to the audit log.
 * @property {string} [command]
 *   The shell command string, if the incident originated from command interception.
 * @property {string} [ruleId]
 *   Correlation rule id, if the incident originated from a fired correlation rule.
 * @property {string[]} [contextNotes]
 *   Optional extra lines shown in the approval UI (e.g. diff preview, context hints).
 */

/**
 * Side-effect callbacks provided by the caller.  Keeping them here (rather
 * than hardcoding process.exit / child.kill / restoreSnapshot) means the
 * module can be unit-tested without spawning processes or touching the FS.
 *
 * @typedef {Object} Runtime
 * @property {boolean} canPrompt
 *   True when an interactive TTY prompt is possible.  When false,
 *   handleIncident() returns `{ outcome: "deferred" }` instead of prompting.
 * @property {(approvalArg: object) => Promise<"approve"|"deny"|"quit">} [prompt]
 *   Override the prompt function.  Defaults to the real `promptApproval()` UI.
 *   Inject a stub here in tests.
 * @property {() => void} [onRestore]
 *   Called when a snapshot restore is warranted (stashRef present and
 *   config.snapshot.restoreOnDeny is not false).
 * @property {() => void} onTerminate
 *   Called to end the session after a deny/quit decision.
 * @property {() => void} [onResume]
 *   Called after an approval to resume paused streams (if any).
 */

/**
 * The structured result returned to the caller.
 *
 * @typedef {Object} EnforcementResult
 * @property {"approved"|"denied"|"deferred"} outcome
 * @property {Incident} incident
 */

// ─── handleIncident ───────────────────────────────────────────────────────────

/**
 * Evaluate one incident through the full enforcement pipeline.
 *
 * Decision order:
 *   1. autoDeny  — deny immediately if config says so
 *   2. autoApprove — approve immediately if config says so
 *   3. deferred  — return without prompting when canPrompt is false
 *   4. prompt    — show the interactive approval UI and act on the response
 *
 * @param {Object}  options
 * @param {Incident} options.incident
 * @param {object}  [options.config]     Merged AgentGuard config object.
 *                                       Falls back to permissive defaults when omitted.
 * @param {string}  [options.stashRef]   Git stash ref; enables snapshot restore on deny.
 * @param {string}  [options.agent]      Agent name written to the audit log.
 * @param {object}  [options.stats]      Shared stats object (mutated in place).
 * @param {Runtime} options.runtime      Side-effect callbacks.
 * @returns {Promise<EnforcementResult>}
 */
export async function handleIncident({
  incident,
  config,
  stashRef,
  agent,
  stats,
  runtime,
}) {
  const { level, reason, command, ruleId, contextNotes } = incident;

  // A single displayCommand string used in log entries and the approval UI.
  // Prefer the actual command; fall back to ruleId then reason as a descriptor.
  const displayCommand = command ?? ruleId ?? reason;

  // Resolve the prompt function: use injected stub in tests, real UI in prod.
  const doPrompt = runtime.prompt ?? promptApproval;

  // ── Shared deny sequence ─────────────────────────────────────────────────────
  //
  // Every deny path — autoDeny, CRITICAL-no-TTY, and prompt deny — runs the
  // same sequence in the same order:
  //   1. Increment blocked stats
  //   2. Emit incident_denied log entry
  //   3. Call onRestore (if stashRef is set and restoreOnDeny is not false)
  //   4. Call onTerminate
  //
  // Restoring the snapshot on every deny is intentional: the stash captures
  // the workspace at session start, and denying a dangerous operation means
  // we want to roll back to that known-good state regardless of how the deny
  // was triggered.
  function executeDeny() {
    if (stats) stats.blocked = { ...stats.blocked, [level]: (stats.blocked?.[level] ?? 0) + 1 };
    logIncidentDenied(incident, agent);
    if (stashRef && config?.snapshot?.restoreOnDeny !== false) {
      runtime.onRestore?.();
    }
    runtime.onTerminate();
    return { outcome: "denied", incident };
  }

  // ── 1. autoDeny ─────────────────────────────────────────────────────────────

  if (config?.autoDeny?.includes(level)) {
    return executeDeny();
  }

  // ── 2. autoApprove ──────────────────────────────────────────────────────────

  if (config?.autoApprove?.includes(level)) {
    if (stats) stats.approved = (stats.approved ?? 0) + 1;
    logIncidentApproved(incident, agent);
    runtime.onResume?.();
    return { outcome: "approved", incident };
  }

  // ── 3. deferred (no TTY) ────────────────────────────────────────────────────

  if (!runtime.canPrompt) {
    // CRITICAL incidents must never be left unresolved.  Even without an
    // interactive TTY we auto-deny them — a session that cannot prompt a
    // human on a CRITICAL event is not safe to continue.
    // WARN / HIGH are deferred (caller decides what to do with the result).
    if (level === "CRITICAL") {
      return executeDeny();
    }
    // Log that we saw it but could not act interactively.
    logDetected(incident, agent);
    return { outcome: "deferred", incident };
  }

  // ── 4. interactive prompt ───────────────────────────────────────────────────

  if (stats) stats.intercepted = (stats.intercepted ?? 0) + 1;
  logDetected(incident, agent);

  // Build source-specific preview lines and prepend them to any existing
  // contextNotes so the operator sees relevant context before deciding.
  // For command incidents this returns [] (buildDiffPreview handles them).
  const preview = buildIncidentPreview(incident);
  const promptContextNotes = [
    ...preview,
    ...(Array.isArray(contextNotes) ? contextNotes : []),
  ];

  const decision = await doPrompt({ command: displayCommand, level, reason, contextNotes: promptContextNotes });

  if (decision === "approve") {
    if (stats) stats.approved = (stats.approved ?? 0) + 1;
    logIncidentApproved(incident, agent);
    runtime.onResume?.();
    return { outcome: "approved", incident };
  }

  // deny or quit
  return executeDeny();
}
