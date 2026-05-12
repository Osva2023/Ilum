/**
 * AgentGuard snapshot.restoreFile() tests (plain Node.js, no test runner)
 *
 * Exercises the per-file restore chain against real temporary git repos.
 *
 * Tests:
 *   1.  created event → file is deleted
 *   2.  created event, file already gone → still success
 *   3.  modified tracked file → restored from stash@{N}
 *   4.  untracked-at-stash-time file → restored from stash@{N}^3
 *   5.  stash drift — intervening user stash → still finds correct stash
 *   6.  git fails → restored from sensitiveBackupDir
 *   7.  not a git repo + backup → restored via backup
 *   8.  no stash + no backup → restored: false, mode: none
 *   9.  logFileRestore writes file_restore audit entry
 *  10.  logFileRestore omits `by` when not provided
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import assert from "assert";
import { restoreFile } from "../src/snapshot.js";
import { logFileRestore, setSink } from "../src/logger.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.stack || err.message}`);
    failed++;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function mkTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentguard-restore-"));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

function sh(cwd, cmd) {
  execSync(cmd, { cwd, stdio: "pipe" });
}

function makeGitRepo(dir) {
  sh(dir, "git init");
  sh(dir, "git config user.email test@example.com");
  sh(dir, "git config user.name Test");
  sh(dir, "git config commit.gpgsign false");
  fs.writeFileSync(path.join(dir, ".gitkeep"), "");
  sh(dir, "git add .gitkeep");
  sh(dir, 'git commit -m initial');
}

function inRepo(fn) {
  const dir = mkTmpDir();
  try {
    makeGitRepo(dir);
    fn(dir);
  } finally {
    cleanup(dir);
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log("\nsnapshot-restore-file.test.js\n");

test("created event → file is deleted", () => {
  inRepo((dir) => {
    fs.writeFileSync(path.join(dir, "newfile.txt"), "content");
    const result = restoreFile({ relPath: "newfile.txt", event: "created", cwd: dir });
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.mode, "delete");
    assert.strictEqual(fs.existsSync(path.join(dir, "newfile.txt")), false);
  });
});

test("created event, file already absent → still success", () => {
  inRepo((dir) => {
    const result = restoreFile({ relPath: "missing.txt", event: "created", cwd: dir });
    assert.strictEqual(result.restored, true);
    assert.strictEqual(result.mode, "delete");
  });
});

test("modified tracked file → restored from stash", () => {
  inRepo((dir) => {
    const file = "tracked.txt";
    const fp = path.join(dir, file);
    fs.writeFileSync(fp, "v1\n");
    sh(dir, `git add ${file}`);
    sh(dir, 'git commit -m "add tracked"');
    fs.writeFileSync(fp, "v2\n");                       // pre-session uncommitted
    sh(dir, 'git stash -u -m agentguard-snapshot-test');
    fs.writeFileSync(fp, "v3\n");                       // agent overwrite

    const result = restoreFile({
      relPath: file,
      event: "modified",
      stashRef: "agentguard-snapshot-test",
      cwd: dir,
    });

    assert.strictEqual(result.restored, true, result.message);
    assert.strictEqual(result.mode, "stash-tracked");
    assert.strictEqual(fs.readFileSync(fp, "utf8"), "v2\n");
  });
});

test("untracked-at-stash-time file → restored from stash^3", () => {
  inRepo((dir) => {
    const file = "untracked.env";
    const fp = path.join(dir, file);
    fs.writeFileSync(fp, "u1\n");                       // untracked, pre-session
    sh(dir, 'git stash -u -m agentguard-snapshot-test');// stash captures it under ^3
    fs.writeFileSync(fp, "u2\n");                       // agent rewrites

    const result = restoreFile({
      relPath: file,
      event: "modified",
      stashRef: "agentguard-snapshot-test",
      cwd: dir,
    });

    assert.strictEqual(result.restored, true, result.message);
    assert.strictEqual(result.mode, "stash-untracked");
    assert.strictEqual(fs.readFileSync(fp, "utf8"), "u1\n");
  });
});

test("stash drift — intervening user stash → still finds correct stash", () => {
  inRepo((dir) => {
    const file = "tracked.txt";
    const fp = path.join(dir, file);
    fs.writeFileSync(fp, "v1\n");
    sh(dir, `git add ${file}`);
    sh(dir, 'git commit -m "add tracked"');
    fs.writeFileSync(fp, "v2\n");
    sh(dir, 'git stash -u -m agentguard-snapshot-drift'); // our snapshot

    // user makes a totally separate stash AFTER ours
    const other = "other.txt";
    fs.writeFileSync(path.join(dir, other), "o1\n");
    sh(dir, `git add ${other}`);
    sh(dir, 'git commit -m "add other"');
    fs.writeFileSync(path.join(dir, other), "user-edit\n");
    sh(dir, 'git stash -u -m "user-own-stash"');         // pushes ours to stash@{1}

    // agent then mangles tracked.txt
    fs.writeFileSync(fp, "v3\n");

    const result = restoreFile({
      relPath: file,
      event: "modified",
      stashRef: "agentguard-snapshot-drift",
      cwd: dir,
    });

    assert.strictEqual(result.restored, true, result.message);
    assert.strictEqual(result.mode, "stash-tracked");
    assert.strictEqual(fs.readFileSync(fp, "utf8"), "v2\n");
  });
});

test("git fails → restored from sensitiveBackupDir", () => {
  inRepo((dir) => {
    const backupDir = path.join(dir, "_backup");
    const file = "secrets/.env";
    const fp = path.join(dir, file);
    const backupFp = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(backupFp), { recursive: true });
    fs.writeFileSync(backupFp, "ORIGINAL\n");
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, "AGENT_OVERWROTE\n");

    // no stashRef → skips git path entirely, falls through to backup
    const result = restoreFile({
      relPath: file,
      event: "modified",
      sensitiveBackupDir: backupDir,
      cwd: dir,
    });

    assert.strictEqual(result.restored, true, result.message);
    assert.strictEqual(result.mode, "backup-copy");
    assert.strictEqual(fs.readFileSync(fp, "utf8"), "ORIGINAL\n");
  });
});

test("not a git repo + backup → restored via backup", () => {
  const dir = mkTmpDir();
  const backupDir = path.join(dir, "_backup");
  try {
    const file = ".env";
    fs.writeFileSync(path.join(dir, file), "AGENT\n");
    fs.mkdirSync(backupDir);
    fs.writeFileSync(path.join(backupDir, file), "ORIG\n");

    const result = restoreFile({
      relPath: file,
      event: "modified",
      stashRef: "ignored",
      sensitiveBackupDir: backupDir,
      cwd: dir,
    });

    assert.strictEqual(result.restored, true, result.message);
    assert.strictEqual(result.mode, "backup-copy");
    assert.strictEqual(fs.readFileSync(path.join(dir, file), "utf8"), "ORIG\n");
  } finally {
    cleanup(dir);
  }
});

test("no stash + no backup → restored: false, mode: none", () => {
  inRepo((dir) => {
    fs.writeFileSync(path.join(dir, "lonely.txt"), "lone\n");
    const result = restoreFile({
      relPath: "lonely.txt",
      event: "modified",
      cwd: dir,
    });
    assert.strictEqual(result.restored, false);
    assert.strictEqual(result.mode, "none");
  });
});

test("logFileRestore writes file_restore audit entry", () => {
  let captured = null;
  setSink((line) => { captured = JSON.parse(line); });
  try {
    logFileRestore(
      { restored: true, mode: "stash-tracked", message: "Restored x.txt" },
      { file: "x.txt", by: "morphius101" },
      "claude"
    );
  } finally {
    setSink(() => {});
  }
  assert.strictEqual(captured.event, "file_restore");
  assert.strictEqual(captured.restored, true);
  assert.strictEqual(captured.mode, "stash-tracked");
  assert.strictEqual(captured.file, "x.txt");
  assert.strictEqual(captured.by, "morphius101");
  assert.strictEqual(captured.agent, "claude");
});

test("logFileRestore omits `by` when not provided", () => {
  let captured = null;
  setSink((line) => { captured = JSON.parse(line); });
  try {
    logFileRestore(
      { restored: false, mode: "none", message: "nothing" },
      { file: "x.txt" }
    );
  } finally {
    setSink(() => {});
  }
  assert.strictEqual(captured.event, "file_restore");
  assert.strictEqual("by" in captured, false);
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
