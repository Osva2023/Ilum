/**
 * Tray popup preload — bridges a minimal IPC surface into the renderer.
 *
 * Runs with contextIsolation enabled, so the renderer cannot see Node or
 * Electron internals. Only the methods explicitly exposed here are callable
 * from index.html.
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentguard", {
  getState:    () => ipcRenderer.invoke("get-state"),
  startDaemon: () => ipcRenderer.invoke("daemon-start"),
  stopDaemon:  () => ipcRenderer.invoke("daemon-stop"),
  openReport:  () => ipcRenderer.invoke("open-report"),

  onStateChanged(cb) {
    const handler = () => cb();
    ipcRenderer.on("state-changed", handler);
    return () => ipcRenderer.removeListener("state-changed", handler);
  },
});
