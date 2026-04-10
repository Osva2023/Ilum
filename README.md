# AgentGuard

**A terminal safety layer for AI coding agents.**

AgentGuard wraps any CLI coding agent — Claude Code, Codex, aider — and watches what it does while it works. When behavior looks risky or out of scope, it intervenes: pausing execution, showing you a preview of what would happen, and asking for your approval before anything destructive continues.

It is **not an editor plugin**. It does not run inside VS Code or Cursor. It works in the terminal, where CLI agents actually execute.

---

## The problem

AI coding agents are powerful, but they routinely do more than you asked:

- running destructive commands you didn't expect (`rm -rf`, `git push --force`)
- editing files outside the intended scope (`.env`, CI configs, `package.json`)
- chaining several low-risk actions into a dangerous pattern
- writing to credentials, rewriting git history, or bumping engine requirements as a "helpful" side effect

The principle behind AgentGuard:

> **Do not block what you explicitly asked for. Catch the unintended side effects.**

---

## Real scenarios

### The `.env` incident

> *"Set up OpenAI integration in my app"*

The agent wired up the routes, created the client wrapper, added the import — then pulled `OPENAI_API_KEY=sk-proj-...` from earlier in the session and wrote it to `.env`.

AgentGuard surfaced the diff in the Post-Action Review. The key looked right, but it was an old key from a previous project, already rotated. Rolled back, set the correct key manually. Without the diff, that broken key would have shipped.

### The cleanup that wasn't

> *"Clean up unused files in /utils"*

The agent scanned, found files with no obvious imports, and queued `rm -rf ./utils/legacy`.

AgentGuard flagged it **CRITICAL** before the command ran. The directory stayed. A background job imports `legacy/pdf-parser.js` — nobody had touched it in eight months.

### The force push

> *"Fix the merge conflict in feature/payments and push"*

The agent resolved the conflict cleanly. Then it pushed with `git push --force`.

AgentGuard caught the command before execution. Three teammates had pushed to that branch that morning. A force push would have silently rewritten their work.

### The silent `package.json` edit

> *"Add rate limiting to the API"*

The agent installed `express-rate-limit` and wired it up correctly. It also bumped `engines` in `package.json` from `>=16` to `>=20` because the package uses modern syntax.

AgentGuard showed the diff in the Post-Action Review. The deployment environment was pinned to Node 18. That bump would have broken the next deploy.

---

## What it protects today

Three defense layers run in parallel during every session.

### Layer 1 — Command interception

The agent runs inside a PTY wrapper (or a log-based fallback). Every shell command is classified before it executes. Risky commands pause the session and show an approval prompt with context:

```
┌───────────────────────────────────────────────────────┐
│  AgentGuard — CRITICAL RISK OPERATION                 │
├───────────────────────────────────────────────────────┤
│  Command:  rm -rf dist/                               │
│  Risk:     CRITICAL                                   │
│  Reason:   Recursive or forced file deletion          │
├───────────────────────────────────────────────────────┤
│  Files that would be deleted:                         │
│    dist/index.js                                      │
│    dist/bundle.css                                    │
├───────────────────────────────────────────────────────┤
│  [A] Approve   [D] Deny   [Q] Quit session            │
└───────────────────────────────────────────────────────┘
```

30+ built-in rules cover the most common destructive patterns. CRITICAL incidents are denied automatically by default.

### Layer 2 — File watcher

Monitors the filesystem in parallel using chokidar. Catches changes that bypass shell interception — Claude Code in `--print` mode writes files directly without going through a shell command.

After the session ends, a **Post-Action Review** walks through every sensitive file that changed, shows a colorized diff, and lets you keep or roll back each one from the snapshot.

### Layer 3 — Correlation rule engine

Watches for dangerous *combinations* of events within a time window. Six built-in rules:

| Rule | Pattern | Window |
|---|---|---|
| `env-plus-network` | Secret file written → network request | 30 s |
| `mass-delete` | 3+ file deletions | 20 s |
| `force-push-after-delete` | File deletion → force git push | 60 s |
| `env-overwrite` | Secret or credential file overwritten | 10 s |
| `shell-pipe-exec` | Pipe-to-shell pattern | 10 s |
| `dependency-change-plus-network` | Dependency file changed + network activity | 60 s |

CRITICAL correlation incidents block the session the same way command incidents do. A suppression system prevents repeated alerts for the same rule within its detection window.

---

## Severity levels

| Level | Default behavior |
|---|---|
| `CRITICAL` | Auto-denied, session terminated, snapshot restored |
| `HIGH` | Approval prompt shown, session paused |
| `WARN` | Approval prompt shown |

CRITICAL incidents are never quietly deferred. If there is no interactive TTY (CI environment, piped output), AgentGuard denies and terminates rather than allowing the session to continue.

---

## Approval preview

Before showing the prompt, AgentGuard builds a context preview sized for the terminal:

| Situation | Preview content |
|---|---|
| `rm` command | Files that would be deleted |
| Write to `.env` or config file | Current file contents |
| `git reset --hard` | `git diff --stat HEAD` — changes that would be lost |
| `git push --force` | Recent commits at risk |
| Correlation incident | Rule ID, detection pattern, event sources |
| File watch incident | Event type (created / modified / deleted) + file path |

---

## Snapshot and restore

At the start of every session, AgentGuard runs `git stash -u` to capture the full working tree. When an incident is denied, the snapshot is restored automatically before the session terminates — regardless of whether the deny was triggered by autoDeny, a no-TTY CRITICAL, or an interactive choice.

Restore result (success or failure) is written to the audit log as a `snapshot_restore` event.

Snapshot is skipped when: the directory is not a git repository, the working tree is already clean, or `snapshot.enabled` is `false` in config.

---

## Install

**Requires Node.js 18 or later.** Git is strongly recommended — snapshot and rollback require it.

```bash
git clone https://github.com/Osva2023/agentguard
cd agentguard
npm install
npm link
```

`node-pty` native bindings compile during `npm install` via `node-gyp`. If the build fails, AgentGuard falls back to log-based interception automatically — no extra configuration needed.

---

## Usage

```bash
agentguard <agent> [agent-args...]
```

**Examples:**

```bash
# Claude Code
agentguard claude --print "refactor my auth module"

# Codex
agentguard codex

# aider
agentguard aider --model gpt-4
```

**What happens at startup:**

1. Config loaded from `agentguard.config.json` (project) or `~/.agentguard/config.json` (global)
2. Git snapshot created (`git stash -u`) — your rollback point
3. Agent launched inside the interceptor
4. Commands and file changes monitored until the agent exits
5. Post-Action Review runs if any sensitive files changed
6. Session summary printed

**Help:**

```bash
agentguard --help
```

**Local web dashboard** (audit log + session stats):

```bash
agentguard dashboard
```

---

## Audit-only mode

When you want to observe behavior before enabling enforcement — or if interactive prompts are too disruptive for your current workflow — run in audit-only mode:

```bash
# Via CLI flag
agentguard --audit-only claude --print "clean up this project"

# Or set in config
# agentguard.config.json:  { "auditOnly": true }
```

In audit-only mode:
- All incidents are detected and logged
- No prompts are shown
- No commands are blocked
- No snapshot restore is triggered
- The session summary shows "AUDIT-ONLY MODE" and "observed" instead of "intercepted"

This is useful for a first run on a new project, or for teams that want to understand what AgentGuard would flag before committing to enforcement.

---

## Configuration

Create `agentguard.config.json` in your project directory, or `~/.agentguard/config.json` globally:

```json
{
  "policy": "dev",
  "autoApprove": ["WARN"],
  "autoDeny": ["CRITICAL"],
  "auditOnly": false,
  "rules": {
    "disabled": [],
    "custom": [
      {
        "pattern": "deploy\\.sh",
        "level": "HIGH",
        "reason": "Deployment script"
      }
    ]
  },
  "snapshot": {
    "enabled": true,
    "restoreOnDeny": true
  },
  "auditLog": {
    "path": "~/.agentguard/audit.log"
  },
  "notifications": {
    "telegram": {
      "enabled": false,
      "botToken": "",
      "chatId": ""
    }
  }
}
```

| Field | Default | Description |
|---|---|---|
| `policy` | — | Named policy pack: `dev`, `strict`, or `ci` (see below) |
| `autoApprove` | `[]` | Risk levels to approve without prompting |
| `autoDeny` | `["CRITICAL"]` | Risk levels to deny without prompting |
| `auditOnly` | `false` | Log all incidents but take no enforcement action |
| `rules.disabled` | `[]` | Built-in rule IDs to skip |
| `rules.custom` | `[]` | Additional rules: `{ pattern, level, reason }` |
| `snapshot.enabled` | `true` | Create a git stash at session start |
| `snapshot.restoreOnDeny` | `true` | Restore snapshot when an incident is denied |
| `notifications.telegram` | disabled | Send Telegram alerts on CRITICAL incidents |

### Policy packs

Set `"policy"` to apply a behavior preset. Any other fields you set override the pack.

| Pack | `autoApprove` | `autoDeny` | Use case |
|---|---|---|---|
| `dev` | `["WARN"]` | `["CRITICAL"]` | Local development — WARN auto-approved, HIGH prompts, CRITICAL blocked |
| `strict` | `[]` | `["CRITICAL", "HIGH"]` | Security-sensitive work — only WARN prompts, everything risky is blocked |
| `ci` | `[]` | `["CRITICAL", "HIGH", "WARN"]` | CI pipelines — all risky commands fail the build immediately |

Precedence: **defaults → pack → your config**. Your explicit settings always win.

---

## Audit log

All enforcement events are written as JSON-lines to `~/.agentguard/audit.log`:

```jsonl
{"ts":"2026-04-09T10:00:00.000Z","sessionId":"a1b2c3d4","event":"session_start","agent":"claude"}
{"ts":"2026-04-09T10:00:05.123Z","sessionId":"a1b2c3d4","event":"incident_detected","source":"command","level":"CRITICAL","reason":"Recursive or forced file deletion","command":"rm -rf dist/","agent":"claude"}
{"ts":"2026-04-09T10:00:05.456Z","sessionId":"a1b2c3d4","event":"incident_denied","source":"command","level":"CRITICAL","reason":"Recursive or forced file deletion","command":"rm -rf dist/","agent":"claude"}
{"ts":"2026-04-09T10:00:05.501Z","sessionId":"a1b2c3d4","event":"snapshot_restore","restored":true,"message":"Snapshot restored from stash \"stash@{0}\".","agent":"claude"}
{"ts":"2026-04-09T10:01:00.789Z","sessionId":"a1b2c3d4","event":"incident_detected","source":"correlation","level":"CRITICAL","ruleId":"env-plus-network","reason":"Secret file modified then network request","agent":"claude"}
{"ts":"2026-04-09T10:02:00.000Z","sessionId":"a1b2c3d4","event":"session_end","agent":"claude"}
```

Query with `jq`:

```bash
# All denied incidents
jq 'select(.event == "incident_denied")' ~/.agentguard/audit.log

# CRITICAL incidents only
jq 'select(.level == "CRITICAL")' ~/.agentguard/audit.log

# Correlation rule fires
jq 'select(.source == "correlation")' ~/.agentguard/audit.log

# Snapshot restores (success and failure)
jq 'select(.event == "snapshot_restore")' ~/.agentguard/audit.log
```

---

## Current limitations

AgentGuard is in early beta. These are known, honest gaps:

**Command interception is output-pattern based.** It works by reading terminal output lines. Commands that execute silently, use non-standard output formatting, or run via internal process APIs (without echoing a shell command) can slip through undetected.

**No kernel-level visibility.** AgentGuard does not monitor OS-level events (`execve`, `unlink`, `openat`, `connect`). It infers behavior from visible terminal output and filesystem changes, not from what actually executed at the OS level.

**File monitoring has scope limits.** The file watcher only sees changes in the host filesystem under the watched path. Changes inside isolated containers that are not bind-mounted, or non-file side effects (database writes, cloud API calls), are not visible.

**Rollback is git-dependent.** Snapshot restore uses `git stash`. If the directory is not a git repo, or if the working tree was already clean, there is no snapshot to restore. Rollback also cannot revert external side effects — cloud resource changes, third-party API calls, database mutations.

**Tested primarily with Claude Code.** Other agents (Codex CLI, aider, Continue) have not been tested extensively in real sessions. Edge cases are expected.

**No allowlists or scoped exceptions yet.** You cannot currently say "always allow writes to `src/generated/`" without disabling rules entirely. Per-directory or per-rule sensitivity overrides are not yet implemented.

---

## Beta testers wanted

If you use Claude Code, Codex, or another CLI agent regularly, these are the most useful scenarios to test:

**1. Basic wrap — just observe**
```bash
agentguard --audit-only claude --print "add a helper function to utils.js"
```
Check the session summary. Look at `~/.agentguard/audit.log`. Did it see what you expected?

**2. Trigger the file watcher**
```bash
agentguard claude --print "add a REDIS_URL environment variable to the app"
```
AgentGuard should surface the `.env` diff in the Post-Action Review.

**3. Test rollback**
Same as above, but choose `[R]ollback` in the review. Verify the file is restored to its previous state.

**4. Trigger command interception**
Ask your agent to delete unused files. Watch if AgentGuard catches the `rm` before it runs.

**5. Vague-prompt test**
```bash
agentguard claude --print "clean up this project and remove anything unused"
```
Count how many files AgentGuard logged vs. how many you expected. This is useful signal about scope drift.

**6. Non-git directory**
Run in a directory without git. AgentGuard should handle gracefully — no crash, snapshot step skipped with a clear message.

**7. CI / no-TTY**
Run in an environment with no interactive terminal. CRITICAL incidents should terminate the process with a non-zero exit code.

**What feedback is most useful right now:**

- False positives: things AgentGuard flagged that were obviously fine
- False negatives: risky things that ran without being caught
- Crashes or unexpected exits
- Agents or workflows where AgentGuard didn't work at all
- Friction: prompts that interrupted work in an annoying way

**Where to report:** Open an issue at [github.com/Osva2023/agentguard](https://github.com/Osva2023/agentguard/issues). A short description of what you did and what happened is enough.

---

## What AgentGuard does not do

- It is not an IDE plugin or editor extension
- It does not replace code review
- It does not make all destructive changes impossible
- It cannot revert cloud resources, database writes, or external API calls
- It does not understand your intent — it detects patterns, not meaning

Human judgment is still required. AgentGuard improves real-time visibility into autonomous agent behavior; it does not eliminate the need to pay attention.

---

## Architecture

```
agentguard [--audit-only] <agent> [args]
        │
        ├── loadConfig()            agentguard.config.json → policy pack → defaults
        ├── createSnapshot()        git stash -u  →  stashRef
        │
        ├── PTY interceptor         node-pty (preferred when TTY available)
        │   or log interceptor      fallback: no TTY, no native build, CI
        │       │
        │       ├── decodeCommand() raw output line → canonical event
        │       ├── event-bus       time-windowed in-memory event buffer
        │       ├── correlator      6 multi-event correlation rules
        │       ├── suppression     cooldown — no repeat alerts within window
        │       └── handleIncident()
        │               │
        │               ├── auditOnly? → log only, resume
        │               ├── autoDeny  → log denied → restore → terminate
        │               ├── autoApprove → log approved → resume
        │               ├── no TTY + CRITICAL → deny path
        │               └── prompt  → buildIncidentPreview() → promptApproval()
        │
        ├── startFileWatcher()      chokidar — parallel filesystem monitoring
        │       └── decodeFileEvent() → shared event-bus (cross-layer correlation)
        │
        └── showPostActionReview()  per-file diff + keep / rollback after session
```

---

## Development

```bash
# Run all tests
npm test

# Run individual test suites
node --test test/enforcement.test.js
node --test test/correlator.test.js
node --test test/snapshot-restore.test.js
node --test test/audit-only.test.js
node --test test/policy-packs.test.js
node --test test/decoder.test.js
node --test test/suppression.test.js
node test/classifier.test.js
node test/config.test.js
```

**338 tests across 92 suites, 0 failures.**

Stack: Pure Node.js ESM, no TypeScript, no build step.
Runtime: `chalk`, `chokidar`, `node-pty`, `express`. Dev: `jest`.

---

## Roadmap

**Done:**
- [x] PTY command interceptor + log-based fallback
- [x] File watcher (catches `--print` mode agents)
- [x] Post-Action Review — per-file diff + keep/rollback
- [x] Correlation rule engine — 6 multi-event rules with suppression
- [x] Unified deny path — restore always runs on deny, restore result logged
- [x] Incident preview before approval prompt (source-specific context)
- [x] Audit log with full incident lifecycle (detected / approved / denied / restored)
- [x] Audit-only mode — observe without blocking (`auditOnly: true` / `--audit-only`)
- [x] Policy packs — named presets: `dev`, `strict`, `ci`
- [x] Local web dashboard

**Not yet implemented:**
- [ ] Intent context — compare agent actions against your original prompt; alert when the agent touches something outside declared scope
- [ ] Allowlists and scoped path exceptions — allow writes to specific directories without disabling rules
- [ ] Signed / remote audit — hash-chained entries, optional log forwarding for compliance
- [ ] Optional Linux eBPF backend — kernel-level telemetry for silent commands
- [ ] Verified multi-agent testing — Codex CLI, aider, Continue need real sessions
- [ ] Demo video / GIF

---

## Contributing

Issues and feedback are welcome. **This is early — feedback is more valuable than PRs right now.** If something broke, confused you, or should exist and doesn't, open an issue.

If you want to submit a PR: fork, branch, make the change, add a test if it touches logic, open the PR.

---

## License

[MIT](./LICENSE)
