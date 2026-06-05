/**
 * AgentGuard Config Loader
 *
 * Reads agentguard.config.json from the current working directory,
 * falling back to ~/.agentguard/config.json, then to built-in defaults.
 *
 * Config schema:
 * {
 *   "policy":      "dev",              // optional named policy pack (dev | strict | ci)
 *   "autoApprove": ["WARN"],           // auto-approve these risk levels
 *   "autoDeny":    ["CRITICAL"],       // auto-deny these risk levels
 *   "rules": {
 *     "disabled": ["npm-install"],     // rule IDs to skip
 *     "custom": [                      // extra rules appended to the list
 *       { "pattern": "deploy.sh", "level": "HIGH", "reason": "Deployment script" }
 *     ]
 *   },
 *   "snapshot": { "enabled": true, "restoreOnDeny": true },
 *   "auditLog":  { "enabled": true, "path": "~/.agentguard/audit.log" }
 * }
 *
 * Merge precedence (lowest → highest):
 *   DEFAULT_CONFIG  →  policy pack (if set)  →  project/user config file
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, resolve, dirname } from "path";
import { homedir } from "os";

// ─── policy packs ────────────────────────────────────────────────────────────

/**
 * Named policy packs.  Each pack overrides only the fields it cares about;
 * anything not mentioned falls back to DEFAULT_CONFIG.  Project-level config
 * always wins over the pack.
 *
 * dev    — local development: WARN auto-approved, CRITICAL blocked, prompt for HIGH
 * strict — security-conscious: nothing auto-approved, HIGH + CRITICAL both blocked
 * ci     — non-interactive: all risk levels auto-denied so risky commands fail the build
 */
export const POLICY_PACKS = {
  dev: {
    autoApprove: ["WARN"],
    autoDeny:    ["CRITICAL"],
  },
  strict: {
    autoApprove: [],
    autoDeny:    ["CRITICAL", "HIGH"],
  },
  ci: {
    autoApprove: [],
    autoDeny:    ["CRITICAL", "HIGH", "WARN"],
  },
};

// ─── defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  /**
   * When true, AgentGuard detects and logs incidents but never blocks, prompts,
   * restores, or terminates.  Useful for observing behavior before enabling
   * full enforcement.
   */
  auditOnly: false,
  /** Risk levels to approve without prompting. e.g. ["WARN"] */
  autoApprove: [],
  /** Risk levels to deny without prompting. Override to [] to prompt instead. */
  autoDeny: ["CRITICAL"],
  rules: {
    /** Rule IDs to disable. */
    disabled: [],
    /** Additional custom rules: { pattern, level, reason } */
    custom: [],
  },
  snapshot: {
    enabled: true,
    /** Auto-restore the snapshot when an operation is denied. */
    restoreOnDeny: true,
  },
  auditLog: {
    enabled: true,
    path: "~/.agentguard/audit.log",
  },
  notifications: {
    /**
     * Minimum severity that triggers Telegram + macOS system notifications.
     * Options (in order of increasing noise):
     *   "CRITICAL" — only CRITICAL events notify
     *   "HIGH"     — HIGH and CRITICAL notify (default)
     *   "WARN"     — every sensitive event notifies (not recommended)
     * Audit logging and CLI output are unaffected.
     */
    minLevel: "HIGH",
    telegram: {
      /** Set to true and provide botToken + chatId to enable Telegram alerts. */
      enabled: false,
      botToken: "",
      chatId: "",
    },
    email: {
      /**
       * Informational-only SMTP email channel (no rollback buttons).
       * Set enabled:true and provide smtp.host + at least one `to` recipient.
       */
      enabled: false,
      smtp: {
        host: "",
        port: 465,
        user: "",
        pass: "",
        /** TLS on connect (port 465). Set false for STARTTLS (e.g. port 587). */
        secure: true,
      },
      /** Recipient(s): a string or an array of strings. */
      to: "",
    },
    system: {
      /**
       * macOS-only native notifications for HIGH/CRITICAL detections.
       * Defaults on for darwin; harmless elsewhere (the notifier no-ops).
       */
      enabled: process.platform === "darwin",
    },
    dailyReport: {
      /**
       * When true, the daemon sends `agentguard report --days=1` as a plain-text
       * Telegram message once a day at `hour` (local time). Requires Telegram
       * credentials (notifications.telegram.botToken/chatId or env vars).
       */
      enabled: false,
      /** Local hour (0–23) to send the daily report. */
      hour: 8,
    },
    slack: {
      /** Slack incoming-webhook URL. Set it to enable informational Slack alerts. */
      webhookUrl: "",
    },
    discord: {
      /** Discord webhook URL. Set it to enable informational Discord alerts. */
      webhookUrl: "",
    },
  },
  /**
   * Directories to watch when running the daemon (bin/agentguard-daemon.js).
   * Ignored by the interactive CLI.  Supports ~/ expansion.
   */
  watchPaths: [],
  /**
   * Team Plan: forward each logged event to a central server (TASK-023).
   * Both fields must be set to enable syncing; otherwise it is a no-op.
   *   serverUrl — base URL of the agentguard-server deploy, e.g.
   *               "https://agentguard.up.railway.app"
   *   token     — bearer token matching the server's AGENTGUARD_TOKEN
   */
  team: {
    serverUrl: "",
    token: "",
  },
};

// ─── loader ──────────────────────────────────────────────────────────────────

/**
 * Load config with priority: local file > global file > defaults.
 * If the config specifies a `policy` pack, it is applied between the built-in
 * defaults and any explicit project/user overrides.
 *
 * Precedence (lowest → highest):
 *   DEFAULT_CONFIG  →  policy pack  →  project/user config file
 *
 * @param {string} [cwd]  Directory to search for a local config file.
 * @returns {object}      Fully-merged config object.
 */
export function loadConfig(cwd = process.cwd()) {
  const localPath = join(cwd, "agentguard.config.json");
  const globalPath = join(homedir(), ".agentguard", "config.json");

  let raw = {};

  if (existsSync(localPath)) {
    raw = parseJsonFile(localPath, "local");
  } else if (existsSync(globalPath)) {
    raw = parseJsonFile(globalPath, "global");
  }

  // Apply policy pack (if any) between defaults and user overrides.
  const pack = raw.policy ? POLICY_PACKS[raw.policy] : null;
  if (raw.policy && !pack) {
    process.stderr.write(
      `[AgentGuard] Warning: unknown policy pack "${raw.policy}" — ignored. Valid packs: ${Object.keys(POLICY_PACKS).join(", ")}\n`
    );
  }

  const base = pack ? mergeConfig(DEFAULT_CONFIG, pack) : DEFAULT_CONFIG;
  return mergeConfig(base, raw);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function parseJsonFile(filePath, label) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    process.stderr.write(
      `[AgentGuard] Warning: failed to parse ${label} config (${filePath}): ${err.message}\n`
    );
    return {};
  }
}

/**
 * Deep-merge overrides on top of defaults.
 * Scalar arrays are replaced entirely; nested objects are shallow-merged.
 */
export function mergeConfig(defaults, overrides) {
  return {
    auditOnly: overrides.auditOnly ?? defaults.auditOnly,
    autoApprove: overrides.autoApprove ?? [...defaults.autoApprove],
    autoDeny: overrides.autoDeny ?? [...defaults.autoDeny],
    rules: {
      disabled: overrides.rules?.disabled ?? [...defaults.rules.disabled],
      custom: overrides.rules?.custom ?? [...defaults.rules.custom],
    },
    snapshot: {
      ...defaults.snapshot,
      ...(overrides.snapshot ?? {}),
    },
    auditLog: {
      ...defaults.auditLog,
      ...(overrides.auditLog ?? {}),
    },
    notifications: {
      minLevel: overrides.notifications?.minLevel ?? defaults.notifications.minLevel,
      telegram: {
        ...defaults.notifications.telegram,
        ...(overrides.notifications?.telegram ?? {}),
      },
      email: {
        ...defaults.notifications.email,
        ...(overrides.notifications?.email ?? {}),
        // Deep-merge smtp so partial overrides keep the unspecified defaults.
        smtp: {
          ...defaults.notifications.email.smtp,
          ...(overrides.notifications?.email?.smtp ?? {}),
        },
      },
      system: {
        ...defaults.notifications.system,
        ...(overrides.notifications?.system ?? {}),
      },
      dailyReport: {
        ...defaults.notifications.dailyReport,
        ...(overrides.notifications?.dailyReport ?? {}),
      },
      slack: {
        ...defaults.notifications.slack,
        ...(overrides.notifications?.slack ?? {}),
      },
      discord: {
        ...defaults.notifications.discord,
        ...(overrides.notifications?.discord ?? {}),
      },
    },
    watchPaths: overrides.watchPaths ?? [...defaults.watchPaths],
    team: {
      ...defaults.team,
      ...(overrides.team ?? {}),
    },
  };
}

// ─── watchPath mutation (agentguard add-path) ──────────────────────────────────

/** Expand a leading "~" to the home directory and resolve to an absolute path. */
export function expandPath(p) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p === "~" ? "." : p.slice(2));
  }
  return resolve(p);
}

/**
 * Add a directory to the `watchPaths` array of the config file at `configPath`.
 * Handles the full read → validate → write cycle for `agentguard add-path`.
 *
 *   • `newPath` is ~-expanded and resolved to an absolute path.
 *   • The path must exist and be a directory, else nothing is written.
 *   • Existing entries are compared on their absolute form, so a path already
 *     watched (even spelled differently, e.g. "~/x" vs "/home/me/x") is a no-op.
 *   • All other config keys are preserved.
 *
 * @param {string} configPath  Absolute path to the JSON config file.
 * @param {string} newPath     Directory to add (~ allowed).
 * @returns {{ status: "added"|"exists"|"invalid", ok: boolean, path: string, watchPaths: string[] }}
 *   `ok` is true only on "added". `path` is the resolved absolute path (or the
 *   raw input when it could not be resolved). `watchPaths` is the resulting
 *   list on success, or the current list otherwise.
 */
export function addWatchPath(configPath, newPath) {
  const abs = expandPath(newPath);
  if (!abs) return { status: "invalid", ok: false, path: newPath, watchPaths: [] };

  // Read current config first so we can report the existing list on any outcome.
  let cfg = {};
  if (existsSync(configPath)) {
    try {
      cfg = JSON.parse(readFileSync(configPath, "utf8"));
    } catch {
      cfg = {};
    }
  }
  const current = Array.isArray(cfg.watchPaths)
    ? cfg.watchPaths.filter((p) => typeof p === "string")
    : [];

  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch {}
  if (!isDir) return { status: "invalid", ok: false, path: abs, watchPaths: current };

  if (current.some((p) => expandPath(p) === abs)) {
    return { status: "exists", ok: false, path: abs, watchPaths: current };
  }

  const watchPaths = [...current, abs];
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify({ ...cfg, watchPaths }, null, 2) + "\n");
  return { status: "added", ok: true, path: abs, watchPaths };
}
