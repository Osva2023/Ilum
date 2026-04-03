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
 */

import chokidar from "chokidar";
import path from "path";
import chalk from "chalk";
import { logIntercepted } from "./logger.js";
import { decodeFileEvent } from "./decoder.js";
import { bus } from "./event-bus.js";
import { evaluate } from "./correlator.js";
import { filterFired, suppression } from "./suppression.js";

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
 * and are logged to the audit log.  No mid-session prompting occurs — the
 * Post-Action Review (reviewer.js) handles per-file decisions after the
 * agent exits.
 *
 * @param {Object} opts
 * @param {string}   opts.cwd        - Directory to watch
 * @param {string}   opts.agent      - Agent name (for logging)
 * @param {string}   [opts.stashRef] - Snapshot ref (unused by watcher; passed through for context)
 * @param {Object}   [opts.stats]    - Shared stats object (mutated in place)
 * @returns {{ stop: Function, fileChanges: Array }}
 */
export function startFileWatcher({ cwd, agent, stashRef, stats }) {
  void stashRef; // no longer used mid-session; reviewer.js handles rollback
  const fileChanges = [];

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

  function handleChange(event, filePath) {
    const rel = path.relative(cwd, filePath);

    // ── Rule-engine pipeline (correlation layer) ──────────────────────────────
    // handleChange receives internal labels ("created"/"modified"/"deleted");
    // decodeFileEvent expects the raw chokidar event names ("add"/"change"/"unlink").
    const chokidarEvt =
      event === "deleted" ? "unlink" : event === "created" ? "add" : "change";
    bus.push(decodeFileEvent(chokidarEvt, rel));
    const fired = filterFired(evaluate(bus), suppression);
    for (const rule of fired) {
      console.error(
        chalk.magenta(`[AgentGuard] ⚡ Correlation: ${rule.description} [${rule.level}]`)
      );
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
    .on("add",    (p) => handleChange("created", p))
    .on("change", (p) => handleChange("modified", p))
    .on("unlink", (p) => handleChange("deleted", p));

  return {
    stop: () => watcher.close(),
    fileChanges,
  };
}
