/**
 * AgentGuard Pending Changes
 *
 * In-memory registry of sensitive file changes that have been alerted on
 * via Telegram and are waiting for the user to press "Keep" or "Rollback".
 *
 * Lifecycle:
 *   filewatcher.js          → register(entry)                → changeId
 *                           → updateMessageRefs(id, refs)    (after sendFileChangeAlert resolves)
 *   telegram-listener.js    → resolve(changeId)              → entry|null
 *                           → markResolved(changeId)         (after action completes)
 *   bin/agentguard (exit)   → listUnresolved()               → entries still open for cleanup
 *
 * Pure: no side effects, no logging, no imports from other AgentGuard modules.
 * Mirrors event-bus.js in shape.
 */

import { randomUUID } from "crypto";

// ─── PendingChanges class ─────────────────────────────────────────────────────

export class PendingChanges {
  constructor() {
    /** @private @type {Map<string, Object>} */
    this._entries = new Map();
  }

  /**
   * Register a new pending change. Generates an opaque 8-char changeId
   * suitable for embedding in Telegram callback_data (≤64 bytes total).
   *
   * @param {Object} entry
   * @param {string} entry.sessionId
   * @param {string} entry.path                       Path relative to cwd
   * @param {string} entry.event                      "created" | "modified" | "deleted"
   * @param {string} entry.level                      Risk level (HIGH / CRITICAL / WARN)
   * @param {string|null} [entry.stashRef]            Stash message ref (may be null)
   * @param {string|null} [entry.sensitiveBackupDir]  Per-session backup dir (may be null)
   * @param {Array<{chatId:string,messageId:number}>} [entry.messageRefs=[]]
   * @returns {string}  Newly assigned changeId.
   */
  register(entry) {
    const changeId = randomUUID().replace(/-/g, "").slice(0, 8);
    this._entries.set(changeId, {
      ...entry,
      messageRefs: entry.messageRefs ?? [],
      createdAt: Date.now(),
      resolved: false,
    });
    return changeId;
  }

  /**
   * Look up an entry by changeId. Does not mutate.
   *
   * @param {string} changeId
   * @returns {Object|null}
   */
  resolve(changeId) {
    return this._entries.get(changeId) ?? null;
  }

  /**
   * Mark an entry as resolved. Returns true on first successful call,
   * false if missing or already resolved. Idempotent dispatch — handles
   * the case where two callback_query updates arrive for the same id.
   *
   * @param {string} changeId
   * @returns {boolean}
   */
  markResolved(changeId) {
    const entry = this._entries.get(changeId);
    if (!entry || entry.resolved) return false;
    entry.resolved = true;
    return true;
  }

  /**
   * Attach Telegram message refs to an existing entry — called after
   * sendFileChangeAlert resolves with the (chatId, messageId) pairs.
   *
   * @param {string} changeId
   * @param {Array<{chatId:string,messageId:number}>} messageRefs
   * @returns {boolean}  False if the entry no longer exists.
   */
  updateMessageRefs(changeId, messageRefs) {
    const entry = this._entries.get(changeId);
    if (!entry) return false;
    entry.messageRefs = messageRefs;
    return true;
  }

  /**
   * Attach the rendered Telegram message text to an entry.  The listener
   * needs this verbatim to pass as `originalText` when editing the alert
   * after a button press.
   *
   * @param {string} changeId
   * @param {string} text
   * @returns {boolean}  False if the entry no longer exists.
   */
  updateMessageText(changeId, text) {
    const entry = this._entries.get(changeId);
    if (!entry) return false;
    entry.messageText = text;
    return true;
  }

  /**
   * Snapshot copy of all entries still unresolved, each tagged with its
   * changeId. Used by bin/agentguard on session-end to clear stale buttons.
   *
   * @returns {Array<Object>}
   */
  listUnresolved() {
    const out = [];
    for (const [changeId, entry] of this._entries) {
      if (!entry.resolved) out.push({ changeId, ...entry });
    }
    return out;
  }

  /**
   * Remove all entries. Intended for tests and explicit session reset.
   *
   * @returns {void}
   */
  clear() {
    this._entries.clear();
  }

  /** Number of registered entries (resolved + unresolved). */
  get size() {
    return this._entries.size;
  }
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Shared default registry. Import this for application code; create a
 * `new PendingChanges()` in tests so each suite starts with a clean slate.
 *
 * @type {PendingChanges}
 */
export const pending = new PendingChanges();
