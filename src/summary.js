/**
 * AgentGuard Session Summary
 *
 * Renders a bordered summary box at the end of an agent session showing
 * command counts, block/approve tallies, duration, and snapshot status.
 */

import chalk from "chalk";

// ─── box helpers (local copy, keeps this module self-contained) ───────────────

const BOX_WIDTH = 55;

function repeat(ch, n) {
  return ch.repeat(Math.max(0, n));
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\[[0-9;]*m/g;

function visLen(s) {
  return s.replace(ANSI_RE, "").length;
}

function boxTop() {
  return chalk.cyan("┌" + repeat("─", BOX_WIDTH) + "┐");
}

function boxBottom() {
  return chalk.cyan("└" + repeat("─", BOX_WIDTH) + "┘");
}

function boxDivider() {
  return chalk.cyan("├" + repeat("─", BOX_WIDTH) + "┤");
}

function boxRow(content) {
  const pad = repeat(" ", Math.max(0, BOX_WIDTH - visLen(content)));
  return chalk.cyan("│") + content + pad + chalk.cyan("│");
}

// ─── duration formatting ──────────────────────────────────────────────────────

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Print the end-of-session summary box to stderr.
 *
 * @param {Object} opts
 * @param {string}  opts.agent         - Agent name
 * @param {number}  opts.startTime     - Session start timestamp (Date.now())
 * @param {Object}  opts.stats         - { commandsSeen, intercepted, approved, blocked }
 * @param {Object}  [opts.snapshot]    - Snapshot result from createSnapshot()
 */
export function printSessionSummary({ agent, startTime, stats, snapshot }) {
  const duration = formatDuration(Date.now() - startTime);

  const blockedTotal = Object.values(stats.blocked || {}).reduce((a, b) => a + b, 0);
  const blockedDetail = ["CRITICAL", "HIGH", "WARN"]
    .map((l) => `${stats.blocked?.[l] ?? 0} ${l}`)
    .join(", ");

  const snapStatus = snapshot?.created
    ? chalk.green(`✓ ${snapshot.stashRef || "created"}`)
    : chalk.gray("none (not a git repo)");

  console.error(""); // blank line before box
  console.error(boxTop());
  console.error(boxRow(chalk.cyan.bold("  AgentGuard \u2014 Session Summary")));
  console.error(boxDivider());
  console.error(boxRow(`  Agent:      ${chalk.yellow(agent)}`));
  console.error(boxRow(`  Duration:   ${chalk.white(duration)}`));
  console.error(boxDivider());
  console.error(
    boxRow(
      `  Commands:   ${chalk.white(stats.commandsSeen)} seen, ` +
        `${chalk.yellow(stats.intercepted)} intercepted`
    )
  );
  console.error(
    boxRow(
      `  Blocked:    ${blockedTotal > 0 ? chalk.red(blockedTotal) : chalk.gray("0")}` +
        (blockedTotal > 0 ? chalk.gray(` (${blockedDetail})`) : "")
    )
  );
  console.error(
    boxRow(
      `  Approved:   ${stats.approved > 0 ? chalk.green(stats.approved) : chalk.gray("0")}`
    )
  );
  console.error(boxDivider());
  console.error(boxRow(`  Snapshot:   ${snapStatus}`));
  console.error(boxBottom());
  console.error("");
}
