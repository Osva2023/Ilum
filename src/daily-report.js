/**
 * AgentGuard daily-report helpers  (TASK-013)
 *
 * Pure, side-effect-free building blocks for the daemon's scheduled daily
 * Telegram report.  Kept out of bin/agentguard-daemon.js so the timing math
 * and the message rendering can be unit-tested without the daemon's start-up
 * side effects (config load, pid file, chokidar watchers).
 *
 * The daemon owns the scheduling wiring (setTimeout/setInterval) and the
 * Telegram send; this module only computes "when" and "what".
 */

import { runReport } from "./report.js";

// Matches ANSI SGR sequences (the chalk colors runReport emits).
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip ANSI color escape codes so the report reads cleanly in Telegram. */
export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, "");
}

/**
 * Milliseconds from `now` until the next local-time occurrence of `hour`:00:00.
 * If that hour has already passed today — or is exactly now — the next
 * occurrence is tomorrow, so the return value is always > 0.
 *
 * @param {number} hour            Target hour, 0–23 (local time).
 * @param {Date}   [now=new Date()]
 * @returns {number}               Milliseconds until the next occurrence.
 */
export function msUntilHour(hour, now = new Date()) {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

/**
 * Render the day's report as a clean, plain-text string (no chalk colors),
 * suitable for a Telegram message.  Always uses days=1 ("today").
 *
 * @param {object} [opts]  Forwarded to runReport — useful for tests:
 * @param {string}   [opts.logPath]  Override the audit-log path.
 * @param {Date}     [opts.now]      Override "now" for deterministic output.
 * @returns {string}
 */
export function buildDailyReportMessage(opts = {}) {
  let buf = "";
  // days is forced to 1 last so callers can't accidentally widen the window.
  runReport({ ...opts, days: 1, out: (s) => { buf += s; } });
  return stripAnsi(buf).trimEnd();
}
