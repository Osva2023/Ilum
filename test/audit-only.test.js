/**
 * AgentGuard — audit-only mode tests
 *
 * Run with:
 *   node --test test/audit-only.test.js
 *
 * Audit-only mode: config.auditOnly = true causes handleIncident() to log
 * every incident and resume the session without blocking, prompting,
 * restoring, or terminating.
 *
 * Tests cover:
 *   - command incidents (all levels)
 *   - correlation incidents
 *   - that onRestore and onTerminate are never called
 *   - that onResume is called (session continues)
 *   - that stats.intercepted is incremented
 *   - that the prompt is never invoked
 *   - that audit log entries are written (via setSink)
 *   - config.auditOnly propagation in loadConfig / mergeConfig
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { handleIncident } from "../src/enforcement.js";
import { setSink } from "../src/logger.js";
import { loadConfig, mergeConfig, DEFAULT_CONFIG } from "../src/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Capture log lines written during a test and restore original sink after. */
function captureLogs(fn) {
  const lines = [];
  setSink((line) => lines.push(line));
  try { return fn(lines); }
  finally { setSink(() => {}); }
}

function makeRuntime(overrides = {}) {
  return {
    canPrompt: true,
    prompt: async () => { throw new Error("prompt must not be called in audit-only mode"); },
    onRestore: () => { throw new Error("onRestore must not be called in audit-only mode"); },
    onTerminate: () => { throw new Error("onTerminate must not be called in audit-only mode"); },
    onResume: () => {},
    ...overrides,
  };
}

const auditConfig = { auditOnly: true, autoApprove: [], autoDeny: ["CRITICAL"] };
const normalConfig = { auditOnly: false, autoApprove: [], autoDeny: ["CRITICAL"] };

// ─── core behavior ────────────────────────────────────────────────────────────

describe("audit-only mode — core enforcement behavior", () => {
  it("returns outcome=approved for a command incident", async () => {
    const result = await handleIncident({
      incident: { source: "command", level: "HIGH", reason: "Dangerous command", command: "rm -rf tmp" },
      config: auditConfig,
      runtime: makeRuntime(),
    });
    assert.equal(result.outcome, "approved");
  });

  it("returns outcome=approved for CRITICAL command (no block)", async () => {
    const result = await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
      config: auditConfig,
      runtime: makeRuntime(),
    });
    assert.equal(result.outcome, "approved");
  });

  it("returns outcome=approved for WARN command", async () => {
    const result = await handleIncident({
      incident: { source: "command", level: "WARN", reason: "Minor risk", command: "npm audit" },
      config: auditConfig,
      runtime: makeRuntime(),
    });
    assert.equal(result.outcome, "approved");
  });

  it("returns outcome=approved for a correlation incident", async () => {
    const result = await handleIncident({
      incident: { source: "correlation", level: "CRITICAL", reason: "Mass delete", ruleId: "mass-delete" },
      config: auditConfig,
      runtime: makeRuntime(),
    });
    assert.equal(result.outcome, "approved");
  });

  it("returns outcome=approved for a filewatch incident", async () => {
    const result = await handleIncident({
      incident: { source: "filewatch", level: "HIGH", reason: "Sensitive file modified", command: "modified: .env" },
      config: auditConfig,
      runtime: makeRuntime(),
    });
    assert.equal(result.outcome, "approved");
  });
});

// ─── callbacks not called ─────────────────────────────────────────────────────

describe("audit-only mode — blocked callbacks", () => {
  it("does not call onTerminate for CRITICAL (default autoDeny)", async () => {
    let terminated = false;
    await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
      config: auditConfig,
      runtime: makeRuntime({ onTerminate: () => { terminated = true; } }),
    });
    assert.equal(terminated, false);
  });

  it("does not call onTerminate for HIGH", async () => {
    let terminated = false;
    await handleIncident({
      incident: { source: "command", level: "HIGH", reason: "Risky op", command: "rm -rf /" },
      config: auditConfig,
      runtime: makeRuntime({ onTerminate: () => { terminated = true; } }),
    });
    assert.equal(terminated, false);
  });

  it("does not call onRestore even when stashRef is set", async () => {
    let restored = false;
    await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
      config: auditConfig,
      stashRef: "stash@{0}",
      runtime: makeRuntime({ onRestore: () => { restored = true; } }),
    });
    assert.equal(restored, false);
  });

  it("does not call the prompt function", async () => {
    let prompted = false;
    await handleIncident({
      incident: { source: "command", level: "HIGH", reason: "Risky", command: "rm -rf tmp" },
      config: auditConfig,
      runtime: makeRuntime({ prompt: async () => { prompted = true; return "deny"; } }),
    });
    assert.equal(prompted, false);
  });
});

// ─── onResume called ──────────────────────────────────────────────────────────

describe("audit-only mode — session continues via onResume", () => {
  it("calls onResume so the session continues unimpeded", async () => {
    let resumed = false;
    await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
      config: auditConfig,
      runtime: makeRuntime({ onResume: () => { resumed = true; } }),
    });
    assert.equal(resumed, true);
  });

  it("calls onResume for correlation incidents", async () => {
    let resumed = false;
    await handleIncident({
      incident: { source: "correlation", level: "CRITICAL", ruleId: "env-plus-network", reason: "Exfil" },
      config: auditConfig,
      runtime: makeRuntime({ onResume: () => { resumed = true; } }),
    });
    assert.equal(resumed, true);
  });

  it("calls onResume for WARN incidents", async () => {
    let resumed = false;
    await handleIncident({
      incident: { source: "command", level: "WARN", reason: "Minor", command: "npm audit" },
      config: auditConfig,
      runtime: makeRuntime({ onResume: () => { resumed = true; } }),
    });
    assert.equal(resumed, true);
  });
});

// ─── stats ────────────────────────────────────────────────────────────────────

describe("audit-only mode — stats tracking", () => {
  it("increments stats.intercepted per observed incident", async () => {
    const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: { source: "command", level: "HIGH", reason: "R", command: "rm -rf tmp" },
      config: auditConfig,
      stats,
      runtime: makeRuntime(),
    });
    assert.equal(stats.intercepted, 1);
  });

  it("increments stats.intercepted for each incident independently", async () => {
    const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
    const opts = {
      config: auditConfig,
      stats,
      runtime: makeRuntime(),
    };
    await handleIncident({ ...opts, incident: { source: "command", level: "CRITICAL", reason: "R1", command: "a" } });
    await handleIncident({ ...opts, incident: { source: "command", level: "HIGH", reason: "R2", command: "b" } });
    await handleIncident({ ...opts, incident: { source: "correlation", level: "WARN", reason: "R3", ruleId: "x" } });
    assert.equal(stats.intercepted, 3);
  });

  it("does not increment stats.blocked in audit-only mode", async () => {
    const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "R", command: "git push --force" },
      config: auditConfig,
      stats,
      runtime: makeRuntime(),
    });
    assert.equal(Object.values(stats.blocked).reduce((a, b) => a + b, 0), 0);
  });

  it("does not increment stats.approved in audit-only mode", async () => {
    const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: { source: "command", level: "HIGH", reason: "R", command: "rm -rf tmp" },
      config: auditConfig,
      stats,
      runtime: makeRuntime(),
    });
    assert.equal(stats.approved, 0);
  });

  it("works without a stats object (no crash)", async () => {
    await assert.doesNotReject(() =>
      handleIncident({
        incident: { source: "command", level: "HIGH", reason: "R", command: "rm -rf tmp" },
        config: auditConfig,
        runtime: makeRuntime(),
      })
    );
  });
});

// ─── audit log ────────────────────────────────────────────────────────────────

describe("audit-only mode — audit log entries", () => {
  it("writes an incident_detected log entry", async () => {
    let logged = null;
    setSink((line) => { logged = line; });
    try {
      await handleIncident({
        incident: { source: "command", level: "HIGH", reason: "Dangerous rm", command: "rm -rf tmp" },
        config: auditConfig,
        runtime: makeRuntime(),
      });
    } finally {
      setSink(() => {});
    }
    assert.ok(logged, "should have written a log line");
    const entry = JSON.parse(logged);
    assert.equal(entry.event, "incident_detected");
    assert.equal(entry.level, "HIGH");
    assert.equal(entry.source, "command");
  });

  it("does not write incident_denied or incident_approved entries", async () => {
    const entries = [];
    setSink((line) => { entries.push(JSON.parse(line)); });
    try {
      await handleIncident({
        incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
        config: auditConfig,
        runtime: makeRuntime(),
      });
    } finally {
      setSink(() => {});
    }
    assert.ok(!entries.some((e) => e.event === "incident_denied"), "should not log incident_denied");
    assert.ok(!entries.some((e) => e.event === "incident_approved"), "should not log incident_approved");
  });

  it("writes incident_detected for correlation incidents", async () => {
    let entry = null;
    setSink((line) => { entry = JSON.parse(line); });
    try {
      await handleIncident({
        incident: { source: "correlation", level: "CRITICAL", reason: "Mass delete", ruleId: "mass-delete" },
        config: auditConfig,
        runtime: makeRuntime(),
      });
    } finally {
      setSink(() => {});
    }
    assert.equal(entry?.event, "incident_detected");
    assert.equal(entry?.source, "correlation");
    assert.equal(entry?.ruleId, "mass-delete");
  });
});

// ─── full enforcement still works when auditOnly is false ────────────────────

describe("audit-only mode — enforcement is unaffected when auditOnly is false", () => {
  it("CRITICAL with auditOnly=false is still blocked", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: { source: "command", level: "CRITICAL", reason: "Force push", command: "git push --force" },
      config: normalConfig,
      runtime: { canPrompt: true, onTerminate: () => { terminated = true; }, onRestore: () => {}, onResume: () => {} },
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });
});

// ─── config loading ───────────────────────────────────────────────────────────

describe("audit-only config — loadConfig and mergeConfig", () => {
  function makeTmp() {
    const dir = join(tmpdir(), `ag-audit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("DEFAULT_CONFIG has auditOnly: false", () => {
    assert.equal(DEFAULT_CONFIG.auditOnly, false);
  });

  it("loadConfig defaults to auditOnly: false when not in file", () => {
    const cfg = loadConfig("/nonexistent/dir");
    assert.equal(cfg.auditOnly, false);
  });

  it("loadConfig reads auditOnly: true from config file", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "agentguard.config.json"), JSON.stringify({ auditOnly: true }));
      const cfg = loadConfig(dir);
      assert.equal(cfg.auditOnly, true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("mergeConfig preserves auditOnly: true from overrides", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { auditOnly: true });
    assert.equal(cfg.auditOnly, true);
  });

  it("mergeConfig defaults to false when override omits auditOnly", () => {
    const cfg = mergeConfig(DEFAULT_CONFIG, { autoApprove: ["WARN"] });
    assert.equal(cfg.auditOnly, false);
  });

  it("auditOnly: true can coexist with a policy pack", () => {
    const dir = makeTmp();
    try {
      writeFileSync(join(dir, "agentguard.config.json"), JSON.stringify({ policy: "ci", auditOnly: true }));
      const cfg = loadConfig(dir);
      assert.equal(cfg.auditOnly, true);
      // ci pack's autoDeny is still present (for if auditOnly is toggled off)
      assert.ok(cfg.autoDeny.includes("WARN"));
    } finally { rmSync(dir, { recursive: true }); }
  });
});
