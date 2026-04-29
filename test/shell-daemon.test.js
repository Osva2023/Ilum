/**
 * AgentGuard — shell-daemon integration tests
 *
 * Run with:
 *   node --test test/shell-daemon.test.js
 *
 * Tests 1–3 hit the daemon directly via a Node net client, stubbing the TTY
 * lock so no terminal state is touched.  Tests 4–5 spawn the prebuilt Go
 * wrapper binary at shell-wrapper/agentguard-shell to exercise the
 * fail-closed / fail-open paths from the wrapper's perspective.  When the
 * binary isn't built, those tests are skipped so the suite still runs in
 * environments without Go.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startShellDaemon } from "../src/shell-daemon.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER_BIN = path.join(REPO_ROOT, "shell-wrapper", "agentguard-shell");

function nullTtyLock() {
  return {
    canPrompt: false,        // forces non-interactive path in handleIncident
    acquire: async () => {},
    release: () => {},
  };
}

function uniqueSocketPath(label) {
  return path.join(os.tmpdir(), `agentguard-test-${label}-${process.pid}-${Date.now()}.sock`);
}

/** Start a daemon, run `fn(socketPath)`, then stop the daemon. */
async function withDaemon({ config = {}, label }, fn) {
  const socketPath = uniqueSocketPath(label);
  const stats = { commandsSeen: 0, intercepted: 0, approved: 0, blocked: {} };
  const daemon = await startShellDaemon({
    socketPath,
    config,
    agent: "test",
    stats,
    ttyLock: nullTtyLock(),
  });
  try {
    return await fn(socketPath, stats);
  } finally {
    await daemon.stop();
  }
}

/** One-shot JSON request → JSON response over the daemon's UDS. */
function ask(socketPath, req) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk) => { buf += chunk; });
    sock.on("end", () => {
      try { resolve(JSON.parse(buf.trim())); } catch (e) { reject(e); }
    });
    sock.on("error", reject);
    setTimeout(() => {
      try { sock.destroy(); } catch {}
      reject(new Error("ask() timeout 3s"));
    }, 3000);
  });
}

/** Run the Go wrapper binary with the given args and env, return {code,out,err}. */
function runWrapper(args, env, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(WRAPPER_BIN, args, { env });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    const t = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch {}
      resolve({ code: "TIMEOUT", out, err });
    }, timeoutMs);
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out, err });
    });
  });
}

const wrapperBuilt = (() => {
  try {
    const st = fs.statSync(WRAPPER_BIN);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
})();

// ─── 1. Safe command → approved ──────────────────────────────────────────────

describe("shell-daemon: safe command", () => {
  it("returns outcome=approved without invoking handleIncident", async () => {
    await withDaemon({ label: "safe" }, async (socketPath, stats) => {
      const resp = await ask(socketPath, {
        v: 1, cmd: "echo hello", cwd: process.cwd(), ppid: process.pid,
      });
      assert.equal(resp.v, 1);
      assert.equal(resp.outcome, "approved");
      assert.equal(stats.commandsSeen, 1);
      // Safe commands take the fast path — never counted as intercepted.
      assert.equal(stats.intercepted, 0);
    });
  });
});

// ─── 2. Risky command → denied ───────────────────────────────────────────────

describe("shell-daemon: risky command, no TTY", () => {
  it("CRITICAL command with canPrompt=false → denied", async () => {
    // canPrompt=false (default for nullTtyLock) + level=CRITICAL forces deny
    // via the no-TTY safety branch in handleIncident — no prompt needed.
    await withDaemon({ label: "risky" }, async (socketPath, stats) => {
      const resp = await ask(socketPath, {
        v: 1,
        cmd: "rm -rf /tmp/agentguard-test-target",
        cwd: process.cwd(),
        ppid: process.pid,
      });
      assert.equal(resp.outcome, "denied");
      assert.ok(resp.reason, "denied response includes a reason string");
      assert.equal(stats.commandsSeen, 1);
      assert.ok((stats.blocked.CRITICAL ?? 0) >= 1, "CRITICAL deny is counted in stats.blocked");
    });
  });
});

// ─── 3. autoApprove path ─────────────────────────────────────────────────────

describe("shell-daemon: autoApprove config", () => {
  it("WARN command with autoApprove=[WARN] → approved without prompting", async () => {
    await withDaemon(
      { label: "autoapprove", config: { autoApprove: ["WARN"] } },
      async (socketPath, stats) => {
        const resp = await ask(socketPath, {
          v: 1,
          cmd: "npm install lodash",
          cwd: process.cwd(),
          ppid: process.pid,
        });
        assert.equal(resp.outcome, "approved");
        assert.equal(stats.commandsSeen, 1);
        assert.equal(stats.approved, 1, "approved counter incremented via autoApprove path");
      }
    );
  });
});

// ─── 4. Wrapper: socket unreachable → fail-closed ────────────────────────────

describe("agentguard-shell wrapper: fail-closed", () => {
  it(
    "exits 126 when AGENTGUARD_SESSION_ID is set but the socket is unreachable",
    { skip: !wrapperBuilt && "Go wrapper binary not built — skipping" },
    async () => {
      const fakeSocket = path.join(os.tmpdir(), `agentguard-no-such-${Date.now()}.sock`);
      // Ensure it really doesn't exist.
      try { fs.unlinkSync(fakeSocket); } catch {}

      const env = {
        ...process.env,
        AGENTGUARD_SESSION_ID: "test-fail-closed",
        AGENTGUARD_SOCKET: fakeSocket,
        // Marker that the wrapper would propagate to /bin/sh ONLY if it
        // erroneously fell through to passthrough — we assert it never does.
        AGENTGUARD_TEST_LEAK: "leaked",
      };
      const r = await runWrapper(
        ["-c", "echo SHOULD_NOT_RUN"],
        env,
      );
      assert.equal(r.code, 126, "fail-closed exit code");
      assert.ok(!r.out.includes("SHOULD_NOT_RUN"), "command body must not have run");
      assert.match(r.err, /unreachable|blocking/i, "stderr explains the block");
    }
  );
});

// ─── 5. Wrapper: no session → fail-open (passthrough) ────────────────────────

describe("agentguard-shell wrapper: fail-open", () => {
  it(
    "execs /bin/sh when AGENTGUARD_SESSION_ID is absent, even with a bogus socket path",
    { skip: !wrapperBuilt && "Go wrapper binary not built — skipping" },
    async () => {
      // Strip BOTH session env vars.  The wrapper should not consult either.
      const env = { ...process.env };
      delete env.AGENTGUARD_SESSION_ID;
      env.AGENTGUARD_SOCKET = "/nonexistent/should/be/ignored.sock";

      const r = await runWrapper(["-c", "echo PASSED_THROUGH"], env);
      assert.equal(r.code, 0, "exit 0 means /bin/sh ran the command");
      assert.match(r.out, /PASSED_THROUGH/, "stdout contains the echo output");
      assert.equal(r.err, "", "no error output on the fail-open path");
    }
  );

  it(
    "execs /bin/sh for non-`-c` invocations even when a session is active",
    { skip: !wrapperBuilt && "Go wrapper binary not built — skipping" },
    async () => {
      // Active session, valid socket — but we invoke without -c.  The
      // wrapper recognises this as a non-command-mode call and passes
      // through unconditionally (no adjudication).
      const fakeSocket = path.join(os.tmpdir(), `agentguard-noncmd-${Date.now()}.sock`);
      const env = {
        ...process.env,
        AGENTGUARD_SESSION_ID: "test-noncmd",
        AGENTGUARD_SOCKET: fakeSocket,
      };
      // `sh -c "echo hi"` is the command-mode path.  `sh /dev/null` is not —
      // it interprets argv[1] as a script file.  /dev/null is empty so the
      // shell exits 0.  No daemon contact required.
      const r = await runWrapper(["/dev/null"], env);
      assert.equal(r.code, 0, "non -c invocation passes through");
    }
  );
});
