/**
 * AgentGuard Memory Scanner  (TASK-021)
 *
 * Scans the *content* of agent memory files (CLAUDE.md, .cursorrules, files
 * under .hermes/ and .claude/, .aider.*) for signs of poisoning / prompt
 * injection. Agent memory persists between sessions, so a poisoned memory file
 * can silently steer an agent on every future run — worth flagging hard.
 *
 * Pure and side-effect-free (no I/O) so it is trivially unit-testable; the
 * caller (filewatcher.js) reads the file and decides what to do with the
 * result.
 */

import path from "path";

// Memory files whose content is worth scanning. Mirrors the agent-memory
// entries in sensitive.js, kept separate so the scanner stands alone.
const MEMORY_FILE_PATTERNS = [
  /^CLAUDE\.md$/,
  /^\.cursorrules$/,
  /(^|\/)\.hermes\//,
  /(^|\/)\.claude\//,
  /(^|\/)\.aider\./,
  /^(agent-memory|memories)\.json$/,
];

/** True when `relPath` is an agent memory file worth content-scanning. */
export function isMemoryFile(relPath) {
  if (typeof relPath !== "string" || !relPath) return false;
  const basename = path.basename(relPath);
  return MEMORY_FILE_PATTERNS.some((re) => re.test(basename) || re.test(relPath));
}

// 1. Prompt-injection phrases (matched case-insensitively).
const INJECTION_PHRASES = [
  "ignore previous instructions",
  "from now on",
  "disregard",
  "override your",
  "you are now",
  "act as if",
];

// 3. Imperative instructions shouted in uppercase.
const UPPERCASE_IMPERATIVES = ["ALWAYS", "NEVER", "YOU MUST", "DO NOT"];

// 4. Hosts that are not "external".
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/**
 * Scan agent-memory file content for suspicious patterns.
 *
 * Severity:
 *   CRITICAL — prompt injection or a suspicious base64 blob.
 *   HIGH     — uppercase imperatives or external URLs (when nothing CRITICAL).
 *   null     — nothing matched.
 *
 * @param {string} filePath  Path of the file (for context only).
 * @param {string} content   File contents.
 * @returns {{ suspicious: boolean, patterns: string[], severity: "CRITICAL"|"HIGH"|null }}
 */
export function scanMemoryFile(filePath, content) {
  const patterns = [];
  let hasCritical = false;
  let hasHigh = false;

  const text = typeof content === "string" ? content : "";
  const lower = text.toLowerCase();

  // 1. Prompt injection
  for (const phrase of INJECTION_PHRASES) {
    if (lower.includes(phrase)) {
      patterns.push(`prompt-injection: "${phrase}"`);
      hasCritical = true;
    }
  }

  // 2. Suspicious base64 — long base64 runs that are NOT part of a URL or a
  // data: URI (those are stripped first so legit embedded assets don't trip it).
  const stripped = text
    .replace(/data:[^\s)"']+/gi, " ")
    .replace(/https?:\/\/[^\s)"']+/gi, " ");
  if (/[A-Za-z0-9+/]{50,}={0,2}/.test(stripped)) {
    patterns.push("suspicious-base64 (>50 chars)");
    hasCritical = true;
  }

  // 3. Uppercase imperatives (whole-token match so ALWAYSON etc. don't trip).
  for (const word of UPPERCASE_IMPERATIVES) {
    if (new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`).test(text)) {
      patterns.push(`uppercase-imperative: ${word}`);
      hasHigh = true;
    }
  }

  // 4. External URLs (http/https not pointing at a local host).
  const urlRe = /https?:\/\/([^\s/:?#)"']+)/gi;
  const seenHosts = new Set();
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    const host = m[1].toLowerCase();
    if (LOCAL_HOSTS.has(host) || seenHosts.has(host)) continue;
    seenHosts.add(host);
    patterns.push(`external-url: ${host}`);
    hasHigh = true;
  }

  const severity = hasCritical ? "CRITICAL" : hasHigh ? "HIGH" : null;
  return { suspicious: severity !== null, patterns, severity };
}
