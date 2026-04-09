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
import { logIntercepted, logSessionEnd } from "./logger.js";
import { decodeFileEvent } from "./decoder.js";
import { bus } from "./event-bus.js";
import { evaluate } from "./correlator.js";
import { filterFired, suppression } from "./suppression.js";
import { handleIncident } from "./enforcement.js";
import { restoreSnapshot } from "./snapshot.js";

// ─── Sensitive file patterns ─────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /^\.env(\..*)?$/,                         // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|crt|cer)$/i,         // crypto keys / certs
  /^id_(rsa|ecdsa|ed25519)(\.pub)?$/,       // SSH keys
  /^package(-lock)?\.json$/,                // deps manifest
  /^(Dockerfile|docker-compose\.ya?ml)$/i, // container config
  /\.(config\.(js|ts|cjs|mjs))$/,          // build/tool configs
  /\.(db|sqlite|sqlite3)$/,                 // databases
  /^\.github\/workflows\/.+\.ya?ml$/,      // CI/CD
  /^(\.gitconfig|\.npmrc|\.yarnrc)$/,      // tool credentials
];

const SAFE_EXTENSIONS = [
  ".md", ".txt", ".log", ".json.lock",
];

function isSensitive(filePath) {
  const basename = path.basename(filePath);
  const rel = filePath;

  // Never flag safe extensions
  if (SAFE_EXTENSIONS.some(ext => basename.endsWith(ext))) return false;

  return SENSITIVE_PATTERNS.some(re => re.test(basename) || re.test(rel));
}

function riskLevel(filePath) {
  const basename = path.basename(filePath);
  // Highest risk — secrets and credentials
  if (/^\.env(\..*)?$/.test(basename)) return "HIGH";
  if (/\.(pem|key|p12|pfx)$/i.test(basename)) return "CRITICAL";
  if (/^id_(rsa|ecdsa|ed25519)$/.test(basename)) return "CRITICAL";
  if (/^\.github\/workflows/.test(filePath)) return "HIGH";
  if (/^package(-lock)?\.json$/.test(basename)) return "WARN";
  return "WARN";
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
 * @param {string}   opts.cwd        - Directory to watch
 * @param {string}   opts.agent      - Agent name (for logging)
 * @param {string}   [opts.stashRef] - Snapshot ref for restore-on-deny
 * @param {Object}   [opts.config]   - Merged AgentGuard config object
 * @param {Object}   [opts.stats]    - Shared stats object (mutated in place)
 * @returns {{ stop: Function, fileChanges: Array }}
 */
export function startFileWatcher({ cwd, agent, stashRef, config, stats }) {
  const fileChanges = [];
  let handlingCorrelation = false; // prevent re-entrant enforcement

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

    // ── Existing sensitive-file detection (unchanged) ─────────────────────────
    const sensitive = isSensitive(rel);
    const level = sensitive ? riskLevel(rel) : "SAFE";

    fileChanges.push({ event, file: rel, level, time: new Date().toISOString() });

    if (stats) stats.fileChanges = (stats.fileChanges || 0) + 1;

    if (sensitive) {
      if (stats) stats.intercepted = (stats.intercepted || 0) + 1;

      // Audit log — always record sensitive touches
      logIntercepted({ command: `${event}: ${rel}`, level, reason: "Sensitive file modified by agent", agent });

      // Quiet notice — no blocking, no prompt
      console.error(chalk.gray(`[AgentGuard] 📝 sensitive: ${rel}`));
    } else {
      // Non-sensitive change — log quietly
      console.error(chalk.gray(`[AgentGuard] 📝 ${event}: ${rel}`));
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
