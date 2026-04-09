/**
 * AgentGuard Incident Preview
 *
 * Generates context-specific preview text shown in the approval prompt box
 * before the operator makes a decision.  Preview lines are returned as plain
 * text strings (no ANSI codes); the promptApproval() renderer applies styling.
 *
 * Responsibilities by incident source:
 *
 *   command     — No extra context here.  buildDiffPreview() in approval.js
 *                 already handles command-specific previews (rm file lists,
 *                 current file content, git diff stat, etc.).
 *
 *   correlation — Shows the rule that fired, its id, and the triggering pattern.
 *                 Helps operators understand which multi-event sequence was
 *                 detected without needing to look up rule ids manually.
 *
 *   filewatch   — Shows the file path and change event that triggered the
 *                 incident, providing context the reason string alone lacks.
 *
 * All paths are failure-safe: any exception returns [].
 *
 * Preview lines are truncated to MAX_ITEM_LEN so they fit inside the 55-char
 * approval box when rendered with the ⚑ prefix.
 */

// BOX_WIDTH (55) − box borders (2) − prefix "  ⚑ " (4) = 49 chars max.
const MAX_ITEM_LEN = 49;

/**
 * Truncate a string to MAX_ITEM_LEN, appending "…" when cut.
 *
 * @param {string} s
 * @param {number} [max]
 * @returns {string}
 */
function fit(s, max = MAX_ITEM_LEN) {
  return s.length > max ? s.slice(0, max - 1) + "\u2026" : s;
}

// ─── source-specific builders ─────────────────────────────────────────────────

/**
 * Context notes for a correlation-triggered incident.
 *
 * @param {{ ruleId?: string, reason?: string }} incident
 * @returns {string[]}
 */
function correlationPreview({ ruleId, reason }) {
  const lines = ["Source:  correlation (multi-event pattern)"];
  if (ruleId) {
    lines.push(fit(`Rule:    ${ruleId}`));
  }
  // Show reason only when it adds information beyond the ruleId.
  if (reason && reason !== ruleId) {
    lines.push(fit(`Match:   ${reason}`));
  }
  return lines;
}

/**
 * Context notes for a filewatch-triggered incident.
 *
 * The filewatcher sets incident.command to "event: filepath" (e.g.
 * "modified: .env").  When present we split it into labelled lines;
 * otherwise we fall back to incident.reason.
 *
 * @param {{ command?: string, reason?: string }} incident
 * @returns {string[]}
 */
function filewatchPreview({ command, reason }) {
  const lines = ["Source:  filewatch"];

  if (command) {
    // command format is "event: filepath"
    const colonIdx = command.indexOf(":");
    if (colonIdx !== -1) {
      const event = command.slice(0, colonIdx).trim();
      const file  = command.slice(colonIdx + 1).trim();
      lines.push(fit(`Event:   ${event}`));
      lines.push(fit(`File:    ${file}`));
    } else {
      lines.push(fit(`Detail:  ${command}`));
    }
  } else if (reason) {
    lines.push(fit(`Detail:  ${reason}`));
  }

  return lines;
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Generate a list of plain-text context lines for the given incident.
 * The lines are suitable for use as contextNotes in promptApproval().
 *
 * Returns [] for command incidents (buildDiffPreview handles those) and for
 * any source that has no meaningful structured context to surface.
 *
 * @param {import('./enforcement.js').Incident} incident
 * @returns {string[]}
 */
export function buildIncidentPreview(incident) {
  try {
    if (!incident) return [];
    switch (incident.source) {
      case "command":
        // buildDiffPreview() in approval.js handles command previews.
        // Returning [] avoids double-filling the context section.
        return [];
      case "correlation":
        return correlationPreview(incident);
      case "filewatch":
        return filewatchPreview(incident);
      default:
        return [];
    }
  } catch {
    // Preview must never crash the approval flow.
    return [];
  }
}
