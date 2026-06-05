/**
 * AgentGuard Tray — launchd lifecycle controls (install / uninstall)
 *
 * Used by `agentguard tray <install|uninstall>`.
 *
 *   Plist:  ~/Library/LaunchAgents/com.agentguard.tray.plist
 *   Log:    ~/.agentguard/tray.log
 *   App:    tray/ (Electron menu-bar app), launched as
 *           `{node} {tray/node_modules/.bin/electron} {tray/}`
 *
 * The tray is a GUI menu-bar app, so the plist uses RunAtLoad only (no
 * KeepAlive) — it starts on login but the user can Quit it for good.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";

// ─── paths ───────────────────────────────────────────────────────────────────

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const TRAY_LOG = path.join(AGENTGUARD_DIR, "tray.log");

export const LAUNCHD_LABEL = "com.agentguard.tray";
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), "Library", "LaunchAgents");
const PLIST_PATH = path.join(LAUNCH_AGENTS_DIR, `${LAUNCHD_LABEL}.plist`);

// tray/ lives one level up from src/, resolved to an absolute path so the plist
// never contains a "~" or a relative segment.
const TRAY_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "tray"
);
// .bin/electron is a `#!/usr/bin/env node` shim (symlink to electron/cli.js).
// We invoke it with process.execPath so launchd doesn't depend on PATH.
const ELECTRON_BIN = path.join(TRAY_DIR, "node_modules", ".bin", "electron");

// ─── helpers ─────────────────────────────────────────────────────────────────

function ensureDir() {
  fs.mkdirSync(AGENTGUARD_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isLaunchdLoaded() {
  const r = spawnSync("launchctl", ["list", LAUNCHD_LABEL], { encoding: "utf8" });
  return r.status === 0;
}

/**
 * Build the launchd plist for the tray app.  Pure function — no I/O — so it can
 * be unit-tested without touching launchd or the filesystem.
 *
 * @param {Object} params
 * @param {string} params.nodeBin      Absolute path to the node binary (process.execPath)
 * @param {string} params.electronBin  Absolute path to tray/node_modules/.bin/electron
 * @param {string} params.trayDir      Absolute path to the tray/ directory
 * @param {string} params.logFile      Absolute path for stdout/stderr
 * @returns {string} plist XML
 */
export function buildTrayPlist({ nodeBin, electronBin, trayDir, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(electronBin)}</string>
    <string>${xmlEscape(trayDir)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logFile)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(trayDir)}</string>
</dict>
</plist>
`;
}

// ─── install ───────────────────────────────────────────────────────────────────

export async function trayInstall() {
  if (process.platform !== "darwin") {
    console.error(
      chalk.red(`[AgentGuard tray] install is macOS-only (platform: ${process.platform})`)
    );
    process.exit(1);
  }

  if (!fs.existsSync(ELECTRON_BIN)) {
    console.error(chalk.red("[AgentGuard tray] tray dependencies not installed."));
    console.error(chalk.gray(`  Run: cd ${TRAY_DIR} && npm install`));
    process.exit(1);
  }

  ensureDir();
  fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
  fs.writeFileSync(
    PLIST_PATH,
    buildTrayPlist({
      nodeBin: process.execPath,
      electronBin: ELECTRON_BIN,
      trayDir: TRAY_DIR,
      logFile: TRAY_LOG,
    })
  );

  // Best-effort unload of any prior registration so `load` doesn't fail on re-install.
  spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });

  const loadResult = spawnSync("launchctl", ["load", "-w", PLIST_PATH], { encoding: "utf8" });
  if (loadResult.status !== 0) {
    console.error(
      chalk.red(`[AgentGuard tray] launchctl load failed: ${loadResult.stderr || loadResult.stdout}`)
    );
    process.exit(1);
  }

  // Give launchd a moment to spawn it, then verify it registered.
  await sleep(500);
  if (!isLaunchdLoaded()) {
    console.error(
      chalk.red(`[AgentGuard tray] launchctl load succeeded but the job is not listed. Check ${TRAY_LOG}`)
    );
    process.exit(1);
  }

  console.error(chalk.green(`[AgentGuard tray] installed and started`));
  console.error(chalk.gray(`  Plist: ${PLIST_PATH}`));
  console.error(chalk.gray(`  Log:   ${TRAY_LOG}`));
  console.error(
    chalk.gray(`  The shield icon will appear in the menu bar on every login.`)
  );
}

// ─── uninstall ─────────────────────────────────────────────────────────────────

export async function trayUninstall() {
  if (process.platform !== "darwin") {
    console.error(
      chalk.red(`[AgentGuard tray] uninstall is macOS-only (platform: ${process.platform})`)
    );
    process.exit(1);
  }

  if (!fs.existsSync(PLIST_PATH)) {
    console.error(chalk.gray(`[AgentGuard tray] not installed (no plist at ${PLIST_PATH})`));
    return;
  }

  // unload stops the job and removes it from launchd.
  const unloadResult = spawnSync("launchctl", ["unload", PLIST_PATH], { encoding: "utf8" });
  if (unloadResult.status !== 0) {
    console.error(
      chalk.yellow(
        `[AgentGuard tray] launchctl unload reported an error (continuing): ${unloadResult.stderr || unloadResult.stdout}`
      )
    );
  }

  try { fs.unlinkSync(PLIST_PATH); } catch {}

  console.error(chalk.green(`[AgentGuard tray] uninstalled`));
  console.error(chalk.gray(`  Removed: ${PLIST_PATH}`));
  console.error(
    chalk.gray(`  The tray app may still be running — Quit it from the menu bar if so.`)
  );
}

export { PLIST_PATH, TRAY_LOG, TRAY_DIR, ELECTRON_BIN };
