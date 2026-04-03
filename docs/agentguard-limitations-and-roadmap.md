# AgentGuard Limitations and Improvement Paths

Using ideas inspired by Datadog (eBPF runtime telemetry) and Wazuh (multi-source detection and rule correlation).

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

### 1.5 Rules are mostly single-event and static
Risk scoring is mostly regex-based on individual command/file events.

Impact: weaker context understanding and potential false positives/negatives.

### 1.6 Audit model is local by default
Audit logs are local JSONL by default.

Impact: useful operationally, but limited tamper resistance and centralized compliance controls.

### 1.7 Human approval fatigue
Interactive prompts are useful, but frequent prompts can create fatigue.

Impact: users may over-approve under pressure.

### 1.8 Cross-platform parity constraints
Higher-assurance kernel/runtime telemetry differs by OS.

Impact: uneven assurance model across Linux/macOS/Windows.

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

### 2.2 Wazuh-style: decoder + rule-engine pipeline
Wazuh's model suggests separating parsing from decision logic.

Proposed architecture:

1. Decoder/normalizer stage converts raw streams into canonical events:
   - `process_exec`
   - `file_write`
   - `file_delete`
   - `git_operation`
   - `network_connect`
2. Rule engine applies policy to normalized events.
3. Correlation rules score risky sequences across time windows.

Example correlations:

- `.env` modification + outbound network connection to unknown host,
- force push + risky branch operation sequence,
- mass deletion + mismatch with declared task scope.

What it improves:

- significantly improves 1.5 (context-aware detection),
- improves 1.7 by allowing suppression/tuning,
- improves 1.6 with richer event context and governance.

### 2.3 Wazuh-style tuning, suppression, and policy packs
Proposed operational controls:

- allowlists and scoped exceptions,
- deduplication and cooldown windows,
- policy packs for local dev, CI, and regulated workflows.

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

## 5) Practical roadmap summary

Recommended sequence:

1. Add optional Linux eBPF backend for high-fidelity runtime telemetry.
2. Refactor detection into decoder + correlation rule engine.
3. Add policy packs, tuning/suppression controls, and confidence-based response tiers.
4. Add signed/remote audit options for stronger governance.
5. Keep current PTY/output and file-watcher modes as portable fallbacks.

Expected outcome:

- materially fewer blind spots,
- improved detection quality and operator trust,
- clearer separation between what can be controlled and what requires broader platform/process controls.
