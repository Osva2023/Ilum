# Ilum — Architecture

Technical reference for the codebase. Read alongside `CLAUDE.md` (project
conventions) and `TASKS.md` (task board). Everything here reflects the real
code under `src/` and `bin/`.

## 1. Overview

Ilum is a guardian for AI coding agents (Codex, Claude Code, aider, …).
It intercepts dangerous shell commands and watches sensitive files in real time,
alerting via terminal / Telegram / email / macOS notification and allowing
rollback. It runs as an interactive wrapper or as a background daemon.

## 2. Stack

- **Pure Node.js ESM** (`"type": "module"`). **No TypeScript, no build step** —
  the source runs as-is. Node ≥ 18.
- **Dependencies** (minimal, intentional):
  - `chalk` — terminal color.
  - `chokidar` — file-system watching (`filewatcher.js`).
  - `express` — dashboard web server (`dashboard/server.js`).
  - `nodemailer` — SMTP email alerts (`notifier.js`, imported lazily).
  - Native `fetch` (Node 18+) for Telegram — no HTTP library.
- **Optional**: `node-pty` (real PTY interception), `electron` (tray app, own
  `package.json` under `tray/`).

## 3. Modes of operation

| Mode | Entry | What it does |
|------|-------|--------------|
| Interactive session | `agentguard <agent> [args]` (`bin/agentguard`) | Snapshots the tree, wraps the agent in a PTY (or log-based fallback), watches files, prompts on risk, prints a session summary. |
| Daemon | `agentguard daemon start` (`bin/agentguard-daemon.js`) | Persistent, audit-only watcher over `watchPaths`. No prompts/enforcement; per-event Telegram suppressed. Optional daily Telegram report. launchd lifecycle via `install`/`uninstall`. |
| Tray | `agentguard tray` | Electron menu-bar app showing daemon status (`tray/`, launchd via `tray-control.js`). |
| Report | `agentguard report [--days=N]` | Renders a human summary of the audit log (`report.js`). |
| Dashboard | `agentguard dashboard` | Local web UI at `localhost:7429` (`dashboard/server.js`). |

## 4. The three layers of defense

1. **Command interception** — the agent's I/O is scanned for dangerous commands.
   - `pty-interceptor.js` (Phase 1): real PTY via `node-pty`, used when stdout is
     a TTY and bindings exist.
   - `interceptor.js` (Phase 0): log-based line scanning of stdout/stderr, the
     fallback for pipes / CI / no native build.
   - `decoder.js` de-obfuscates (base64, etc.) before `classifier.js` →
     `rules.js` assign SAFE / WARN / HIGH / CRITICAL.
2. **File watching** — `filewatcher.js` (chokidar) detects edits that bypass the
   shell (e.g. `--print` mode). `sensitive.js` flags `.env`, keys, `CLAUDE.md`,
   etc. Touches are logged and alerted.
3. **Correlation engine** — multi-event patterns (mass-delete, exfil) over a
   shared in-memory `event-bus.js`. `correlator.js` evaluates
   `correlation-rules.js`; `suppression.js` dedups repeat fires.

All three normalize findings into an **Incident** and route through
`enforcement.js → handleIncident()`, which decides: auto-deny / auto-approve /
prompt / defer — then calls injected runtime callbacks (resume, terminate,
restore). `snapshot.js` (git stash) and `pending-changes.js` enable rollback.

## 5. Data flow (interactive session)

```
agentguard <agent>
      │
      ▼
 createSnapshot()              git stash -u  → stashRef
      │
      ├───────────────► startFileWatcher (chokidar)
      │                      │  file event → decoder → event-bus
      │                      │                          │
      │                      ▼                          ▼
      │                 isSensitive?              correlator.evaluate()
      │                      │                          │
      ▼                      └──────────┬───────────────┘
 runPtyInterceptor / runInterceptor     ▼
   stdout/err line → decoder → classify → Incident
                                         │
                                         ▼
                              enforcement.handleIncident()
                          autoDeny│autoApprove│prompt│defer
                                         │
                  ┌──────────────────────┼───────────────────────┐
                  ▼                       ▼                        ▼
            logger.log()          approval.promptApproval   notifier (Telegram/
        (~/.agentguard/audit.log)   (terminal raw mode)      email/macOS) +
                                                             snapshot restore
      │
      ▼ (agent exits)
 showPostActionReview()  →  printSessionSummary()
```

The daemon runs only the file-watch + correlation half, in `auditOnly` mode
(log, never prompt/enforce).

## 6. Main modules

| File | Responsibility | Key imports |
|------|----------------|-------------|
| `index.js` | Re-exports the public API | all of the below |
| `classifier.js` | `classify(cmd)` → `{level, reason, matchedPattern}` | `rules.js` |
| `rules.js` | Regex risk rules + `RISK_LEVELS` | — |
| `decoder.js` | De-obfuscate commands / normalize file events | — |
| `correlation-rules.js` | Multi-event patterns (mass-delete, exfil) | — |
| `correlator.js` | `evaluate(bus)` runs correlation rules | `correlation-rules.js`, `event-bus.js` |
| `event-bus.js` | In-memory event store (`bus`, `EventBus`) | — |
| `filewatcher.js` | Watch `watchPaths`, emit events, alert | `chokidar`, `decoder`, `correlator`, `suppression`, `enforcement`, `notifier`, `sensitive`, `pending-changes`, `logger` |
| `sensitive.js` | Sensitive-file patterns (`isSensitive`) | — |
| `interceptor.js` | Phase 0 log-based interception | `classifier`, `decoder`, `enforcement`, `logger` |
| `pty-interceptor.js` | Phase 1 PTY interception | `node-pty`, `classifier`, `enforcement`, `notifier` |
| `enforcement.js` | `handleIncident()` decision + side-effect callbacks | `approval`, `preview`, `logger` |
| `approval.js` | Terminal approval UI (raw mode; no-TTY ⇒ deny) | `readline` |
| `snapshot.js` | `createSnapshot` / `restoreSnapshot` (git stash) | `child_process`, `sensitive` |
| `pending-changes.js` | Per-file rollback registry (Telegram Keep/Rollback) | — |
| `reviewer.js` | Post-action review of changes | `pending-changes`, `logger` |
| `preview.js` | Preview what an incident would change | — |
| `suppression.js` | Notification/rule dedupe + cooldown | — |
| `notifier.js` | Telegram + email (SMTP) + macOS alerts | `fetch`, `nodemailer`, `child_process` |
| `telegram-listener.js` | Poll Telegram for approve/deny, keep/rollback | `fetch`, `pending-changes`, `logger` |
| `logger.js` | JSON-lines audit log, per-process `sessionId` | `fs` |
| `report.js` / `summary.js` | Audit-log summary / session summary box | `logger`, `chalk` |
| `daily-report.js` | Pure helpers for the daemon's daily Telegram report | `report.js` |
| `init.js` | `agentguard init` wizard (paths, aliases, daemon) | `readline`, `daemon-control` |
| `config.js` | `loadConfig`, `mergeConfig`, `addWatchPath`, policy packs | `fs` |
| `daemon-control.js` / `tray-control.js` | launchd lifecycle for daemon / tray | `child_process` |
| `dashboard/server.js` | Express dashboard + REST API | `express`, `config`, `daemon-control` |

## 7. The audit log

JSON-lines at `~/.agentguard/audit.log` (one self-contained JSON object per
line). Under tests (`NODE_ENV=test`) it is redirected to a temp file. Written by
`logger.js`; every entry has `ts` (ISO-8601) and `sessionId`.

**Event types** (`event` field): `session_start`, `session_end`,
`command_intercepted`, `command_approved`, `command_denied`,
`incident_detected`, `incident_approved`, `incident_denied`,
`snapshot_created`, `snapshot_restore`, `file_restore`, `telegram_keep`,
`review_kept`.

**Common fields** (present when relevant):
`source` (`command`|`correlation`|`filewatch`), `level`
(`SAFE`/`WARN`/`HIGH`/`CRITICAL`), `command`, `ruleId`, `reason`, `agent`,
`file`, `watchPath` (the watched root a file belongs to — for project
attribution in the dashboard), `stashRef`, `restored`, `by`, `deferredTo`.

## 8. Configuration

`config.js → loadConfig()` searches `agentguard.config.json` (cwd) →
`~/.agentguard/config.json` → built-in `DEFAULT_CONFIG`. An optional `policy`
pack (`dev`/`strict`/`ci`) merges between defaults and user overrides.

Main fields:

- `auditOnly` — log only, never enforce (the daemon forces this on).
- `autoApprove` / `autoDeny` — risk levels handled without a prompt.
- `rules.disabled` / `rules.custom` — tweak the rule set.
- `snapshot.enabled` / `snapshot.restoreOnDeny`.
- `auditLog.enabled` / `auditLog.path`.
- `notifications.minLevel` — gate for out-of-band channels (default `HIGH`).
- `notifications.telegram` — `enabled`, `botToken`, `chatId`, `extraChatIds`.
- `notifications.email` — `enabled`, `smtp{host,port,user,pass,secure}`, `to`.
- `notifications.system` — macOS native notification toggle.
- `notifications.dailyReport` — `enabled`, `hour` (local, default 8).
- `watchPaths` — directories the daemon watches (supports `~`).

## 9. Code conventions

- **ESM only**: `import`/`export`, explicit `.js` extensions on relative
  imports. `require()` only in dedicated `.cjs` files (e.g. `node-hook.cjs`).
- **Pure modules with seams** for testing: inject `opts.spawnFn`,
  `opts.createTransport`, `setSink()`, etc., so logic is testable without I/O.
  Pure helpers are factored out (e.g. `daily-report.js`, `addWatchPath`).
- **Absolute paths** via `path` / `os.homedir()` / `fileURLToPath`; never embed
  `~` in generated files.
- **Exports**: public API surfaces through `index.js`. Test-only helpers are
  exported from their own module and exercised directly.

## 10. Contributing in remote mode

- **Work on `dev`. Never commit directly to `main`** (`main` only receives
  merges from `dev`, then publishes to npm).
- Before changes: `agentguard daemon status`. After changes: **`npm test`** —
  if it fails, revert before committing. Tests set `NODE_ENV=test` so they never
  touch the real audit log. New test files must be added to the explicit `test`
  script chain in `package.json`.
- Do not edit `src/config.js`, `src/logger.js`, or `bin/agentguard` without an
  explicit instruction (which then *is* the review — keep it minimal).
- Commit + push:
  ```bash
  git add <files>
  git commit -m "type(scope): description"
  git push origin dev   # pushes to both remotes (morphius101, Osva2023)
  ```
