#!/usr/bin/env node
/**
 * AgentGuard Daemon — v1 (minimal)
 *
 * A persistent, no-prompt observer that watches one or more directories
 * for sensitive file changes and writes them to the audit log.
 *
 * Usage:
 *   node bin/agentguard-daemon.js
 *
 * Configuration: ~/.agentguard/config.json
 *   {
 *     "watchPaths": ["~/projects/app", "/etc/myservice"]
 *   }
 *
 * Scope (v1):
 *   - audit-only — no prompts, no enforcement, no PTY, no snapshot
 *   - Telegram alerts suppressed even if globally configured
 *   - graceful shutdown on SIGINT / SIGTERM
 */

import fs from "fs";
import os from "os";
import path from "path";
import chalk from "chalk";
import { loadConfig } from "../src/config.js";
import { startFileWatcher } from "../src/filewatcher.js";
import {
  logSessionStart,
  logSessionEnd,
  LOG_FILE,
  sessionId,
} from "../src/logger.js";

// ─── path expansion ──────────────────────────────────────────────────────────

function expandPath(p) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~" || p.startsWith("~/")) {
    return path.resolve(os.homedir(), p === "~" ? "." : p.slice(2));
  }
  return path.resolve(p);
}

// ─── config + validation ─────────────────────────────────────────────────────

const config = loadConfig();

const rawPaths = Array.isArray(config.watchPaths) ? config.watchPaths : [];
if (rawPaths.length === 0) {
  console.error(
    chalk.red("[AgentGuard daemon] No watchPaths configured.\n") +
      `  Add to ~/.agentguard/config.json:\n` +
      `    { "watchPaths": ["/absolute/or/~/relative/path"] }\n`
  );
  process.exit(2);
}

const expanded = rawPaths
  .map((p) => ({ raw: p, abs: expandPath(p) }))
  .filter((x) => x.abs !== null);

const invalid = expanded.filter((x) => {
  try {
    return !fs.statSync(x.abs).isDirectory();
  } catch {
    return true;
  }
});

if (invalid.length > 0) {
  console.error(
    chalk.red("[AgentGuard daemon] Some watchPaths are not existing directories:")
  );
  for (const { raw, abs } of invalid) {
    console.error(`  - ${raw}  (resolved: ${abs})`);
  }
  process.exit(2);
}

// Force audit-only + suppress Telegram alerts for v1.
config.auditOnly = true;
config.notifications = {
  ...(config.notifications ?? {}),
  telegram: { ...(config.notifications?.telegram ?? {}), enabled: false },
};

// ─── banner ──────────────────────────────────────────────────────────────────

console.error(
  chalk.cyan.bold("\n[AgentGuard daemon] ") +
    chalk.white(`watching ${expanded.length} path${expanded.length === 1 ? "" : "s"}:`)
);
for (const { abs } of expanded) {
  console.error(chalk.gray(`  • ${abs}`));
}
console.error(chalk.gray(`  Audit log: ${LOG_FILE}`));
console.error(chalk.gray(`  Session:   ${sessionId}`));
console.error(chalk.gray("  Mode:      audit-only (no enforcement, no Telegram)"));
console.error("");

// ─── pid file ────────────────────────────────────────────────────────────────

// Written here (rather than only by `daemonStart()`) so that `agentguard daemon
// status` works under launchd as well, which spawns this script directly.
const PID_FILE = path.join(os.homedir(), ".agentguard", "daemon.pid");
try {
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));
} catch (e) {
  console.error(chalk.yellow(`[AgentGuard daemon] could not write PID file: ${e.message}`));
}

// ─── start watchers ──────────────────────────────────────────────────────────

logSessionStart("daemon");

const watchers = expanded.map(({ abs }) =>
  startFileWatcher({
    cwd: abs,
    agent: "daemon",
    sessionId,
    stashRef: null,
    sensitiveBackupDir: null,
    config,
    stats: {},
  })
);

// ─── graceful shutdown ───────────────────────────────────────────────────────

let shuttingDown = false;

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.error(chalk.gray(`\n[AgentGuard daemon] received ${signal}, stopping…`));
  for (const w of watchers) {
    try { w.stop(); } catch {}
  }
  try { fs.unlinkSync(PID_FILE); } catch {}
  logSessionEnd("daemon");
  process.exit(0);
}

process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
