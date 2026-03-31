# AgentGuard

**Guardrails for AI coding agents. See what they touch. Keep what you want.**

[![npm version](https://img.shields.io/npm/v/agentguard)](https://www.npmjs.com/package/agentguard)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/agentguard/agentguard/pulls)

AgentGuard wraps any AI coding agent — Claude Code, Codex, aider — and watches everything it does. Dangerous commands get flagged before they run. Every file change gets tracked. When the session ends, you review a diff of anything sensitive and decide, file by file, what to keep.

You asked for one thing. AgentGuard makes sure that's all you got.

---

AI coding agents are powerful but unpredictable. Claude Code might refactor `auth.js` and quietly edit your `.env` while it's at it. Codex might clean up "unused files" and delete something critical. You asked for one thing — you got ten. Most of the time nothing breaks. But you never really know what changed until something goes wrong, and by then the context is gone.

---

## How AgentGuard helps

- **PTY Interceptor** — Wraps the agent process and catches dangerous shell commands mid-execution (`rm -rf`, `git push --force`, pipe-to-shell, etc.) before they run
- **File Watcher** — Silently tracks every file touched during the session, including agents running in `--print` mode that bypass the PTY
- **Post-Action Review** — When the agent finishes, shows a diff of every sensitive file (`.env`, keys, CI configs, `package.json`) and lets you choose Keep / Rollback per file

**You see exactly what changed. You decide what to keep.**

---

## Install

**From npm** (coming soon):
```bash
npm install -g agentguard
```

**From source** (for beta testers with repo access):
```bash
git clone https://github.com/morphius101/agentguard.git
cd agentguard
npm install
npm install -g .
```

**Requirements:** Node.js 18+, git (for snapshots and rollback)

---

## Usage

```bash
# Wrap any agent
agentguard claude --print "refactor my auth module"
agentguard codex
agentguard aider --model gpt-4
```

---

## What it looks like

```
$ agentguard claude --print "clean up the auth module"

  ╔══════════════════════════════════════════╗
  ║  AgentGuard v0.2.0  •  Session started   ║
  ║  Snapshot: ✓  File watcher: ✓  PTY: ✓   ║
  ╚══════════════════════════════════════════╝

[claude] Analyzing auth module...
[claude] Refactoring src/auth.js — extracting token validation helper
[claude] Removing duplicate middleware in src/middleware/auth.js
[claude] Done.

  [AgentGuard] File watcher recorded 4 changes

──────────────────────────────────────────────
  POST-ACTION REVIEW
  Files changed during session: 4
  Sensitive files requiring review: 1
──────────────────────────────────────────────

  [1/1]  CRITICAL  •  .env
  ─────────────────────────────────────────
  @@ -12,3 +12,4 @@
   DATABASE_URL=postgres://localhost/myapp
   SESSION_SECRET=abc123
   NODE_ENV=development
  +OPENAI_API_KEY=sk-proj-••••••••••••••••••

  This file was modified during the session.
  [K]eep  [R]ollback  [S]kip all  › _

  › K

  ✓ Kept .env

──────────────────────────────────────────────
  ╔══════════════════════════════════════════╗
  ║  Session complete                        ║
  ║  Files changed:   4   (3 source, 1 env)  ║
  ║  Review:          1 kept, 0 rolled back  ║
  ║  Audit log:  ~/.agentguard/audit.log     ║
  ╚══════════════════════════════════════════╝
```

---

## Post-Action Review

Most guardrail tools try to block things mid-session. AgentGuard doesn't, and that's intentional.

**Why not block mid-session?** Claude Code runs fast. By the time a risky write is detected, the agent may be three steps ahead. More importantly — you might have *asked* it to touch that file. Blocking mid-stream creates false positives and breaks the agent's flow. The PTY interceptor still catches clearly-dangerous shell commands (deletes, force pushes), but file writes go through.

**Why per-file rollback instead of full repo restore?** A full restore throws away everything. If the agent correctly refactored five files and accidentally touched `.env`, you want to keep the five and roll back one. Per-file granularity means you don't have to choose between "accept everything" and "lose all progress."

**The prompt:** `[K]eep` accepts the change. `[R]ollback` reverts the file to its pre-session snapshot. `[S]kip all` exits without rolling back anything — useful when you've already reviewed and you trust the run.

---

## Risk levels

| Level | Examples | Behavior |
|---|---|---|
| CRITICAL | `.env`, private keys, CI/CD configs (`.github/workflows`) | Always shown in Post-Action Review |
| HIGH | `package.json`, `Dockerfile`, `.gitconfig` | Always shown in Post-Action Review |
| WARN | Build configs, tool configs (`.eslintrc`, `tsconfig.json`) | Listed quietly in session summary |
| SAFE | Source files, docs, tests | Listed quietly in session summary |

CRITICAL and HIGH files always surface for review, even if the diff looks harmless. You should be the one deciding that.

---

## Audit log

Everything gets written to `~/.agentguard/audit.log` as newline-delimited JSON — session starts, file changes, review decisions, rollbacks. Useful for post-mortems, compliance, or just understanding what your agents are up to over time.

---

## Configuration

`agentguard.config.json` support is coming. Planned options:

- Custom file risk classifications
- Auto-approve rules (e.g. always keep source file changes)
- Ignore patterns (e.g. `node_modules`, build output)
- Notification hooks

---

## Roadmap

- [x] PTY command interceptor
- [x] File watcher (all agents, including `--print` mode)
- [x] Post-Action Review with per-file diff + rollback
- [ ] Intent context — compare agent actions vs your original prompt
- [ ] Per-project config file (`agentguard.config.json`)
- [ ] Web dashboard
- [ ] Multi-agent test suite

---

## Contributing

Issues and feedback welcome. This is early — **feedback > PRs right now**. If something broke, something confused you, or something should exist that doesn't, open an issue.

If you do want to submit a PR: fork, branch, make the change, add a test if it touches logic, open the PR. That's it.

---

## License

[MIT License](./LICENSE) — free to use, modify, and distribute.
