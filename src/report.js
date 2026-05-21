/**
 * AgentGuard Daemon Report
 *
 * Reads the JSON-lines audit log and renders a human-readable summary of
 * what AI agents did over a recent time window.
 *
 * Usage:
 *   agentguard daemon report [--days=N]
 *   agentguard report        [--days=N]
 *
 * Default window is 1 day = "today" (events since local midnight).
 *
 * The module is split into pure helpers (parseAuditLog, filterByDays,
 * summarize, formatReport, parseDaysFlag) plus a thin orchestrator
 * (runReport) so the parser/formatter logic is unit-testable without
 * touching the filesystem.
 */

import fs from "fs";
import chalk from "chalk";
import { LOG_FILE } from "./logger.js";

// ─── parsing ─────────────────────────────────────────────────────────────────

/**
 * Parse JSON-lines audit log text into an array of entry objects.
 * Blank lines and malformed JSON are skipped silently — the audit log is a
 * best-effort record and a single corrupted line should not break the report.
 *
 * @param {string} text
 * @returns {Object[]}
 */
export function parseAuditLog(text) {
  if (!text) return [];
  const entries = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines.
    }
  }
  return entries;
}

// ─── time-window filter ──────────────────────────────────────────────────────

/**
 * Return the entries whose `ts` falls within the last `days` days.
 *
 * Cutoff = local midnight − (days − 1) calendar days.  So days=1 means
 * "since today's local midnight" and days=7 means "the last 7 calendar
 * days inclusive."  Entries at the boundary (ts === cutoff) are included.
 *
 * Entries missing a `ts` or with an unparseable timestamp are dropped.
 *
 * @param {Object[]} entries
 * @param {number}   days
 * @param {Date}     [now=new Date()]
 * @returns {Object[]}
 */
export function filterByDays(entries, days, now = new Date()) {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const cutoff = new Date(midnight);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  const cutoffMs = cutoff.getTime();
  return entries.filter((e) => {
    if (!e.ts) return false;
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) return false;
    return t >= cutoffMs;
  });
}

// ─── summarizer ──────────────────────────────────────────────────────────────

/**
 * Derive the report sections from a window-filtered array of entries.
 *
 * @param {Object[]} entries
 * @returns {{
 *   sessions:       { count: number, totalDurationMs: number, inProgress: number },
 *   sensitiveFiles: Array<{ file: string, level: string, event: string }>,
 *   incidents:      Array<{ reason: string, ruleId: string|undefined, level: string, count: number }>,
 *   actions:        { kept: number, rolledBack: number, deferredToTelegram: number }
 * }}
 */
export function summarize(entries) {
  // ── Sessions ────────────────────────────────────────────────────────────
  // Pair session_start with session_end by sessionId.  Sessions whose start
  // we see but whose end we don't are counted as "in progress" (either
  // really running, or crashed before logging an end — both are reported the
  // same way; the report is not the place to distinguish).
  const sessionStart = new Map();   // sessionId -> ts (ms)
  const sessionEnd = new Map();     // sessionId -> ts (ms)
  for (const e of entries) {
    const t = Date.parse(e.ts);
    if (Number.isNaN(t)) continue;
    if (e.event === "session_start") sessionStart.set(e.sessionId, t);
    else if (e.event === "session_end") sessionEnd.set(e.sessionId, t);
  }
  let totalDurationMs = 0;
  let inProgress = 0;
  for (const [id, startMs] of sessionStart) {
    const endMs = sessionEnd.get(id);
    if (endMs === undefined) inProgress++;
    else totalDurationMs += Math.max(0, endMs - startMs);
  }
  const sessions = {
    count: sessionStart.size,
    totalDurationMs,
    inProgress,
  };

  // ── Sensitive files ─────────────────────────────────────────────────────
  // command_intercepted entries with the canonical reason from the file
  // watcher carry "<event>: <path>" in the `command` field.  We de-dup by
  // path, keeping the first occurrence so the listing is stable.
  const sensitiveFiles = [];
  const seenFiles = new Set();
  for (const e of entries) {
    if (e.event !== "command_intercepted") continue;
    if (e.reason !== "Sensitive file modified by agent") continue;
    const m = /^(\w+):\s+(.+)$/.exec(e.command ?? "");
    if (!m) continue;
    const [, event, file] = m;
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    sensitiveFiles.push({ file, level: e.level ?? "WARN", event });
  }

  // ── Incidents (correlation + command source) ────────────────────────────
  // Grouped by (reason, level).  ruleId is preserved on the first sighting
  // of each group so we can show "(rule: <id>)" alongside the reason.
  const incidentMap = new Map();
  for (const e of entries) {
    if (e.event !== "incident_detected") continue;
    const key = `${e.level}\0${e.reason}`;
    const existing = incidentMap.get(key);
    if (existing) existing.count++;
    else incidentMap.set(key, {
      reason: e.reason ?? "(no reason)",
      ruleId: e.ruleId,
      level: e.level ?? "WARN",
      count: 1,
    });
  }
  const incidents = [...incidentMap.values()].sort(
    (a, b) => levelRank(b.level) - levelRank(a.level) || b.count - a.count,
  );

  // ── Actions ─────────────────────────────────────────────────────────────
  let kept = 0;
  let rolledBack = 0;
  let deferredToTelegram = 0;
  for (const e of entries) {
    if (e.event === "review_kept" || e.event === "telegram_keep") kept++;
    else if (e.event === "file_restore" && e.restored === true) rolledBack++;
    else if (e.event === "snapshot_restore" && e.restored === true) rolledBack++;
    else if (e.event === "incident_detected" && e.deferredTo === "telegram") deferredToTelegram++;
  }

  return {
    sessions,
    sensitiveFiles,
    incidents,
    actions: { kept, rolledBack, deferredToTelegram },
  };
}

function levelRank(level) {
  switch (level) {
    case "CRITICAL": return 3;
    case "HIGH":     return 2;
    case "WARN":     return 1;
    default:         return 0;
  }
}

// ─── formatting ──────────────────────────────────────────────────────────────

function levelColor(level) {
  switch (level) {
    case "CRITICAL": return chalk.red.bold;
    case "HIGH":     return chalk.red;
    case "WARN":     return chalk.yellow;
    default:         return chalk.gray;
  }
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Render the summary to a string suitable for stdout.
 *
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ date: Date, days: number, logPath: string }} ctx
 * @returns {string}
 */
export function formatReport(summary, { date, days, logPath }) {
  const lines = [];

  lines.push(chalk.cyan.bold(`AgentGuard Report — ${formatDate(date)}`));
  lines.push(chalk.gray(days === 1 ? "(today)" : `(last ${days} days)`));
  lines.push("");

  // Sessions
  const { count, totalDurationMs, inProgress } = summary.sessions;
  if (count === 0) {
    lines.push(chalk.bold("Sessions:") + "           (none)");
  } else {
    const parts = [`${count}`];
    if (totalDurationMs > 0) parts.push(`total duration ${formatDuration(totalDurationMs)}`);
    if (inProgress > 0) parts.push(`${inProgress} in progress`);
    lines.push(chalk.bold("Sessions:") + `           ${parts[0]}` +
      (parts.length > 1 ? chalk.gray(` (${parts.slice(1).join("; ")})`) : ""));
  }
  lines.push("");

  // Sensitive files
  lines.push(chalk.bold("Sensitive files touched:"));
  if (summary.sensitiveFiles.length === 0) {
    lines.push("  " + chalk.gray("(none)"));
  } else {
    for (const { file, level, event } of summary.sensitiveFiles) {
      const lv = levelColor(level)(level.padEnd(8));
      lines.push(`  ${lv}  ${file}  ${chalk.gray(`(${event})`)}`);
    }
  }
  lines.push("");

  // Incidents
  lines.push(chalk.bold("Incidents detected:"));
  if (summary.incidents.length === 0) {
    lines.push("  " + chalk.gray("(none)"));
  } else {
    for (const { reason, ruleId, level, count } of summary.incidents) {
      const lv = levelColor(level)(level.padEnd(8));
      const tail = ruleId ? chalk.gray(`  (rule: ${ruleId})`) : "";
      lines.push(`  ${lv}  ${reason}  ${chalk.gray(`×${count}`)}${tail}`);
    }
  }
  lines.push("");

  // Actions
  const { kept, rolledBack, deferredToTelegram } = summary.actions;
  lines.push(chalk.bold("Actions taken:"));
  lines.push(`  Kept                  ${kept}`);
  lines.push(`  Rolled back           ${rolledBack}`);
  lines.push(`  Deferred to Telegram  ${deferredToTelegram}`);
  lines.push("");

  lines.push(chalk.gray(`Full log: ${logPath}`));

  return lines.join("\n");
}

// ─── flag parsing ────────────────────────────────────────────────────────────

/**
 * Parse a `--days=N` or `--days N` flag from an argv-style array.
 * Returns the integer days (default 1).  Non-numeric values fall back to 1.
 *
 * @param {string[]} args
 * @returns {number}
 */
export function parseDaysFlag(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--days=")) {
      const n = parseInt(a.slice("--days=".length), 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
    if (a === "--days" && i + 1 < args.length) {
      const n = parseInt(args[i + 1], 10);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }
  }
  return 1;
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

function readAuditLog(logPath) {
  try {
    return fs.readFileSync(logPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

// ─── orchestrator ────────────────────────────────────────────────────────────

/**
 * Read the audit log, build the report, and write it to stdout.
 *
 * @param {Object} [opts]
 * @param {number}                [opts.days=1]
 * @param {string}                [opts.logPath=LOG_FILE]
 * @param {Date}                  [opts.now=new Date()]
 * @param {(s: string) => void}   [opts.out]   - Write sink, defaults to stdout
 */
export function runReport({
  days = 1,
  logPath = LOG_FILE,
  now = new Date(),
  out = (s) => process.stdout.write(s),
} = {}) {
  const text = readAuditLog(logPath);
  const entries = parseAuditLog(text);
  const filtered = filterByDays(entries, days, now);
  const summary = summarize(filtered);
  out(formatReport(summary, { date: now, days, logPath }) + "\n");
}
