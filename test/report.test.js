/**
 * AgentGuard — report.js tests
 *
 * Run with:
 *   node --test test/report.test.js
 *
 * The pure helpers (parseAuditLog, filterByDays, summarize, formatReport,
 * parseDaysFlag) are exercised with in-memory fixtures so no filesystem or
 * timezone setup is required.  runReport itself is a thin orchestrator; we
 * cover it via the helpers it composes.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseAuditLog,
  filterByDays,
  summarize,
  formatReport,
  parseDaysFlag,
} from "../src/report.js";

// ─── parseAuditLog ───────────────────────────────────────────────────────────

describe("parseAuditLog", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(parseAuditLog(""), []);
    assert.deepEqual(parseAuditLog(null), []);
    assert.deepEqual(parseAuditLog(undefined), []);
  });

  it("parses JSON-lines", () => {
    const text = `{"event":"a"}\n{"event":"b"}\n`;
    assert.deepEqual(parseAuditLog(text), [{ event: "a" }, { event: "b" }]);
  });

  it("skips blank lines", () => {
    const text = `{"event":"a"}\n\n  \n{"event":"b"}\n`;
    assert.deepEqual(parseAuditLog(text), [{ event: "a" }, { event: "b" }]);
  });

  it("skips malformed lines silently", () => {
    const text = `{"event":"a"}\nnot json\n{"event":"b"}\n`;
    assert.deepEqual(parseAuditLog(text), [{ event: "a" }, { event: "b" }]);
  });

  it("handles a trailing line without a final newline", () => {
    assert.deepEqual(parseAuditLog(`{"event":"a"}`), [{ event: "a" }]);
  });
});

// ─── filterByDays ────────────────────────────────────────────────────────────

describe("filterByDays", () => {
  // Anchor "now" at a fixed local time so cutoff math is deterministic.
  const now = new Date(2026, 4, 20, 14, 30, 0); // 2026-05-20 14:30 local
  // Local midnight today for assertion below.
  const todayMidnight = new Date(2026, 4, 20, 0, 0, 0);

  it("includes entries from today when days=1", () => {
    const entries = [
      { ts: new Date(2026, 4, 20, 9, 0, 0).toISOString(), event: "x" },
    ];
    assert.equal(filterByDays(entries, 1, now).length, 1);
  });

  it("excludes entries from yesterday when days=1", () => {
    const entries = [
      { ts: new Date(2026, 4, 19, 23, 59, 59).toISOString(), event: "x" },
    ];
    assert.equal(filterByDays(entries, 1, now).length, 0);
  });

  it("includes the boundary (ts === local midnight today) when days=1", () => {
    const entries = [
      { ts: todayMidnight.toISOString(), event: "x" },
    ];
    assert.equal(filterByDays(entries, 1, now).length, 1);
  });

  it("includes the last 7 calendar days when days=7", () => {
    const entries = [
      { ts: new Date(2026, 4, 14, 0, 0, 0).toISOString(), event: "in" },   // 6 days ago, midnight → in
      { ts: new Date(2026, 4, 13, 23, 59, 0).toISOString(), event: "out" }, // 7 days ago, late → out
      { ts: now.toISOString(),                              event: "in2" },
    ];
    const out = filterByDays(entries, 7, now);
    const events = out.map((e) => e.event).sort();
    assert.deepEqual(events, ["in", "in2"]);
  });

  it("drops entries with no ts", () => {
    const entries = [{ event: "x" }];
    assert.equal(filterByDays(entries, 1, now).length, 0);
  });

  it("drops entries with unparseable ts", () => {
    const entries = [{ ts: "not a date", event: "x" }];
    assert.equal(filterByDays(entries, 1, now).length, 0);
  });
});

// ─── summarize ───────────────────────────────────────────────────────────────

describe("summarize — sessions", () => {
  it("pairs session_start/end by sessionId and sums durations", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", sessionId: "a", event: "session_start" },
      { ts: "2026-05-20T10:00:05Z", sessionId: "a", event: "session_end" },
      { ts: "2026-05-20T10:10:00Z", sessionId: "b", event: "session_start" },
      { ts: "2026-05-20T10:10:10Z", sessionId: "b", event: "session_end" },
    ];
    const s = summarize(entries);
    assert.equal(s.sessions.count, 2);
    assert.equal(s.sessions.totalDurationMs, 15_000);
    assert.equal(s.sessions.inProgress, 0);
  });

  it("flags sessions with no session_end as in progress", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", sessionId: "a", event: "session_start" },
      { ts: "2026-05-20T10:00:05Z", sessionId: "a", event: "session_end" },
      { ts: "2026-05-20T10:10:00Z", sessionId: "b", event: "session_start" },
    ];
    const s = summarize(entries);
    assert.equal(s.sessions.count, 2);
    assert.equal(s.sessions.inProgress, 1);
    assert.equal(s.sessions.totalDurationMs, 5_000);
  });

  it("counts zero sessions when none present", () => {
    const s = summarize([]);
    assert.equal(s.sessions.count, 0);
    assert.equal(s.sessions.totalDurationMs, 0);
    assert.equal(s.sessions.inProgress, 0);
  });
});

describe("summarize — sensitive files", () => {
  it("extracts file + event + level from command_intercepted entries", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z",
        event: "command_intercepted",
        command: "modified: .env",
        level: "HIGH",
        reason: "Sensitive file modified by agent",
      },
    ];
    const s = summarize(entries);
    assert.deepEqual(s.sensitiveFiles, [
      { file: ".env", level: "HIGH", event: "modified" },
    ]);
  });

  it("de-dups by file path, keeping the first occurrence", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z",
        event: "command_intercepted",
        command: "modified: .env",
        level: "HIGH",
        reason: "Sensitive file modified by agent",
      },
      {
        ts: "2026-05-20T10:00:30Z",
        event: "command_intercepted",
        command: "modified: .env",
        level: "HIGH",
        reason: "Sensitive file modified by agent",
      },
    ];
    const s = summarize(entries);
    assert.equal(s.sensitiveFiles.length, 1);
  });

  it("ignores command_intercepted entries with a different reason", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z",
        event: "command_intercepted",
        command: "rm -rf /",
        level: "CRITICAL",
        reason: "Recursive delete from root",
      },
    ];
    assert.equal(summarize(entries).sensitiveFiles.length, 0);
  });
});

describe("summarize — incidents", () => {
  it("groups by (reason, level) and sums counts", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z", event: "incident_detected",
        source: "correlation", level: "CRITICAL",
        reason: "Mass file deletion detected", ruleId: "mass-delete",
      },
      {
        ts: "2026-05-20T10:00:05Z", event: "incident_detected",
        source: "correlation", level: "CRITICAL",
        reason: "Mass file deletion detected", ruleId: "mass-delete",
      },
      {
        ts: "2026-05-20T10:01:00Z", event: "incident_detected",
        source: "correlation", level: "HIGH",
        reason: ".env overwritten after network access", ruleId: "env-overwrite",
      },
    ];
    const s = summarize(entries);
    assert.equal(s.incidents.length, 2);
    // Sorted by level desc, then count desc — CRITICAL first.
    assert.equal(s.incidents[0].level, "CRITICAL");
    assert.equal(s.incidents[0].count, 2);
    assert.equal(s.incidents[0].ruleId, "mass-delete");
    assert.equal(s.incidents[1].level, "HIGH");
    assert.equal(s.incidents[1].count, 1);
  });

  it("treats same reason at different levels as separate groups", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", event: "incident_detected", reason: "X", level: "WARN" },
      { ts: "2026-05-20T10:00:01Z", event: "incident_detected", reason: "X", level: "HIGH" },
    ];
    const s = summarize(entries);
    assert.equal(s.incidents.length, 2);
  });
});

describe("summarize — actions", () => {
  it("counts kept = review_kept + telegram_keep", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", event: "review_kept", file: ".env" },
      { ts: "2026-05-20T10:00:01Z", event: "telegram_keep", file: ".env" },
      { ts: "2026-05-20T10:00:02Z", event: "telegram_keep", file: "CLAUDE.md" },
    ];
    assert.equal(summarize(entries).actions.kept, 3);
  });

  it("counts rolledBack = file_restore + snapshot_restore where restored=true", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", event: "file_restore", restored: true,  file: ".env" },
      { ts: "2026-05-20T10:00:01Z", event: "file_restore", restored: false, file: ".env" }, // failure — not counted
      { ts: "2026-05-20T10:00:02Z", event: "snapshot_restore", restored: true },
      { ts: "2026-05-20T10:00:03Z", event: "snapshot_restore", restored: false },           // failure — not counted
    ];
    assert.equal(summarize(entries).actions.rolledBack, 2);
  });

  it("counts deferredToTelegram = incident_detected with deferredTo:'telegram'", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z", event: "incident_detected",
        source: "correlation", level: "HIGH", reason: "x", ruleId: "r",
        deferredTo: "telegram",
      },
      {
        ts: "2026-05-20T10:00:01Z", event: "incident_detected",
        source: "correlation", level: "HIGH", reason: "x", ruleId: "r",
      },
    ];
    assert.equal(summarize(entries).actions.deferredToTelegram, 1);
  });

  it("returns zeros when no action events present", () => {
    const s = summarize([{ ts: "2026-05-20T10:00:00Z", event: "session_start", sessionId: "a" }]);
    assert.deepEqual(s.actions, { kept: 0, rolledBack: 0, deferredToTelegram: 0 });
  });
});

// ─── formatReport ────────────────────────────────────────────────────────────

describe("formatReport", () => {
  // Strip ANSI escapes so we can assert on plain content.
  // eslint-disable-next-line no-control-regex
  const stripAnsi = (s) => s.replace(/\x1B\[[0-9;]*m/g, "");

  const ctx = {
    date: new Date(2026, 4, 20, 12, 0, 0),
    days: 1,
    logPath: "/tmp/audit.log",
  };

  it("renders the header with today's date", () => {
    const out = stripAnsi(formatReport(summarize([]), ctx));
    assert.match(out, /AgentGuard Report — 2026-05-20/);
    assert.match(out, /\(today\)/);
  });

  it("renders '(last N days)' subtitle when days > 1", () => {
    const out = stripAnsi(formatReport(summarize([]), { ...ctx, days: 7 }));
    assert.match(out, /\(last 7 days\)/);
  });

  it("renders '(none)' for empty sections", () => {
    const out = stripAnsi(formatReport(summarize([]), ctx));
    assert.match(out, /Sessions:\s+\(none\)/);
    assert.match(out, /Sensitive files touched:[\s\S]*?\(none\)/);
    assert.match(out, /Incidents detected:[\s\S]*?\(none\)/);
  });

  it("includes the log path in the footer", () => {
    const out = stripAnsi(formatReport(summarize([]), ctx));
    assert.match(out, /Full log: \/tmp\/audit\.log/);
  });

  it("renders sensitive files and incidents when present", () => {
    const entries = [
      {
        ts: "2026-05-20T10:00:00Z", event: "command_intercepted",
        command: "modified: .env", level: "HIGH",
        reason: "Sensitive file modified by agent",
      },
      {
        ts: "2026-05-20T10:01:00Z", event: "incident_detected",
        source: "correlation", level: "CRITICAL",
        reason: "Mass file deletion detected", ruleId: "mass-delete",
      },
    ];
    const out = stripAnsi(formatReport(summarize(entries), ctx));
    assert.match(out, /HIGH\s+\.env\s+\(modified\)/);
    assert.match(out, /CRITICAL\s+Mass file deletion detected\s+×1\s+\(rule: mass-delete\)/);
  });

  it("renders action counts", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", event: "review_kept", file: ".env" },
      { ts: "2026-05-20T10:00:01Z", event: "file_restore", restored: true, file: ".env" },
    ];
    const out = stripAnsi(formatReport(summarize(entries), ctx));
    assert.match(out, /Kept\s+1/);
    assert.match(out, /Rolled back\s+1/);
    assert.match(out, /Deferred to Telegram\s+0/);
  });

  it("includes session duration in the subtitle when present", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", sessionId: "a", event: "session_start" },
      { ts: "2026-05-20T10:01:05Z", sessionId: "a", event: "session_end" },
    ];
    const out = stripAnsi(formatReport(summarize(entries), ctx));
    assert.match(out, /Sessions:\s+1\s+\(total duration 1m 05s\)/);
  });

  it("notes in-progress sessions", () => {
    const entries = [
      { ts: "2026-05-20T10:00:00Z", sessionId: "a", event: "session_start" },
    ];
    const out = stripAnsi(formatReport(summarize(entries), ctx));
    assert.match(out, /1 in progress/);
  });
});

// ─── parseDaysFlag ───────────────────────────────────────────────────────────

describe("parseDaysFlag", () => {
  it("defaults to 1 when no flag is given", () => {
    assert.equal(parseDaysFlag([]), 1);
    assert.equal(parseDaysFlag(["--other"]), 1);
  });

  it("parses --days=N form", () => {
    assert.equal(parseDaysFlag(["--days=7"]), 7);
  });

  it("parses --days N form", () => {
    assert.equal(parseDaysFlag(["--days", "14"]), 14);
  });

  it("falls back to 1 for non-numeric values", () => {
    assert.equal(parseDaysFlag(["--days=abc"]), 1);
    assert.equal(parseDaysFlag(["--days", "abc"]), 1);
  });

  it("falls back to 1 for non-positive values", () => {
    assert.equal(parseDaysFlag(["--days=0"]), 1);
    assert.equal(parseDaysFlag(["--days=-3"]), 1);
  });

  it("ignores --days at the end of argv with no value", () => {
    assert.equal(parseDaysFlag(["--days"]), 1);
  });
});
