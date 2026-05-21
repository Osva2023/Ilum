/**
 * AgentGuard Sensitive File Patterns
 *
 * Shared between the filewatcher (audit-time detection) and the snapshot
 * module (pre-session backup of gitignored secrets that `git stash -u`
 * cannot capture).
 */

import path from "path";

export const SENSITIVE_PATTERNS = [
  /^\.env(\..*)?$/,                         // .env, .env.local, .env.production
  /\.(pem|key|p12|pfx|crt|cer)$/i,          // crypto keys / certs
  /^id_(rsa|ecdsa|ed25519)(\.pub)?$/,       // SSH keys
  /^package(-lock)?\.json$/,                // deps manifest
  /^(Dockerfile|docker-compose\.ya?ml)$/i,  // container config
  /\.(config\.(js|ts|cjs|mjs))$/,           // build/tool configs
  /\.(db|sqlite|sqlite3)$/,                 // databases
  /^\.github\/workflows\/.+\.ya?ml$/,       // CI/CD
  /^(\.gitconfig|\.npmrc|\.yarnrc)$/,       // tool credentials

  // Agent memory files — persistent instructions that survive between
  // sessions and could be poisoned.
  /^CLAUDE\.md$/,                           // Claude Code project memory
  /^\.cursorrules$/,                        // Cursor rules
  /^\.claude\/settings\.json$/,             // Claude config
  /^\.claude\/memory/,                      // Claude memory files (memory.md, memory/...)
  /^\.hermes\//,                            // Hermes agent memory dir
  /^\.aider\.conf\.ya?ml$/,                 // aider config
  /^\.aider\.tags\.cache/,                  // aider tags cache (.aider.tags.cache, .v1, etc)
  /^agent-memory\.json$/,                   // generic agent memory
  /^memories\.json$/,                       // generic agent memory
];

export const SAFE_EXTENSIONS = [
  ".md", ".txt", ".log", ".json.lock",
];

export function isSensitive(filePath) {
  const basename = path.basename(filePath);
  const rel = filePath;
  // SENSITIVE_PATTERNS is checked first so that explicit entries (e.g.
  // CLAUDE.md) win over the broad SAFE_EXTENSIONS allowlist, which
  // includes .md for generic docs.
  if (SENSITIVE_PATTERNS.some(re => re.test(basename) || re.test(rel))) return true;
  if (SAFE_EXTENSIONS.some(ext => basename.endsWith(ext))) return false;
  return false;
}
