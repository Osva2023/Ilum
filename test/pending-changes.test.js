/**
 * AgentGuard pending-changes.js tests (plain Node.js, no test runner)
 *
 * Tests:
 *   1. register() returns a non-empty string id
 *   2. register() assigns createdAt and resolved=false
 *   3. resolve() preserves passed fields
 *   4. resolve() returns null for unknown id
 *   5. register() ids are unique across many calls
 *   6. markResolved() flips the flag; second call returns false
 *   7. markResolved() on unknown id returns false
 *   8. resolve() after markResolved() still finds entry; resolved=true
 *   9. updateMessageRefs() attaches refs
 *  10. updateMessageRefs() on unknown id returns false
 *  11. listUnresolved() excludes resolved entries and surfaces changeId
 *  12. clear() empties the registry
 *  13. messageRefs defaults to [] when omitted on register
 */

import assert from "assert";
import { PendingChanges } from "../src/pending-changes.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

const baseEntry = () => ({
  sessionId: "abc12345",
  path: "src/.env",
  event: "modified",
  level: "HIGH",
  stashRef: "agentguard-snapshot-x",
  sensitiveBackupDir: "/tmp/agentguard/snapshots/abc12345",
});

console.log("\npending-changes.test.js\n");

test("register() returns a non-empty string id", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  assert.strictEqual(typeof id, "string");
  assert.ok(id.length > 0, "id must be non-empty");
});

test("register() assigns createdAt and resolved=false", () => {
  const p = new PendingChanges();
  const before = Date.now();
  const id = p.register(baseEntry());
  const entry = p.resolve(id);
  assert.ok(entry.createdAt >= before, "createdAt should be set to now-ish");
  assert.strictEqual(entry.resolved, false);
});

test("resolve() preserves passed fields", () => {
  const p = new PendingChanges();
  const e = baseEntry();
  const id = p.register(e);
  const got = p.resolve(id);
  assert.strictEqual(got.sessionId, e.sessionId);
  assert.strictEqual(got.path, e.path);
  assert.strictEqual(got.event, e.event);
  assert.strictEqual(got.level, e.level);
  assert.strictEqual(got.stashRef, e.stashRef);
  assert.strictEqual(got.sensitiveBackupDir, e.sensitiveBackupDir);
});

test("resolve() returns null for unknown id", () => {
  const p = new PendingChanges();
  assert.strictEqual(p.resolve("nosuch"), null);
});

test("register() ids are unique across many calls", () => {
  const p = new PendingChanges();
  const ids = new Set();
  for (let i = 0; i < 1000; i++) {
    ids.add(p.register(baseEntry()));
  }
  assert.strictEqual(ids.size, 1000, "all ids must be unique");
});

test("markResolved() flips the flag; second call returns false", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  assert.strictEqual(p.markResolved(id), true);
  assert.strictEqual(p.markResolved(id), false, "second markResolved is a no-op");
});

test("markResolved() on unknown id returns false", () => {
  const p = new PendingChanges();
  assert.strictEqual(p.markResolved("nosuch"), false);
});

test("resolve() after markResolved() still finds entry; resolved=true", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  p.markResolved(id);
  const entry = p.resolve(id);
  assert.ok(entry, "entry should still exist");
  assert.strictEqual(entry.resolved, true);
});

test("updateMessageRefs() attaches refs", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  const refs = [
    { chatId: "c1", messageId: 42 },
    { chatId: "c2", messageId: 43 },
  ];
  assert.strictEqual(p.updateMessageRefs(id, refs), true);
  assert.deepStrictEqual(p.resolve(id).messageRefs, refs);
});

test("updateMessageRefs() on unknown id returns false", () => {
  const p = new PendingChanges();
  assert.strictEqual(p.updateMessageRefs("nosuch", []), false);
});

test("updateMessageText() attaches text", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  assert.strictEqual(p.updateMessageText(id, "rendered alert body"), true);
  assert.strictEqual(p.resolve(id).messageText, "rendered alert body");
});

test("updateMessageText() on unknown id returns false", () => {
  const p = new PendingChanges();
  assert.strictEqual(p.updateMessageText("nosuch", "x"), false);
});

test("listUnresolved() excludes resolved entries and surfaces changeId", () => {
  const p = new PendingChanges();
  const a = p.register({ ...baseEntry(), path: "a.env" });
  const b = p.register({ ...baseEntry(), path: "b.env" });
  const c = p.register({ ...baseEntry(), path: "c.env" });
  p.markResolved(b);
  const open = p.listUnresolved();
  const paths = open.map((e) => e.path).sort();
  assert.deepStrictEqual(paths, ["a.env", "c.env"]);
  for (const e of open) {
    assert.ok(e.changeId === a || e.changeId === c, "changeId surfaced on unresolved entry");
  }
});

test("clear() empties the registry", () => {
  const p = new PendingChanges();
  p.register(baseEntry());
  p.register(baseEntry());
  assert.strictEqual(p.size, 2);
  p.clear();
  assert.strictEqual(p.size, 0);
});

test("messageRefs defaults to [] when omitted on register", () => {
  const p = new PendingChanges();
  const id = p.register(baseEntry());
  assert.deepStrictEqual(p.resolve(id).messageRefs, []);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
