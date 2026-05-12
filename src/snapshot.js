/**
 * AgentGuard Snapshot
 *
 * Creates a git stash before the agent session starts so the user can
 * roll back any changes the agent makes.  Silently no-ops when the current
 * directory is not a git repository.
 */

import { execSync, spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { logSnapshot, AGENTGUARD_DIR, sessionId } from "./logger.js";
import { isSensitive } from "./sensitive.js";

/**
 * Check whether the current working directory is inside a git repository.
 *
 * @returns {boolean}
 */
function isGitRepo(cwd) {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd,
      stdio: "ignore",
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the current `stash@{N}` index for a stash message ref.  Tolerates
 * intervening user stashes (which shift indices) by searching the list
 * for our recorded message.
 *
 * @param {string} stashRef  The message used at stash time.
 * @param {string} [cwd]
 * @returns {string|null}     "stash@{N}" or null if not found.
 */
function findStashIndexByRef(stashRef, cwd) {
  const listResult = spawnSync("git", ["stash", "list"], {
    cwd,
    encoding: "utf8",
    timeout: 5000,
  });
  if (listResult.status !== 0 || listResult.error) return null;
  const lines = listResult.stdout.trim().split("\n");
  const matchLine = lines.find((l) => l.includes(stashRef));
  if (!matchLine) return null;
  const m = matchLine.match(/stash@\{(\d+)\}/);
  return m ? `stash@{${m[1]}}` : null;
}

// Directories never descended into when scanning for sensitive files.
// Mirrors the ignore list in filewatcher.js.
const IGNORED_DIRS = new Set(["node_modules", ".git", ".agentguard"]);

/**
 * Walk the working tree and return all files matching SENSITIVE_PATTERNS.
 * Catches gitignored files (.env, *.key, *.pem, ...) that `git stash -u`
 * silently skips.
 */
function findSensitiveFiles(root) {
  const results = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile() && isSensitive(rel)) {
        results.push({ abs, rel });
      }
    }
  };
  walk(root);
  return results;
}

/**
 * Copy every sensitive file under `cwd` to
 * ~/.agentguard/snapshots/{sessionId}/{relative-path}.
 * Returns the backup directory path (or null if nothing was backed up).
 */
function backupSensitiveFiles(cwd) {
  const files = findSensitiveFiles(cwd);
  if (files.length === 0) return { dir: null, count: 0 };

  const backupDir = path.join(AGENTGUARD_DIR, "snapshots", sessionId);
  for (const { abs, rel } of files) {
    const dest = path.join(backupDir, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(abs, dest);
    } catch {
      // Best-effort — a single failed copy shouldn't abort the snapshot.
    }
  }
  return { dir: backupDir, count: files.length };
}

/**
 * Create a snapshot stash with a timestamped message.
 * Includes untracked files (-u) so the full working tree is preserved.
 *
 * Also copies any sensitive files (.env, *.key, *.pem, ...) to a
 * per-session backup directory, since `git stash -u` skips gitignored
 * files and those are the ones most worth protecting.
 *
 * @returns {{ created: boolean, stashRef: string|null, sensitiveBackupDir: string|null, message: string }}
 */
export function createSnapshot() {
  if (!isGitRepo()) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: null,
      message: "Not a git repository — snapshot skipped.",
    };
  }

  const backup = backupSensitiveFiles(process.cwd());

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const stashMsg = `agentguard-snapshot-${timestamp}`;

  const result = spawnSync("git", ["stash", "-u", "-m", stashMsg], {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (result.error) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: `Snapshot failed: ${result.error.message}`,
    };
  }

  if (result.status !== 0) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: `Snapshot failed (git exit ${result.status}): ${result.stderr.trim()}`,
    };
  }

  const stdout = result.stdout.trim();

  // git stash outputs "No local changes to save" when tree is clean
  if (stdout.startsWith("No local changes")) {
    return {
      created: false,
      stashRef: null,
      sensitiveBackupDir: backup.dir,
      message: "Working tree clean — no snapshot needed.",
    };
  }

  // Typical output: "Saved working directory and index state On main: agentguard-snapshot-..."
  logSnapshot(stashMsg);

  return {
    created: true,
    stashRef: stashMsg,
    sensitiveBackupDir: backup.dir,
    message: `Snapshot created: stash "${stashMsg}"`,
  };
}

/**
 * Restore the most recent agentguard snapshot stash (pop it).
 * Used when the user denies a critical operation and wants to roll back.
 *
 * @param {string} stashRef - The stash message used when the snapshot was created.
 * @returns {{ restored: boolean, message: string }}
 */
export function restoreSnapshot(stashRef) {
  if (!isGitRepo()) {
    return { restored: false, message: "Not a git repository." };
  }

  const stashIndex = findStashIndexByRef(stashRef);
  if (!stashIndex) {
    return {
      restored: false,
      message: `Snapshot stash not found for ref: ${stashRef}`,
    };
  }

  const popResult = spawnSync("git", ["stash", "pop", stashIndex], {
    encoding: "utf8",
    timeout: 15_000,
  });

  if (popResult.status !== 0 || popResult.error) {
    return {
      restored: false,
      message: `Stash pop failed: ${(popResult.stderr || popResult.error?.message || "").trim()}`,
    };
  }

  return {
    restored: true,
    message: `Snapshot restored from stash "${stashRef}".`,
  };
}

/**
 * Restore a single file to its pre-session state without consuming the stash.
 *
 * Chain (first that succeeds wins):
 *   1. event === "created"      → unlink the file (it didn't exist before)
 *   2. git checkout stash@{N} -- <relPath>     (file tracked at snapshot time)
 *   3. git checkout stash@{N}^3 -- <relPath>   (untracked at snapshot time —
 *                                               ^3 is the untracked-files
 *                                               parent created by `git stash -u`)
 *   4. fs.copyFileSync from sensitiveBackupDir (catches .gitignore'd files
 *                                               that git stash silently skips)
 *
 * Never pops or drops the stash — the same session may need to restore
 * other files later.  The stash index is looked up dynamically by message
 * so an intervening `git stash push` from the user does not break us.
 *
 * @param {Object} opts
 * @param {string}      opts.relPath               Path relative to cwd
 * @param {string}      opts.event                 "created" | "modified" | "deleted"
 * @param {string|null} [opts.stashRef]            Stash message (from createSnapshot)
 * @param {string|null} [opts.sensitiveBackupDir]  Per-session backup dir
 * @param {string}      [opts.cwd]                 Defaults to process.cwd()
 * @returns {{ restored: boolean, mode: string, message: string }}
 *          mode ∈ "delete" | "stash-tracked" | "stash-untracked"
 *                | "backup-copy" | "none"
 */
export function restoreFile({
  relPath,
  event,
  stashRef,
  sensitiveBackupDir,
  cwd = process.cwd(),
}) {
  const absPath = path.resolve(cwd, relPath);

  // ── 1. Created files → delete ─────────────────────────────────────────────
  if (event === "created") {
    try {
      fs.unlinkSync(absPath);
      return { restored: true, mode: "delete", message: `Deleted ${relPath}` };
    } catch (err) {
      if (err.code === "ENOENT") {
        return { restored: true, mode: "delete", message: `${relPath} already absent` };
      }
      return { restored: false, mode: "delete", message: `Delete failed: ${err.message}` };
    }
  }

  // ── 2/3. Git stash restore ────────────────────────────────────────────────
  if (isGitRepo(cwd) && stashRef) {
    const stashIndex = findStashIndexByRef(stashRef, cwd);
    if (stashIndex) {
      const tracked = spawnSync(
        "git",
        ["checkout", stashIndex, "--", relPath],
        { cwd, encoding: "utf8", timeout: 15_000 }
      );
      if (tracked.status === 0) {
        return {
          restored: true,
          mode: "stash-tracked",
          message: `Restored ${relPath} from ${stashIndex}`,
        };
      }

      const untracked = spawnSync(
        "git",
        ["checkout", `${stashIndex}^3`, "--", relPath],
        { cwd, encoding: "utf8", timeout: 15_000 }
      );
      if (untracked.status === 0) {
        return {
          restored: true,
          mode: "stash-untracked",
          message: `Restored ${relPath} from ${stashIndex}^3`,
        };
      }
    }
  }

  // ── 4. Backup-copy fallback ───────────────────────────────────────────────
  if (sensitiveBackupDir) {
    const src = path.join(sensitiveBackupDir, relPath);
    if (fs.existsSync(src)) {
      try {
        fs.mkdirSync(path.dirname(absPath), { recursive: true });
        fs.copyFileSync(src, absPath);
        return {
          restored: true,
          mode: "backup-copy",
          message: `Restored ${relPath} from backup`,
        };
      } catch (err) {
        return {
          restored: false,
          mode: "backup-copy",
          message: `Backup copy failed: ${err.message}`,
        };
      }
    }
  }

  return {
    restored: false,
    mode: "none",
    message: `No source available to restore ${relPath}`,
  };
}
