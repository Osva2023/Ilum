import { test } from "node:test";
import assert from "node:assert/strict";

import { buildTrayPlist, LAUNCHD_LABEL } from "../src/tray-control.js";

const SAMPLE = {
  nodeBin: "/usr/local/bin/node",
  electronBin: "/Users/x/agentguard/tray/node_modules/.bin/electron",
  trayDir: "/Users/x/agentguard/tray",
  logFile: "/Users/x/.agentguard/tray.log",
};

test("buildTrayPlist — label is com.agentguard.tray", () => {
  assert.strictEqual(LAUNCHD_LABEL, "com.agentguard.tray");
  const plist = buildTrayPlist(SAMPLE);
  assert.ok(
    plist.includes("<key>Label</key>\n  <string>com.agentguard.tray</string>"),
    "plist should declare the com.agentguard.tray label",
  );
});

test("buildTrayPlist — ProgramArguments is node → electron → trayDir", () => {
  const plist = buildTrayPlist(SAMPLE);
  const block = plist.slice(
    plist.indexOf("<array>"),
    plist.indexOf("</array>"),
  );
  const args = [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
  assert.deepStrictEqual(args, [SAMPLE.nodeBin, SAMPLE.electronBin, SAMPLE.trayDir]);
});

test("buildTrayPlist — RunAtLoad true and no KeepAlive", () => {
  const plist = buildTrayPlist(SAMPLE);
  assert.ok(/<key>RunAtLoad<\/key>\s*<true\/>/.test(plist), "RunAtLoad should be true");
  assert.ok(!plist.includes("KeepAlive"), "tray plist must not set KeepAlive (user can Quit)");
});

test("buildTrayPlist — stdout/stderr both point at tray.log", () => {
  const plist = buildTrayPlist(SAMPLE);
  assert.ok(plist.includes(`<key>StandardOutPath</key>\n  <string>${SAMPLE.logFile}</string>`));
  assert.ok(plist.includes(`<key>StandardErrorPath</key>\n  <string>${SAMPLE.logFile}</string>`));
});

test("buildTrayPlist — uses absolute paths, never a ~", () => {
  const plist = buildTrayPlist(SAMPLE);
  assert.ok(!plist.includes("~"), "plist must not contain a tilde path");
});
