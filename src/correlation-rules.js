/**
 * AgentGuard Correlation Rules
 *
 * Multi-event risk patterns: each rule fires when a *combination* of events
 * has occurred within a given time window, rather than on a single event alone.
 *
 * Each rule object:
 *   id          — unique slug used for lookup and logging
 *   description — human-readable summary shown in alerts
 *   level       — "WARN" | "HIGH" | "CRITICAL"
 *   windowMs    — how far back the rule looks (milliseconds)
 *   match(bus)  — function receiving an EventBus; returns true when the rule fires
 *
 * This module is intentionally pure: no side effects, no logging, no I/O.
 */

// ─── Internal helper ──────────────────────────────────────────────────────────

/**
 * Return an ISO timestamp exactly `ms` milliseconds in the past.
 * Used inside match() functions to compute the "since" boundary.
 *
 * @param {number} ms
 * @returns {string} ISO 8601 timestamp
 */
function sinceWindow(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// ─── Rules ────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} CorrelationRule
 * @property {string}   id          - Unique slug (e.g. "env-plus-network")
 * @property {string}   description - Human-readable summary
 * @property {"WARN"|"HIGH"|"CRITICAL"} level
 * @property {number}   windowMs    - Look-back window in milliseconds
 * @property {(bus: import("./event-bus.js").EventBus) => boolean} match
 */

/** @type {CorrelationRule[]} */
export const CORRELATION_RULES = [
  // ── CRITICAL ───────────────────────────────────────────────────────────────

  {
    id: "env-plus-network",
    description: "Secret file modified then network request — possible exfiltration",
    level: "CRITICAL",
    windowMs: 30_000,
    match(bus) {
      const since = sinceWindow(30_000);
      const secretWritten = bus.query({ type: "file_write", subtype: "secret", since }).length > 0;
      const networkSeen   = bus.query({ type: "process_exec", subtype: "network_request", since }).length > 0;
      return secretWritten && networkSeen;
    },
  },

  {
    id: "mass-delete",
    description: "Mass file deletion detected",
    level: "CRITICAL",
    windowMs: 20_000,
    match(bus) {
      const since = sinceWindow(20_000);
      return bus.query({ type: "file_delete", since }).length >= 3;
    },
  },

  {
    id: "force-push-after-delete",
    description: "Force git push following file deletion — history rewrite risk",
    level: "CRITICAL",
    windowMs: 60_000,
    match(bus) {
      const since = sinceWindow(60_000);
      const hasDelete    = bus.query({ type: "file_delete", since }).length > 0;
      const hasForcePush = bus
        .query({ type: "process_exec", subtype: "git_operation", since })
        .some((e) => /--force|-f\b/.test(e.command ?? ""));
      return hasDelete && hasForcePush;
    },
  },

  // ── HIGH ───────────────────────────────────────────────────────────────────

  {
    id: "env-overwrite",
    description: "Secret/credential file overwritten",
    level: "HIGH",
    windowMs: 10_000,
    match(bus) {
      const since = sinceWindow(10_000);
      return bus.query({ type: "file_write", subtype: "secret", since }).length > 0;
    },
  },

  {
    id: "shell-pipe-exec",
    description: "Pipe to shell detected — remote code execution risk",
    level: "HIGH",
    windowMs: 10_000,
    match(bus) {
      const since = sinceWindow(10_000);
      return bus.query({ type: "process_exec", subtype: "shell_exec", since }).length > 0;
    },
  },

  // ── WARN ───────────────────────────────────────────────────────────────────

  {
    id: "dependency-change-plus-network",
    description: "Dependency file changed alongside network activity",
    level: "WARN",
    windowMs: 60_000,
    match(bus) {
      const since = sinceWindow(60_000);
      const depChanged  = bus.query({ type: "file_write", subtype: "dependency", since }).length > 0;
      const networkSeen = bus.query({ type: "process_exec", subtype: "network_request", since }).length > 0;
      return depChanged && networkSeen;
    },
  },
];
