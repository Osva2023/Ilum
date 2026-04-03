/**
 * AgentGuard — event-bus unit tests
 *
 * Run with:
 *   node --test test/event-bus.test.js
 *   npm test                           (if jest is configured to pick this up)
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { EventBus, bus } from "../src/event-bus.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal canonical event, overriding any fields via `overrides`. */
function makeEvent(overrides = {}) {
  return {
    type: "process_exec",
    raw: "$ echo hi",
    command: "echo hi",
    subtype: "generic",
    time: new Date().toISOString(),
    ...overrides,
  };
}

/** Return an ISO timestamp offset by `deltaMs` from now. */
function isoOffset(deltaMs) {
  return new Date(Date.now() + deltaMs).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("EventBus", () => {
  let eb;

  beforeEach(() => {
    // Fresh instance per test — never share state between cases.
    eb = new EventBus(60_000);
  });

  // ── push & size ─────────────────────────────────────────────────────────────

  describe("push() / size", () => {
    it("starts empty", () => {
      assert.equal(eb.size, 0);
    });

    it("increments size on each push", () => {
      eb.push(makeEvent());
      assert.equal(eb.size, 1);
      eb.push(makeEvent());
      assert.equal(eb.size, 2);
    });

    it("returns void", () => {
      assert.equal(eb.push(makeEvent()), undefined);
    });
  });

  // ── time-window eviction ────────────────────────────────────────────────────

  describe("time-window eviction", () => {
    it("keeps events within the window", () => {
      const bus1s = new EventBus(1_000);
      bus1s.push(makeEvent({ time: isoOffset(-500) })); // 500 ms ago — inside
      bus1s.push(makeEvent());                           // now — inside
      assert.equal(bus1s.size, 2);
    });

    it("evicts events older than windowMs on push", () => {
      const bus1s = new EventBus(1_000);
      // Push an event timestamped 2 seconds ago — outside the 1 s window.
      bus1s.push(makeEvent({ time: isoOffset(-2_000) }));
      // Trigger eviction by pushing a fresh event.
      bus1s.push(makeEvent());
      // Only the fresh event survives.
      assert.equal(bus1s.size, 1);
    });

    it("evicts multiple stale events in one push", () => {
      const bus500 = new EventBus(500);
      bus500.push(makeEvent({ time: isoOffset(-1_000) }));
      bus500.push(makeEvent({ time: isoOffset(-800) }));
      bus500.push(makeEvent({ time: isoOffset(-600) }));
      // All three are outside the 500 ms window; a fresh push triggers eviction.
      bus500.push(makeEvent());
      assert.equal(bus500.size, 1);
    });

    it("does not evict a fresh event when no subsequent push occurs", () => {
      // Eviction is lazy — a fresh event added now is not removed until the
      // next push() fires the eviction pass (which, in a window-spanning
      // future, would cull it).  Immediately after pushing it should survive.
      const bus1s = new EventBus(1_000);
      bus1s.push(makeEvent()); // timestamp = now, inside the 1 s window
      assert.equal(bus1s.size, 1);
    });

    it("handles an empty buffer push without error", () => {
      assert.doesNotThrow(() => eb.push(makeEvent()));
    });
  });

  // ── query ───────────────────────────────────────────────────────────────────

  describe("query()", () => {
    beforeEach(() => {
      eb.push(makeEvent({ type: "process_exec", subtype: "git_operation",  time: isoOffset(-300) }));
      eb.push(makeEvent({ type: "process_exec", subtype: "package_install",time: isoOffset(-200) }));
      eb.push(makeEvent({ type: "file_write",   subtype: "secret",         time: isoOffset(-100) }));
      eb.push(makeEvent({ type: "file_delete",  subtype: "source",         time: isoOffset(0)    }));
    });

    it("returns all events when called with no filters", () => {
      assert.equal(eb.query().length, 4);
    });

    it("filters by type — process_exec", () => {
      const results = eb.query({ type: "process_exec" });
      assert.equal(results.length, 2);
      assert.ok(results.every((e) => e.type === "process_exec"));
    });

    it("filters by type — file_write", () => {
      const results = eb.query({ type: "file_write" });
      assert.equal(results.length, 1);
      assert.equal(results[0].subtype, "secret");
    });

    it("filters by type — file_delete", () => {
      const results = eb.query({ type: "file_delete" });
      assert.equal(results.length, 1);
      assert.equal(results[0].subtype, "source");
    });

    it("returns empty array for unknown type", () => {
      assert.deepEqual(eb.query({ type: "nonexistent" }), []);
    });

    it("filters by subtype", () => {
      const results = eb.query({ subtype: "git_operation" });
      assert.equal(results.length, 1);
      assert.equal(results[0].type, "process_exec");
    });

    it("returns empty array for unknown subtype", () => {
      assert.deepEqual(eb.query({ subtype: "shell_exec" }), []);
    });

    it("combines type and subtype filters", () => {
      const results = eb.query({ type: "process_exec", subtype: "package_install" });
      assert.equal(results.length, 1);
    });

    it("combined filter returns empty when no match", () => {
      assert.deepEqual(
        eb.query({ type: "file_write", subtype: "git_operation" }),
        []
      );
    });

    it("filters by since — excludes events before the timestamp", () => {
      // Only events at or after 150 ms ago → file_write and file_delete.
      const since = isoOffset(-150);
      const results = eb.query({ since });
      assert.equal(results.length, 2);
      assert.ok(results.every((e) => Date.parse(e.time) >= Date.parse(since)));
    });

    it("since with a future timestamp returns empty", () => {
      const results = eb.query({ since: isoOffset(1_000) });
      assert.deepEqual(results, []);
    });

    it("since combined with type filter", () => {
      // process_exec events older than 150 ms → git_operation and package_install
      const results = eb.query({ type: "process_exec", since: isoOffset(-350) });
      assert.equal(results.length, 2);
    });

    it("returns a copy — mutations do not affect the buffer", () => {
      const results = eb.query();
      results.pop();
      assert.equal(eb.size, 4);
    });
  });

  // ── recent ──────────────────────────────────────────────────────────────────

  describe("recent(n)", () => {
    beforeEach(() => {
      eb.push(makeEvent({ subtype: "first"  }));
      eb.push(makeEvent({ subtype: "second" }));
      eb.push(makeEvent({ subtype: "third"  }));
    });

    it("returns the last n events in insertion order", () => {
      const r = eb.recent(2);
      assert.equal(r.length, 2);
      assert.equal(r[0].subtype, "second");
      assert.equal(r[1].subtype, "third");
    });

    it("returns all events when n >= size", () => {
      assert.equal(eb.recent(10).length, 3);
    });

    it("recent(1) returns only the last event", () => {
      const r = eb.recent(1);
      assert.equal(r.length, 1);
      assert.equal(r[0].subtype, "third");
    });

    it("recent(0) returns an empty array", () => {
      assert.deepEqual(eb.recent(0), []);
    });

    it("returns a copy — mutations do not affect the buffer", () => {
      const r = eb.recent(3);
      r.pop();
      assert.equal(eb.size, 3);
    });
  });

  // ── clear ───────────────────────────────────────────────────────────────────

  describe("clear()", () => {
    it("empties the buffer", () => {
      eb.push(makeEvent());
      eb.push(makeEvent());
      eb.clear();
      assert.equal(eb.size, 0);
    });

    it("returns void", () => {
      assert.equal(eb.clear(), undefined);
    });

    it("is idempotent on an already-empty buffer", () => {
      assert.doesNotThrow(() => eb.clear());
      assert.equal(eb.size, 0);
    });

    it("allows new events to be pushed after clearing", () => {
      eb.push(makeEvent());
      eb.clear();
      eb.push(makeEvent({ subtype: "after-clear" }));
      assert.equal(eb.size, 1);
      assert.equal(eb.query()[0].subtype, "after-clear");
    });
  });

  // ── default singleton ────────────────────────────────────────────────────────

  describe("exported singleton `bus`", () => {
    it("is an EventBus instance", () => {
      assert.ok(bus instanceof EventBus);
    });
  });
});
