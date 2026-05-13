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
import { spawn, spawnSync } from "child_process";
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

const LAUNCHD_LABEL = "com.agentguard.daemon";
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LAUNCHD_LABEL}.plist`);

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
  // Prefer the PID file's mtime — it's rewritten by every daemon process on
  // startup (manual via daemonStart() AND launchd via the daemon binary
  // itself), so its mtime is the actual start time in both cases.
  try {
    return fs.statSync(PID_FILE).mtimeMs;
  } catch {}
  // Fallback: parse the header line written by daemonStart() to daemon.log.
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

// ─── launchd (macOS) ─────────────────────────────────────────────────────────

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generatePlist() {
  const nodeBin = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(DAEMON_BIN)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(LOG_FILE)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(os.homedir())}</string>
</dict>
</plist>
`;
}

function isLaunchdLoaded() {
  const r = spawnSync("launchctl", ["list", LAUNCHD_LABEL], { encoding: "utf8" });
  return r.status === 0;
}

export async function daemonInstall() {
  if (process.platform !== "darwin") {
    console.error(
      chalk.red(`[AgentGuard daemon] install is macOS-only (platform: ${process.platform})`)
    );
    process.exit(1);
  }

  ensureDir();

  // If a manually-started daemon is running, stop it so launchd takes over cleanly.
  const existing = readPid();
  if (existing && isAlive(existing) && !isLaunchdLoaded()) {
    console.error(
      chalk.gray(`[AgentGuard daemon] stopping manually-started daemon (PID ${existing}) before install…`)
    );
    await daemonStop();
  }

  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.writeFileSync(PLIST_PATH, generatePlist());

  // Best-effort unload of any prior registration so `load` doesn't fail on re-install.
  spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });

  const loadResult = spawnSync("launchctl", ["load", "-w", PLIST_PATH], { encoding: "utf8" });
  if (loadResult.status !== 0) {
    console.error(
      chalk.red(`[AgentGuard daemon] launchctl load failed: ${loadResult.stderr || loadResult.stdout}`)
    );
    process.exit(1);
  }

  // Give launchd a moment to spawn it, then verify.
  await sleep(500);
  const listResult = spawnSync("launchctl", ["list", LAUNCHD_LABEL], { encoding: "utf8" });
  if (listResult.status !== 0) {
    console.error(
      chalk.red(`[AgentGuard daemon] launchd registered the job but reports it as not running. Check ${LOG_FILE}`)
    );
    process.exit(1);
  }

  // Parse the PID column (line like: `\t"PID" = 12345;`)
  const pidMatch = listResult.stdout.match(/"PID"\s*=\s*(\d+);/);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;

  console.error(chalk.green(`[AgentGuard daemon] installed and started`));
  if (pid) console.error(chalk.gray(`  PID:   ${pid}`));
  console.error(chalk.gray(`  Plist: ${PLIST_PATH}`));
  console.error(chalk.gray(`  Log:   ${LOG_FILE}`));
  console.error(
    chalk.yellow(
      `  Note: while installed, \`agentguard daemon stop\` only kills the process — ` +
      `launchd will respawn it. Use \`agentguard daemon uninstall\` to disable.`
    )
  );
}

export async function daemonUninstall() {
  if (process.platform !== "darwin") {
    console.error(
      chalk.red(`[AgentGuard daemon] uninstall is macOS-only (platform: ${process.platform})`)
    );
    process.exit(1);
  }

  if (!fs.existsSync(PLIST_PATH)) {
    console.error(chalk.gray(`[AgentGuard daemon] not installed (no plist at ${PLIST_PATH})`));
    return;
  }

  // unload stops the job *and* removes it from launchd; with KeepAlive=true this is
  // the only way to actually stop the daemon.
  const unloadResult = spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
  if (unloadResult.status !== 0) {
    console.error(
      chalk.yellow(
        `[AgentGuard daemon] launchctl unload reported an error (continuing): ${unloadResult.stderr || unloadResult.stdout}`
      )
    );
  }

  try { fs.unlinkSync(PLIST_PATH); } catch {}

  // If launchctl killed the daemon hard, its own PID-file cleanup may not have run.
  const pid = readPid();
  if (!pid || !isAlive(pid)) removePidFile();

  console.error(chalk.green(`[AgentGuard daemon] uninstalled`));
  console.error(chalk.gray(`  Removed: ${PLIST_PATH}`));
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
