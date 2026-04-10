/**
 * AgentGuard — snapshot restore audit logging tests
 *
 * Run with:
 *   node --test test/snapshot-restore.test.js
 *
 * These tests verify that:
 *   - deny triggers onRestore when a stashRef is set
 *   - deny without a stashRef does not call onRestore (no crash)
 *   - logSnapshotRestore writes a snapshot_restore audit entry
 *   - restore success (restored: true) is logged correctly
 *   - restore failure (restored: false) is logged correctly
 *   - audit-only mode does not call onRestore
 *   - the summary stats do not include restore state (restore is logged, not counted)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleIncident } from "../src/enforcement.js";
import { logSnapshotRestore, setSink } from "../src/logger.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function captureLogs(fn) {
  const lines = [];
  setSink((line) => lines.push(JSON.parse(line)));
  try { return fn(lines); }
  finally { setSink(() => {}); }
}

function makeRuntime(overrides = {}) {
  return {
    canPrompt: false,
    onRestore: () => {},
    onTerminate: () => {},
    onResume: () => {},
    ...overrides,
  };
}

const criticalIncident = {
  source: "command",
  level: "CRITICAL",
  reason: "Force push",
  command: "git push --force",
};

const denyConfig = { autoDeny: ["CRITICAL"], autoApprove: [], auditOnly: false };
const auditConfig = { autoDeny: ["CRITICAL"], autoApprove: [], auditOnly: true };

// ─── onRestore is called on deny when stashRef is present ────────────────────

describe("snapshot restore — deny triggers onRestore", () => {
  it("calls onRestore when stashRef is set and incident is denied", async () => {
    let restored = false;
    await handleIncident({
      incident: criticalIncident,
      config: denyConfig,
      stashRef: "stash@{0}",
      runtime: makeRuntime({ onRestore: () => { restored = true; } }),
    });
    assert.equal(restored, true);
  });

  it("does not call onRestore when stashRef is absent", async () => {
    let restored = false;
    await handleIncident({
      incident: criticalIncident,
      config: denyConfig,
      stashRef: undefined,
      runtime: makeRuntime({ onRestore: () => { restored = true; } }),
    });
    assert.equal(restored, false);
  });

  it("does not call onRestore when restoreOnDeny is false in config", async () => {
    let restored = false;
    await handleIncident({
      incident: criticalIncident,
      config: { ...denyConfig, snapshot: { restoreOnDeny: false } },
      stashRef: "stash@{0}",
      runtime: makeRuntime({ onRestore: () => { restored = true; } }),
    });
    assert.equal(restored, false);
  });

  it("does not crash when no onRestore callback is provided", async () => {
    const { outcome } = await handleIncident({
      incident: criticalIncident,
      config: denyConfig,
      stashRef: "stash@{0}",
      runtime: { canPrompt: false, onTerminate: () => {}, onResume: () => {} },
    });
    assert.equal(outcome, "denied");
  });
});

// ─── audit-only does not restore ─────────────────────────────────────────────

describe("snapshot restore — audit-only mode skips restore", () => {
  it("does not call onRestore in audit-only mode", async () => {
    let restored = false;
    const result = await handleIncident({
      incident: criticalIncident,
      config: auditConfig,
      stashRef: "stash@{0}",
      runtime: makeRuntime({
        onRestore: () => { restored = true; },
        onTerminate: () => { throw new Error("onTerminate must not be called"); },
      }),
    });
    assert.equal(restored, false);
    assert.equal(result.outcome, "approved");
  });
});

// ─── logSnapshotRestore audit log output ─────────────────────────────────────

describe("logSnapshotRestore — audit log entries", () => {
  it("writes a snapshot_restore entry when restore succeeds", () => {
    const entries = [];
    setSink((line) => entries.push(JSON.parse(line)));
    try {
      logSnapshotRestore({ restored: true, message: "Snapshot restored from stash \"stash@{0}\"." }, "claude");
    } finally {
      setSink(() => {});
    }
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.event, "snapshot_restore");
    assert.equal(e.restored, true);
    assert.equal(e.agent, "claude");
    assert.ok(e.message.includes("restored"));
  });

  it("writes a snapshot_restore entry when restore fails", () => {
    const entries = [];
    setSink((line) => entries.push(JSON.parse(line)));
    try {
      logSnapshotRestore({ restored: false, message: "Not a git repository." }, "codex");
    } finally {
      setSink(() => {});
    }
    assert.equal(entries.length, 1);
    const e = entries[0];
    assert.equal(e.event, "snapshot_restore");
    assert.equal(e.restored, false);
    assert.equal(e.agent, "codex");
  });

  it("includes sessionId and ts fields", () => {
    let entry = null;
    setSink((line) => { entry = JSON.parse(line); });
    try {
      logSnapshotRestore({ restored: true, message: "ok" });
    } finally {
      setSink(() => {});
    }
    assert.ok(entry.sessionId, "should have sessionId");
    assert.ok(entry.ts, "should have ts");
  });

  it("works without an agent argument (no crash)", () => {
    setSink(() => {});
    try {
      assert.doesNotThrow(() =>
        logSnapshotRestore({ restored: false, message: "Not a git repository." })
      );
    } finally {
      setSink(() => {});
    }
  });
});

// ─── outcome and stats are unaffected by restore ─────────────────────────────

describe("snapshot restore — outcome and stats", () => {
  it("outcome is still denied after restore", async () => {
    const { outcome } = await handleIncident({
      incident: criticalIncident,
      config: denyConfig,
      stashRef: "stash@{0}",
      runtime: makeRuntime(),
    });
    assert.equal(outcome, "denied");
  });

  it("stats.blocked is incremented on deny regardless of restore", async () => {
    const stats = { intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: criticalIncident,
      config: denyConfig,
      stashRef: "stash@{0}",
      stats,
      runtime: makeRuntime(),
    });
    assert.equal(stats.blocked.CRITICAL, 1);
  });

  it("no stats.blocked increment when no stats object provided", async () => {
    await assert.doesNotReject(() =>
      handleIncident({
        incident: criticalIncident,
        config: denyConfig,
        stashRef: "stash@{0}",
        runtime: makeRuntime(),
      })
    );
  });
});

// ─── incident_denied log entry is written on deny ────────────────────────────

describe("snapshot restore — incident_denied log entry", () => {
  it("writes incident_denied entry when deny fires with stashRef", async () => {
    const entries = [];
    setSink((line) => entries.push(JSON.parse(line)));
    try {
      await handleIncident({
        incident: criticalIncident,
        config: denyConfig,
        stashRef: "stash@{0}",
        runtime: makeRuntime(),
      });
    } finally {
      setSink(() => {});
    }
    const denied = entries.find((e) => e.event === "incident_denied");
    assert.ok(denied, "should have written incident_denied");
    assert.equal(denied.level, "CRITICAL");
  });

  it("writes incident_denied when deny fires without stashRef", async () => {
    const entries = [];
    setSink((line) => entries.push(JSON.parse(line)));
    try {
      await handleIncident({
        incident: criticalIncident,
        config: denyConfig,
        runtime: makeRuntime(),
      });
    } finally {
      setSink(() => {});
    }
    const denied = entries.find((e) => e.event === "incident_denied");
    assert.ok(denied, "should have written incident_denied even without stashRef");
  });
});
