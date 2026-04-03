/**
 * AgentGuard — suppression unit tests
 *
 * Run with:
 *   node --test test/suppression.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SuppressionManager, filterFired, suppression } from "../src/suppression.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal rule object — only the fields suppression cares about. */
function makeRule(id, windowMs = 30_000, extras = {}) {
  return { id, windowMs, level: "HIGH", description: `Rule ${id}`, ...extras };
}

/** Fresh manager per test — never share state across cases. */
function mgr(defaultCooldownMs) {
  return new SuppressionManager(defaultCooldownMs);
}

// ─── SuppressionManager ───────────────────────────────────────────────────────

describe("SuppressionManager", () => {

  // ── isSuppressed — before any record() ──────────────────────────────────────

  describe("isSuppressed() — initial state", () => {
    it("returns false for an unknown rule id", () => {
      assert.equal(mgr().isSuppressed("never-fired"), false);
    });

    it("returns false for every id when manager is freshly constructed", () => {
      const m = mgr();
      for (const id of ["a", "b", "env-plus-network"]) {
        assert.equal(m.isSuppressed(id), false);
      }
    });
  });

  // ── record() + isSuppressed() ────────────────────────────────────────────────

  describe("record() + isSuppressed()", () => {
    it("is suppressed immediately after record()", () => {
      const m = mgr();
      m.record("rule-a");
      assert.equal(m.isSuppressed("rule-a"), true);
    });

    it("uses defaultCooldownMs when no per-rule cooldown is given", () => {
      const m = mgr(60_000);
      m.record("rule-a");        // no explicit cooldown → uses 60 000 ms
      assert.equal(m.isSuppressed("rule-a"), true);
    });

    it("uses the provided per-rule cooldown when given", () => {
      const m = mgr(60_000);
      m.record("rule-a", 1);     // 1 ms — expires almost immediately
      // Give it a moment to expire.
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait ~5 ms */ }
      assert.equal(m.isSuppressed("rule-a"), false);
    });

    it("suppressing one rule does not affect another", () => {
      const m = mgr();
      m.record("rule-a");
      assert.equal(m.isSuppressed("rule-a"), true);
      assert.equal(m.isSuppressed("rule-b"), false);
    });

    it("re-recording an already-suppressed rule extends (resets) the timer", () => {
      const m = mgr(10);         // 10 ms default
      m.record("rule-a");
      // Wait until near expiry, then re-record to extend.
      const start = Date.now();
      while (Date.now() - start < 5) { /* wait ~5 ms */ }
      m.record("rule-a");        // resets the clock with another 10 ms
      // Should still be suppressed because we just reset it.
      assert.equal(m.isSuppressed("rule-a"), true);
    });
  });

  // ── cooldown expiry ──────────────────────────────────────────────────────────

  describe("cooldown expiry", () => {
    it("is no longer suppressed once the cooldown window has passed", () => {
      const m = mgr();
      m.record("rule-a", 1);     // 1 ms cooldown
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }
      assert.equal(m.isSuppressed("rule-a"), false);
    });

    it("expired rule does not appear in suppressedIds", () => {
      const m = mgr();
      m.record("rule-a", 1);
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }
      assert.equal(m.suppressedIds.includes("rule-a"), false);
    });

    it("can be re-recorded after expiry", () => {
      const m = mgr();
      m.record("rule-a", 1);
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }
      assert.equal(m.isSuppressed("rule-a"), false);
      // Record again — should suppress afresh.
      m.record("rule-a", 60_000);
      assert.equal(m.isSuppressed("rule-a"), true);
    });
  });

  // ── reset() ──────────────────────────────────────────────────────────────────

  describe("reset()", () => {
    it("clears suppression for the specified rule", () => {
      const m = mgr();
      m.record("rule-a");
      m.reset("rule-a");
      assert.equal(m.isSuppressed("rule-a"), false);
    });

    it("does not affect other suppressed rules", () => {
      const m = mgr();
      m.record("rule-a");
      m.record("rule-b");
      m.reset("rule-a");
      assert.equal(m.isSuppressed("rule-a"), false);
      assert.equal(m.isSuppressed("rule-b"), true);
    });

    it("is a no-op when the rule is not suppressed", () => {
      const m = mgr();
      assert.doesNotThrow(() => m.reset("never-recorded"));
      assert.equal(m.isSuppressed("never-recorded"), false);
    });
  });

  // ── resetAll() ───────────────────────────────────────────────────────────────

  describe("resetAll()", () => {
    it("clears all suppression state", () => {
      const m = mgr();
      m.record("rule-a");
      m.record("rule-b");
      m.record("rule-c");
      m.resetAll();
      assert.equal(m.isSuppressed("rule-a"), false);
      assert.equal(m.isSuppressed("rule-b"), false);
      assert.equal(m.isSuppressed("rule-c"), false);
    });

    it("suppressedIds is empty after resetAll()", () => {
      const m = mgr();
      m.record("rule-a");
      m.resetAll();
      assert.deepEqual(m.suppressedIds, []);
    });

    it("is a no-op on an already-empty manager", () => {
      const m = mgr();
      assert.doesNotThrow(() => m.resetAll());
      assert.deepEqual(m.suppressedIds, []);
    });
  });

  // ── suppressedIds ────────────────────────────────────────────────────────────

  describe("suppressedIds", () => {
    it("returns empty array when nothing is suppressed", () => {
      assert.deepEqual(mgr().suppressedIds, []);
    });

    it("lists every currently suppressed rule id", () => {
      const m = mgr();
      m.record("rule-a");
      m.record("rule-b");
      const ids = m.suppressedIds;
      assert.ok(ids.includes("rule-a"), "rule-a should be listed");
      assert.ok(ids.includes("rule-b"), "rule-b should be listed");
      assert.equal(ids.length, 2);
    });

    it("omits expired entries", () => {
      const m = mgr();
      m.record("rule-expired", 1);
      m.record("rule-active",  60_000);
      const start = Date.now();
      while (Date.now() - start < 5) { /* busy-wait */ }
      const ids = m.suppressedIds;
      assert.ok(!ids.includes("rule-expired"), "expired rule should not appear");
      assert.ok(ids.includes("rule-active"),   "active rule should appear");
    });

    it("returns a new array each call — mutations do not affect internal state", () => {
      const m = mgr();
      m.record("rule-a");
      const ids = m.suppressedIds;
      ids.push("injected");
      assert.equal(m.suppressedIds.length, 1);
    });
  });
});

// ─── filterFired ─────────────────────────────────────────────────────────────

describe("filterFired()", () => {
  it("passes all rules through when none are suppressed", () => {
    const m = mgr();
    const rules = [makeRule("r1"), makeRule("r2")];
    const result = filterFired(rules, m);
    assert.deepEqual(result.map((r) => r.id), ["r1", "r2"]);
  });

  it("returns an empty array when all rules are suppressed", () => {
    const m = mgr();
    m.record("r1");
    m.record("r2");
    const rules = [makeRule("r1"), makeRule("r2")];
    assert.deepEqual(filterFired(rules, m), []);
  });

  it("blocks suppressed rules while passing unsuppressed ones", () => {
    const m = mgr();
    m.record("r1");            // r1 is suppressed
    const rules = [makeRule("r1"), makeRule("r2")];
    const result = filterFired(rules, m);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "r2");
  });

  it("records newly passed rules in the suppression manager", () => {
    const m = mgr();
    assert.equal(m.isSuppressed("r1"), false);
    filterFired([makeRule("r1")], m);
    assert.equal(m.isSuppressed("r1"), true);
  });

  it("uses rule.windowMs as the cooldown when recording", () => {
    const m = mgr(999_999);        // large default that would keep it suppressed
    // Pass a rule with windowMs=1 so it expires almost immediately.
    filterFired([makeRule("r1", 1)], m);
    const start = Date.now();
    while (Date.now() - start < 5) { /* busy-wait */ }
    // After 5 ms the 1 ms cooldown has expired.
    assert.equal(m.isSuppressed("r1"), false);
  });

  it("does not record rules that were suppressed (blocked ones stay suppressed)", () => {
    const m = mgr(60_000);
    m.record("r1", 60_000);       // record with long cooldown
    // Run filterFired — r1 is blocked.
    filterFired([makeRule("r1", 1)], m);  // would set 1 ms if it passed through
    // If filterFired had re-recorded it, the cooldown would be 1 ms (expired).
    // If it correctly did NOT re-record, the original 60 s cooldown still holds.
    assert.equal(m.isSuppressed("r1"), true);
  });

  it("returns a new array — does not mutate the input", () => {
    const m = mgr();
    const rules = [makeRule("r1")];
    const result = filterFired(rules, m);
    assert.notStrictEqual(result, rules);
  });

  it("handles an empty firedRules array gracefully", () => {
    const m = mgr();
    assert.deepEqual(filterFired([], m), []);
  });

  it("preserves rule object identity (no copies)", () => {
    const m = mgr();
    const rule = makeRule("r1");
    const [passed] = filterFired([rule], m);
    assert.strictEqual(passed, rule);
  });
});

// ─── Default singleton ────────────────────────────────────────────────────────

describe("exported singleton `suppression`", () => {
  it("is a SuppressionManager instance", () => {
    assert.ok(suppression instanceof SuppressionManager);
  });
});
