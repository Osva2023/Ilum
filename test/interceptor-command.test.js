/**
 * AgentGuard — interceptor command enforcement tests
 *
 * Run with:
 *   node --test test/interceptor-command.test.js
 *
 * After the refactor, both log-based and PTY interceptors route single-event
 * command incidents through handleIncident().  These tests validate the
 * "log-based interceptor runtime" shape — particularly that stream.write()
 * is called via onResume on approve, and is NOT called on deny.
 *
 * Log-based interceptor runtime contract:
 *   canPrompt  : process.stdout.isTTY ?? false
 *   onTerminate: logSessionEnd → child.kill("SIGTERM") → process.exit(1)
 *   onResume   : stream.write(line + "\n") → child.stdout.resume() → child.stderr.resume()
 *   onRestore  : restoreSnapshot() + console feedback
 *
 * PTY runtime contract (tested in pty-correlation.test.js):
 *   onResume   : pty.resume() → enableForwarding() → handlingApproval = false
 *   (no stream.write — PTY already forwarded the bytes)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleIncident } from "../src/enforcement.js";
import { setSink } from "../src/logger.js";

setSink(() => {});

// ─── Factories ────────────────────────────────────────────────────────────────

function makeCommandIncident(overrides = {}) {
  return {
    source: "command",
    level: "HIGH",
    reason: "Recursive file deletion",
    command: "rm -rf dist/",
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

/**
 * Simulates the runtime the log-based interceptor provides.
 * stream.write and stream resume/pause are tracked via counters.
 */
function makeInterceptorRuntime(line = "$ rm -rf dist/", overrides = {}) {
  const calls = { writes: [], resumes: 0, terminates: 0, restores: 0 };
  const runtime = {
    canPrompt: true,
    prompt: async () => "approve",
    onRestore: () => { calls.restores++; },
    onTerminate: () => { calls.terminates++; },
    onResume: () => {
      // Mirrors interceptor.js makeRuntime(extraOnResume):
      //   extraOnResume: () => stream.write(line + "\n")
      //   then: child.stdout.resume() + child.stderr.resume()
      calls.writes.push(line + "\n");
      calls.resumes++;
    },
    ...overrides,
  };
  return { runtime, calls };
}

// ─── approve path ─────────────────────────────────────────────────────────────

describe("command incident — approve (log-based interceptor runtime)", () => {
  it("returns outcome=approved", async () => {
    const { runtime } = makeInterceptorRuntime();
    const result = await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      runtime,
    });
    assert.equal(result.outcome, "approved");
  });

  it("calls onResume on approve — triggers stream.write + resume", async () => {
    const line = "$ rm -rf dist/";
    const { runtime, calls } = makeInterceptorRuntime(line);
    await handleIncident({
      incident: makeCommandIncident({ command: "rm -rf dist/" }),
      config: makeConfig(),
      runtime,
    });
    assert.equal(calls.writes.length, 1, "stream.write should be called once");
    assert.equal(calls.writes[0], line + "\n");
    assert.equal(calls.resumes, 1);
  });

  it("does not call onTerminate on approve", async () => {
    const { runtime, calls } = makeInterceptorRuntime();
    await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      runtime,
    });
    assert.equal(calls.terminates, 0);
  });

  it("increments stats.approved", async () => {
    const stats = { intercepted: 0, approved: 0, blocked: {} };
    const { runtime } = makeInterceptorRuntime();
    await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      stats,
      runtime,
    });
    assert.equal(stats.approved, 1);
  });
});

// ─── deny path ────────────────────────────────────────────────────────────────

describe("command incident — deny (log-based interceptor runtime)", () => {
  it("returns outcome=denied", async () => {
    const { runtime } = makeInterceptorRuntime("$ rm -rf dist/", {
      prompt: async () => "deny",
    });
    const result = await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      runtime,
    });
    assert.equal(result.outcome, "denied");
  });

  it("does NOT call onResume (stream.write) on deny", async () => {
    const { runtime, calls } = makeInterceptorRuntime("$ rm -rf dist/", {
      prompt: async () => "deny",
    });
    await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      runtime,
    });
    assert.equal(calls.writes.length, 0, "stream.write must not be called on deny");
    assert.equal(calls.resumes, 0);
  });

  it("calls onTerminate on deny", async () => {
    const { runtime, calls } = makeInterceptorRuntime("$ rm -rf dist/", {
      prompt: async () => "deny",
    });
    await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      runtime,
    });
    assert.equal(calls.terminates, 1);
  });

  it("calls onRestore before onTerminate when stashRef is set", async () => {
    const order = [];
    const { runtime } = makeInterceptorRuntime("$ rm -rf dist/", {
      prompt: async () => "deny",
      onRestore: () => { order.push("restore"); },
      onTerminate: () => { order.push("terminate"); },
    });
    await handleIncident({
      incident: makeCommandIncident(),
      config: makeConfig(),
      stashRef: "stash@{0}",
      runtime,
    });
    assert.deepEqual(order, ["restore", "terminate"]);
  });

  it("increments stats.blocked by level", async () => {
    const stats = { intercepted: 0, approved: 0, blocked: {} };
    const { runtime } = makeInterceptorRuntime("$ rm -rf dist/", {
      prompt: async () => "deny",
    });
    await handleIncident({
      incident: makeCommandIncident({ level: "HIGH" }),
      config: makeConfig(),
      stats,
      runtime,
    });
    assert.equal(stats.blocked["HIGH"], 1);
  });
});

// ─── autoDeny path ────────────────────────────────────────────────────────────

describe("command incident — autoDeny (log-based interceptor runtime)", () => {
  it("CRITICAL with autoDeny:['CRITICAL'] → denied without prompt", async () => {
    let prompted = false;
    const { runtime, calls } = makeInterceptorRuntime("$ git push --force", {
      prompt: async () => { prompted = true; return "approve"; },
    });
    const result = await handleIncident({
      incident: makeCommandIncident({ level: "CRITICAL", command: "git push --force" }),
      config: makeConfig({ autoDeny: ["CRITICAL"] }),
      runtime,
    });
    assert.equal(result.outcome, "denied");
    assert.equal(prompted, false);
    assert.equal(calls.terminates, 1);
    assert.equal(calls.writes.length, 0);
  });

  it("autoDeny calls onRestore when stashRef is set", async () => {
    let restored = false;
    const { runtime } = makeInterceptorRuntime("$ git push --force", {
      onRestore: () => { restored = true; },
    });
    await handleIncident({
      incident: makeCommandIncident({ level: "CRITICAL", command: "git push --force" }),
      config: makeConfig({ autoDeny: ["CRITICAL"] }),
      stashRef: "stash@{0}",
      runtime,
    });
    assert.equal(restored, true);
  });
});

// ─── autoApprove path ─────────────────────────────────────────────────────────

describe("command incident — autoApprove (log-based interceptor runtime)", () => {
  it("WARN with autoApprove:['WARN'] → approved, onResume called", async () => {
    const { runtime, calls } = makeInterceptorRuntime("$ npm audit");
    const result = await handleIncident({
      incident: makeCommandIncident({ level: "WARN", command: "npm audit" }),
      config: makeConfig({ autoDeny: [], autoApprove: ["WARN"] }),
      runtime,
    });
    assert.equal(result.outcome, "approved");
    assert.equal(calls.resumes, 1);
    assert.equal(calls.writes.length, 1);
  });

  it("autoApprove does not prompt", async () => {
    let prompted = false;
    const { runtime } = makeInterceptorRuntime("$ npm audit", {
      prompt: async () => { prompted = true; return "approve"; },
    });
    await handleIncident({
      incident: makeCommandIncident({ level: "WARN", command: "npm audit" }),
      config: makeConfig({ autoDeny: [], autoApprove: ["WARN"] }),
      runtime,
    });
    assert.equal(prompted, false);
  });
});

// ─── CRITICAL no-TTY ──────────────────────────────────────────────────────────

describe("command incident — CRITICAL no TTY (log-based interceptor runtime)", () => {
  it("CRITICAL with canPrompt=false → denied (never deferred)", async () => {
    const { runtime, calls } = makeInterceptorRuntime("$ rm -rf /", {
      canPrompt: false,
    });
    const result = await handleIncident({
      incident: makeCommandIncident({ level: "CRITICAL", command: "rm -rf /" }),
      config: makeConfig({ autoDeny: [] }),
      runtime,
    });
    assert.equal(result.outcome, "denied");
    assert.equal(calls.terminates, 1);
    assert.equal(calls.writes.length, 0);
  });
});

// ─── deferred path ────────────────────────────────────────────────────────────

describe("command incident — deferred (no TTY, non-CRITICAL)", () => {
  it("WARN with canPrompt=false → deferred, no terminate, no stream.write via onResume", async () => {
    const { runtime, calls } = makeInterceptorRuntime("$ npm audit", {
      canPrompt: false,
    });
    const result = await handleIncident({
      incident: makeCommandIncident({ level: "WARN", command: "npm audit" }),
      config: makeConfig({ autoDeny: [] }),
      runtime,
    });
    assert.equal(result.outcome, "deferred");
    assert.equal(calls.terminates, 0);
    // onResume is not called for deferred — interceptor handles resume manually
    assert.equal(calls.resumes, 0);
  });
});
