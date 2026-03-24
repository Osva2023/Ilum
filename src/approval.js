/**
 * AgentGuard Approval Prompt
 *
 * Renders a bordered approval UI in the terminal and reads a single keypress
 * response (A / D / Q).  Falls back gracefully when stdin is not a TTY
 * (e.g. in CI or when piped) by defaulting to "deny" with a clear message.
 *
 * Phase 1 additions:
 *   • buildDiffPreview(command) — generates context-sensitive previews
 *     (files at risk, current file contents, git diff/log snippets) shown
 *     inside the approval box between the risk info and the action line.
 */

import readline from "readline";
import chalk from "chalk";
import { execSync } from "child_process";

// ─── box drawing ─────────────────────────────────────────────────────────────

const BOX_WIDTH = 55;

function repeat(ch, n) {
  return ch.repeat(Math.max(0, n));
}

function boxTop() {
  return chalk.yellow("┌" + repeat("─", BOX_WIDTH) + "┐");
}

function boxBottom() {
  return chalk.yellow("└" + repeat("─", BOX_WIDTH) + "┘");
}

function boxDivider() {
  return chalk.yellow("├" + repeat("─", BOX_WIDTH) + "┤");
}

/**
 * Render a single row, padding content to BOX_WIDTH chars.
 * Content is plain text; caller is responsible for chalk styling.
 */
function boxRow(content) {
  // Strip ANSI escape codes for length calculation
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\x1B\[[0-9;]*m/g;
  const visibleLen = content.replace(ansiRe, "").length;
  const padding = repeat(" ", Math.max(0, BOX_WIDTH - visibleLen));
  return chalk.yellow("│") + content + padding + chalk.yellow("│");
}

// ─── level colors ────────────────────────────────────────────────────────────

function colorLevel(level) {
  switch (level) {
    case "CRITICAL":
      return chalk.bgRed.white.bold(` ${level} `);
    case "HIGH":
      return chalk.red.bold(level);
    case "WARN":
      return chalk.yellow.bold(level);
    default:
      return chalk.green(level);
  }
}

function levelIcon(level) {
  switch (level) {
    case "CRITICAL":
      return "🚨";
    case "HIGH":
      return "⚠️ ";
    case "WARN":
      return "⚡";
    default:
      return "✅";
  }
}

// ─── diff preview ─────────────────────────────────────────────────────────────

/**
 * Build a context-sensitive diff/preview for commands that modify the
 * filesystem or repository.  Returns an array of plain-text lines (already
 * truncated to fit inside the box) to show between the risk info and the
 * [A/D/Q] prompt.  Returns an empty array when nothing useful can be shown.
 *
 * Supported cases:
 *   • rm …          → list files that would be deleted (via find)
 *   • > .env / config files → show first 20 lines of the target file
 *   • git reset --hard → show git diff --stat HEAD (what would be lost)
 *   • git push --force → show git log --oneline -5 (commits at risk)
 *
 * @param {string} command
 * @returns {string[]}
 */
export function buildDiffPreview(command) {
  const lines = [];

  // Helper: run a shell command safely, return trimmed output or "".
  function run(cmd) {
    try {
      return execSync(cmd, { timeout: 3000, encoding: "utf8" }).trim();
    } catch {
      return "";
    }
  }

  // Helper: truncate a line so it fits in the box with a 4-char indent.
  const MAX = BOX_WIDTH - 4;
  function fit(s) {
    return s.length > MAX ? s.slice(0, MAX - 1) + "…" : s;
  }

  try {
    // ── rm — list files that would be deleted ────────────────────────────
    if (/\brm\b/.test(command)) {
      // Remove flags like -rf, -r, -f, --recursive, etc., then grab paths.
      const paths = command
        .replace(/^(?:.*\s)?rm\s+/, "")
        .replace(/(?:^|\s)-[rRfFivI]+/g, "")
        .replace(/--(?:recursive|force|interactive\S*)/g, "")
        .trim();

      if (paths) {
        const found = run(`find ${paths} -maxdepth 4 2>/dev/null | head -10`);
        if (found) {
          lines.push(chalk.gray("  Files that would be deleted:"));
          for (const f of found.split("\n").slice(0, 8)) {
            lines.push(chalk.gray("    " + fit(f)));
          }
        }
      }
    }

    // ── redirect to .env / config files — show current content ───────────
    const redirectMatch = command.match(
      />+\s*(\.env\S*|[^\s]*\.(?:json|yaml|yml|toml|ini|conf|cfg|env))\s*$/
    );
    if (redirectMatch) {
      const filePath = redirectMatch[1];
      const content = run(`head -20 "${filePath}" 2>/dev/null`);
      if (content) {
        lines.push(chalk.gray(`  Current content of ${filePath}:`));
        for (const l of content.split("\n").slice(0, 10)) {
          lines.push(chalk.gray("    " + fit(l)));
        }
      }
    }

    // ── git reset --hard — show what uncommitted changes would be lost ────
    if (/git\s+reset\b.*--hard/.test(command)) {
      const diffStat = run("git diff --stat HEAD 2>/dev/null");
      if (diffStat) {
        lines.push(chalk.gray("  Changes that would be lost:"));
        for (const l of diffStat.split("\n").slice(0, 8)) {
          lines.push(chalk.gray("    " + fit(l)));
        }
      } else {
        lines.push(chalk.gray("  No uncommitted changes would be lost."));
      }
    }

    // ── git push --force — show recent commits at risk ────────────────────
    if (/git\s+push\b.*(?:--force|-f)\b/.test(command)) {
      const log = run("git log --oneline -5 2>/dev/null");
      if (log) {
        lines.push(chalk.gray("  Recent commits at risk:"));
        for (const l of log.split("\n")) {
          lines.push(chalk.gray("    " + fit(l)));
        }
      }
    }
  } catch {
    // Never crash the approval prompt due to a preview failure.
  }

  return lines;
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Display the approval prompt for a risky command and wait for user input.
 *
 * @param {import('./classifier.js').ClassifyResult} result
 * @returns {Promise<'approve'|'deny'|'quit'>}
 */
export async function promptApproval(result) {
  const { command, level, reason } = result;

  // Truncate very long commands for display
  const displayCmd =
    command.length > BOX_WIDTH - 12
      ? command.slice(0, BOX_WIDTH - 15) + "..."
      : command;

  const header = `  ${levelIcon(level)} AgentGuard \u2014 ${colorLevel(level)} RISK OPERATION`;
  const cmdLine = `  Command:  ${chalk.cyan(displayCmd)}`;
  const riskLine = `  Risk:     ${colorLevel(level)}`;
  const reasonLine = `  Reason:   ${chalk.white(reason || "unknown")}`;
  const actionLine = `  ${chalk.green("[A] Approve")}   ${chalk.red("[D] Deny")}   ${chalk.gray("[Q] Quit session")}`;

  // Build diff preview (may be empty)
  const diffLines = buildDiffPreview(command);

  console.error(""); // blank line before box
  console.error(boxTop());
  console.error(boxRow(header));
  console.error(boxDivider());
  console.error(boxRow(cmdLine));
  console.error(boxRow(riskLine));
  console.error(boxRow(reasonLine));
  if (diffLines.length > 0) {
    console.error(boxDivider());
    for (const dl of diffLines) {
      console.error(boxRow(dl));
    }
  }
  console.error(boxDivider());
  console.error(boxRow(actionLine));
  console.error(boxBottom());
  console.error("");

  // ── non-interactive fallback ─────────────────────────────────────────────
  if (!process.stdin.isTTY) {
    console.error(
      chalk.red(
        "[AgentGuard] stdin is not a TTY — defaulting to DENY for safety.\n"
      )
    );
    return "deny";
  }

  // ── interactive readline ─────────────────────────────────────────────────
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });

    // Switch to raw mode so we get single keypresses without Enter.
    if (process.stdin.setRawMode) {
      process.stdin.setRawMode(true);
    }

    process.stderr.write("  Choice: ");

    function onData(chunk) {
      const key = chunk.toString().toLowerCase().trim();

      if (key === "a") {
        cleanup();
        console.error(chalk.green("approve\n"));
        resolve("approve");
      } else if (key === "d") {
        cleanup();
        console.error(chalk.red("deny\n"));
        resolve("deny");
      } else if (key === "q" || key === "\u0003" /* Ctrl-C */) {
        cleanup();
        console.error(chalk.gray("quit\n"));
        resolve("quit");
      } else {
        // Re-render the prompt for unrecognized keys
        process.stderr.write("\r  Choice (a/d/q): ");
      }
    }

    function cleanup() {
      if (process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
      }
      rl.close();
      process.stdin.off("data", onData);
    }

    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
