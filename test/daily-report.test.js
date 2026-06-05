import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { stripAnsi, msUntilHour, buildDailyReportMessage } from "../src/daily-report.js";

test("stripAnsi — removes ANSI SGR color codes", () => {
  const colored = "\x1b[36m\x1b[1mAgentGuard\x1b[22m\x1b[39m Report";
  assert.strictEqual(stripAnsi(colored), "AgentGuard Report");
  assert.strictEqual(stripAnsi("plain"), "plain");
});

test("msUntilHour — targets later today when the hour is still ahead", () => {
  const now = new Date(2026, 4, 29, 6, 0, 0, 0); // 06:00 local
  assert.strictEqual(msUntilHour(8, now), 2 * 60 * 60 * 1000); // 2h
});

test("msUntilHour — rolls to tomorrow when the hour already passed", () => {
  const now = new Date(2026, 4, 29, 9, 30, 0, 0); // 09:30 local
  // next 08:00 is tomorrow → 22h30m
  assert.strictEqual(msUntilHour(8, now), (22 * 60 + 30) * 60 * 1000);
});

test("msUntilHour — exactly on the hour rolls to tomorrow (always > 0)", () => {
  const now = new Date(2026, 4, 29, 8, 0, 0, 0); // 08:00 local exactly
  assert.strictEqual(msUntilHour(8, now), 24 * 60 * 60 * 1000);
});

test("buildDailyReportMessage — clean plain text from the audit log", () => {
  const dir = mkdtempSync(join(tmpdir(), "ag-daily-"));
  const logPath = join(dir, "audit.log");
  const now = new Date();
  const ts = now.toISOString();
  const lines = [
    { ts, sessionId: "s1", event: "session_start", agent: "daemon" },
    { ts, sessionId: "s1", event: "command_intercepted", command: "modified: .env", level: "HIGH", reason: "Sensitive file modified by agent", agent: "daemon" },
    { ts, sessionId: "s1", event: "session_end", agent: "daemon" },
  ].map((o) => JSON.stringify(o)).join("\n") + "\n";
  writeFileSync(logPath, lines);

  try {
    const msg = buildDailyReportMessage({ logPath, now });
    // No ANSI escape codes survive.
    assert.ok(!/\x1b\[/.test(msg), "message must not contain ANSI codes");
    // Recognisable report structure + the day's data.
    assert.ok(msg.includes("AgentGuard Report"), "has report header");
    assert.ok(msg.includes("Sensitive files touched:"), "has sensitive section");
    assert.ok(msg.includes(".env"), "lists the touched file");
    assert.ok(msg.includes("HIGH"), "shows the level");
    // trimEnd applied — no trailing blank line/newline.
    assert.strictEqual(msg, msg.trimEnd());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
