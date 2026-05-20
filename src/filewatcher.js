/**
 * AgentGuard File Watcher
 *
 * Monitors the working directory for file changes while an agent runs.
 * Catches edits that bypass shell interception (e.g. Claude Code --print mode).
 *
 * All changes are tracked silently into the fileChanges array.  Sensitive file
 * touches are logged to the audit log and noted with a quiet gray notice.
 * The mid-session approval prompt has been replaced by a Post-Action Review
 * (see reviewer.js) that runs after the agent exits.
 *
 * Correlation incidents (multi-event patterns across the shared event bus) are
 * routed through handleIncident() so filewatcher-triggered correlations are
 * enforced the same way as interceptor.js and pty-interceptor.js.
 */

import chokidar from "chokidar";
import path from "path";
import chalk from "chalk";
import { logDetected, logIntercepted, logSessionEnd, logSnapshotRestore } from "./logger.js";
import { decodeFileEvent } from "./decoder.js";
import { bus } from "./event-bus.js";
import { evaluate } from "./correlator.js";
import { filterFired, suppression } from "./suppression.js";
import { handleIncident } from "./enforcement.js";
import { restoreSnapshot } from "./snapshot.js";
import { isSensitive } from "./sensitive.js";
import {
  isNotifierConfigured,
  meetsThreshold,
  sendFileChangeAlert,
  sendSystemNotification,
} from "./notifier.js";
import { pending } from "./pending-changes.js";

// ─── Sensitive file patterns ─────────────────────────────────────────────────
// Patterns and isSensitive() live in ./sensitive.js so snapshot.js can reuse
// them without creating a circular import.

function riskLevel(filePath) {
  const basename = path.basename(filePath);
  // Highest risk — secrets and credentials
  if (/^\.env(\..*)?$/.test(basename)) return "HIGH";
  if (/\.(pem|key|p12|pfx)$/i.test(basename)) return "CRITICAL";
  if (/^id_(rsa|ecdsa|ed25519)$/.test(basename)) return "CRITICAL";
  if (/^\.github\/workflows/.test(filePath)) return "HIGH";
  if (/^package(-lock)?\.json$/.test(basename)) return "WARN";
  // Agent memory files — persistent instructions that survive between
  // sessions and could be poisoned.  Same risk band as .env.
  if (/^CLAUDE\.md$/.test(basename)) return "HIGH";
  if (/^\.cursorrules$/.test(basename)) return "HIGH";
  if (/^\.claude\/(settings\.json|memory)/.test(filePath)) return "HIGH";
  if (/^\.hermes\//.test(filePath)) return "HIGH";
  if (/^\.aider\.(conf\.ya?ml|tags\.cache)/.test(basename)) return "HIGH";
  if (/^(agent-memory|memories)\.json$/.test(basename)) return "HIGH";
  return "WARN";
}

// ─── Telegram deferral check ─────────────────────────────────────────────────

/**
 * Return true when a fired correlation rule should defer its CLI prompt
 * because an unresolved Telegram alert already covers one of the file
 * events that drove the rule.  Exported as a pure function so it can be
 * unit-tested without spinning up chokidar.
 *
 * @param {Object} args
 * @param {Object} args.config
 * @param {import("./correlation-rules.js").CorrelationRule} args.rule
 * @param {import("./event-bus.js").EventBus} args.bus
 * @param {import("./pending-changes.js").PendingChanges} args.pending
 * @returns {boolean}
 */
export function shouldDeferToTelegram({ config, rule, bus, pending }) {
  if (!isNotifierConfigured(config)) return false;
  const since = new Date(Date.now() - (rule.windowMs ?? 60_000)).toISOString();
  const busFiles = new Set([
    ...bus.query({ type: "file_write", since }).map((e) => e.file),
    ...bus.query({ type: "file_delete", since }).map((e) => e.file),
  ]);
  return pending.listUnresolved().some((entry) => busFiles.has(entry.path));
}

// ─── Per-file cooldown + session dedup for sensitive-file notices ────────────

// Two layers throttle sensitive-file notifications:
//   1. recentSensitive — module-level cooldown (10s per file) that suppresses
//      bursts (e.g. `npm install` rewriting package-lock.json many times).
//      Suppresses everything: audit log, stderr, Telegram, macOS popup.
//   2. notifiedFiles — per-watcher-session Set (see startFileWatcher) that
//      ensures one *alert* per file per session.  After the first alert,
//      subsequent events still write to the audit log but skip the noisy
//      out-of-band channels (Telegram + macOS popup).
// fileChanges and stats are unaffected by either layer.
const SENSITIVE_COOLDOWN_MS = 10_000;
const recentSensitive = new Map();

/**
 * Classify a sensitive-file event into "cooldown" | "dedup" | "fire".
 *
 *   cooldown — same file touched within cooldownMs; suppress everything.
 *   dedup    — already alerted this session; audit log + dedup stderr only.
 *   fire     — first sight; full alert path (audit + stderr + notifications).
 *
 * Mutates notifiedFiles (added on "fire") and recentSensitive (updated on
 * "fire" + "dedup", preserved on "cooldown" so the burst anchor stands).
 * Exported so unit tests can drive it without spinning up chokidar.
 */
export function classifySensitiveEvent({
  rel,
  now,
  notifiedFiles,
  recentSensitive,
  cooldownMs = SENSITIVE_COOLDOWN_MS,
}) {
  const last = recentSensitive.get(rel);
  if (last && now - last < cooldownMs) return "cooldown";
  recentSensitive.set(rel, now);
  if (notifiedFiles.has(rel)) return "dedup";
  notifiedFiles.add(rel);
  return "fire";
}

// ─── Watcher ─────────────────────────────────────────────────────────────────

/**
 * Start watching the working directory for file changes.
 *
 * Changes are tracked silently.  Sensitive file touches emit a quiet notice
 * and are logged to the audit log.
 *
 * Correlation incidents (multi-event patterns detected via the shared event
 * bus) are routed through handleIncident() exactly as interceptor.js does.
 * CRITICAL correlations auto-deny and terminate the session; HIGH prompts
 * interactively when a TTY is available; WARN is deferred when no TTY.
 *
 * @param {Object} opts
 * @param {string}   opts.cwd                       - Directory to watch
 * @param {string}   opts.agent                     - Agent name (for logging)
 * @param {string}   [opts.sessionId]               - Current AgentGuard session id
 * @param {string}   [opts.stashRef]                - Snapshot ref for restore-on-deny
 * @param {string}   [opts.sensitiveBackupDir]      - Per-session backup dir for sensitive files
 * @param {Object}   [opts.config]                  - Merged AgentGuard config object
 * @param {Object}   [opts.stats]                   - Shared stats object (mutated in place)
 * @returns {{ stop: Function, fileChanges: Array }}
 */
export function startFileWatcher({
  cwd,
  agent,
  sessionId,
  stashRef,
  sensitiveBackupDir,
  config,
  stats,
}) {
  const fileChanges = [];
  let handlingCorrelation = false; // prevent re-entrant enforcement

  // Session-level dedup: one Telegram/macOS alert per file per startFileWatcher
  // call.  Scoped here (not module-level) so a new watcher starts fresh.
  const notifiedFiles = new Set();

  const watcher = chokidar.watch(cwd, {
    ignored: [
      /node_modules/,
      /\.git\//,
      /\.agentguard/,
      /\.(log)$/,
    ],
    persistent: true,
    ignoreInitial: true,        // only watch NEW changes
    usePolling: false,
    awaitWriteFinish: false,    // report immediately, don't wait
  });

  async function handleChange(event, filePath) {
    const rel = path.relative(cwd, filePath);

    // ── Sensitive-file detection ──────────────────────────────────────────────
    // Runs BEFORE the correlation pipeline below.  The Telegram alert is
    // fire-and-forget, so placing it first guarantees the alert leaves the
    // process immediately on detection — regardless of whether a correlation
    // rule further down awaits an interactive prompt.  fileChanges + stats
    // updates are sync and order-independent.
    const sensitive = isSensitive(rel);
    const level = sensitive ? riskLevel(rel) : "SAFE";

    fileChanges.push({ event, file: rel, level, time: new Date().toISOString() });

    if (stats) stats.fileChanges = (stats.fileChanges || 0) + 1;

    if (sensitive) {
      if (stats) stats.intercepted = (stats.intercepted || 0) + 1;

      const action = classifySensitiveEvent({
        rel,
        now: Date.now(),
        notifiedFiles,
        recentSensitive,
      });

      if (action === "dedup") {
        logIntercepted({ command: `${event}: ${rel}`, level, reason: "Sensitive file modified by agent", agent });
        console.error(chalk.gray(`[AgentGuard] 📝 sensitive: ${rel} (already alerted this session)`));
      } else if (action === "fire") {
        logIntercepted({ command: `${event}: ${rel}`, level, reason: "Sensitive file modified by agent", agent });
        console.error(chalk.gray(`[AgentGuard] 📝 sensitive: ${rel}`));

        // Gate noisy out-of-band channels (Telegram + macOS popup) on the
        // configured minimum severity.  Audit log + CLI stderr above are
        // always emitted so the in-terminal observer never loses signal.
        const passesThreshold = meetsThreshold(level, config?.notifications?.minLevel);

        // Register a pending change and fire a Telegram alert with inline
        // Keep / Rollback buttons.  Fire-and-forget so the watcher never
        // blocks on network latency.  Gated on isNotifierConfigured to
        // mirror the pty-interceptor.js pattern and avoid pending-entry
        // leaks when Telegram is unconfigured (no listener to consume them).
        if (passesThreshold && isNotifierConfigured(config)) {
          const changeId = pending.register({
            sessionId,
            path: rel,
            event,
            level,
            stashRef,
            sensitiveBackupDir,
          });
          sendFileChangeAlert(
            { file: rel, level, event, sessionId, changeId, agent },
            config
          )
            .then(({ text, refs }) => {
              pending.updateMessageRefs(changeId, refs);
              pending.updateMessageText(changeId, text);
            })
            .catch(() => {});
        }

        // macOS native notification — fire-and-forget.  Threshold gate is
        // applied here so we skip the string-building / spawn setup below
        // configured minLevel; sendSystemNotification re-checks defensively.
        if (passesThreshold) {
          sendSystemNotification(
            { title: rel, message: `${event} by ${agent}`, level },
            config,
          );
        }
      }
      // action === "cooldown": fully suppressed by the burst throttle.
    } else {
      // Non-sensitive change — log quietly
      console.error(chalk.gray(`[AgentGuard] 📝 ${event}: ${rel}`));
    }

    // ── Rule-engine pipeline (correlation layer) ──────────────────────────────
    // handleChange receives internal labels ("created"/"modified"/"deleted");
    // decodeFileEvent expects the raw chokidar event names ("add"/"change"/"unlink").
    const chokidarEvt =
      event === "deleted" ? "unlink" : event === "created" ? "add" : "change";
    bus.push(decodeFileEvent(chokidarEvt, rel));
    const fired = filterFired(evaluate(bus), suppression);

    for (const rule of fired) {
      if (handlingCorrelation) continue; // prevent re-entrant enforcement

      console.error(
        chalk.magenta(`[AgentGuard] ⚡ Correlation: ${rule.description} [${rule.level}]`)
      );

      const incident = {
        source: "correlation",
        level: rule.level,
        reason: rule.description,
        ruleId: rule.id,
      };

      // When notifications are configured AND pending.listUnresolved() has an
      // entry whose path appears in the file events that drove this rule, the
      // user already has an actionable Keep / Rollback alert in Telegram —
      // showing the CLI prompt too would double-handle the same event.  The
      // incident is still recorded to the audit log with deferredTo:"telegram"
      // so deferred correlations stay observable and distinguishable.
      if (shouldDeferToTelegram({ config, rule, bus, pending })) {
        console.error(chalk.gray("[AgentGuard] decision deferred to Telegram"));
        logDetected(incident, agent, { deferredTo: "telegram" });
        continue;
      }

      handlingCorrelation = true;

      const { outcome } = await handleIncident({
        incident,
        config,
        stashRef,
        agent,
        stats,
        runtime: {
          // Filewatch runs alongside the interceptor — no PTY, no child ref.
          // Use process.stdout.isTTY as the canPrompt signal, same as interceptor.js.
          canPrompt: process.stdout.isTTY ?? false,
          onRestore: () => {
            console.error(chalk.yellow("[AgentGuard] Restoring snapshot\u2026"));
            const snap = restoreSnapshot(stashRef);
            console.error(
              snap.restored
                ? chalk.green(`[AgentGuard] ${snap.message}`)
                : chalk.red(`[AgentGuard] Restore failed: ${snap.message}`)
            );
            logSnapshotRestore(snap, agent);
          },
          onTerminate: () => {
            console.error(chalk.red("\n[AgentGuard] Operation blocked."));
            logSessionEnd(agent);
            process.exit(1);
          },
          onResume: () => {
            handlingCorrelation = false;
          },
        },
      });

      if (outcome === "deferred") {
        // Non-CRITICAL with no interactive TTY — allow the session to continue.
        handlingCorrelation = false;
      }
      // outcome === "approved": onResume already reset the flag.
      // outcome === "denied":   onTerminate called process.exit(1).
    }

  }

  watcher
    .on("add",    (p) => { handleChange("created", p).catch(() => {}); })
    .on("change", (p) => { handleChange("modified", p).catch(() => {}); })
    .on("unlink", (p) => { handleChange("deleted", p).catch(() => {}); });

  return {
    stop: () => watcher.close(),
    fileChanges,
  };
}
