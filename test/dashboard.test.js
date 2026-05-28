import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectOf,
  higherLevel,
  withinRange,
  groupByProject,
} from "../src/dashboard/server.js";

test("projectOf — leading path segment is the project", () => {
  assert.strictEqual(projectOf("beach-flag-dashboard/.env.local"), "beach-flag-dashboard");
  assert.strictEqual(projectOf("my-app/src/config.js"), "my-app");
  assert.strictEqual(projectOf("/leading/slash/file"), "leading");
  assert.strictEqual(projectOf(""), null);
  assert.strictEqual(projectOf(undefined), null);
});

test("higherLevel — picks the more severe level", () => {
  assert.strictEqual(higherLevel("WARN", "HIGH"), "HIGH");
  assert.strictEqual(higherLevel("CRITICAL", "HIGH"), "CRITICAL");
  assert.strictEqual(higherLevel(null, "WARN"), "WARN");
  assert.strictEqual(higherLevel("HIGH", null), "HIGH");
});

test("withinRange — today / 7d / 30d boundaries", () => {
  // Use offsets from `now` so the assertions are timezone-independent.
  const now = Date.parse("2026-05-28T12:00:00Z");
  const ago = (days) => new Date(now - days * 86400000).toISOString();
  assert.strictEqual(withinRange(new Date(now).toISOString(), "today", now), true);
  assert.strictEqual(withinRange(ago(2), "today", now), false);
  assert.strictEqual(withinRange(ago(3), "7d", now), true);
  assert.strictEqual(withinRange(ago(10), "7d", now), false);
  assert.strictEqual(withinRange(ago(10), "30d", now), true);
  assert.strictEqual(withinRange(ago(40), "30d", now), false);
  assert.strictEqual(withinRange(ago(2000), "all", now), true);
});

test("groupByProject — groups file sessions by leading segment", () => {
  const events = [
    { sessionId: "s1", event: "session_start", agent: "claude", ts: "2026-05-28T10:00:00Z" },
    { sessionId: "s1", event: "incident_detected", file: "proj-a/.env", level: "HIGH", ts: "2026-05-28T10:05:00Z" },
    { sessionId: "s1", event: "incident_denied", file: "proj-a/.env", level: "HIGH", ts: "2026-05-28T10:06:00Z" },
    { sessionId: "s1", event: "review_kept", file: "proj-a/config.js", level: "WARN", ts: "2026-05-28T11:23:00Z" },
  ];
  const groups = groupByProject(events, ["/home/me/proj-a"]);
  assert.strictEqual(groups.length, 1);
  const g = groups[0];
  assert.strictEqual(g.project, "proj-a");
  assert.strictEqual(g.fullPath, "/home/me/proj-a");
  assert.strictEqual(g.sessions.length, 1);
  const s = g.sessions[0];
  assert.strictEqual(s.maxLevel, "HIGH");
  // detected + review_kept counted; incident_denied excluded from sensitiveCount
  assert.strictEqual(s.sensitiveCount, 2);
  // per-project window spans the file events only (10:05 → 11:23 = 78m)
  assert.strictEqual(s.durationMs, 78 * 60 * 1000);
});

test("groupByProject — sessions without files land in (command-line), sorted last", () => {
  const events = [
    { sessionId: "f1", event: "review_kept", file: "proj-x/app.js", level: "WARN", ts: "2026-05-28T09:00:00Z" },
    { sessionId: "c1", event: "session_start", agent: "codex", ts: "2026-05-28T08:00:00Z" },
    { sessionId: "c1", event: "command_intercepted", command: "rm -rf /", level: "CRITICAL", ts: "2026-05-28T08:01:00Z" },
    { sessionId: "c1", event: "session_end", ts: "2026-05-28T08:02:00Z" },
  ];
  const groups = groupByProject(events, []);
  assert.strictEqual(groups.length, 2);
  assert.strictEqual(groups[groups.length - 1].project, "(command-line)");
  const cmd = groups.find((g) => g.project === "(command-line)");
  assert.strictEqual(cmd.fullPath, null);
  assert.strictEqual(cmd.sessions[0].maxLevel, "CRITICAL");
  assert.strictEqual(cmd.sessions[0].sensitiveCount, 1);
});
