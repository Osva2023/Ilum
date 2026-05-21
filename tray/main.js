/**
 * AgentGuard tray app — macOS menu bar entry point.
 *
 * Behaviour:
 *   • Left-click  → toggles a 320x400 popup anchored under the tray icon.
 *   • Right-click → shows a context menu (daemon status + Quit).
 *   • Polls daemon liveness every 5s; pushes "state-changed" to the popup
 *     when the status flips so the UI updates without a re-open.
 */

"use strict";

const {
  app, Tray, Menu, BrowserWindow, nativeImage, ipcMain, screen,
} = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const AGENTGUARD_DIR = path.join(os.homedir(), ".agentguard");
const PID_FILE       = path.join(AGENTGUARD_DIR, "daemon.pid");
const CONFIG_FILE    = path.join(AGENTGUARD_DIR, "config.json");
const AUDIT_LOG      = path.join(AGENTGUARD_DIR, "audit.log");
const ICON_PATH      = path.join(__dirname, "icon.png");
const AGENTGUARD_BIN = path.resolve(__dirname, "..", "bin", "agentguard");

const POLL_INTERVAL_MS = 5000;
const POPUP_WIDTH  = 320;
const POPUP_HEIGHT = 400;

let tray = null;
let popup = null;
let pollTimer = null;
let lastStatus = "checking...";

// ─── daemon liveness ─────────────────────────────────────────────────────────

function readPid() {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

function currentStatus() {
  const pid = readPid();
  return pid && isAlive(pid) ? "running" : "stopped";
}

// ─── state for the popup ─────────────────────────────────────────────────────

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return {};
  }
}

function readRecentDaemonEvents(n) {
  let text;
  try {
    text = fs.readFileSync(AUDIT_LOG, "utf8");
  } catch {
    return [];
  }
  const out = [];
  // Iterate lines in reverse so we can stop early once we have enough matches.
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.agent === "daemon") out.push(ev);
    } catch {
      // Skip malformed lines silently.
    }
  }
  return out;
}

function collectState() {
  const config = readConfig();
  return {
    status: currentStatus(),
    watchPaths: Array.isArray(config.watchPaths) ? config.watchPaths : [],
    events: readRecentDaemonEvents(5),
  };
}

// ─── shelling out to the agentguard CLI ──────────────────────────────────────

function runAgentguard(args) {
  return new Promise((resolve) => {
    if (!fs.existsSync(AGENTGUARD_BIN)) {
      resolve({ ok: false, error: `agentguard binary not found at ${AGENTGUARD_BIN}` });
      return;
    }
    try {
      const child = spawn(AGENTGUARD_BIN, args, {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.on("error", (err) => resolve({ ok: false, error: err.message }));
      child.unref();
      resolve({ ok: true, pid: child.pid });
    } catch (err) {
      resolve({ ok: false, error: err.message });
    }
  });
}

function openReportInTerminal() {
  // Wrap the agentguard path in single-quotes inside the AppleScript so paths
  // with spaces survive. Assumes the path itself contains no single quotes.
  const cmd = `'${AGENTGUARD_BIN}' report`;
  const apple = `tell application "Terminal" to do script "${cmd}"\n` +
                `tell application "Terminal" to activate`;
  return new Promise((resolve) => {
    const child = spawn("osascript", ["-e", apple], { stdio: "ignore" });
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("exit", () => resolve({ ok: true }));
  });
}

// ─── context menu (right-click) ──────────────────────────────────────────────

function buildMenu(statusLabel) {
  return Menu.buildFromTemplate([
    { label: "AgentGuard", enabled: false },
    { label: `Daemon: ${statusLabel}`, enabled: false },
    { type: "separator" },
    { label: "Quit", click: () => app.quit() },
  ]);
}

// ─── popup window ────────────────────────────────────────────────────────────

function createPopup() {
  popup = new BrowserWindow({
    width: POPUP_WIDTH,
    height: POPUP_HEIGHT,
    frame: false,
    resizable: false,
    movable: false,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    transparent: false,
    backgroundColor: "#1a1a1a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  popup.loadFile(path.join(__dirname, "index.html"));
  popup.on("blur", () => { if (popup && !popup.isDestroyed()) popup.hide(); });
  popup.on("closed", () => { popup = null; });
}

function positionPopup() {
  if (!popup || !tray) return;
  const trayBounds = tray.getBounds();
  const anchorX = trayBounds.x + trayBounds.width / 2;
  const anchorY = trayBounds.y + trayBounds.height + 4;

  const display = screen.getDisplayNearestPoint({ x: anchorX, y: anchorY }).workArea;
  let x = Math.round(anchorX - POPUP_WIDTH / 2);
  let y = Math.round(anchorY);

  // Clamp to display work area so the popup never spills off-screen.
  x = Math.max(display.x + 4, Math.min(x, display.x + display.width  - POPUP_WIDTH  - 4));
  y = Math.max(display.y + 4, Math.min(y, display.y + display.height - POPUP_HEIGHT - 4));

  popup.setPosition(x, y, false);
}

function togglePopup() {
  if (!popup) createPopup();
  if (popup.isVisible()) {
    popup.hide();
    return;
  }
  positionPopup();
  popup.show();
  popup.focus();
}

// ─── status poller ───────────────────────────────────────────────────────────

function refresh() {
  const status = currentStatus();
  if (status === lastStatus) return;
  lastStatus = status;
  if (popup && !popup.isDestroyed()) {
    popup.webContents.send("state-changed");
  }
}

// ─── lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  const image = nativeImage.createFromPath(ICON_PATH);
  image.setTemplateImage(true);

  tray = new Tray(image);
  tray.setToolTip("AgentGuard");

  tray.on("click",       togglePopup);
  tray.on("right-click", () => tray.popUpContextMenu(buildMenu(currentStatus())));

  // IPC handlers consumed by the renderer via preload.js.
  ipcMain.handle("get-state",    () => collectState());
  ipcMain.handle("daemon-start", () => runAgentguard(["daemon", "start"]));
  ipcMain.handle("daemon-stop",  () => runAgentguard(["daemon", "stop"]));
  ipcMain.handle("open-report",  () => openReportInTerminal());

  lastStatus = currentStatus();
  pollTimer = setInterval(refresh, POLL_INTERVAL_MS);
});

app.on("window-all-closed", () => {
  // Tray-only app — don't quit when the popup closes.
});

app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
});
