/**
 * AgentGuard — filewatcher correlation enforcement tests
 *
 * Run with:
 *   node --test test/filewatcher-correlation.test.js
 *
 * The filewatcher is not easy to drive end-to-end without real FS events, so
 * these tests validate the enforcement behavior the filewatcher relies on by
 * driving handleIncident() with a "filewatch runtime" — the exact shape of
 * callbacks that startFileWatcher() provides.
 *
 * Filewatch-specific runtime contract:
 *   canPrompt  : process.stdout.isTTY ?? false  (no PTY, so often false in CI)
 *   onTerminate: logSessionEnd(agent) → process.exit(1)  (no child to kill)
 *   onResume   : handlingCorrelation = false      (just reset the guard flag)
 *   onRestore  : restoreSnapshot(stashRef) + console feedback
 *
 * This mirrors the approach in pty-correlation.test.js and lets us confirm
 * that the filewatcher runtime shape satisfies enforcement.js contracts.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleIncident } from "../src/enforcement.js";
import { setSink } from "../src/logger.js";

// Redirect audit-log writes to /dev/null for the duration of this file.
setSink(() => {});

// ─── Factories ────────────────────────────────────────────────────────────────

function makeIncident(overrides = {}) {
  return {
    source: "correlation",
    level: "CRITICAL",
    reason: "Mass file deletion detected",
    ruleId: "mass-delete",
    ...overrides,
  };
}

/**
 * Runtime that mirrors startFileWatcher()'s correlation runtime object.
 * Key differences from PTY runtime:
 *   - no pty.pause/resume calls
 *   - onTerminate calls process.exit(1), not resolve(1)
 *   - onResume just resets the handlingCorrelation guard flag
 */
function makeFilewatchRuntime(overrides = {}) {
  return {
    canPrompt: false,              // file watcher is often in a non-TTY context
    prompt: async () => "approve",
    onTerminate: () => {},         // would call logSessionEnd + process.exit(1) in prod
    onResume: () => {},            // would reset handlingCorrelation in prod
    onRestore: () => {},           // would call restoreSnapshot + print feedback
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  return {
    autoApprove: [],
    autoDeny: ["CRITICAL"],
    snapshot: { enabled: true, restoreOnDeny: true },
    ...overrides,
  };
}

// ─── CRITICAL — autoDeny default ──────────────────────────────────────────────

describe("CRITICAL correlation — autoDeny (filewatch runtime)", () => {
  it("returns outcome=denied", async () => {
    const result = await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makeFilewatchRuntime(),
    });
    assert.equal(result.outcome, "denied");
  });

  it("calls onTerminate", async () => {
    let terminated = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makeFilewatchRuntime({ onTerminate: () => { terminated = true; } }),
    });
    assert.equal(terminated, true);
  });

  it("does not prompt", async () => {
    let prompted = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makeFilewatchRuntime({
        prompt: async () => { prompted = true; return "deny"; },
      }),
    });
    assert.equal(prompted, false);
  });

  it("calls onRestore when stashRef is set", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, true);
  });

  it("calls onRestore before onTerminate", async () => {
    const order = [];
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        onRestore: () => { order.push("restore"); },
        onTerminate: () => { order.push("terminate"); },
      }),
    });
    assert.deepEqual(order, ["restore", "terminate"]);
  });

  it("does not call onRestore when stashRef is absent", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stashRef: undefined,
      runtime: makeFilewatchRuntime({
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, false);
  });

  it("does not call onRestore when restoreOnDeny is false", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig({ snapshot: { restoreOnDeny: false } }),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, false);
  });

  it("increments stats.blocked[CRITICAL]", async () => {
    const stats = { intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stats,
      runtime: makeFilewatchRuntime(),
    });
    assert.equal(stats.blocked["CRITICAL"], 1);
  });

  it("does not call onResume", async () => {
    let resumed = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makeFilewatchRuntime({ onResume: () => { resumed = true; } }),
    });
    assert.equal(resumed, false);
  });
});

// ─── CRITICAL — no TTY, autoDeny cleared ──────────────────────────────────────

describe("CRITICAL correlation — no TTY, autoDeny cleared (filewatch runtime)", () => {
  const cfg = () => makeConfig({ autoDeny: [] });

  it("auto-denies CRITICAL even when autoDeny is empty and canPrompt=false", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makeFilewatchRuntime({
        canPrompt: false,
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });

  it("calls onRestore for CRITICAL-no-TTY deny when stashRef is set", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        canPrompt: false,
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, true);
  });
});

// ─── Non-CRITICAL with no TTY — deferred ──────────────────────────────────────

describe("non-CRITICAL correlation — no TTY (filewatch runtime)", () => {
  const cfg = () => makeConfig({ autoDeny: [] });

  it("WARN with canPrompt=false → deferred (session continues)", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident({ level: "WARN", ruleId: "dependency-change-plus-network" }),
      config: cfg(),
      runtime: makeFilewatchRuntime({
        canPrompt: false,
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "deferred");
    assert.equal(terminated, false);
  });

  it("HIGH with canPrompt=false → deferred", async () => {
    const result = await handleIncident({
      incident: makeIncident({ level: "HIGH", ruleId: "env-overwrite" }),
      config: cfg(),
      runtime: makeFilewatchRuntime({ canPrompt: false }),
    });
    assert.equal(result.outcome, "deferred");
  });

  it("deferred does not call onRestore", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident({ level: "WARN", ruleId: "dependency-change-plus-network" }),
      config: cfg(),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        canPrompt: false,
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, false);
  });
});

// ─── Interactive prompt path (canPrompt=true, autoDeny cleared) ───────────────

describe("correlation — interactive prompt (filewatch runtime with TTY)", () => {
  const cfg = () => makeConfig({ autoDeny: [] });

  it("approve → outcome=approved, onResume called", async () => {
    let resumed = false;
    const result = await handleIncident({
      incident: makeIncident({ level: "HIGH", ruleId: "env-overwrite" }),
      config: cfg(),
      runtime: makeFilewatchRuntime({
        canPrompt: true,
        prompt: async () => "approve",
        onResume: () => { resumed = true; },
      }),
    });
    assert.equal(result.outcome, "approved");
    assert.equal(resumed, true);
  });

  it("approve → onTerminate not called", async () => {
    let terminated = false;
    await handleIncident({
      incident: makeIncident({ level: "HIGH", ruleId: "env-overwrite" }),
      config: cfg(),
      runtime: makeFilewatchRuntime({
        canPrompt: true,
        prompt: async () => "approve",
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(terminated, false);
  });

  it("deny → outcome=denied, onTerminate called", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident({ level: "HIGH", ruleId: "env-overwrite" }),
      config: cfg(),
      runtime: makeFilewatchRuntime({
        canPrompt: true,
        prompt: async () => "deny",
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });

  it("calls onRestore before onTerminate on interactive deny", async () => {
    const order = [];
    await handleIncident({
      incident: makeIncident({ level: "HIGH", ruleId: "env-overwrite" }),
      config: cfg(),
      stashRef: "stash@{0}",
      runtime: makeFilewatchRuntime({
        canPrompt: true,
        prompt: async () => "deny",
        onRestore: () => { order.push("restore"); },
        onTerminate: () => { order.push("terminate"); },
      }),
    });
    assert.deepEqual(order, ["restore", "terminate"]);
  });
});

// ─── autoApprove path ─────────────────────────────────────────────────────────

describe("correlation — autoApprove (filewatch runtime)", () => {
  it("WARN with autoApprove:['WARN'] → approved, onResume called", async () => {
    let resumed = false;
    const result = await handleIncident({
      incident: makeIncident({ level: "WARN", ruleId: "dependency-change-plus-network" }),
      config: makeConfig({ autoDeny: [], autoApprove: ["WARN"] }),
      runtime: makeFilewatchRuntime({
        onResume: () => { resumed = true; },
      }),
    });
    assert.equal(result.outcome, "approved");
    assert.equal(resumed, true);
  });

  it("autoApprove does not call onTerminate", async () => {
    let terminated = false;
    await handleIncident({
      incident: makeIncident({ level: "WARN", ruleId: "dependency-change-plus-network" }),
      config: makeConfig({ autoDeny: [], autoApprove: ["WARN"] }),
      runtime: makeFilewatchRuntime({
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(terminated, false);
  });
});
