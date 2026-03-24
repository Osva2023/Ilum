/**
 * test/config.test.js — plain Node.js, no external test runner
 */
import assert from "assert";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const { loadConfig, mergeConfig, DEFAULT_CONFIG } = await import("../src/config.js");

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch(e) { console.error(`  ✗ ${name}\n    ${e.message}`); failed++; }
}

function makeTmp() {
  const dir = join(tmpdir(), `ag-cfg-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

console.log("loadConfig():");

test("returns defaults when no config file exists", () => {
  const cfg = loadConfig("/nonexistent/dir/that/does/not/exist");
  assert.deepStrictEqual(cfg.autoApprove, []);
  assert.deepStrictEqual(cfg.autoDeny, []);
  assert.strictEqual(cfg.snapshot.enabled, true);
});

test("loads local agentguard.config.json", () => {
  const dir = makeTmp();
  writeFileSync(join(dir, "agentguard.config.json"), JSON.stringify({ autoApprove: ["WARN"] }));
  const cfg = loadConfig(dir);
  assert.deepStrictEqual(cfg.autoApprove, ["WARN"]);
  rmSync(dir, { recursive: true });
});

test("merges snapshot overrides with defaults", () => {
  const dir = makeTmp();
  writeFileSync(join(dir, "agentguard.config.json"), JSON.stringify({ snapshot: { restoreOnDeny: false } }));
  const cfg = loadConfig(dir);
  assert.strictEqual(cfg.snapshot.enabled, true);       // default kept
  assert.strictEqual(cfg.snapshot.restoreOnDeny, false); // override applied
  rmSync(dir, { recursive: true });
});

test("invalid JSON falls back to defaults gracefully", () => {
  const dir = makeTmp();
  writeFileSync(join(dir, "agentguard.config.json"), "not json{{");
  const cfg = loadConfig(dir);
  assert.deepStrictEqual(cfg.autoApprove, []);
  rmSync(dir, { recursive: true });
});

console.log("\nmergeConfig():");

test("custom rules are applied", () => {
  const custom = [{ pattern: "deploy.sh", level: "HIGH", reason: "Deploy" }];
  const cfg = mergeConfig(DEFAULT_CONFIG, { rules: { custom } });
  assert.strictEqual(cfg.rules.custom[0].pattern, "deploy.sh");
});

test("autoDeny override replaces default", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, { autoDeny: ["CRITICAL"] });
  assert.deepStrictEqual(cfg.autoDeny, ["CRITICAL"]);
});

console.log(`\n${failed === 0 ? "All tests passed." : `${failed} test(s) FAILED.`}`);
if (failed > 0) process.exit(1);
