# AgentGuard Limitations and Improvement Paths

Using ideas inspired by Datadog (eBPF runtime telemetry) and Wazuh (multi-source detection and rule correlation).

**Last updated: April 9, 2026**

---

## 1) Current limitations of AgentGuard

### 1.1 Command interception is output-pattern based
AgentGuard currently detects risky commands by parsing terminal output lines (for example `$ ...` and `Running: ...`).

That can miss behavior when:

- commands execute silently (no printed line),
- output format is non-standard,
- tools use internal process APIs without echoing command text,
- output is fragmented or styled in ways that bypass matching.

Impact: false negatives for live interception.

### 1.2 No kernel/syscall-level authority
AgentGuard does not currently monitor OS-level events like `execve`, `unlink`, `rename`, `openat`, or `connect`.

Impact: it infers behavior from visible text plus file changes rather than observing what definitely executed.

### 1.3 File monitoring has scope boundaries
File watching only sees host filesystem changes in the watched path.

Limitations include:

- isolated container filesystems that are not bind-mounted,
- very short-lived temp file sequences,
- non-file side effects (database writes, cloud/API actions).

Impact: incomplete visibility in some deployment/runtime topologies.

### 1.4 Snapshot/rollback is Git-dependent
Rollback relies on Git stash and repository state.

Limitations include:

- no Git repo means no snapshot rollback,
- stash restore edge cases (renames, deletes, untracked conflicts),
- rollback restores files, not external system side effects.

Impact: strong repository safety, weaker full-environment recovery.

Note: the unified deny path (all deny triggers call restore before terminating) is now implemented. The limitation is in what restore can cover, not in whether it fires.

### 1.5 ~~Rules are mostly single-event and static~~ — Partially addressed

**Status:** The Wazuh-style decoder + rule-engine pipeline is implemented. Six correlation rules detect multi-event patterns across time windows (env-plus-network, mass-delete, force-push-after-delete, env-overwrite, shell-pipe-exec, dependency-change-plus-network). Correlation incidents from all three sources — PTY interceptor, log-based interceptor, and file watcher — now route through the unified enforcement pipeline and can block the session.

Remaining gap: rule definitions are still static (no runtime tuning UI). Adding or adjusting rules requires editing the config file or code.

### 1.6 Audit model is local by default
Audit logs are local JSONL by default.

Impact: useful operationally, but limited tamper resistance and centralized compliance controls.

Note: audit-only mode (see §2.3) is now implemented — teams can run AgentGuard in observe-only mode before enabling full enforcement, which increases practical adoption of audit logging.

### 1.7 Human approval fatigue
Interactive prompts are useful, but frequent prompts can create fatigue.

**Status:** Partially addressed.

- Suppression system: repeated correlation alerts for the same rule are silenced within the detection window.
- Policy packs: `dev`, `strict`, and `ci` presets let teams quickly set appropriate autoDeny/autoApprove levels without hand-tuning config.
- Audit-only mode: teams who find prompts too disruptive can run in observe-only mode to build trust before enabling enforcement.

Remaining gap: no dynamic confidence scoring or context-aware suppression (e.g., suppress if agent is working in a known-safe directory).

### 1.8 Cross-platform parity constraints
Higher-assurance kernel/runtime telemetry differs by OS.

Impact: uneven assurance model across Linux/macOS/Windows.

---

## 2) Addressable limitations using Datadog and Wazuh ideas

### 2.1 Datadog-style: add optional eBPF telemetry on Linux
Datadog-inspired eBPF concepts can improve signal fidelity significantly.

Proposed additions:

- optional Linux backend for `execve`, file-destructive operations, sensitive writes, and network egress,
- event correlation to wrapped agent process tree/session,
- telemetry quality indicator in summaries (`output-inferred` vs `kernel-observed`).

What it improves:

- strongly improves 1.1 and 1.2 (silent/non-printed command blind spots),
- partially improves 1.3,
- improves audit fidelity in 1.6.

**Status:** Not yet implemented.

### 2.2 ~~Wazuh-style: decoder + rule-engine pipeline~~ — Implemented

**Status:** Complete.

The decoder/normalizer stage (`src/decoder.js`) converts raw PTY lines and filesystem events into canonical typed events (`process_exec`, `file_write`, `file_delete`, `git_operation`, `network_request`). The correlator (`src/correlator.js`) evaluates rules against the shared event bus. Six correlation rules fire enforcement actions — not just notices — through the unified `handleIncident()` pipeline.

All three sources share the same event bus, so cross-layer correlations (e.g., file watcher sees `.env` written, PTY interceptor sees outbound connection) fire naturally.

### 2.3 Wazuh-style tuning, suppression, and policy packs

**Status:** Partially implemented.

Implemented:
- Deduplication and cooldown windows (suppression system, per-rule `windowMs`).
- Policy packs: named presets (`dev`, `strict`, `ci`) set autoApprove/autoDeny levels. Selected via `"policy": "dev"` in config. Project config always overrides the pack.
- Audit-only mode: `auditOnly: true` config or `--audit-only` CLI flag — incidents detected and logged, no enforcement. Teams can observe before committing to blocking behavior.

Not yet implemented:
- Allowlists and scoped path exceptions.
- Per-directory or per-rule sensitivity overrides.
- Confidence-based response tiers (different behavior based on detection confidence).

What it improves:

- reduces prompt fatigue (1.7),
- reduces noisy false positives (1.5).

### 2.4 Stronger audit integrity and centralization
Proposed enhancements:

- hash-chained or signed audit entries,
- optional remote forwarding,
- immutable/append-only sinks where available.

What it improves:

- directly improves 1.6 for security/compliance use cases.

**Status:** Not yet implemented.

---

## 3) Partially addressable limitations

### 3.1 Container filesystem blind spots
If writes occur inside unmounted container filesystems, host watchers cannot inspect contents directly.

Possible mitigation:

- runtime/container-aware telemetry,
- stronger process-level monitoring.

Why partial:

- visibility depends on namespace/mount topology and runtime privileges.

### 3.2 Rollback beyond source files
Git rollback cannot revert:

- database mutations,
- cloud/service-side changes,
- external API side effects.

Possible mitigation:

- stricter preflight policies,
- isolated credentials/sandboxes,
- infrastructure-level guardrails.

Why partial:

- those states are outside repository control.

### 3.3 Cross-platform feature parity
eBPF is Linux-native; equivalent fidelity on other OSes requires different stacks.

Why partial:

- platform primitives and privilege models differ.

---

## 4) Limitations that cannot be fully solved by AgentGuard alone

### 4.1 External side effects in third-party systems
Once an approved action changes external systems (cloud resources, SaaS settings, billing, DNS), full local rollback is not guaranteed.

Reason:

- authority/state lives outside the local host and repo.

### 4.2 Human decision risk
Human-in-the-loop approval can still fail under time pressure.

Reason:

- this is fundamentally an operational/human factors risk.

### 4.3 Prompt intent ambiguity
Natural language task scope is often ambiguous.

Reason:

- determining "intended" vs "unintended" behavior is inherently probabilistic without strict structured intent.

### 4.4 Heterogeneous vendor tool semantics
Different agents and runtimes expose different internals and execution models.

Reason:

- no wrapper can perfectly normalize opaque, provider-specific behavior in all cases.

---

## 5) Practical roadmap summary

| Item | Status |
|---|---|
| PTY/output and file-watcher modes as portable fallbacks | ✅ Done |
| Decoder + correlation rule engine | ✅ Done |
| Correlation rules trigger enforcement (not just notices) | ✅ Done |
| Unified deny path (restore on all deny triggers) | ✅ Done |
| Audit-only mode | ✅ Done |
| Policy packs (dev / strict / ci) | ✅ Done (basic presets) |
| Allowlists, scoped exceptions, confidence tiers | ⬜ Not started |
| Signed / remote audit options | ⬜ Not started |
| Optional Linux eBPF backend | ⬜ Not started |

Remaining sequence for higher assurance:

1. Allowlists and scoped path exceptions — reduces false positives without disabling rules.
2. Signed/remote audit — makes the audit log trustworthy for compliance use cases.
3. Optional Linux eBPF backend — closes the silent-command blind spot (1.1, 1.2).
4. Intent context — compare agent actions against the developer's original prompt (the key unsolved differentiator).

Expected outcome from completing the remaining items:

- materially fewer blind spots,
- improved detection quality and operator trust,
- clearer separation between what can be controlled and what requires broader platform/process controls.
