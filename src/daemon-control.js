/**
 * AgentGuard Daemon — lifecycle controls (start / stop / status / logs)
 *
 * Used by `agentguard daemon <subcommand>`.
 *
 *   PID file:  ~/.agentguard/daemon.pid
 *   Log file:  ~/.agentguard/daemon.log
 *   Binary:    bin/agentguard-daemon.js (spawned detached on `start`)
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";
import { loadConfig } from "./config.js";

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const PID_FILE = path.join(AGENTGUARD_DIR, "daemon.pid");
const LOG_FILE = path.join(AGENTGUARD_DIR, "daemon.log");

const DAEMON_BIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "bin",
  "agentguard-daemon.js"
);

// ─── helpers ─────────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(AGENTGUARD_DIR, { recursive: true });
}

function isAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours — still "alive"
  }
}

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function removePidFile() {
  try { fs.unlinkSync(PID_FILE); } catch {}
}

function expandPath(p) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~" || p.startsWith("~/")) {
    return path.resolve(os.homedir(), p === "~" ? "." : p.slice(2));
  }
  return path.resolve(p);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function humanUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  const s = Math.floor(ms / 1000);
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  if (days)  return `${days}d ${hours}h ${mins}m`;
  if (hours) return `${hours}h ${mins}m`;
  if (mins)  return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function readStartTime() {
  // First line of daemon.log is written by daemonStart() as:
  //   [<ISO>] AgentGuard daemon starting
  try {
    const fd = fs.openSync(LOG_FILE, "r");
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const firstLine = buf.slice(0, n).toString("utf8").split("\n")[0];
    const m = firstLine.match(/^\[([^\]]+)\]/);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// ─── start ───────────────────────────────────────────────────────────────────

export async function daemonStart() {
  ensureDir();

  const existing = readPid();
  if (existing && isAlive(existing)) {
    console.error(
      chalk.yellow(`[AgentGuard daemon] already running (PID ${existing})`)
    );
    process.exit(1);
  }
  if (existing && !isAlive(existing)) {
    removePidFile(); // stale
  }

  // Truncate log + write header so `status` can derive uptime from line 1.
  const header = `[${new Date().toISOString()}] AgentGuard daemon starting\n`;
  fs.writeFileSync(LOG_FILE, header);

  const fd = fs.openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON_BIN], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  fs.closeSync(fd);

  fs.writeFileSync(PID_FILE, String(child.pid));
  child.unref();

  // Give it a moment to crash on bad config etc.
  await sleep(300);

  if (!isAlive(child.pid)) {
    removePidFile();
    console.error(
      chalk.red(`[AgentGuard daemon] failed to start — see ${LOG_FILE}`)
    );
    process.exit(1);
  }

  console.error(
    chalk.green(`[AgentGuard daemon] started (PID ${child.pid})`)
  );
  console.error(chalk.gray(`  Log: ${LOG_FILE}`));
}

// ─── stop ────────────────────────────────────────────────────────────────────

export async function daemonStop() {
  const pid = readPid();
  if (!pid || !isAlive(pid)) {
    removePidFile();
    console.error(chalk.gray("[AgentGuard daemon] not running"));
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch (e) {
    console.error(
      chalk.red(`[AgentGuard daemon] failed to signal PID ${pid}: ${e.message}`)
    );
    process.exit(1);
  }

  const timeoutMs = 5000;
  const start = Date.now();
  while (isAlive(pid) && Date.now() - start < timeoutMs) {
    await sleep(100);
  }

  if (isAlive(pid)) {
    console.error(
      chalk.yellow(
        `[AgentGuard daemon] PID ${pid} did not exit within 5s — still running. ` +
        `Send SIGKILL manually if needed: kill -9 ${pid}`
      )
    );
    process.exit(1);
  }

  removePidFile();
  console.error(chalk.green(`[AgentGuard daemon] stopped (PID ${pid})`));
}

// ─── status ──────────────────────────────────────────────────────────────────

export async function daemonStatus() {
  const pid = readPid();

  if (!pid) {
    console.error(chalk.gray("AgentGuard daemon: ") + chalk.yellow("not running"));
    return;
  }

  if (!isAlive(pid)) {
    console.error(
      chalk.gray("AgentGuard daemon: ") +
        chalk.yellow(`not running (stale PID file at ${PID_FILE})`)
    );
    return;
  }

  const startTime = readStartTime();
  const uptime = startTime ? humanUptime(Date.now() - startTime) : "unknown";

  const config = loadConfig();
  const watchPaths = (Array.isArray(config.watchPaths) ? config.watchPaths : [])
    .map((p) => ({ raw: p, abs: expandPath(p) }));

  console.log(chalk.bold("AgentGuard daemon: ") + chalk.green("running"));
  console.log(`  PID:     ${pid}`);
  console.log(`  Uptime:  ${uptime}`);
  console.log(`  Log:     ${LOG_FILE}`);
  if (watchPaths.length === 0) {
    console.log(`  Watching: ${chalk.yellow("(no watchPaths configured)")}`);
  } else {
    console.log(`  Watching:`);
    for (const { abs, raw } of watchPaths) {
      console.log(`    • ${abs ?? raw}`);
    }
  }
}

// ─── logs ────────────────────────────────────────────────────────────────────

export async function daemonLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.error(
      chalk.yellow(
        `[AgentGuard daemon] no daemon log yet — start the daemon first (${LOG_FILE})`
      )
    );
    process.exit(1);
  }

  const child = spawn("tail", ["-f", LOG_FILE], { stdio: "inherit" });

  const forward = (sig) => {
    try { child.kill(sig); } catch {}
  };
  process.on("SIGINT", () => forward("SIGINT"));
  process.on("SIGTERM", () => forward("SIGTERM"));

  await new Promise((resolve) => {
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    child.on("error", (err) => {
      console.error(chalk.red(`[AgentGuard daemon] tail failed: ${err.message}`));
      resolve();
      process.exit(1);
    });
  });
}
