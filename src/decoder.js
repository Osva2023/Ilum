/**
 * AgentGuard Decoder
 *
 * First stage of the rule-engine pipeline.  Normalises raw events from two
 * sources — PTY output lines and filesystem change notifications — into
 * canonical event objects that downstream stages can reason about uniformly.
 *
 * This module is intentionally pure: no side effects, no logging, no I/O.
 */

// ─── Canonical event types ────────────────────────────────────────────────────

/**
 * Frozen map of every event type the decoder can produce.
 * Import this instead of using raw strings so typos surface at runtime.
 *
 * @type {Readonly<{PROCESS_EXEC: string, FILE_WRITE: string, FILE_DELETE: string}>}
 */
export const EVENT_TYPES = Object.freeze({
  PROCESS_EXEC: "process_exec",
  FILE_WRITE: "file_write",
  FILE_DELETE: "file_delete",
});

// ─── Command subtype patterns ─────────────────────────────────────────────────

/** @type {Array<{subtype: string, pattern: RegExp}>} Tested in order; first match wins. */
const COMMAND_SUBTYPE_RULES = [
  { subtype: "git_operation",  pattern: /\bgit\b/ },
  { subtype: "file_delete",    pattern: /\b(rm|unlink|rmdir)\b/ },
  { subtype: "network_request",pattern: /\b(curl|wget|fetch|ssh|nc|netcat)\b/ },
  { subtype: "package_install",pattern: /\b(npm|pip3?|brew|apt(?:-get)?|yarn|pnpm)\b/ },
  { subtype: "shell_exec",     pattern: /\|\s*(ba)?sh\b|\|\s*zsh\b|\beval\b|\bsource\b/ },
  // file_write: redirect into a file, tee, or cp (cp can silently overwrite)
  { subtype: "file_write",     pattern: /(?:^|[^<])\s*>{1,2}\s*\S|\btee\b|\bcp\b/ },
];

/**
 * Derive the command subtype from an extracted command string.
 *
 * @param {string} command
 * @returns {"git_operation"|"file_delete"|"file_write"|"network_request"|"package_install"|"shell_exec"|"generic"}
 */
function commandSubtype(command) {
  for (const { subtype, pattern } of COMMAND_SUBTYPE_RULES) {
    if (pattern.test(command)) return subtype;
  }
  return "generic";
}

// ─── File subtype patterns ────────────────────────────────────────────────────
//
// Derived from the SENSITIVE_PATTERNS / riskLevel logic in filewatcher.js.
// Keep these in sync when filewatcher.js changes.
//
// Order matters: more-specific subtypes are listed first so a file like
// ".github/workflows/ci.yml" is classified as "cicd" rather than "config".

const SOURCE_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|cs|php|swift|kt|sh|bash|zsh)$/i;

/** @type {Array<{subtype: string, test: (basename: string, rel: string) => boolean}>} */
const FILE_SUBTYPE_RULES = [
  {
    subtype: "cicd",
    test: (_b, rel) => /^\.github\/workflows\/.+\.ya?ml$/.test(rel),
  },
  {
    subtype: "secret",
    test: (b) =>
      /^\.env(\..*)?$/.test(b) ||
      /\.(pem|key|p12|pfx|crt|cer)$/i.test(b) ||
      /^id_(rsa|ecdsa|ed25519)(\.pub)?$/.test(b) ||
      /^(\.gitconfig|\.npmrc|\.yarnrc)$/.test(b),
  },
  {
    subtype: "dependency",
    test: (b) => /^package(-lock)?\.json$/.test(b),
  },
  {
    subtype: "config",
    test: (b) =>
      /^(Dockerfile|docker-compose\.ya?ml)$/i.test(b) ||
      /\.(config\.(js|ts|cjs|mjs))$/.test(b) ||
      /\.(db|sqlite|sqlite3)$/.test(b),
  },
  {
    subtype: "source",
    test: (b) => SOURCE_EXTENSIONS.test(b),
  },
];

/**
 * Derive the file subtype from a file path.
 *
 * @param {string} filePath  Relative or absolute path
 * @returns {"secret"|"config"|"dependency"|"cicd"|"source"|"generic"}
 */
function fileSubtype(filePath) {
  const { basename } = splitPath(filePath);
  for (const { subtype, test } of FILE_SUBTYPE_RULES) {
    if (test(basename, filePath)) return subtype;
  }
  return "generic";
}

/** Minimal path helper — avoids importing the `path` module. */
function splitPath(p) {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return { basename: idx === -1 ? p : p.slice(idx + 1) };
}

// ─── Command line extraction ──────────────────────────────────────────────────
//
// Mirror of extractCommand() in interceptor.js.  Kept in sync manually.

/**
 * Extract a shell command string from a raw terminal output line.
 *
 * Recognises shell prompt prefixes (`$ cmd`, `% cmd`, `> cmd`, `# cmd`) and
 * agent-style "Running: cmd" / "Executing: cmd" annotations.
 *
 * @param {string} line  Raw terminal line
 * @returns {string|null}  Extracted command, or null if the line is not command-like
 */
function extractCommand(line) {
  const promptMatch = line.match(/^[>$%#]\s+(.+)$/);
  if (promptMatch) return promptMatch[1].trim();

  const runMatch = line.match(/^(?:running|executing|exec|run):\s+(.+)$/i);
  if (runMatch) return runMatch[1].trim();

  return null;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Decode a raw PTY/terminal output line into a canonical process-exec event.
 *
 * Returns `null` when the line does not look like a shell command being run
 * (e.g. plain log output, blank lines, progress bars, etc.).
 *
 * @param {string} line  Raw terminal output line
 * @returns {{
 *   type: "process_exec",
 *   raw: string,
 *   command: string,
 *   subtype: "git_operation"|"file_delete"|"file_write"|"network_request"|"package_install"|"shell_exec"|"generic",
 *   time: string
 * }|null}
 */
export function decodeCommand(line) {
  const command = extractCommand(line);
  if (!command) return null;

  return {
    type: EVENT_TYPES.PROCESS_EXEC,
    raw: line,
    command,
    subtype: commandSubtype(command),
    time: new Date().toISOString(),
  };
}

/**
 * Decode a chokidar filesystem event into a canonical file event.
 *
 * @param {"add"|"change"|"unlink"} event  Chokidar event name
 * @param {string} filePath               Relative or absolute file path
 * @returns {{
 *   type: "file_write"|"file_delete",
 *   raw: string,
 *   file: string,
 *   subtype: "secret"|"config"|"dependency"|"cicd"|"source"|"generic",
 *   time: string
 * }}
 */
export function decodeFileEvent(event, filePath) {
  const type =
    event === "unlink" ? EVENT_TYPES.FILE_DELETE : EVENT_TYPES.FILE_WRITE;

  return {
    type,
    raw: filePath,
    file: filePath,
    subtype: fileSubtype(filePath),
    time: new Date().toISOString(),
  };
}
