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

import { readFileSync, existsSync } from "fs";
import { join } from "path";
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
    system: {
      /**
       * macOS-only native notifications for HIGH/CRITICAL detections.
       * Defaults on for darwin; harmless elsewhere (the notifier no-ops).
       */
      enabled: process.platform === "darwin",
    },
  },
  /**
   * Directories to watch when running the daemon (bin/agentguard-daemon.js).
   * Ignored by the interactive CLI.  Supports ~/ expansion.
   */
  watchPaths: [],
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
      system: {
        ...defaults.notifications.system,
        ...(overrides.notifications?.system ?? {}),
      },
    },
    watchPaths: overrides.watchPaths ?? [...defaults.watchPaths],
  };
}
