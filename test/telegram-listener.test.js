/**
 * AgentGuard telegram-listener.js tests (plain Node.js, no test runner)
 *
 * Focus: handleCallbackQuery dispatch logic (the business rules).
 * startListener gets a smoke test + idempotent-stop assertion only.
 *
 * Tests:
 *   1.  unauthorized from.id → answerCallback "Not authorized"
 *   2.  unknown action → answerCallback "Unknown action"
 *   3.  unknown changeId → "Already handled or expired"
 *   4.  resolved changeId → same path as unknown
 *   5.  action "k" → marks resolved, edits all messageRefs, logs telegram_keep
 *   6.  action "r" success → marks resolved, edits all refs, logs file_restore restored:true
 *   7.  action "r" failure → leaves unresolved, alert with show_alert, no edits, logs file_restore restored:false
 *   8.  startListener — not configured → returns no-op stop()
 *   9.  startListener — stop() is idempotent
 */

import assert from "assert";
import {
  handleCallbackQuery,
  startListener,
  cleanupPendingAlerts,
} from "../src/telegram-listener.js";
import { PendingChanges } from "../src/pending-changes.js";
import { setSink } from "../src/logger.js";

let passed = 0;
let failed = 0;

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try { return fn(); }
  finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function mockFetch() {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const body = opts?.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    return { ok: true, json: async () => ({}), text: async () => "" };
  };
  return {
    calls,
    restore() { globalThis.fetch = originalFetch; },
  };
}

console.log("\ntelegram-listener.test.js\n");

// ── 1 ─────────────────────────────────────────────────────────────────────────
await testAsync("unauthorized from.id → answerCallback Not authorized", async () => {
  const m = mockFetch();
  try {
    const ctx = {
      token: "tok",
      allowedChatIds: new Set(["999"]),
      cwd: "/",
      agent: "a",
      pending: new PendingChanges(),
      restoreFn: () => { throw new Error("must not be called"); },
    };
    const r = await handleCallbackQuery(
      { id: "cb1", from: { id: 123, username: "x" }, data: "k:abc" },
      ctx
    );
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, "unauthorized");
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.strictEqual(ans.body.text, "Not authorized");
    assert.strictEqual(ans.body.show_alert, true);
  } finally { m.restore(); }
});

// ── 2 ─────────────────────────────────────────────────────────────────────────
await testAsync("unknown action → answerCallback Unknown action", async () => {
  const m = mockFetch();
  try {
    const ctx = {
      token: "tok",
      allowedChatIds: new Set(["123"]),
      cwd: "/", agent: "a",
      pending: new PendingChanges(),
      restoreFn: () => ({ restored: false, mode: "none" }),
    };
    const r = await handleCallbackQuery(
      { id: "cb2", from: { id: 123 }, data: "x:abc" }, ctx
    );
    assert.strictEqual(r.reason, "unknown-action");
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.strictEqual(ans.body.text, "Unknown action");
  } finally { m.restore(); }
});

// ── 3 ─────────────────────────────────────────────────────────────────────────
await testAsync("unknown changeId → already handled or expired", async () => {
  const m = mockFetch();
  try {
    const ctx = {
      token: "tok", allowedChatIds: new Set(["123"]),
      cwd: "/", agent: "a",
      pending: new PendingChanges(),
      restoreFn: () => ({ restored: false, mode: "none" }),
    };
    const r = await handleCallbackQuery(
      { id: "cb3", from: { id: 123 }, data: "k:nosuch" }, ctx
    );
    assert.strictEqual(r.reason, "missing-or-resolved");
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.strictEqual(ans.body.text, "Already handled or expired");
  } finally { m.restore(); }
});

// ── 4 ─────────────────────────────────────────────────────────────────────────
await testAsync("already-resolved changeId → already handled or expired", async () => {
  const m = mockFetch();
  try {
    const p = new PendingChanges();
    const id = p.register({ sessionId: "s", path: "x", event: "modified", level: "HIGH" });
    p.markResolved(id);
    const r = await handleCallbackQuery(
      { id: "cb4", from: { id: 123 }, data: `k:${id}` },
      {
        token: "tok", allowedChatIds: new Set(["123"]),
        cwd: "/", agent: "a", pending: p,
        restoreFn: () => ({ restored: false, mode: "none" }),
      }
    );
    assert.strictEqual(r.reason, "missing-or-resolved");
  } finally { m.restore(); }
});

// ── 5 ─────────────────────────────────────────────────────────────────────────
await testAsync('action "k" → marks resolved + edits all messageRefs + logs', async () => {
  const m = mockFetch();
  const logs = [];
  setSink((l) => logs.push(JSON.parse(l)));
  try {
    const p = new PendingChanges();
    const id = p.register({
      sessionId: "s", path: ".env", event: "modified", level: "HIGH",
      messageText: "ORIG",
    });
    p.updateMessageRefs(id, [
      { chatId: "c1", messageId: 11 },
      { chatId: "c2", messageId: 22 },
    ]);
    const r = await handleCallbackQuery(
      { id: "cb5", from: { id: 123, username: "alice" }, data: `k:${id}` },
      {
        token: "tok", allowedChatIds: new Set(["123"]),
        cwd: "/", agent: "claude", pending: p,
        restoreFn: () => { throw new Error("restoreFn must not be called for keep"); },
      }
    );
    assert.strictEqual(r.action, "kept");
    assert.strictEqual(p.resolve(id).resolved, true);
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.strictEqual(ans.body.text, "Kept");
    const edits = m.calls.filter((c) => c.url.endsWith("/editMessageText"));
    assert.strictEqual(edits.length, 2);
    assert.deepStrictEqual(edits.map((e) => e.body.chat_id).sort(), ["c1", "c2"]);
    for (const e of edits) {
      assert.ok(e.body.text.includes("✅ Kept by @alice"));
      assert.deepStrictEqual(e.body.reply_markup, { inline_keyboard: [] });
    }
    const keep = logs.find((l) => l.event === "telegram_keep");
    assert.ok(keep, "telegram_keep log written");
    assert.strictEqual(keep.file, ".env");
    assert.strictEqual(keep.by, "alice");
  } finally { m.restore(); setSink(() => {}); }
});

// ── 6 ─────────────────────────────────────────────────────────────────────────
await testAsync('action "r" success → resolved, edits, logs restored:true', async () => {
  const m = mockFetch();
  const logs = [];
  setSink((l) => logs.push(JSON.parse(l)));
  try {
    const p = new PendingChanges();
    const id = p.register({
      sessionId: "s", path: ".env", event: "modified", level: "HIGH",
      stashRef: "ref", sensitiveBackupDir: "/b",
      messageText: "ORIG",
    });
    p.updateMessageRefs(id, [{ chatId: "c1", messageId: 11 }]);
    const restoreFn = () => ({ restored: true, mode: "stash-tracked", message: "ok" });
    const r = await handleCallbackQuery(
      { id: "cb6", from: { id: 123, username: "bob" }, data: `r:${id}` },
      {
        token: "tok", allowedChatIds: new Set(["123"]),
        cwd: "/proj", agent: "claude", pending: p, restoreFn,
      }
    );
    assert.strictEqual(r.action, "rolled_back");
    assert.strictEqual(p.resolve(id).resolved, true);
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.strictEqual(ans.body.text, "Rolled back");
    const edit = m.calls.find((c) => c.url.endsWith("/editMessageText"));
    assert.ok(edit.body.text.includes("↩️ Rolled back by @bob"));
    const fr = logs.find((l) => l.event === "file_restore");
    assert.ok(fr);
    assert.strictEqual(fr.restored, true);
    assert.strictEqual(fr.by, "bob");
  } finally { m.restore(); setSink(() => {}); }
});

// ── 7 ─────────────────────────────────────────────────────────────────────────
await testAsync('action "r" failure → unresolved, alert, logs restored:false', async () => {
  const m = mockFetch();
  const logs = [];
  setSink((l) => logs.push(JSON.parse(l)));
  try {
    const p = new PendingChanges();
    const id = p.register({
      sessionId: "s", path: ".env", event: "modified", level: "HIGH",
      messageText: "ORIG",
    });
    p.updateMessageRefs(id, [{ chatId: "c1", messageId: 11 }]);
    const restoreFn = () => ({ restored: false, mode: "none", message: "no source" });
    const r = await handleCallbackQuery(
      { id: "cb7", from: { id: 123, username: "bob" }, data: `r:${id}` },
      {
        token: "tok", allowedChatIds: new Set(["123"]),
        cwd: "/proj", agent: "claude", pending: p, restoreFn,
      }
    );
    assert.strictEqual(r.handled, false);
    assert.strictEqual(r.reason, "restore-failed");
    assert.strictEqual(p.resolve(id).resolved, false);
    const ans = m.calls.find((c) => c.url.endsWith("/answerCallbackQuery"));
    assert.ok(ans.body.text.startsWith("Rollback failed"));
    assert.strictEqual(ans.body.show_alert, true);
    const edit = m.calls.find((c) => c.url.endsWith("/editMessageText"));
    assert.strictEqual(edit, undefined, "no editMessageText on failure");
    const fr = logs.find((l) => l.event === "file_restore");
    assert.ok(fr);
    assert.strictEqual(fr.restored, false);
  } finally { m.restore(); setSink(() => {}); }
});

// ── 8 ─────────────────────────────────────────────────────────────────────────
await testAsync("startListener — not configured → no-op stop()", async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true }; };
  try {
    await withEnv(
      {
        AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
        AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
      },
      async () => {
        const handle = startListener({
          config: {}, sessionId: "s", cwd: "/", agent: "a",
        });
        assert.strictEqual(typeof handle.stop, "function");
        handle.stop();
        await new Promise((r) => setTimeout(r, 20));
        assert.strictEqual(fetchCalled, false);
      }
    );
  } finally { globalThis.fetch = originalFetch; }
});

// ── 9 ─────────────────────────────────────────────────────────────────────────
await testAsync("startListener — stop() is idempotent", async () => {
  const originalFetch = globalThis.fetch;
  const originalWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true; // silence listener logs from aborted fetches
  globalThis.fetch = async (_url, opts) => {
    return new Promise((_, reject) => {
      const onAbort = () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        reject(e);
      };
      if (opts?.signal?.aborted) return onAbort();
      opts?.signal?.addEventListener?.("abort", onAbort);
    });
  };
  try {
    const config = {
      notifications: {
        telegram: { enabled: true, botToken: "t", chatId: "c" },
      },
    };
    const handle = startListener({ config, sessionId: "s", cwd: "/", agent: "a" });
    await new Promise((r) => setTimeout(r, 10));
    handle.stop();
    handle.stop();
    handle.stop();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    globalThis.fetch = originalFetch;
    process.stderr.write = originalWrite;
  }
});

// ── 10 ────────────────────────────────────────────────────────────────────────
await testAsync("cleanupPendingAlerts — edits every unresolved alert with session_ended", async () => {
  const m = mockFetch();
  try {
    const p = new PendingChanges();
    const a = p.register({ sessionId: "s", path: "a.env", event: "modified", level: "HIGH", messageText: "A-ORIG" });
    const b = p.register({ sessionId: "s", path: "b.env", event: "modified", level: "HIGH", messageText: "B-ORIG" });
    const c = p.register({ sessionId: "s", path: "c.env", event: "modified", level: "HIGH", messageText: "C-ORIG" });
    p.updateMessageRefs(a, [{ chatId: "c1", messageId: 1 }, { chatId: "c2", messageId: 2 }]);
    p.updateMessageRefs(b, [{ chatId: "c1", messageId: 3 }]);
    p.updateMessageRefs(c, [{ chatId: "c1", messageId: 9 }]);
    p.markResolved(c);

    const config = { notifications: { telegram: { enabled: true, botToken: "t", chatId: "c1" } } };
    await cleanupPendingAlerts(config, { pending: p, timeoutMs: 1000 });

    const edits = m.calls.filter((x) => x.url.endsWith("/editMessageText"));
    assert.strictEqual(edits.length, 3, "2 refs for a + 1 ref for b — c skipped");
    for (const e of edits) {
      assert.ok(e.body.text.endsWith("⌛ Session ended — no action taken"));
      assert.deepStrictEqual(e.body.reply_markup, { inline_keyboard: [] });
    }
  } finally { m.restore(); }
});

// ── 11 ────────────────────────────────────────────────────────────────────────
await testAsync("cleanupPendingAlerts — not configured → no-op", async () => {
  const m = mockFetch();
  try {
    const p = new PendingChanges();
    p.register({ sessionId: "s", path: "x", event: "modified", level: "HIGH" });
    await withEnv(
      { AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined, AGENTGUARD_TELEGRAM_CHAT_ID: undefined },
      async () => {
        await cleanupPendingAlerts({}, { pending: p });
      }
    );
    assert.strictEqual(m.calls.length, 0, "no fetch when not configured");
  } finally { m.restore(); }
});

// ── 12 ────────────────────────────────────────────────────────────────────────
await testAsync("cleanupPendingAlerts — caps at timeoutMs when network hangs", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {}); // never resolves
  try {
    const p = new PendingChanges();
    const id = p.register({ sessionId: "s", path: "x", event: "modified", level: "HIGH", messageText: "ORIG" });
    p.updateMessageRefs(id, [{ chatId: "c", messageId: 1 }]);
    const config = { notifications: { telegram: { enabled: true, botToken: "t", chatId: "c" } } };
    const start = Date.now();
    await cleanupPendingAlerts(config, { pending: p, timeoutMs: 50 });
    const dur = Date.now() - start;
    assert.ok(dur >= 40 && dur < 500, `expected ~50ms cap, got ${dur}ms`);
  } finally { globalThis.fetch = originalFetch; }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
