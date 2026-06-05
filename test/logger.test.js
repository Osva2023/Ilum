/**
 * AgentGuard — logger unit tests
 *
 * Run with:
 *   node --test test/logger.test.js
 *
 * Uses setSink() to capture log entries in memory — no filesystem assertions,
 * no ~/.agentguard writes during this test run.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  log,
  setSink,
  sessionId,
  logDetected,
  logIncidentApproved,
  logIncidentDenied,
  logIntercepted,
  logApproved,
  logDenied,
  logSessionStart,
  logSessionEnd,
} from "../src/logger.js";

// ─── Capture helper ───────────────────────────────────────────────────────────

/** Redirect writes to an in-memory array; returns the captured-lines array. */
function captureLines() {
  const lines = [];
  setSink((line) => lines.push(line));
  return lines;
}

/** Parse the last captured line as JSON. */
function lastEntry(lines) {
  return JSON.parse(lines.at(-1));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("log() — base helper", () => {
  it("writes a JSON-lines entry with ts and sessionId", () => {
    const lines = captureLines();
    log({ event: "test_event" });
    const entry = lastEntry(lines);
    assert.equal(typeof entry.ts, "string", "ts should be a string");
    assert.ok(entry.ts.endsWith("Z"), "ts should be ISO-8601");
    assert.equal(entry.sessionId, sessionId);
    assert.equal(entry.event, "test_event");
  });

  it("each line ends with a newline", () => {
    const lines = captureLines();
    log({ event: "x" });
    assert.ok(lines[0].endsWith("\n"));
  });

  it("does not throw when the sink throws", () => {
    setSink(() => { throw new Error("sink failure"); });
    // Should swallow the error — must not throw
    assert.doesNotThrow(() => log({ event: "boom" }));
  });
});

describe("logDetected()", () => {
  beforeEach(() => captureLines()); // reset sink before each

  it("writes event=incident_detected with source, level, reason, agent", () => {
    const lines = captureLines();
    const incident = { source: "command", level: "HIGH", reason: "rm -rf detected", command: "rm -rf /" };
    logDetected(incident, "codex");
    const entry = lastEntry(lines);
    assert.equal(entry.event, "incident_detected");
    assert.equal(entry.source, "command");
    assert.equal(entry.level, "HIGH");
    assert.equal(entry.reason, "rm -rf detected");
    assert.equal(entry.command, "rm -rf /");
    assert.equal(entry.agent, "codex");
    assert.equal(entry.ruleId, undefined, "ruleId should be absent when not in incident");
  });

  it("includes ruleId when present on incident", () => {
    const lines = captureLines();
    logDetected({ source: "correlation", level: "CRITICAL", reason: "pattern", ruleId: "RULE_001" }, "aider");
    const entry = lastEntry(lines);
    assert.equal(entry.ruleId, "RULE_001");
    assert.equal(entry.command, undefined, "command should be absent when not in incident");
  });

  it("includes watchPath when present on incident, omits it otherwise (TASK-009)", () => {
    const lines = captureLines();
    logDetected(
      { source: "correlation", level: "HIGH", reason: "mass delete", ruleId: "MASS_DEL", watchPath: "/home/me/proj-a" },
      "daemon"
    );
    assert.equal(lastEntry(lines).watchPath, "/home/me/proj-a");

    logDetected({ source: "command", level: "HIGH", reason: "rm", command: "rm -rf /" }, "codex");
    assert.equal(lastEntry(lines).watchPath, undefined, "watchPath absent when not on incident");
  });
});

describe("logIncidentApproved()", () => {
  it("writes event=incident_approved with correlation fields", () => {
    const lines = captureLines();
    logIncidentApproved(
      { source: "filewatch", level: "WARN", reason: "suspicious write", command: "echo x > /etc/hosts" },
      "claude"
    );
    const entry = lastEntry(lines);
    assert.equal(entry.event, "incident_approved");
    assert.equal(entry.source, "filewatch");
    assert.equal(entry.level, "WARN");
    assert.equal(entry.agent, "claude");
  });
});

describe("logIncidentDenied()", () => {
  it("writes event=incident_denied with correlation fields", () => {
    const lines = captureLines();
    logIncidentDenied(
      { source: "correlation", level: "CRITICAL", reason: "exfil pattern", ruleId: "EXFIL_01" },
      "codex"
    );
    const entry = lastEntry(lines);
    assert.equal(entry.event, "incident_denied");
    assert.equal(entry.ruleId, "EXFIL_01");
    assert.equal(entry.source, "correlation");
  });
});

// ─── Backward-compat: existing command helpers still work ─────────────────────

describe("legacy command helpers (backward compat)", () => {
  it("logIntercepted writes event=command_intercepted", () => {
    const lines = captureLines();
    logIntercepted({ command: "rm foo", level: "HIGH", reason: "rm", agent: "codex" });
    assert.equal(lastEntry(lines).event, "command_intercepted");
    assert.equal(lastEntry(lines).watchPath, undefined, "watchPath absent when not provided");
  });

  it("logIntercepted includes watchPath when provided (TASK-009)", () => {
    const lines = captureLines();
    logIntercepted({ command: "modified: .env", level: "HIGH", reason: "Sensitive file modified by agent", agent: "daemon", watchPath: "/home/me/proj-a" });
    assert.equal(lastEntry(lines).watchPath, "/home/me/proj-a");
  });

  it("logApproved writes event=command_approved", () => {
    const lines = captureLines();
    logApproved({ command: "rm foo", level: "HIGH", agent: "codex" });
    assert.equal(lastEntry(lines).event, "command_approved");
  });

  it("logDenied writes event=command_denied", () => {
    const lines = captureLines();
    logDenied({ command: "rm foo", level: "HIGH", agent: "codex" });
    assert.equal(lastEntry(lines).event, "command_denied");
  });

  it("logSessionStart writes event=session_start", () => {
    const lines = captureLines();
    logSessionStart("codex");
    assert.equal(lastEntry(lines).event, "session_start");
  });

  it("logSessionEnd writes event=session_end", () => {
    const lines = captureLines();
    logSessionEnd("codex");
    assert.equal(lastEntry(lines).event, "session_end");
  });
});
