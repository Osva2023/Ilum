/**
 * AgentGuard — PTY correlation enforcement tests
 *
 * Run with:
 *   node --test test/pty-correlation.test.js
 *
 * These tests validate the enforcement behavior that runPtyInterceptor relies
 * on for correlation-fired incidents.  node-pty is NOT required — we drive
 * handleIncident() directly with runtime stubs that mirror the exact shape
 * the PTY interceptor provides to it.
 *
 * PTY-specific runtime contract:
 *   canPrompt  : process.stdin.isTTY !== false  (truthy in real terminal)
 *   onTerminate: cleanup() → logSessionEnd → pty.kill() → resolve(1)
 *   onResume   : pty.resume() → enableForwarding() → handlingApproval=false
 *   onRestore  : restoreSnapshot() with console feedback
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleIncident } from "../src/enforcement.js";
import { setSink } from "../src/logger.js";

// Redirect audit-log writes to /dev/null for the duration of this test file.
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

/** Runtime that mirrors runPtyInterceptor's correlation runtime object. */
function makePtyRuntime(overrides = {}) {
  return {
    canPrompt: true,              // PTY mode assumes a real terminal
    prompt: async () => "approve",
    onTerminate: () => {},        // would call pty.kill() + resolve(1) in prod
    onResume: () => {},           // would call pty.resume() + enableForwarding
    onRestore: () => {},          // would call restoreSnapshot + print feedback
    ...overrides,
  };
}

/** Config that reflects the production default (autoDeny: ["CRITICAL"]). */
function makeConfig(overrides = {}) {
  return {
    autoApprove: [],
    autoDeny: ["CRITICAL"],
    snapshot: { enabled: true, restoreOnDeny: true },
    ...overrides,
  };
}

// ─── CRITICAL — default config (autoDeny includes CRITICAL) ───────────────────

describe("CRITICAL correlation — autoDeny default", () => {
  it("returns outcome=denied", async () => {
    const result = await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makePtyRuntime({ onTerminate: () => {} }),
    });
    assert.equal(result.outcome, "denied");
  });

  it("calls onTerminate (PTY kill + resolve signal)", async () => {
    let terminated = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makePtyRuntime({ onTerminate: () => { terminated = true; } }),
    });
    assert.equal(terminated, true);
  });

  it("does not call the prompt function", async () => {
    let prompted = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makePtyRuntime({
        onTerminate: () => {},
        prompt: async () => { prompted = true; return "deny"; },
      }),
    });
    assert.equal(prompted, false);
  });

  it("calls onRestore when stashRef is set (autoDeny path now restores)", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stashRef: "stash@{0}",
      runtime: makePtyRuntime({
        onTerminate: () => {},
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, true);
  });

  it("calls onRestore before onTerminate on autoDeny", async () => {
    const order = [];
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stashRef: "stash@{0}",
      runtime: makePtyRuntime({
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
      runtime: makePtyRuntime({
        onTerminate: () => {},
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, false);
  });

  it("does not call onRestore when restoreOnDeny is false", async () => {
    let restored = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig({ snapshot: { enabled: true, restoreOnDeny: false } }),
      stashRef: "stash@{0}",
      runtime: makePtyRuntime({
        onTerminate: () => {},
        onRestore: () => { restored = true; },
      }),
    });
    assert.equal(restored, false);
  });

  it("increments stats.blocked[CRITICAL]", async () => {
    const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      stats,
      runtime: makePtyRuntime({ onTerminate: () => {} }),
    });
    assert.equal(stats.blocked["CRITICAL"], 1);
  });

  it("does not call onResume on deny", async () => {
    let resumed = false;
    await handleIncident({
      incident: makeIncident(),
      config: makeConfig(),
      runtime: makePtyRuntime({
        onTerminate: () => {},
        onResume: () => { resumed = true; },
      }),
    });
    assert.equal(resumed, false);
  });
});

// ─── CRITICAL — interactive prompt path (autoDeny cleared) ───────────────────

describe("CRITICAL correlation — interactive prompt (autoDeny: [])", () => {
  const cfg = () => makeConfig({ autoDeny: [] });

  it("shows the prompt when not auto-denied", async () => {
    let prompted = false;
    await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({ prompt: async () => { prompted = true; return "approve"; } }),
    });
    assert.equal(prompted, true);
  });

  it("approve → outcome=approved, onResume called (PTY resume + forwarding)", async () => {
    let resumed = false;
    const result = await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({
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
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({
        prompt: async () => "approve",
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(terminated, false);
  });

  it("deny → outcome=denied, onTerminate called", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({
        prompt: async () => "deny",
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });

  it("calls onRestore before onTerminate on deny with stashRef", async () => {
    const order = [];
    await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      stashRef: "stash@{0}",
      runtime: makePtyRuntime({
        prompt: async () => "deny",
        onRestore: () => { order.push("restore"); },
        onTerminate: () => { order.push("terminate"); },
      }),
    });
    assert.deepEqual(order, ["restore", "terminate"]);
  });

  it("quit is treated as deny", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({
        prompt: async () => "quit",
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });

  it("passes ruleId as the display command to the prompt", async () => {
    let capturedArg = null;
    await handleIncident({
      incident: makeIncident({ ruleId: "env-plus-network" }),
      config: cfg(),
      runtime: makePtyRuntime({
        prompt: async (arg) => { capturedArg = arg; return "approve"; },
      }),
    });
    // ruleId is the fallback display command when no command field is present
    assert.equal(capturedArg.command, "env-plus-network");
    assert.equal(capturedArg.level, "CRITICAL");
  });
});

// ─── Non-CRITICAL levels ──────────────────────────────────────────────────────

describe("non-CRITICAL correlation — PTY runtime", () => {
  const cfg = () => makeConfig({ autoDeny: [] });

  it("HIGH correlation with canPrompt=true → prompt shown", async () => {
    let prompted = false;
    await handleIncident({
      incident: makeIncident({ level: "HIGH", reason: "Credential file overwritten", ruleId: "env-overwrite" }),
      config: cfg(),
      runtime: makePtyRuntime({ prompt: async () => { prompted = true; return "approve"; } }),
    });
    assert.equal(prompted, true);
  });

  it("WARN correlation with canPrompt=false → deferred (not blocked)", async () => {
    const result = await handleIncident({
      incident: makeIncident({ level: "WARN", ruleId: "dependency-change-plus-network" }),
      config: cfg(),
      runtime: makePtyRuntime({ canPrompt: false }),
    });
    assert.equal(result.outcome, "deferred");
  });

  // Safety net: even with autoDeny cleared, CRITICAL with no TTY must block.
  it("CRITICAL with canPrompt=false → denied even when autoDeny is empty", async () => {
    let terminated = false;
    const result = await handleIncident({
      incident: makeIncident(),
      config: cfg(),
      runtime: makePtyRuntime({
        canPrompt: false,
        onTerminate: () => { terminated = true; },
      }),
    });
    assert.equal(result.outcome, "denied");
    assert.equal(terminated, true);
  });
});
