/**
 * AgentGuard — sensitive-file dedup classifier tests
 *
 * Run with:
 *   node --test test/filewatcher-dedup.test.js
 *
 * Drives classifySensitiveEvent() directly so we can cover the layered
 * cooldown + session-dedup behavior without spinning up chokidar.
 *
 * Decision table:
 *
 *   recentSensitive set, within window     → "cooldown" (no state change)
 *   recentSensitive set, outside window,
 *     notifiedFiles has rel                → "dedup"    (recentSensitive bumped)
 *   notifiedFiles has rel, no recent burst → "dedup"    (recentSensitive bumped)
 *   first sight                            → "fire"     (both maps written)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classifySensitiveEvent } from "../src/filewatcher.js";

const COOLDOWN = 10_000;

function fresh() {
  return { notifiedFiles: new Set(), recentSensitive: new Map() };
}

describe("classifySensitiveEvent — fire on first sight", () => {
  it("returns 'fire' the first time a file is seen", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    const action = classifySensitiveEvent({
      rel: ".env",
      now: 1000,
      notifiedFiles,
      recentSensitive,
      cooldownMs: COOLDOWN,
    });
    assert.equal(action, "fire");
  });

  it("adds the file to notifiedFiles on 'fire'", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env",
      now: 1000,
      notifiedFiles,
      recentSensitive,
      cooldownMs: COOLDOWN,
    });
    assert.equal(notifiedFiles.has(".env"), true);
  });

  it("records the timestamp in recentSensitive on 'fire'", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env",
      now: 1000,
      notifiedFiles,
      recentSensitive,
      cooldownMs: COOLDOWN,
    });
    assert.equal(recentSensitive.get(".env"), 1000);
  });
});

describe("classifySensitiveEvent — cooldown suppresses everything", () => {
  it("returns 'cooldown' for the same file within the window", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    const action = classifySensitiveEvent({
      rel: ".env", now: 5000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "cooldown");
  });

  it("does not update recentSensitive on 'cooldown' (anchor stays put)", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    classifySensitiveEvent({
      rel: ".env", now: 5000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    // Anchor must remain at t=1000 so the cooldown window is [1000, 11000),
    // not extended each burst event.
    assert.equal(recentSensitive.get(".env"), 1000);
  });

  it("at the cooldown boundary (now - last === cooldownMs) → not cooldown", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    const action = classifySensitiveEvent({
      rel: ".env", now: 11000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.notEqual(action, "cooldown");
  });
});

describe("classifySensitiveEvent — dedup after cooldown lapses", () => {
  it("returns 'dedup' on a second event past the cooldown", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    const action = classifySensitiveEvent({
      rel: ".env", now: 20_000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "dedup");
  });

  it("bumps recentSensitive on 'dedup' so the dedup stderr line is rate-limited", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    classifySensitiveEvent({
      rel: ".env", now: 20_000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(recentSensitive.get(".env"), 20_000);
  });

  it("after 'dedup', another event within the new cooldown → 'cooldown'", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    classifySensitiveEvent({
      rel: ".env", now: 20_000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    const action = classifySensitiveEvent({
      rel: ".env", now: 25_000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "cooldown");
  });
});

describe("classifySensitiveEvent — files are tracked independently", () => {
  it("notifying one file does not dedup a different file", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    const action = classifySensitiveEvent({
      rel: "CLAUDE.md", now: 1500, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "fire");
  });

  it("cooldown on one file does not affect a different file", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    // Same timestamp — still inside .env's cooldown but a different file.
    const action = classifySensitiveEvent({
      rel: "id_rsa", now: 1500, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "fire");
  });
});

describe("classifySensitiveEvent — session-scoped notifiedFiles", () => {
  it("a fresh notifiedFiles Set means a fresh session: first event → 'fire'", () => {
    // Simulate the same file from a prior session sitting in recentSensitive,
    // but long enough ago that we're past the cooldown window.  A fresh
    // watcher starts with an empty notifiedFiles → first event must fire.
    const recentSensitive = new Map([[".env", 1000]]);
    const notifiedFiles = new Set();
    const action = classifySensitiveEvent({
      rel: ".env", now: 1_000_000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "fire");
  });

  it("inherits dedup state when notifiedFiles already contains the file", () => {
    // Same Set instance reused across events — that's the in-session case.
    const recentSensitive = new Map();
    const notifiedFiles = new Set([".env"]);
    const action = classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive, cooldownMs: COOLDOWN,
    });
    assert.equal(action, "dedup");
  });
});

describe("classifySensitiveEvent — defaults", () => {
  it("uses the module's SENSITIVE_COOLDOWN_MS when cooldownMs is omitted", () => {
    const { notifiedFiles, recentSensitive } = fresh();
    classifySensitiveEvent({
      rel: ".env", now: 1000, notifiedFiles, recentSensitive,
    });
    // 9.999s later: still inside the default 10s window.
    const action = classifySensitiveEvent({
      rel: ".env", now: 10_999, notifiedFiles, recentSensitive,
    });
    assert.equal(action, "cooldown");
  });
});
