/**
 * test/config.test.js — plain Node.js, no external test runner
 */
import assert from "assert";
import { writeFileSync, readFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir, homedir } from "os";

const { loadConfig, mergeConfig, DEFAULT_CONFIG, addWatchPath, expandPath } =
  await import("../src/config.js");

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
  assert.deepStrictEqual(cfg.autoDeny, ["CRITICAL"]);
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

test("notifications.dailyReport defaults: disabled, hour 8 (TASK-013)", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {});
  assert.strictEqual(cfg.notifications.dailyReport.enabled, false);
  assert.strictEqual(cfg.notifications.dailyReport.hour, 8);
});

test("notifications.dailyReport override merges with defaults (TASK-013)", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    notifications: { dailyReport: { enabled: true, hour: 7 } },
  });
  assert.strictEqual(cfg.notifications.dailyReport.enabled, true);
  assert.strictEqual(cfg.notifications.dailyReport.hour, 7);
  // partial override keeps the unspecified default
  const cfg2 = mergeConfig(DEFAULT_CONFIG, {
    notifications: { dailyReport: { enabled: true } },
  });
  assert.strictEqual(cfg2.notifications.dailyReport.hour, 8);
});

test("notifications.email default is disabled (TASK-012)", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {});
  assert.strictEqual(cfg.notifications.email.enabled, false);
  assert.strictEqual(cfg.notifications.email.smtp.secure, true);
});

test("notifications.email partial smtp override keeps other smtp defaults (TASK-012)", () => {
  const cfg = mergeConfig(DEFAULT_CONFIG, {
    notifications: { email: { enabled: true, smtp: { host: "smtp.x.com", secure: false }, to: "me@x.com" } },
  });
  assert.strictEqual(cfg.notifications.email.enabled, true);
  assert.strictEqual(cfg.notifications.email.smtp.host, "smtp.x.com");
  assert.strictEqual(cfg.notifications.email.smtp.secure, false); // overridden
  assert.strictEqual(cfg.notifications.email.smtp.port, 465);     // default kept
  assert.strictEqual(cfg.notifications.email.to, "me@x.com");
  // Telegram defaults untouched by an email-only override.
  assert.strictEqual(cfg.notifications.telegram.enabled, false);
});

console.log("\naddWatchPath():  (TASK-015)");

test("expandPath — expands ~ and resolves to absolute", () => {
  assert.strictEqual(expandPath("~"), homedir());
  assert.strictEqual(expandPath("~/x"), join(homedir(), "x"));
  assert.strictEqual(expandPath("/abs/path"), "/abs/path");
  assert.strictEqual(expandPath(""), null);
});

test("adds a new valid directory and writes config", () => {
  const dir = makeTmp();
  const cfgPath = join(dir, "config.json");
  const r = addWatchPath(cfgPath, dir);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, "added");
  assert.deepStrictEqual(r.watchPaths, [dir]);
  assert.deepStrictEqual(JSON.parse(readFileSync(cfgPath, "utf8")).watchPaths, [dir]);
  rmSync(dir, { recursive: true });
});

test("does not duplicate an already-present path", () => {
  const dir = makeTmp();
  const cfgPath = join(dir, "config.json");
  addWatchPath(cfgPath, dir);
  const r = addWatchPath(cfgPath, dir);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, "exists");
  assert.strictEqual(JSON.parse(readFileSync(cfgPath, "utf8")).watchPaths.length, 1);
  rmSync(dir, { recursive: true });
});

test("rejects a non-existent / non-directory path", () => {
  const dir = makeTmp();
  const cfgPath = join(dir, "config.json");
  const r = addWatchPath(cfgPath, join(dir, "does-not-exist"));
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, "invalid");
  rmSync(dir, { recursive: true });
});

test("preserves other config keys when adding a path", () => {
  const dir = makeTmp();
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify({ autoDeny: ["CRITICAL"], watchPaths: [] }));
  const r = addWatchPath(cfgPath, dir);
  assert.strictEqual(r.ok, true);
  const written = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.deepStrictEqual(written.autoDeny, ["CRITICAL"]);
  assert.deepStrictEqual(written.watchPaths, [dir]);
  rmSync(dir, { recursive: true });
});

console.log(`\n${failed === 0 ? "All tests passed." : `${failed} test(s) FAILED.`}`);
if (failed > 0) process.exit(1);
