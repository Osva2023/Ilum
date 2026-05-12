/**
 * AgentGuard Node Runtime Hook  (Phase 1.6)
 *
 * Loaded via NODE_OPTIONS=--require=<this-path> when AgentGuard wraps a
 * Node-based agent (Codex CLI, Claude Code, aider, etc).  Patches the
 * `child_process` module so that any shell-bound spawn — `exec`, `spawn`
 * with `shell:true`, or direct `spawn('/bin/sh', ['-c', cmd])` — routes
 * through the agentguard-shell wrapper instead of the system `/bin/sh`.
 *
 * Why this exists:
 *   The SHELL env-var approach (set $SHELL=<wrapper>) works for callers
 *   that read $SHELL.  But Node's `child_process.exec` and friends hardcode
 *   `/bin/sh`, ignoring $SHELL entirely.  Empirical confirmation: Codex CLI
 *   produced an empty wrapper-trace.log under SHELL-only interception.
 *   This hook closes that hole by patching from inside the same Node
 *   process, swapping the shell binary at the call site.
 *
 * Mechanism:
 *   We do NOT reimplement the daemon protocol here — we just point Node at
 *   our existing wrapper by overriding `options.shell`.  The wrapper handles
 *   the daemon round-trip exactly as it does for $SHELL paths.
 *
 * Safety:
 *   • No-op when AGENTGUARD_SOCKET is unset (agent is not under AgentGuard).
 *   • No-op when the wrapper binary is missing or not executable.
 *   • Errors during patching are swallowed; agent code never breaks.
 *   • Respects an explicit `shell: '/bin/bash'` — we only override the
 *     "default shell" cases (undefined / null / true).  A determined agent
 *     can still bypass by writing `shell: '/bin/sh'`, but legitimate code
 *     that needs bash extensions keeps working.
 *   • Re-injects AGENTGUARD_SOCKET / AGENTGUARD_SESSION_ID into a custom
 *     `options.env` so env-clobbering doesn't silently disable interception.
 *
 * NOTE: This file MUST stay CJS (.cjs).  AgentGuard's package.json is
 * `"type": "module"`, but `--require` only loads CJS.
 */

"use strict";

(() => {
  // ─── Startup diagnostic ───────────────────────────────────────────────────
  // Append one JSON line to ~/.agentguard/hook-trace.log every time the hook
  // is loaded.  Runs BEFORE the AGENTGUARD_SOCKET early-bail so we can tell
  // "Codex never loaded the hook" from "hook loaded but no session env".
  // Best-effort: any failure is swallowed — diagnostics must never break the
  // agent.  Remove this block (and the comment) once the hook is verified
  // working end-to-end.
  try {
    const fs = require("fs");
    const path = require("path");
    const os = require("os");
    const dir = path.join(os.homedir(), ".agentguard");
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      event: "hook_loaded",
      pid: process.pid,
      argv0: process.argv[0] ?? "",
    }) + "\n";
    fs.appendFileSync(path.join(dir, "hook-trace.log"), line, { mode: 0o600 });
  } catch {}

  // Bail early if we're not under AgentGuard.  Hook becomes a no-op,
  // user code runs normally.
  if (!process.env.AGENTGUARD_SOCKET) return;

  let childProcess, fs, path;
  try {
    childProcess = require("child_process");
    fs = require("fs");
    path = require("path");
  } catch {
    return; // exotic Node environment without these built-ins; nothing to do
  }

  // Hook lives at <repo>/src/node-hook.cjs; wrapper at
  // <repo>/shell-wrapper/agentguard-shell.  Resolve relative.
  const wrapperPath = path.resolve(__dirname, "..", "shell-wrapper", "agentguard-shell");

  try {
    const stat = fs.statSync(wrapperPath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return;
  } catch {
    return; // wrapper not built — silently skip
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  // Basenames that indicate "this is a shell invocation" when paired with
  // `-c` as the first argument.  Conservative list — the major POSIX shells
  // plus dash/ksh/fish.  Agents that use anything else aren't intercepted.
  const SHELL_BASENAMES = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

  /**
   * True when `spawn(file, args)` is functionally a shell invocation —
   * `file` resolves to a known shell, and args[0] === '-c' with a command
   * string at args[1].  Catches the common pattern of code that bypasses
   * `shell:true` to dodge its quoting footgun.
   */
  function isShellInvocation(file, args) {
    if (typeof file !== "string") return false;
    const base = path.basename(file);
    return SHELL_BASENAMES.has(base) &&
      Array.isArray(args) &&
      args.length >= 2 &&
      args[0] === "-c" &&
      typeof args[1] === "string";
  }

  /**
   * Decision 1 (confirmed): only override the "default shell" cases.
   * An explicit `shell: '/bin/bash'` is respected — the agent may rely on
   * bash-specific features.
   */
  function shouldOverrideShell(shell) {
    return shell === undefined || shell === null || shell === true;
  }

  /**
   * Decision 2 (confirmed): when the agent supplies a custom env (clobbering
   * process.env), copy our session vars in so the wrapper subprocess can
   * still find the daemon socket.  When env is omitted, the child inherits
   * process.env — already has the vars.
   */
  function injectEnv(env) {
    if (env == null) return env;
    const out = { ...env };
    if (process.env.AGENTGUARD_SOCKET && out.AGENTGUARD_SOCKET == null) {
      out.AGENTGUARD_SOCKET = process.env.AGENTGUARD_SOCKET;
    }
    if (process.env.AGENTGUARD_SESSION_ID && out.AGENTGUARD_SESSION_ID == null) {
      out.AGENTGUARD_SESSION_ID = process.env.AGENTGUARD_SESSION_ID;
    }
    return out;
  }

  // ─── Patches ──────────────────────────────────────────────────────────────

  // exec(command, [options], [callback])
  // execSync(command, [options])
  // execFile(file, [args], [options], [callback])
  // execFileSync(file, [args], [options])
  //
  // For exec/execSync we always intercept (shell is implicit).
  // For execFile* we only intercept when options.shell is truthy, which is
  // the rare opt-in shell path.

  const origExec = childProcess.exec;
  const origExecSync = childProcess.execSync;
  const origExecFile = childProcess.execFile;
  const origExecFileSync = childProcess.execFileSync;
  const origSpawn = childProcess.spawn;
  const origSpawnSync = childProcess.spawnSync;

  childProcess.exec = function patchedExec(command, optionsOrCallback, callback) {
    let options, cb;
    if (typeof optionsOrCallback === "function") {
      cb = optionsOrCallback;
      options = {};
    } else {
      options = optionsOrCallback ? { ...optionsOrCallback } : {};
      cb = callback;
    }
    if (shouldOverrideShell(options.shell)) options.shell = wrapperPath;
    options.env = injectEnv(options.env);
    return cb !== undefined
      ? origExec.call(this, command, options, cb)
      : origExec.call(this, command, options);
  };

  childProcess.execSync = function patchedExecSync(command, options) {
    options = options ? { ...options } : {};
    if (shouldOverrideShell(options.shell)) options.shell = wrapperPath;
    options.env = injectEnv(options.env);
    return origExecSync.call(this, command, options);
  };

  // execFile / execFileSync — args list is mandatory after `file`.  Only
  // intercept when shell is explicitly truthy.
  childProcess.execFile = function patchedExecFile(file, ...rest) {
    return forwardWithMaybeShell(origExecFile, this, file, rest);
  };

  childProcess.execFileSync = function patchedExecFileSync(file, ...rest) {
    return forwardWithMaybeShell(origExecFileSync, this, file, rest);
  };

  function forwardWithMaybeShell(orig, thisArg, file, rest) {
    // Argument shape: (file, [args], [options], [callback]).
    // Find the options object (first plain object that isn't an array or
    // function) and patch it.
    let optsIdx = -1;
    for (let i = 0; i < rest.length; i++) {
      const v = rest[i];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        optsIdx = i;
        break;
      }
    }
    if (optsIdx === -1) return orig.call(thisArg, file, ...rest);

    const opts = { ...rest[optsIdx] };
    // Decision 1: shell-string respected; only swap when shell is truthy
    // *and* shouldOverride.  execFile defaults to NO shell (false), so
    // shell:true is the explicit opt-in.
    if (opts.shell === true) opts.shell = wrapperPath;
    opts.env = injectEnv(opts.env);
    rest[optsIdx] = opts;
    return orig.call(thisArg, file, ...rest);
  }

  // spawn / spawnSync — three call shapes:
  //   spawn(command)
  //   spawn(command, args)
  //   spawn(command, options)
  //   spawn(command, args, options)
  childProcess.spawn = function patchedSpawn(command, args, options) {
    const [cmd, normArgs, opts, hadArgs] = patchSpawnArgs(command, args, options);
    return hadArgs
      ? origSpawn.call(this, cmd, normArgs, opts)
      : origSpawn.call(this, cmd, opts);
  };

  childProcess.spawnSync = function patchedSpawnSync(command, args, options) {
    const [cmd, normArgs, opts, hadArgs] = patchSpawnArgs(command, args, options);
    return hadArgs
      ? origSpawnSync.call(this, cmd, normArgs, opts)
      : origSpawnSync.call(this, cmd, opts);
  };

  /**
   * Normalise spawn-style args, apply the shell-substitution rules, and
   * return `[cmd, args, options, hadArgsArray]` so the caller can reconstruct
   * the original call shape.
   */
  function patchSpawnArgs(command, args, options) {
    let actualArgs = null; // null → caller did not pass an args array
    let actualOpts;

    if (Array.isArray(args)) {
      actualArgs = args;
      actualOpts = options ? { ...options } : {};
    } else if (args !== null && typeof args === "object") {
      // spawn(command, options) form
      actualOpts = { ...args };
    } else {
      actualOpts = {};
    }

    let cmd = command;

    if (actualOpts.shell === true) {
      // shell:true → swap to wrapper.
      actualOpts.shell = wrapperPath;
    } else if (
      (actualOpts.shell === undefined || actualOpts.shell === null) &&
      isShellInvocation(command, actualArgs)
    ) {
      // Decision 4: direct shell invocation — spawn('/bin/sh', ['-c', cmd]).
      // No `shell` option, but the file IS a shell.  Swap the file.
      cmd = wrapperPath;
    }
    // Explicit `shell: '/bin/bash'` etc. → leave alone (Decision 1).

    actualOpts.env = injectEnv(actualOpts.env);
    return [cmd, actualArgs ?? [], actualOpts, actualArgs !== null];
  }

  // ─── Test harness escape hatch ────────────────────────────────────────────
  // When AGENTGUARD_NODE_HOOK_TESTING is set, expose the helpers so unit
  // tests can verify them in isolation without spawning subprocesses.  The
  // patches stay applied — production behaviour is unchanged.
  if (process.env.AGENTGUARD_NODE_HOOK_TESTING) {
    module.exports = {
      _internals: {
        wrapperPath,
        isShellInvocation,
        shouldOverrideShell,
        injectEnv,
        SHELL_BASENAMES,
      },
    };
  }
})();
