import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectOf,
  projectMetaOf,
  higherLevel,
  withinRange,
  groupByProject,
  sensitiveFileOf,
  topSensitiveFiles,
} from "../src/dashboard/server.js";

test("projectOf — leading path segment is the project", () => {
  assert.strictEqual(projectOf("beach-flag-dashboard/.env.local"), "beach-flag-dashboard");
  assert.strictEqual(projectOf("my-app/src/config.js"), "my-app");
  assert.strictEqual(projectOf("/leading/slash/file"), "leading");
  assert.strictEqual(projectOf(""), null);
  assert.strictEqual(projectOf(undefined), null);
});

test("projectMetaOf — prefers watchPath over file (TASK-009)", () => {
  // Explicit watchPath wins and supplies the full path via basename.
  assert.deepStrictEqual(
    projectMetaOf({ watchPath: "/home/me/mainstreetaiaudit", command: "modified: .env" }),
    { project: "mainstreetaiaudit", fullPath: "/home/me/mainstreetaiaudit" }
  );
  // Falls back to the leading file segment when no watchPath.
  assert.deepStrictEqual(
    projectMetaOf({ file: "proj-a/.env" }, { "proj-a": "/home/me/proj-a" }),
    { project: "proj-a", fullPath: "/home/me/proj-a" }
  );
  // No project context at all → null.
  assert.strictEqual(projectMetaOf({ command: "rm -rf /" }), null);
});

test("groupByProject — watchPath attributes file-less events to the right project (TASK-009)", () => {
  // Daemon-style sensitive-file events carry no `file`, only watchPath.
  const events = [
    { sessionId: "d1", event: "session_start", agent: "daemon", ts: "2026-05-28T10:00:00Z" },
    { sessionId: "d1", event: "command_intercepted", command: "modified: .env", level: "HIGH", watchPath: "/home/me/mainstreetaiaudit", ts: "2026-05-28T10:05:00Z" },
    { sessionId: "d1", event: "command_intercepted", command: "modified: package.json", level: "WARN", watchPath: "/home/me/mainstreetaiaudit", ts: "2026-05-28T10:09:00Z" },
  ];
  const groups = groupByProject(events, ["/home/me/mainstreetaiaudit"]);
  assert.strictEqual(groups.length, 1);
  const g = groups[0];
  assert.strictEqual(g.project, "mainstreetaiaudit");
  assert.strictEqual(g.fullPath, "/home/me/mainstreetaiaudit");
  assert.strictEqual(g.sessions.length, 1);
  assert.strictEqual(g.sessions[0].sensitiveCount, 2);
  assert.strictEqual(g.sessions[0].maxLevel, "HIGH");
});

test("sensitiveFileOf — parses path from command_intercepted only (TASK-010)", () => {
  assert.strictEqual(sensitiveFileOf({ event: "command_intercepted", command: "modified: .env.local" }), ".env.local");
  assert.strictEqual(sensitiveFileOf({ event: "command_intercepted", command: "created: src/keys.pem" }), "src/keys.pem");
  assert.strictEqual(sensitiveFileOf({ event: "command_intercepted", command: "deleted: a/b/c.key" }), "a/b/c.key");
  // Follow-up / unrelated events are not counted.
  assert.strictEqual(sensitiveFileOf({ event: "review_kept", file: ".env" }), null);
  assert.strictEqual(sensitiveFileOf({ event: "session_start" }), null);
  assert.strictEqual(sensitiveFileOf(null), null);
});

test("topSensitiveFiles — counts, ranks by frequency, respects range (TASK-010)", () => {
  const now = Date.parse("2026-05-28T12:00:00Z");
  const ago = (days) => new Date(now - days * 86400000).toISOString();
  const events = [
    { event: "command_intercepted", command: "modified: .env.local", level: "WARN", ts: ago(3) },
    { event: "command_intercepted", command: "modified: .env.local", level: "HIGH", ts: ago(2) },
    { event: "command_intercepted", command: "modified: .env.local", level: "WARN", ts: ago(1) },
    { event: "command_intercepted", command: "modified: package.json", level: "WARN", ts: ago(2) },
    { event: "command_intercepted", command: "modified: old.pem", level: "CRITICAL", ts: ago(20) }, // outside 7d
    { event: "session_start", ts: ago(1) },
  ];
  const top = topSensitiveFiles(events, "7d", now);
  assert.strictEqual(top.length, 2, "old.pem excluded by 7d range; session_start ignored");
  assert.strictEqual(top[0].file, ".env.local");
  assert.strictEqual(top[0].count, 3);
  assert.strictEqual(top[0].maxLevel, "HIGH");
  assert.strictEqual(top[0].lastSeen, ago(1));
  assert.strictEqual(top[1].file, "package.json");
  assert.strictEqual(top[1].count, 1);
});

test("topSensitiveFiles — caps the list at 10 (TASK-010)", () => {
  const events = [];
  for (let i = 0; i < 15; i++) {
    events.push({ event: "command_intercepted", command: `modified: f${i}.env`, level: "WARN", ts: "2026-05-28T10:00:00Z" });
  }
  assert.strictEqual(topSensitiveFiles(events, "all").length, 10);
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
