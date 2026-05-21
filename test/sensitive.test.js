/**
 * AgentGuard — sensitive-file detection tests
 *
 * Run with:
 *   node --test test/sensitive.test.js
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSensitive } from "../src/sensitive.js";

describe("isSensitive — agent memory files", () => {
  it("treats CLAUDE.md as sensitive (not swallowed by .md safe extension)", () => {
    assert.equal(isSensitive("CLAUDE.md"), true);
  });

  it("treats .cursorrules as sensitive", () => {
    assert.equal(isSensitive(".cursorrules"), true);
  });

  it("treats nested .claude/memory files as sensitive", () => {
    assert.equal(isSensitive(".claude/memory/foo.md"), true);
  });

  it("treats .hermes/ directory files as sensitive", () => {
    assert.equal(isSensitive(".hermes/memory.db"), true);
  });
});

describe("isSensitive — regular markdown is not sensitive", () => {
  it("README.md is not sensitive", () => {
    assert.equal(isSensitive("README.md"), false);
  });

  it("regular.md is not sensitive", () => {
    assert.equal(isSensitive("regular.md"), false);
  });
});

describe("isSensitive — regression: existing patterns still fire", () => {
  it(".env is still sensitive", () => {
    assert.equal(isSensitive(".env"), true);
  });
});
