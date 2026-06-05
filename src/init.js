/**
 * AgentGuard — `agentguard init` interactive setup wizard.
 *
 * Pure Node.js (readline/promises), no external deps.
 * Configures: watchPaths in ~/.agentguard/config.json, shell aliases in
 * ~/.zshrc, and (optionally) the launchd daemon on macOS.
 */

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import { stdin as input, stdout as output } from "process";
import chalk from "chalk";

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const CONFIG_PATH = path.join(AGENTGUARD_DIR, "config.json");
const ZSHRC_PATH = path.join(os.homedir(), ".zshrc");

const KNOWN_AGENTS = ["claude", "codex", "aider", "cursor"];

const ALIAS_BLOCK_START = "# === AgentGuard aliases (managed by `agentguard init`) ===";
const ALIAS_BLOCK_END   = "# === end AgentGuard ===";

// ─── line-queue prompt helper ────────────────────────────────────────────────
// We build a queue on top of readline's `line` event rather than using
// `rl.question`. Piped stdin emits all lines as soon as data arrives, and
// `rl.question`'s one-shot listener drops every line except the first — the
// queue lets us pair buffered lines with awaiting prompts.

function makePrompter(rl) {
  const lines = [];
  const waiters = [];
  let closed = false;

  rl.on("line", (line) => {
    if (waiters.length > 0) waiters.shift()(line);
    else lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()("");
  });

  return function ask(promptText) {
    if (promptText) output.write(promptText);
    return new Promise((resolve) => {
      if (lines.length > 0) resolve(lines.shift());
      else if (closed) resolve("");
      else waiters.push(resolve);
    });
  };
}

async function confirmYesNo(ask, question, defaultYes) {
  const suffix = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = (await ask(`${question} ${suffix} `)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function multiSelectNumbered(ask, question, options) {
  console.log(question);
  options.forEach((opt, i) => console.log(`  ${i + 1}) ${opt}`));
  const raw = (await ask("Select (comma-separated numbers, or Enter to skip): ")).trim();
  if (!raw) return [];
  const picks = new Set();
  for (const part of raw.split(",")) {
    const n = Number.parseInt(part.trim(), 10);
    if (Number.isFinite(n) && n >= 1 && n <= options.length) picks.add(options[n - 1]);
  }
  return [...picks];
}

function expandPath(p) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~" || p.startsWith("~/")) {
    return path.resolve(os.homedir(), p === "~" ? "." : p.slice(2));
  }
  return path.resolve(p);
}

// ─── step: watch paths ───────────────────────────────────────────────────────

async function promptWatchPaths(ask) {
  console.log(chalk.bold("\nWhich directories should AgentGuard watch?"));
  console.log(chalk.gray("  Enter one path per line. Empty line to finish."));
  console.log(chalk.gray(`  Press Enter immediately to use the current directory (${process.cwd()}).`));

  const collected = [];
  while (true) {
    const line = (await ask("  > ")).trim();
    if (!line) break;
    const abs = expandPath(line);
    let valid = false;
    try { valid = fs.statSync(abs).isDirectory(); } catch {}
    if (!valid) {
      console.log(chalk.yellow(`    ! skipped (not a directory): ${abs}`));
      continue;
    }
    collected.push(abs);
  }

  if (collected.length === 0) collected.push(process.cwd());
  return collected;
}

// Collect zero or more existing directories from the user, one per line.
// Unlike promptWatchPaths(), this does NOT fall back to the cwd on empty
// input — an empty first line simply means "no paths to add". Used by the
// "add more paths" flow for an already-configured install.
async function collectValidDirs(ask) {
  console.log(chalk.bold("\nEnter new paths to watch:"));
  console.log(chalk.gray("  One path per line. Empty line to finish."));

  const collected = [];
  while (true) {
    const line = (await ask("  > ")).trim();
    if (!line) break;
    const abs = expandPath(line);
    let valid = false;
    try { valid = fs.statSync(abs).isDirectory(); } catch {}
    if (!valid) {
      console.log(chalk.yellow(`    ! skipped (not a directory): ${abs}`));
      continue;
    }
    collected.push(abs);
  }
  return collected;
}

// ─── step: aliases ───────────────────────────────────────────────────────────

function existingZshrc() {
  try { return fs.readFileSync(ZSHRC_PATH, "utf8"); } catch { return ""; }
}

function stripManagedBlock(content) {
  const start = content.indexOf(ALIAS_BLOCK_START);
  if (start === -1) return content;
  const end = content.indexOf(ALIAS_BLOCK_END, start);
  if (end === -1) return content;
  // Trim one trailing newline if present
  let cut = end + ALIAS_BLOCK_END.length;
  if (content[cut] === "\n") cut += 1;
  // And one leading newline if it created a blank line
  let from = start;
  if (from > 0 && content[from - 1] === "\n") from -= 1;
  return content.slice(0, from) + content.slice(cut);
}

function detectExistingAliasOutsideBlock(content, agent) {
  const stripped = stripManagedBlock(content);
  // Loose match for any line declaring this alias
  const re = new RegExp(`^\\s*alias\\s+${agent}\\s*=`, "m");
  return re.test(stripped);
}

function writeAliasesToZshrc(agents) {
  const existing = existingZshrc();
  const skipped = [];
  const willAlias = [];
  for (const a of agents) {
    if (detectExistingAliasOutsideBlock(existing, a)) {
      skipped.push(a);
    } else {
      willAlias.push(a);
    }
  }

  const base = stripManagedBlock(existing);
  let next = base;
  if (willAlias.length > 0) {
    const block =
      `${ALIAS_BLOCK_START}\n` +
      willAlias.map((a) => `alias ${a}='agentguard ${a}'`).join("\n") +
      `\n${ALIAS_BLOCK_END}\n`;
    if (next.length > 0 && !next.endsWith("\n")) next += "\n";
    next += (next.length > 0 ? "\n" : "") + block;
  }
  fs.writeFileSync(ZSHRC_PATH, next);
  return { added: willAlias, skipped };
}

// ─── step: write config ──────────────────────────────────────────────────────

function writeConfig(watchPaths) {
  fs.mkdirSync(AGENTGUARD_DIR, { recursive: true });
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {}
  const next = { ...existing, watchPaths };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
}

function hasExistingConfig() {
  try {
    const stat = fs.statSync(CONFIG_PATH);
    return stat.isFile() && stat.size > 0;
  } catch { return false; }
}

/**
 * Parse the watchPaths array out of config JSON text.  Tolerant: returns []
 * for malformed JSON, a missing array, or non-string entries.  Pure — exported
 * for testing.
 *
 * @param {string} jsonText
 * @returns {string[]}
 */
export function parseWatchPaths(jsonText) {
  try {
    const cfg = JSON.parse(jsonText);
    return Array.isArray(cfg.watchPaths)
      ? cfg.watchPaths.filter((p) => typeof p === "string" && p)
      : [];
  } catch {
    return [];
  }
}

function readExistingWatchPaths() {
  try {
    return parseWatchPaths(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return [];
  }
}

/**
 * Return the candidates that are not already present in `existing`, with
 * intra-candidate duplicates removed and order preserved.  Pure — exported
 * for testing.
 *
 * @param {string[]} existing
 * @param {string[]} candidates
 * @returns {string[]}
 */
export function filterNewPaths(existing, candidates) {
  const seen = new Set(existing);
  const out = [];
  for (const p of candidates) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

// ─── main ────────────────────────────────────────────────────────────────────

export async function runInit() {
  const rl = readline.createInterface({ input, output });
  const ask = makePrompter(rl);

  try {
    console.log(chalk.bold.cyan("\nAgentGuard setup"));
    console.log(
      "AgentGuard is a universal wrapper for AI coding agents that intercepts dangerous\n" +
      "shell commands and watches your files for sensitive changes. It logs everything\n" +
      "to ~/.agentguard/audit.log and can run as a background daemon."
    );

    if (hasExistingConfig()) {
      // Already configured: focus on adding watch paths without overwriting the
      // rest of the config (agents/aliases/daemon are left untouched). Existing
      // paths are always preserved; only genuinely-new ones are appended.
      const existingPaths = readExistingWatchPaths();

      if (existingPaths.length > 0) {
        console.log(chalk.bold("\nCurrent watched paths:"));
        for (const p of existingPaths) console.log(`  • ${p}`);
      } else {
        console.log(chalk.gray("\nExisting config has no watched paths yet."));
      }

      const addMore = await confirmYesNo(ask, "\nAdd more paths?", false);
      if (!addMore) {
        console.log(chalk.gray("Nothing changed. Run `agentguard daemon status` to verify."));
        return;
      }

      const candidates = await collectValidDirs(ask);
      const newPaths = filterNewPaths(existingPaths, candidates);

      // Note any candidates dropped for being already watched / duplicated.
      const dropped = [...new Set(candidates)].filter((p) => !newPaths.includes(p));
      for (const p of dropped) {
        console.log(chalk.yellow(`  ! already watched (skipped): ${p}`));
      }

      if (newPaths.length === 0) {
        console.log(chalk.gray("Nothing to add."));
        return;
      }

      console.log(chalk.bold("\nNew paths to add:"));
      for (const p of newPaths) console.log(`  • ${p}`);

      const confirmAdd = await confirmYesNo(
        ask,
        `\nAdd ${newPaths.length} new path${newPaths.length === 1 ? "" : "s"}?`,
        true
      );
      if (!confirmAdd) {
        console.log(chalk.gray("Nothing changed. Run `agentguard daemon status` to verify."));
        return;
      }

      const merged = [...existingPaths, ...newPaths];
      writeConfig(merged);

      console.log(chalk.bold.green("\n✓ Watched paths updated"));
      console.log(`  Config:      ${CONFIG_PATH}`);
      console.log(`  Watching:`);
      for (const p of merged) console.log(`    • ${p}`);
      console.log(
        chalk.gray("\nRestart the daemon to pick up the new paths: `agentguard daemon stop && agentguard daemon start`.")
      );
      return;
    }

    // 1. Watch paths
    const watchPaths = await promptWatchPaths(ask);

    // 2. Agents
    const agents = await multiSelectNumbered(
      ask,
      chalk.bold("\nWhich AI agents do you use?"),
      KNOWN_AGENTS
    );

    // 3. Aliases (only if agents selected)
    let aliasResult = null;
    if (agents.length > 0) {
      const wantAliases = await confirmYesNo(
        ask,
        `\nAdd \`alias <agent>='agentguard <agent>'\` lines to ~/.zshrc for: ${agents.join(", ")}?`,
        true
      );
      if (wantAliases) {
        aliasResult = writeAliasesToZshrc(agents);
      }
    }

    // 4. Daemon install (darwin only)
    let installResult = "skipped";
    if (process.platform === "darwin") {
      const wantInstall = await confirmYesNo(
        ask,
        "\nInstall the daemon to auto-start on login (launchd)?",
        true
      );
      if (wantInstall) {
        rl.close(); // free stdin before daemon child inherits anything
        const { daemonInstall } = await import("./daemon-control.js");
        try {
          await daemonInstall();
          installResult = "installed";
        } catch (e) {
          installResult = `failed (${e.message})`;
        }
      } else {
        installResult = "declined";
      }
    } else {
      installResult = `skipped (launchd is macOS-only; current platform: ${process.platform})`;
    }

    // 5. Write config
    writeConfig(watchPaths);

    // 6. Summary
    console.log(chalk.bold.green("\n✓ AgentGuard configured"));
    console.log(`  Config:      ${CONFIG_PATH}`);
    console.log(`  Watching:`);
    for (const p of watchPaths) console.log(`    • ${p}`);
    if (aliasResult) {
      if (aliasResult.added.length) {
        console.log(`  Aliases:     added for ${aliasResult.added.join(", ")} (run \`source ~/.zshrc\` or restart your shell)`);
      } else {
        console.log(`  Aliases:     nothing added`);
      }
      if (aliasResult.skipped.length) {
        console.log(chalk.yellow(`    skipped (already aliased in ~/.zshrc): ${aliasResult.skipped.join(", ")}`));
      }
    } else if (agents.length > 0) {
      console.log(`  Aliases:     declined`);
    }
    console.log(`  Daemon:      ${installResult}`);
    console.log(chalk.gray("\nRun `agentguard daemon status` to verify."));
  } finally {
    // rl may already be closed (daemon install path closes it early); ignore.
    try { rl.close(); } catch {}
  }
}
