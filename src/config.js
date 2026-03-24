/**
 * AgentGuard Config Loader
 *
 * Reads agentguard.config.json from the current working directory,
 * falling back to ~/.agentguard/config.json, then to built-in defaults.
 *
 * Config schema:
 * {
 *   "autoApprove": ["WARN"],          // auto-approve these risk levels
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
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ─── defaults ────────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  /** Risk levels to approve without prompting. e.g. ["WARN"] */
  autoApprove: [],
  /** Risk levels to deny without prompting. e.g. ["CRITICAL"] */
  autoDeny: [],
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
};

// ─── loader ──────────────────────────────────────────────────────────────────

/**
 * Load config with priority: local file > global file > defaults.
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

  return mergeConfig(DEFAULT_CONFIG, raw);
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
  };
}
