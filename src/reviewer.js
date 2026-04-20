/**
 * AgentGuard Post-Action Reviewer
 *
 * After an agent session completes, shows the developer every file that changed,
 * grouped by sensitivity level.  For sensitive files it shows a colour-coded git
 * diff and asks [K]eep / [R]ollback / [S]kip per file.  Non-sensitive files are
 * just listed quietly.
 *
 * Rollback restores a single file from the snapshot stash rather than popping
 * the whole stash — so the developer gets surgical per-file control.
 */

import { spawnSync } from "child_process";
import readline from "readline";
import chalk from "chalk";
import { log } from "./logger.js";

// ─── risk-level helpers ───────────────────────────────────────────────────────

const SENSITIVE_LEVELS = new Set(["CRITICAL", "HIGH", "WARN"]);

function isSensitive(level) {
  return SENSITIVE_LEVELS.has(level);
}

function levelColor(level) {
  switch (level) {
    case "CRITICAL": return chalk.red.bold(level);
    case "HIGH":     return chalk.red(level);
    case "WARN":     return chalk.yellow(level);
    default:         return chalk.gray(level);
  }
}

// ─── git helpers ─────────────────────────────────────────────────────────────

/**
 * Parse a stash index from a stashRef string like "agentguard-snapshot-..." or
 * "stash@{2}".  Returns the stash@{N} form, or null on failure.
 */
function resolveStashIndex(stashRef) {
  if (!stashRef) return null;

  // Already in stash@{N} form
  if (/^stash@\{\d+\}$/.test(stashRef)) return stashRef;

  // Look up by message
  const list = spawnSync("git", ["stash", "list"], {
    encoding: "utf8",
    timeout: 5000,
  });

  if (list.status !== 0 || list.error) return null;

  for (const line of list.stdout.trim().split("\n")) {
    if (line.includes(stashRef)) {
      const m = line.match(/stash@\{(\d+)\}/);
      if (m) return `stash@{${m[1]}}`;
    }
  }

  return null;
}

/**
 * Return a colourised unified diff for a single file, truncated to maxLines.
 *
 * Primary baseline is the snapshot stash (stash@{N}) captured by
 * `git stash push -u` at session start — its tree covers both tracked and
 * untracked content, so modified files and agent-created files both surface
 * a meaningful diff.  Falls back to `git diff HEAD -- file` when no
 * stashIndex is available (non-git dir or clean tree at session start).
 * Returns null when neither produces output.
 *
 * @param {string}      file       - Relative file path
 * @param {string}      cwd        - Working directory
 * @param {string|null} stashIndex - Resolved stash ref (stash@{N}) or null
 * @param {number}      maxLines   - Maximum diff lines to show (default 50)
 */
function getFileDiff(file, cwd, stashIndex, maxLines = 50) {
  if (stashIndex) {
    const result = spawnSync("git", ["diff", stashIndex, "--", file], {
      encoding: "utf8",
      cwd,
      timeout: 10_000,
    });
    if (result.status === 0 && !result.error && result.stdout.trim()) {
      return colourDiff(result.stdout, maxLines);
    }
  }

  const head = spawnSync("git", ["diff", "HEAD", "--", file], {
    encoding: "utf8",
    cwd,
    timeout: 10_000,
  });
  if (head.status !== 0 || head.error || !head.stdout.trim()) return null;
  return colourDiff(head.stdout, maxLines);
}

/**
 * Colorize a unified diff string.
 * Added lines → green, removed lines → red, hunk headers → cyan, rest → gray.
 */
function colourDiff(diff, maxLines) {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines);
  const extra = lines.length - maxLines;

  const coloured = shown.map((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return chalk.white(line);
    if (line.startsWith("+")) return chalk.green(line);
    if (line.startsWith("-")) return chalk.red(line);
    if (line.startsWith("@@")) return chalk.cyan(line);
    return chalk.gray(line);
  });

  if (extra > 0) {
    coloured.push(chalk.gray(`  ... ${extra} more line${extra === 1 ? "" : "s"}`));
  }

  return coloured.join("\n");
}

/**
 * Restore a single file from the snapshot stash.
 *
 * @param {string} stashIndex - e.g. "stash@{0}"
 * @param {string} file       - Relative file path
 * @param {string} cwd        - Working directory
 * @returns {{ ok: boolean, message: string }}
 */
function restoreFile(stashIndex, file, cwd) {
  const result = spawnSync("git", ["checkout", stashIndex, "--", file], {
    encoding: "utf8",
    cwd,
    timeout: 10_000,
  });

  if (result.status !== 0 || result.error) {
    const msg = (result.stderr || result.error?.message || "").trim();
    return { ok: false, message: msg || "git checkout failed" };
  }

  return { ok: true, message: `Restored ${file} from ${stashIndex}` };
}

// ─── readline prompt helper ───────────────────────────────────────────────────

/**
 * Ask a single-character question on stderr and return the normalised answer.
 * Valid answers: k, r, s (case-insensitive).  Repeats on invalid input.
 */
function askAction(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: false,
    });

    const ask = () => {
      process.stderr.write(prompt);
      rl.once("line", (answer) => {
        const a = answer.trim().toLowerCase();
        if (["k", "r", "s"].includes(a)) {
          rl.close();
          resolve(a);
        } else {
          process.stderr.write(chalk.gray("  Please enter K, R, or S.\n"));
          ask();
        }
      });
    };

    // Handle stdin closed (non-interactive — default to keep)
    rl.once("close", () => resolve("k"));
    ask();
  });
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Show the Post-Action Review UI.
 *
 * @param {Object}   opts
 * @param {Array}    opts.fileChanges  - Array of { file, event, level } from filewatcher
 * @param {string}   [opts.stashRef]  - Stash ref created at session start (may be null)
 * @param {string}   opts.cwd         - Working directory
 *
 * @returns {Promise<{ kept: number, rolledBack: number } | null>}
 *   Returns stats if the review ran (sensitive files existed), or null if skipped.
 */
export async function showPostActionReview({ fileChanges, stashRef, cwd }) {
  if (!fileChanges || fileChanges.length === 0) return null;

  // ── Deduplicate: keep last event per file ─────────────────────────────────
  const byFile = new Map();
  for (const entry of fileChanges) {
    byFile.set(entry.file, entry);
  }
  const changes = Array.from(byFile.values());

  // ── Split into sensitive vs safe ─────────────────────────────────────────
  const sensitiveFiles = changes.filter((c) => isSensitive(c.level));
  const safeFiles = changes.filter((c) => !isSensitive(c.level));

  // ── Always print the full file list ──────────────────────────────────────
  console.error("");
  console.error(chalk.cyan.bold("─── AgentGuard: File Change Summary ──────────────────────"));

  if (sensitiveFiles.length > 0) {
    console.error(chalk.yellow.bold(`  SENSITIVE (${sensitiveFiles.length}):`));
    for (const c of sensitiveFiles) {
      console.error(`    ${levelColor(c.level)}  ${chalk.white(c.file)}  ${chalk.gray(`(${c.event})`)}`);
    }
  }

  if (safeFiles.length > 0) {
    console.error(chalk.gray(`  OTHER (${safeFiles.length}):`));
    for (const c of safeFiles) {
      console.error(chalk.gray(`    ${c.event.padEnd(8)} ${c.file}`));
    }
  }

  console.error(chalk.cyan.bold("──────────────────────────────────────────────────────────"));

  // ── If nothing sensitive changed, we're done ──────────────────────────────
  if (sensitiveFiles.length === 0) {
    console.error(chalk.gray("  No sensitive files changed — review skipped.\n"));
    return null;
  }

  // ── Resolve the stash index once ─────────────────────────────────────────
  let stashIndex = null;
  if (stashRef) {
    stashIndex = resolveStashIndex(stashRef);
    if (!stashIndex) {
      console.error(chalk.yellow(`\n[AgentGuard] ⚠ Could not locate snapshot stash "${stashRef}" — rollback unavailable.`));
    }
  } else {
    console.error(chalk.yellow("\n[AgentGuard] ⚠ No snapshot was created — rollback unavailable."));
  }

  // ── Per-file review ───────────────────────────────────────────────────────
  console.error("");
  console.error(chalk.cyan.bold("─── Post-Action Review ───────────────────────────────────"));
  console.error(chalk.gray("  Review each sensitive file. Choose an action:"));
  console.error(chalk.gray("    [K]eep — accept the agent's change"));
  console.error(chalk.gray("    [R]ollback — restore this file from the snapshot"));
  console.error(chalk.gray("    [S]kip all remaining — keep everything and finish"));
  console.error(chalk.cyan.bold("──────────────────────────────────────────────────────────"));

  let kept = 0;
  let rolledBack = 0;
  let skipAll = false;

  for (const change of sensitiveFiles) {
    if (skipAll) {
      kept++;
      log({ event: "review_kept", file: change.file, level: change.level, reason: "skip_all" });
      continue;
    }

    console.error("");
    console.error(
      chalk.bold(`  File: ${chalk.white(change.file)}`) +
      `  ${levelColor(change.level)}  ${chalk.gray(`(${change.event})`)}`
    );

    // Show diff
    const diff = getFileDiff(change.file, cwd, stashIndex);
    if (diff) {
      console.error(chalk.cyan("  ── diff ──────────────────────────────────────────────────"));
      // Indent diff lines for readability
      for (const line of diff.split("\n")) {
        console.error("  " + line);
      }
      console.error(chalk.cyan("  ──────────────────────────────────────────────────────────"));
    } else {
      console.error(chalk.gray("  (no diff available — file may be untracked or already deleted)"));
    }

    const action = await askAction(
      chalk.white("\n  Action → ") +
      chalk.green("[K]eep") + "  " +
      chalk.red("[R]ollback") + "  " +
      chalk.yellow("[S]kip all") +
      chalk.white(": ")
    );

    if (action === "k") {
      kept++;
      log({ event: "review_kept", file: change.file, level: change.level });
      console.error(chalk.green(`  ✓ Kept: ${change.file}`));
    } else if (action === "r") {
      if (!stashIndex) {
        console.error(chalk.red("  ✗ Rollback unavailable (no snapshot). Keeping change."));
        kept++;
        log({ event: "review_kept", file: change.file, level: change.level, reason: "rollback_unavailable" });
      } else {
        const res = restoreFile(stashIndex, change.file, cwd);
        if (res.ok) {
          rolledBack++;
          log({ event: "review_rolled_back", file: change.file, level: change.level, stashIndex });
          console.error(chalk.green(`  ✓ Rolled back: ${change.file}`));
        } else {
          console.error(chalk.red(`  ✗ Rollback failed: ${res.message}. Keeping change.`));
          kept++;
          log({ event: "review_kept", file: change.file, level: change.level, reason: `rollback_failed: ${res.message}` });
        }
      }
    } else if (action === "s") {
      // Keep this file and all remaining
      kept++;
      skipAll = true;
      log({ event: "review_kept", file: change.file, level: change.level, reason: "skip_all" });
      console.error(chalk.yellow("  ↷ Skipping remaining — all kept."));
    }
  }

  // ── Final tally ───────────────────────────────────────────────────────────
  console.error("");
  console.error(
    chalk.cyan.bold("  Review complete. ") +
    chalk.green(`${kept} kept`) +
    chalk.gray(", ") +
    (rolledBack > 0 ? chalk.red(`${rolledBack} rolled back`) : chalk.gray(`${rolledBack} rolled back`)) +
    chalk.gray(".")
  );
  console.error("");

  return { kept, rolledBack };
}
