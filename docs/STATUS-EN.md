# AgentGuard — Current Status & Next Steps
**Date:** April 9, 2026

---

## What Does AgentGuard Do Today?

AgentGuard is a terminal wrapper that sits between the developer and any AI coding agent (Claude Code, Codex, aider). Its job is to monitor what the agent does while it works.

It has three active defense layers plus a unified enforcement pipeline.

**Layer 1 — PTY Interceptor (shell commands)**
Monitors the terminal in real time. If the agent tries to run destructive commands (`rm -rf`, `git reset --hard`, `git push --force`, etc.), AgentGuard classifies them by risk level and routes them through the enforcement pipeline before execution.

**Layer 2 — File Watcher (file edits)**
Monitors the filesystem in parallel. Detects any file the agent modifies — even if the agent doesn't use shell commands (as Claude Code does in `--print` mode). Sensitive file touches (`.env`, private keys, CI/CD configs) are logged and surface in the Post-Action Review after the session ends.

**Layer 3 — Correlation Rule Engine (multi-event detection)**
Sits above both layers 1 and 2. Instead of reacting to individual commands or file changes, it watches for dangerous *combinations* of events within a time window. Six built-in rules detect patterns like secret file modified → network request (possible exfiltration), mass file deletion, force push after deletion, shell pipe execution, and more.

Correlation incidents from all three layers — PTY, log-based interceptor, and file watcher — now route through the unified enforcement pipeline. CRITICAL correlation incidents are blocked immediately; HIGH incidents show an approval prompt; WARN incidents are deferred when no TTY is available. A suppression system prevents alert fatigue by silencing repeated triggers within the detection window.

**Unified Enforcement Pipeline**
All incidents — whether from command interception, correlation rules, or file watch events — go through a single `handleIncident()` layer. Decision order: autoDeny → autoApprove → deferred (no TTY) → interactive prompt. All deny paths (autoDeny, CRITICAL-no-TTY, prompt deny) share identical behavior: restore snapshot → terminate session.

**Snapshot System**
At the start of each session, AgentGuard automatically runs `git stash` to save the current repo state. All deny paths restore the snapshot automatically before terminating.

**Audit Log**
Every session is recorded in `~/.agentguard/audit.log` — session start/end, incidents detected, incidents approved, incidents denied. JSON-lines format, queryable with `jq`.

**Audit-Only Mode**
When `auditOnly: true` is set in config (or `--audit-only` CLI flag is used), AgentGuard detects and logs all incidents but takes no enforcement action. No prompts, no blocks, no restore, no termination. Useful for observing behavior before turning on full enforcement.

**Policy Packs**
Named config presets (`dev`, `strict`, `ci`) set `autoApprove` and `autoDeny` levels as a starting point. Selected via `"policy": "dev"` in the config file. Project-level config always overrides the pack. Precedence: defaults → pack → project config.

| Pack | autoApprove | autoDeny | Use case |
|---|---|---|---|
| `dev` | `["WARN"]` | `["CRITICAL"]` | Local development |
| `strict` | `[]` | `["CRITICAL","HIGH"]` | Security-sensitive work |
| `ci` | `[]` | `["CRITICAL","HIGH","WARN"]` | CI pipelines |

---

## Architecture

```
raw event → decoder.js → event-bus.js → correlator.js → suppression.js
                                                               ↓
                                                     handleIncident()
                                                    ↙      ↓       ↘
                                              autoDeny  prompt  autoApprove
                                                  ↓       ↓
                                             restore → terminate
```

All three sources (PTY interceptor, log-based interceptor, file watcher) feed into the same `handleIncident()` with source-specific runtime callbacks.

---

## Test Coverage

**338 tests, 0 failures** across 92 suites.

| Suite | Tests |
|---|---|
| enforcement.test.js | 71 |
| correlator.test.js | — |
| decoder.test.js | — |
| suppression.test.js | — |
| preview.test.js | 22 |
| logger.test.js | 12 |
| pty-correlation.test.js | 16 |
| filewatcher-correlation.test.js | 20 |
| interceptor-command.test.js | 15 |
| policy-packs.test.js | 25 |
| audit-only.test.js | 27 |
| snapshot-restore.test.js | 14 |
| classifier.test.js | 63 |
| approval-diff.test.js | 18 |
| config.test.js | 6 |

---

## What's Been Shipped

- [x] PTY command interceptor + log-based fallback
- [x] File watcher (catches `--print` mode agents)
- [x] Post-Action Review — per-file diff + keep/rollback
- [x] Correlation rule engine — 6 multi-event rules with suppression
- [x] **Correlation → enforcement** — all three layers route through `handleIncident()`; CRITICAL fires block the session
- [x] Unified deny path — restore always runs on deny, across all sources; restore result written to audit log (`snapshot_restore` event)
- [x] Incident preview before approval prompt (source-specific context)
- [x] Audit log with full incident lifecycle (detected / approved / denied)
- [x] Default config: `autoDeny: ["CRITICAL"]`
- [x] **Audit-only mode** — observe without blocking (`auditOnly: true` / `--audit-only`)
- [x] **Policy packs** — named presets: `dev`, `strict`, `ci`
- [x] Dashboard (local web UI with audit log and session stats)

---

## What's Still Missing

### Technical
- [ ] **Intent context** — pass the developer's original prompt to AgentGuard so it can compare the agent's action against declared intent. Alert when the agent touches something out of declared scope.
- [ ] **Verified multi-agent support** — tested with Claude Code. Still needs real-world testing with Codex CLI, aider, Continue.
- [ ] **eBPF backend (Linux)** — kernel-level telemetry to catch silent commands that never appear in PTY output.
- [ ] **Signed / remote audit** — hash-chained audit entries, optional remote log forwarding for compliance use cases.
- [ ] **Demo video / GIF** — showing the moment AgentGuard intercepts a `.env` touch or a force push.

### Product / UX
- [ ] **GIF / demo video** — without this there's nothing to show on GitHub or Product Hunt.
- [ ] **Multi-agent testing** — Codex, aider, Continue need real sessions to surface edge cases.

### Outreach / Validation
- [ ] **5 beta testers** — developers who actively use Claude Code or Codex.
- [ ] **Interview first users** — what broke? What felt safe? What was annoying?
- [ ] **Product Hunt / HN launch** — once stable with betas.

---

## Key Design Decision

> **AgentGuard should not block what the developer explicitly asked for.**
> Its value is in detecting unintended side effects.

| Scenario | AgentGuard intervenes? |
|---|---|
| "Update my .env" → Claude edits .env | ❌ That was the intent |
| "Refactor auth.js" → Claude touches .env as side effect | ✅ Unintended side effect |
| "Clean up the code" → Claude runs `rm -rf utils/` | ✅ Unexpected destructive action |
| "Delete the old tests" → Claude deletes tests | ❌ That was the intent |

This requires **intent context** — knowing what the developer asked the agent to do, so AgentGuard can distinguish expected actions from side effects. This is the product's most important unsolved problem.

---

*AgentGuard — Guardrails for AI coding agents before they wreck your repo.*
