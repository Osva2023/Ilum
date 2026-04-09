# AgentGuard

**A terminal safety layer for CLI coding agents.**

AgentGuard wraps agent sessions launched from the shell — Claude Code, Codex, aider, and similar tools — and monitors what they do. When behavior looks risky or out of scope, it intervenes: pausing execution, showing a preview, and asking for explicit approval before anything destructive continues.

It is **not an editor plugin**. It does not run inside VS Code or Cursor. It works in the terminal, where CLI agents actually run.

---

## The problem

AI coding agents are powerful, but they routinely do more than you asked:

- editing files outside the intended scope
- running destructive commands too broadly
- chaining multiple low-risk actions into a genuinely dangerous pattern
- writing to `.env`, overwriting configs, or rewriting git history as a "helpful" side effect

The principle behind AgentGuard:

> **Do not block what you explicitly asked for. Block unintended side effects.**

AgentGuard is not trying to fight the agent. It is trying to protect you from scope drift, destructive automation, and emergent unsafe behavior.

---

## Real scenarios

### The `.env` incident

> *"Set up OpenAI integration in my app"*

The agent wired up the routes, created the client wrapper, and added the import. Then, drawing from context earlier in the session, it added `OPENAI_API_KEY=sk-proj-...` to `.env`.

AgentGuard surfaced the diff in the Post-Action Review. The key looked right — but it was an old key from a previous project, already rotated. Rolled back, set the correct key manually. Without the diff, that broken key would have shipped.

### The cleanup that wasn't

> *"Clean up unused files in /utils"*

The agent scanned, found files with no obvious imports, and queued `rm -rf ./utils/legacy`.

AgentGuard flagged it as **CRITICAL** before the command ran. Searching the codebase showed that `legacy/pdf-parser.js` was imported by a background job that only runs on invoice generation. Nobody had touched it in eight months. The directory stayed.

### The force push

> *"Fix the merge conflict in feature/payments and push"*

The agent resolved the conflict cleanly. Then it pushed with `git push --force`.

AgentGuard caught the command before execution. Three teammates had pushed commits to that branch that morning. A force push would have silently rewritten their work — no warning, no recovery without digging through reflog.

### The silent `package.json` edit

> *"Add rate limiting to the API"*

The agent installed `express-rate-limit`, wired it up correctly, and called it done. It also bumped `engines` in `package.json` from `>=16` to `>=20` because the package uses modern syntax.

AgentGuard showed the `package.json` diff in the Post-Action Review. The deployment environment was pinned to Node 18. That bump would have broken the next deploy.

---

## How it works

Three defense layers run in parallel during every session.

### 1 — Command interception

The agent runs inside a PTY wrapper (or log-based fallback). Every shell command is classified before it executes. Risky commands pause the session and show an approval prompt with a context preview:

```
┌───────────────────────────────────────────────────────┐
│  🚨 AgentGuard — CRITICAL RISK OPERATION              │
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

30+ built-in rules cover the most common destructive patterns. `CRITICAL` incidents are denied automatically by default — no prompt, no delay.

### 2 — File watcher

Monitors the filesystem in parallel using `chokidar`. Catches changes that bypass shell interception — Claude Code in `--print` mode writes files directly without going through the shell.

After the session ends, a **Post-Action Review** walks through every sensitive file that changed, shows a colorized diff, and lets you keep or roll back each file individually from the snapshot stash.

### 3 — Correlation rule engine

Watches for dangerous *combinations* of events within a time window. A command that looks mildly risky and a file edit that looks mildly risky can, together, indicate a high-confidence incident.

Six built-in correlation rules:

| Rule | Pattern | Window |
|---|---|---|
| `env-plus-network` | Secret file written → network request | 30 s |
| `mass-delete` | 3+ file deletions | 20 s |
| `force-push-after-delete` | File deletion → force git push | 60 s |
| `env-overwrite` | Secret or credential file overwritten | 10 s |
| `shell-pipe-exec` | Pipe-to-shell pattern | 10 s |
| `dependency-change-plus-network` | Dependency file changed + network activity | 60 s |

`CRITICAL` correlation incidents block the session the same way command incidents do. A suppression system prevents repeated alerts for the same rule within its detection window.

---

## Severity levels

| Level | Default behavior |
|---|---|
| `CRITICAL` | Auto-denied immediately, session terminated |
| `HIGH` | Approval prompt shown, session paused |
| `WARN` | Approval prompt shown |

`CRITICAL` incidents are never quietly deferred. If AgentGuard cannot show an interactive prompt (no TTY, CI environment), it denies and terminates rather than allowing the session to continue.

---

## Approval preview

Before showing the approval prompt, AgentGuard generates a context preview sized for the terminal:

| Situation | Preview content |
|---|---|
| `rm` command | Files that would be deleted |
| Write to `.env` or config file | Current file contents |
| `git reset --hard` | `git diff --stat HEAD` — changes that would be lost |
| `git push --force` | Recent commits at risk |
| Correlation incident | Rule ID, detection pattern, source label |
| File watch incident | Event type (created / modified / deleted) + file path |

The goal is enough context to make a good decision — not enough to overwhelm.

---

## Snapshot and restore

At the start of every session, AgentGuard runs `git stash -u` to capture the full working tree. When an incident is denied, the snapshot is restored automatically before the session terminates.

Restore follows a consistent order: increment stats → log denial → restore snapshot → terminate.

Snapshot is skipped when the directory is not a git repository, the working tree is already clean, or `snapshot.enabled` is `false`.

---

## Install

**Requires Node.js 18 or later** and git (strongly recommended — snapshot and rollback require it).

```bash
git clone https://github.com/Osva2023/agentguard
cd agentguard
npm install
npm link
```

`node-pty` native bindings compile during `npm install` via `node-gyp`. If the build fails, AgentGuard falls back to log-based interception automatically.

---

## Usage

```bash
agentguard <agent> [agent-args...]
```

**Examples:**

```bash
agentguard codex
agentguard claude --print "refactor my auth module"
agentguard aider --model gpt-4
```

**Help:**

```bash
agentguard --help
```

**Dashboard** (local web UI with audit log and session stats):

```bash
agentguard dashboard
```

**What happens at startup:**

1. Config loaded from `agentguard.config.json` or `~/.agentguard/config.json`
2. Git snapshot created (`git stash -u`) — your rollback point
3. Agent launched inside the interceptor (PTY mode if available, log-based otherwise)
4. Commands and file changes monitored until the agent exits
5. Post-Action Review runs if any sensitive files changed
6. Session summary printed

---

## Configuration

Create `agentguard.config.json` in your project directory, or `~/.agentguard/config.json` globally:

```json
{
  "autoApprove": ["WARN"],
  "autoDeny": ["CRITICAL"],
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
    "enabled": true,
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
| `autoApprove` | `[]` | Risk levels to approve without prompting |
| `autoDeny` | `["CRITICAL"]` | Risk levels to deny without prompting |
| `rules.disabled` | `[]` | Built-in rule IDs to skip |
| `rules.custom` | `[]` | Additional rules: `{ pattern, level, reason }` |
| `snapshot.enabled` | `true` | Create a git stash at session start |
| `snapshot.restoreOnDeny` | `true` | Restore snapshot when an incident is denied |
| `notifications.telegram` | disabled | Send Telegram alerts on `CRITICAL` incidents |

---

## Audit log

All enforcement events are written as JSON-lines to `~/.agentguard/audit.log`:

```json
{"ts":"2026-04-08T10:00:00.000Z","sessionId":"a1b2c3d4","event":"session_start","agent":"claude"}
{"ts":"2026-04-08T10:00:05.123Z","sessionId":"a1b2c3d4","event":"incident_detected","source":"command","level":"CRITICAL","reason":"Recursive or forced file deletion","command":"rm -rf dist/","agent":"claude"}
{"ts":"2026-04-08T10:00:05.456Z","sessionId":"a1b2c3d4","event":"incident_denied","source":"command","level":"CRITICAL","reason":"Recursive or forced file deletion","command":"rm -rf dist/","agent":"claude"}
{"ts":"2026-04-08T10:01:00.789Z","sessionId":"a1b2c3d4","event":"incident_detected","source":"correlation","level":"CRITICAL","ruleId":"env-plus-network","reason":"Secret file modified then network request","agent":"claude"}
{"ts":"2026-04-08T10:02:00.000Z","sessionId":"a1b2c3d4","event":"session_end","agent":"claude"}
```

Query with `jq`:

```bash
# All denied incidents
jq 'select(.event == "incident_denied")' ~/.agentguard/audit.log

# CRITICAL incidents only
jq 'select(.level == "CRITICAL")' ~/.agentguard/audit.log

# Correlation rule fires
jq 'select(.source == "correlation")' ~/.agentguard/audit.log
```

---

## Beta tester checklist

If you have access to the repo, here are specific scenarios worth testing:

1. **Basic wrap** — Run any agent you already use, prefixed with `agentguard`. See the session summary at the end.
   ```bash
   agentguard claude --print "add a helper function to utils.js"
   ```

2. **Trigger the file watcher** — Ask Claude to add an environment variable. Watch AgentGuard surface the `.env` diff in the Post-Action Review.
   ```bash
   agentguard claude --print "add a REDIS_URL environment variable to the app"
   ```

3. **Test rollback** — Same as above, but choose `[R]ollback` in the review. Verify the file is restored.

4. **Trigger the command interceptor** — Ask Codex or aider to delete unused files. See if AgentGuard flags the `rm` command before it runs.
   ```bash
   agentguard codex
   # → prompt: "delete any test files that aren't being used"
   ```

5. **Vague prompt test** — Give a broad prompt and count how many files AgentGuard logged vs. how many you expected.
   ```bash
   agentguard claude --print "clean up this project and remove anything unused"
   ```

6. **Check the audit log** — After any session:
   ```bash
   cat ~/.agentguard/audit.log | tail -20
   ```

7. **Non-git repo** — Run in a directory without git. AgentGuard should handle gracefully — no crash, snapshot step skipped with a clear message.

Found something unexpected? Open an issue — that feedback is the most valuable thing right now.

---

## What AgentGuard does not do

- It is not an IDE plugin or editor extension
- It does not replace code review
- It does not make all destructive changes impossible
- It does not replace version control or careful development practice

It improves real-time oversight of autonomous agent behavior in terminal workflows. Human judgment is still required.

---

## Development

```bash
# Run all tests
npm test

# Run individual test files
node --test test/enforcement.test.js
node --test test/correlator.test.js
node --test test/preview.test.js
node --test test/decoder.test.js
node --test test/suppression.test.js
node test/classifier.test.js
node test/config.test.js
```

239 tests across 52 suites, 0 failures.

**Stack:** Pure Node.js ESM, no TypeScript, no build step.
Runtime: `chalk`, `chokidar`, `node-pty`, `express`. Dev: `jest`.

---

## Architecture

```
agentguard <agent> [args]
        │
        ├── loadConfig()              agentguard.config.json or ~/.agentguard/config.json
        ├── createSnapshot()          git stash -u  →  stashRef
        │
        ├── PTY interceptor           node-pty (auto-detected, preferred)
        │   or log interceptor        fallback when no TTY or no native build
        │       │
        │       ├── decodeCommand()   raw output line → canonical event
        │       ├── event-bus         time-windowed in-memory event buffer
        │       ├── correlator        6 multi-event correlation rules
        │       ├── suppression       cooldown — no repeat alerts within window
        │       └── handleIncident()  autoDeny | autoApprove | prompt | defer
        │               │
        │               ├── buildIncidentPreview()   source-specific context
        │               └── promptApproval()         terminal box + diff preview
        │
        ├── startFileWatcher()        chokidar — parallel filesystem monitoring
        │       └── decodeFileEvent() → shared event-bus (cross-layer correlation)
        │
        └── showPostActionReview()    per-file diff + keep / rollback after session
```

---

## Roadmap

- [x] PTY command interceptor + log-based fallback
- [x] File watcher (catches `--print` mode agents)
- [x] Post-Action Review — per-file diff + keep/rollback
- [x] Correlation rule engine — 6 multi-event patterns
- [x] CRITICAL enforcement in both PTY and non-PTY paths
- [x] Unified deny path — restore always runs on deny
- [x] Incident preview before approval prompt
- [x] Audit log with full incident lifecycle
- [ ] Intent context — compare agent actions against your original prompt
- [ ] Audit-only mode — monitor without blocking
- [ ] Verified multi-agent support (Codex, aider, Continue)
- [ ] Demo video / GIF

---

## Contributing

Issues and feedback welcome. This is early — **feedback is more valuable than PRs right now**. If something broke, confused you, or should exist and doesn't, open an issue.

If you want to submit a PR: fork, branch, make the change, add a test if it touches logic, open the PR.

---

## License

[MIT](./LICENSE)
