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

## Real scenarios

### The .env incident

> _"Set up OpenAI integration in my app"_

The agent did the job well — created a client wrapper, wired up the routes, added the import. Then, drawing from context it had picked up earlier in the session, it added `OPENAI_API_KEY=sk-proj-...` to `.env`.

AgentGuard surfaced the diff in the Post-Action Review. The key looked right at first glance — but it was an old key from a previous project, already rotated. The developer chose `[R]ollback`, set the correct key manually, and moved on. Without the diff, they'd have pushed a broken deploy and spent an hour debugging a 401.

---

### The cleanup that wasn't

> _"Clean up unused files in /utils"_

The agent scanned the directory, found files with no obvious imports, and queued up `rm -rf ./utils/legacy` to clear the clutter.

AgentGuard flagged it as **CRITICAL** before the command ran. The developer paused, searched the codebase — and found that `legacy/pdf-parser.js` was imported by a background job that only runs on invoice generation. Nobody had touched it in eight months. The directory stayed.

---

### The force push

> _"Fix the merge conflict in feature/payments and push"_

The agent resolved the conflict cleanly. Then it pushed with `git push --force`.

AgentGuard caught the command and flagged it **HIGH RISK** before execution. Three teammates had pushed commits to `feature/payments` that morning. A force push would have silently rewritten history and erased their work — no warning, no recovery without digging through reflog. The developer ran `git push` instead.

---

### The silent package.json edit

> _"Add rate limiting to the API"_

The agent installed `express-rate-limit`, wired it up correctly, and called it done. It also bumped the `engines` field in `package.json` from `>=16` to `>=20` — the package uses some modern syntax, so the agent figured it was being helpful.

AgentGuard showed the `package.json` diff in the Post-Action Review. The developer's Railway deployment was pinned to Node 18. The engine bump would have broken the next deploy with a version mismatch error — the kind of thing that wastes an hour and happens on a Friday afternoon.

---

## Real scenarios

**"Set up OpenAI integration in my app"**
The agent wired up the integration correctly. It also added `OPENAI_API_KEY=sk-proj-...` to `.env` — pulling a key from somewhere in context. AgentGuard surfaced the diff. The key was an old one from a different project. Rolled back, avoided leaking the wrong credentials into production.

**"Clean up unused files in /utils"**
The agent ran `rm -rf ./utils/legacy`. AgentGuard flagged it as CRITICAL before execution. The developer said no — `legacy/` had a PDF parser used by a background job nobody had touched in months. It would have been gone.

**"Fix the merge conflict in feature/payments and push"**
The agent resolved the conflict, then ran `git push --force`. AgentGuard caught it before it executed. Three teammates had pushed commits to that branch since the last pull. They would have been gone.

**"Add rate limiting to the API"**
The agent added `express-rate-limit` correctly. It also bumped the Node engine requirement in `package.json` from `>=16` to `>=20` because "it uses modern syntax." AgentGuard showed the `package.json` diff in the Post-Action Review. Railway was running Node 18. That bump would have broken the deploy.

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

## Prompts and side effects

AI coding agents are trained to be helpful and thorough. That's a feature — but it means they routinely do more than you asked. When you say "set up the database connection," an agent doesn't just write the connection string. It might touch `.env`, update `config/database.js`, add a dependency to `package.json`, and drop a comment in `README.md` while it's at it. All reasonable. All unrequested.

The vaguer the prompt, the more the agent fills in the blanks with its own judgment. "Fix the bug" is a focused task with a likely answer. "Clean up the codebase" is an invitation for the agent to decide what clean means — and agents tend to be opinionated. You might get back 40 changed files.

Specific prompts produce fewer surprises. Scoped prompts — naming a file, a function, a behavior — give the agent less room to improvise. Vague prompts leave room for interpretation, and agents interpret generously.

| Prompt | Risk of side effects |
|---|---|
| "Refactor auth.js" | Low — scoped to one file |
| "Clean up the codebase" | High — agent decides what "clean" means |
| "Set up the database connection" | Medium — may touch .env, config files |
| "Fix the bug" | Medium — agent may "fix" related things it notices |
| "Optimize performance" | High — agent may change deps, configs, build setup |

AgentGuard doesn't tell you what prompts to write. It shows you what happened so you can learn the pattern.

---

## Prompts and side effects

Agents are trained to be helpful and thorough. That means they often do more than you asked — not because they're broken, but because they're trying to do a good job. When you say "set up the database connection," a helpful agent might also update `.env`, adjust the config, and add a health check endpoint. You asked for one thing and got four.

The more vague the prompt, the more the agent fills in the blanks with its own judgment. Specific prompts scope the work. Vague prompts open the door.

| Prompt | Side effect risk |
|---|---|
| "Refactor auth.js" | Low — scoped to one file |
| "Clean up the codebase" | High — agent decides what "clean" means |
| "Set up the database connection" | Medium — may touch `.env`, config files |
| "Fix the bug" | Medium — agent may "fix" related things it notices |
| "Optimize performance" | High — agent may change deps, configs, build setup |

AgentGuard doesn't tell you what prompts to write. It shows you what happened so you can learn the pattern.

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

## Try this — beta tester checklist

If you have repo access and want to put AgentGuard through its paces, here are specific scenarios worth testing:

1. **Basic wrap** — Run any agent you already use, just prefix with `agentguard`. See the session summary at the end.
   ```bash
   agentguard claude --print "add a helper function to utils.js"
   ```

2. **Trigger the file watcher** — Ask Claude to "add a new environment variable" and watch AgentGuard surface the `.env` diff in the Post-Action Review.
   ```bash
   agentguard claude --print "add a REDIS_URL environment variable to the app"
   ```

3. **Test rollback** — Ask the agent to modify `.env`, then choose `[R]ollback` in the review. Verify the file is restored to its original state.
   ```bash
   agentguard claude --print "update the DATABASE_URL in .env to use port 5433"
   # → choose [R]ollback in the review
   ```

4. **Trigger the PTY interceptor** — Ask Codex or aider to "delete old test files" and see if AgentGuard flags the `rm` command before it runs.
   ```bash
   agentguard codex
   # → prompt: "delete any test files that aren't being used"
   ```

5. **Vague prompt test** — Give a broad prompt like "clean up this project" and see how many files AgentGuard logs vs. how many you expected.
   ```bash
   agentguard claude --print "clean up this project"
   ```

6. **Check the audit log** — After any session, inspect what was logged.
   ```bash
   cat ~/.agentguard/audit.log | tail -20
   ```

7. **Skip all** — Run a session where the agent touches sensitive files, then choose `[S]kip all` in the review. Verify that all changes were kept as-is.
   ```bash
   agentguard claude --print "add a new config option to .env"
   # → choose [S]kip all in the review
   ```

8. **Non-git repo** — Run AgentGuard in a directory without git. Confirm it handles gracefully — no crash, snapshot step skipped cleanly.
   ```bash
   mkdir /tmp/no-git-test && cd /tmp/no-git-test
   agentguard claude --print "create a hello.js file"
   ```

Found something unexpected? Open an issue — that's exactly the feedback needed right now.

---

## Try this — beta tester checklist

If you have repo access and want to put AgentGuard through its paces, here are specific scenarios worth testing:

1. **Basic wrap** — Run any agent you already use, just prefix with `agentguard`. No other changes. See the session summary at the end.

2. **Trigger the file watcher** — Ask Claude: `agentguard claude --print "add a new environment variable called APP_SECRET"`. Watch AgentGuard surface the `.env` diff in the Post-Action Review.

3. **Test rollback** — Same as above, but when the review appears, choose `[R]ollback`. Verify the file is back to its original state.

4. **Trigger the PTY interceptor** — Ask Codex or aider to "delete old test files". See if AgentGuard flags the `rm` command before it runs. Try approving and denying.

5. **Vague prompt test** — Give a broad prompt: `agentguard claude --print "clean up this project and remove anything unused"`. Count how many files AgentGuard logged vs. how many you expected.

6. **Check the audit log** — After any session, run:
   ```bash
   cat ~/.agentguard/audit.log | tail -20
   ```
   Every intercepted command and review decision is there.

7. **Skip all** — Run a session where the agent touches sensitive files, then choose `[S]kip all` in the Post-Action Review. Verify everything was kept as-is.

8. **Non-git repo** — Run AgentGuard in a directory without git. It should handle gracefully — no crash, snapshot skipped with a clear message.

Found something unexpected? Open an issue — that's exactly the feedback needed right now.

---

## Contributing

Issues and feedback welcome. This is early — **feedback > PRs right now**. If something broke, something confused you, or something should exist that doesn't, open an issue.

If you do want to submit a PR: fork, branch, make the change, add a test if it touches logic, open the PR. That's it.

---

## License

[MIT License](./LICENSE) — free to use, modify, and distribute.
