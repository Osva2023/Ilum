/**
 * AgentGuard — incident preview tests
 *
 * Run with:
 *   node --test test/preview.test.js
 *
 * Tests cover buildIncidentPreview() selection and fallback logic.
 * No filesystem or child-process side effects — preview.js is pure.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildIncidentPreview } from "../src/preview.js";

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Max visible length of one context line (BOX_WIDTH − borders − prefix). */
const MAX_ITEM_LEN = 49;

// ─── command source ───────────────────────────────────────────────────────────

describe("command incidents", () => {
  it("returns [] — buildDiffPreview handles command previews", () => {
    const result = buildIncidentPreview({
      source: "command",
      level: "HIGH",
      reason: "Dangerous rm detected",
      command: "rm -rf /",
    });
    assert.deepEqual(result, []);
  });

  it("returns [] even when command is missing", () => {
    const result = buildIncidentPreview({ source: "command", level: "HIGH", reason: "x" });
    assert.deepEqual(result, []);
  });
});

// ─── correlation source ───────────────────────────────────────────────────────

describe("correlation incidents", () => {
  it("returns a non-empty array", () => {
    const result = buildIncidentPreview({
      source: "correlation",
      level: "CRITICAL",
      ruleId: "mass-delete",
      reason: "Mass file deletion detected",
    });
    assert.ok(result.length > 0);
  });

  it("identifies the source as correlation", () => {
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: "env-plus-network",
      reason: "Secret file modified then network request",
    });
    assert.ok(result.some((l) => l.includes("correlation")), "should mention 'correlation'");
  });

  it("includes the ruleId", () => {
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: "force-push-after-delete",
      reason: "Force git push following file deletion",
    });
    assert.ok(result.some((l) => l.includes("force-push-after-delete")));
  });

  it("includes the reason when it differs from ruleId", () => {
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: "env-plus-network",
      reason: "Secret file modified then network request — possible exfiltration",
    });
    assert.ok(result.some((l) => l.includes("Secret file modified")));
  });

  it("omits reason when it equals ruleId (no duplicate info)", () => {
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: "same-text",
      reason: "same-text",
    });
    // Should not have a second line repeating the same text
    const matchCount = result.filter((l) => l.includes("same-text")).length;
    assert.equal(matchCount, 1, "ruleId and reason should not both appear when identical");
  });

  it("handles missing ruleId gracefully", () => {
    assert.doesNotThrow(() =>
      buildIncidentPreview({ source: "correlation", reason: "Some pattern fired" })
    );
  });

  it("truncates a very long ruleId to fit the box", () => {
    const longId = "a".repeat(80);
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: longId,
      reason: "description",
    });
    const ruleLine = result.find((l) => l.startsWith("Rule:"));
    assert.ok(ruleLine, "should have a Rule line");
    assert.ok(ruleLine.length <= MAX_ITEM_LEN, `line too long: ${ruleLine.length}`);
  });

  it("truncates a very long reason to fit the box", () => {
    const longReason = "b".repeat(100);
    const result = buildIncidentPreview({
      source: "correlation",
      ruleId: "short-id",
      reason: longReason,
    });
    const matchLine = result.find((l) => l.startsWith("Match:"));
    assert.ok(matchLine, "should have a Match line");
    assert.ok(matchLine.length <= MAX_ITEM_LEN, `line too long: ${matchLine.length}`);
  });
});

// ─── filewatch source ─────────────────────────────────────────────────────────

describe("filewatch incidents", () => {
  it("returns a non-empty array", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      level: "HIGH",
      reason: "Sensitive file modified by agent",
      command: "modified: .env",
    });
    assert.ok(result.length > 0);
  });

  it("identifies the source as filewatch", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      command: "modified: .env",
      reason: "Sensitive file",
    });
    assert.ok(result.some((l) => l.includes("filewatch")));
  });

  it("splits command into event and file when colon-separated", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      command: "modified: .env",
    });
    assert.ok(result.some((l) => l.includes("modified")), "should show event");
    assert.ok(result.some((l) => l.includes(".env")), "should show filename");
  });

  it("shows 'created' event when file is new", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      command: "created: secrets/id_rsa",
    });
    assert.ok(result.some((l) => l.includes("created")));
    assert.ok(result.some((l) => l.includes("secrets/id_rsa")));
  });

  it("falls back to reason when command is absent", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      reason: "CI workflow file modified",
    });
    assert.ok(result.some((l) => l.includes("CI workflow file modified")));
  });

  it("falls back to detail line when command has no colon", () => {
    const result = buildIncidentPreview({
      source: "filewatch",
      command: "some-unstructured-string",
    });
    assert.ok(result.some((l) => l.includes("some-unstructured-string")));
  });

  it("truncates long file paths to fit the box", () => {
    const longPath = "deeply/nested/".repeat(5) + "secretfile.pem";
    const result = buildIncidentPreview({
      source: "filewatch",
      command: `modified: ${longPath}`,
    });
    const fileLine = result.find((l) => l.startsWith("File:"));
    assert.ok(fileLine, "should have a File line");
    assert.ok(fileLine.length <= MAX_ITEM_LEN, `line too long: ${fileLine.length}`);
  });
});

// ─── unknown / missing source ─────────────────────────────────────────────────

describe("unknown or missing source", () => {
  it("returns [] for an unknown source", () => {
    const result = buildIncidentPreview({ source: "unknown", reason: "x" });
    assert.deepEqual(result, []);
  });

  it("returns [] when incident is null", () => {
    assert.deepEqual(buildIncidentPreview(null), []);
  });

  it("returns [] when incident is undefined", () => {
    assert.deepEqual(buildIncidentPreview(undefined), []);
  });

  it("returns [] when source is absent", () => {
    const result = buildIncidentPreview({ level: "HIGH", reason: "something" });
    assert.deepEqual(result, []);
  });

  it("always returns an array", () => {
    for (const input of [null, undefined, {}, { source: "correlation" }]) {
      assert.ok(Array.isArray(buildIncidentPreview(input)));
    }
  });
});
