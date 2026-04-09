/**
 * AgentGuard — policy pack tests
 *
 * Run with:
 *   node --test test/policy-packs.test.js
 *
 * Tests cover:
 *   - pack definitions (expected values for each named pack)
 *   - loadConfig with policy field (pack is applied)
 *   - merge precedence: defaults < pack < project overrides
 *   - unknown policy name (graceful fallback, no crash)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { POLICY_PACKS, loadConfig, mergeConfig, DEFAULT_CONFIG } from "../src/config.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmp() {
  const dir = join(tmpdir(), `ag-pack-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeConfig(dir, obj) {
  writeFileSync(join(dir, "agentguard.config.json"), JSON.stringify(obj));
}

// ─── pack definitions ─────────────────────────────────────────────────────────

describe("POLICY_PACKS — definitions", () => {
  it("exports POLICY_PACKS with dev, strict, ci keys", () => {
    assert.ok(typeof POLICY_PACKS === "object");
    assert.ok("dev" in POLICY_PACKS);
    assert.ok("strict" in POLICY_PACKS);
    assert.ok("ci" in POLICY_PACKS);
  });

  it("dev: autoApproves WARN, autoDenies CRITICAL only", () => {
    assert.deepEqual(POLICY_PACKS.dev.autoApprove, ["WARN"]);
    assert.deepEqual(POLICY_PACKS.dev.autoDeny, ["CRITICAL"]);
  });

  it("strict: nothing auto-approved, HIGH + CRITICAL auto-denied", () => {
    assert.deepEqual(POLICY_PACKS.strict.autoApprove, []);
    assert.ok(POLICY_PACKS.strict.autoDeny.includes("CRITICAL"));
    assert.ok(POLICY_PACKS.strict.autoDeny.includes("HIGH"));
  });

  it("ci: all risk levels auto-denied", () => {
    assert.deepEqual(POLICY_PACKS.ci.autoApprove, []);
    assert.ok(POLICY_PACKS.ci.autoDeny.includes("CRITICAL"));
    assert.ok(POLICY_PACKS.ci.autoDeny.includes("HIGH"));
    assert.ok(POLICY_PACKS.ci.autoDeny.includes("WARN"));
  });

  it("strict autoDeny is a superset of dev autoDeny", () => {
    for (const level of POLICY_PACKS.dev.autoDeny) {
      assert.ok(POLICY_PACKS.strict.autoDeny.includes(level),
        `strict.autoDeny should include "${level}" from dev.autoDeny`);
    }
  });

  it("ci autoDeny is a superset of strict autoDeny", () => {
    for (const level of POLICY_PACKS.strict.autoDeny) {
      assert.ok(POLICY_PACKS.ci.autoDeny.includes(level),
        `ci.autoDeny should include "${level}" from strict.autoDeny`);
    }
  });
});

// ─── loadConfig with policy ───────────────────────────────────────────────────

describe("loadConfig — policy field applies the pack", () => {
  it("policy:dev → autoApprove includes WARN", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "dev" });
      const cfg = loadConfig(dir);
      assert.ok(cfg.autoApprove.includes("WARN"));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy:dev → autoDeny contains CRITICAL only", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "dev" });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoDeny, ["CRITICAL"]);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy:strict → autoApprove is empty", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "strict" });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoApprove, []);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy:strict → autoDeny includes HIGH and CRITICAL", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "strict" });
      const cfg = loadConfig(dir);
      assert.ok(cfg.autoDeny.includes("HIGH"));
      assert.ok(cfg.autoDeny.includes("CRITICAL"));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy:ci → autoDeny includes WARN, HIGH, CRITICAL", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "ci" });
      const cfg = loadConfig(dir);
      assert.ok(cfg.autoDeny.includes("WARN"));
      assert.ok(cfg.autoDeny.includes("HIGH"));
      assert.ok(cfg.autoDeny.includes("CRITICAL"));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy:ci → autoApprove is empty", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "ci" });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoApprove, []);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("policy does not affect snapshot defaults", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "ci" });
      const cfg = loadConfig(dir);
      assert.equal(cfg.snapshot.enabled, true);
      assert.equal(cfg.snapshot.restoreOnDeny, true);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("no policy field → returns default behavior", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, {});
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoApprove, DEFAULT_CONFIG.autoApprove);
      assert.deepEqual(cfg.autoDeny, DEFAULT_CONFIG.autoDeny);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── merge precedence ─────────────────────────────────────────────────────────

describe("merge precedence: defaults < pack < project overrides", () => {
  it("project autoDeny overrides pack autoDeny", () => {
    const dir = makeTmp();
    try {
      // dev pack sets autoDeny:["CRITICAL"], but project overrides to []
      writeConfig(dir, { policy: "dev", autoDeny: [] });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoDeny, []);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("project autoApprove overrides pack autoApprove", () => {
    const dir = makeTmp();
    try {
      // dev pack sets autoApprove:["WARN"], but project sets []
      writeConfig(dir, { policy: "dev", autoApprove: [] });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoApprove, []);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("project can extend pack autoDeny (fully replaces — not merged)", () => {
    const dir = makeTmp();
    try {
      // strict pack sets autoDeny:["CRITICAL","HIGH"]
      // project sets autoDeny:["CRITICAL","HIGH","WARN"] — full replacement
      writeConfig(dir, { policy: "strict", autoDeny: ["CRITICAL", "HIGH", "WARN"] });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoDeny, ["CRITICAL", "HIGH", "WARN"]);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("project snapshot settings override pack defaults", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "ci", snapshot: { restoreOnDeny: false } });
      const cfg = loadConfig(dir);
      assert.equal(cfg.snapshot.restoreOnDeny, false);
      assert.equal(cfg.snapshot.enabled, true); // default preserved
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("project custom rules override pack (pack has no rules)", () => {
    const dir = makeTmp();
    const custom = [{ pattern: "deploy.sh", level: "HIGH", reason: "Deploy" }];
    try {
      writeConfig(dir, { policy: "strict", rules: { custom } });
      const cfg = loadConfig(dir);
      assert.equal(cfg.rules.custom.length, 1);
      assert.equal(cfg.rules.custom[0].pattern, "deploy.sh");
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("pack fields not present in project config are preserved", () => {
    const dir = makeTmp();
    try {
      // dev sets autoApprove:["WARN"] — project only sets autoDeny
      writeConfig(dir, { policy: "dev", autoDeny: [] });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoApprove, ["WARN"], "pack autoApprove should be preserved");
      assert.deepEqual(cfg.autoDeny, [], "project autoDeny should win");
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── unknown policy ───────────────────────────────────────────────────────────

describe("unknown policy name — graceful fallback", () => {
  it("does not throw", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "nonexistent-pack" });
      assert.doesNotThrow(() => loadConfig(dir));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it("falls back to DEFAULT_CONFIG behavior", () => {
    const dir = makeTmp();
    try {
      writeConfig(dir, { policy: "nonexistent-pack" });
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.autoDeny, DEFAULT_CONFIG.autoDeny);
      assert.deepEqual(cfg.autoApprove, DEFAULT_CONFIG.autoApprove);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

// ─── mergeConfig with pack ────────────────────────────────────────────────────

describe("mergeConfig — pack as intermediate layer", () => {
  it("applying dev pack raises autoApprove from empty to [WARN]", () => {
    const withPack = mergeConfig(DEFAULT_CONFIG, POLICY_PACKS.dev);
    assert.deepEqual(withPack.autoApprove, ["WARN"]);
  });

  it("user override wins over pack when applied on top", () => {
    const withPack = mergeConfig(DEFAULT_CONFIG, POLICY_PACKS.dev);
    const final = mergeConfig(withPack, { autoApprove: [] });
    assert.deepEqual(final.autoApprove, []);
  });

  it("pack fields not overridden by user are preserved through second merge", () => {
    const withPack = mergeConfig(DEFAULT_CONFIG, POLICY_PACKS.strict);
    // user only specifies snapshot — autoDeny should come from strict pack
    const final = mergeConfig(withPack, { snapshot: { restoreOnDeny: false } });
    assert.deepEqual(final.autoDeny, POLICY_PACKS.strict.autoDeny);
    assert.equal(final.snapshot.restoreOnDeny, false);
  });
});
