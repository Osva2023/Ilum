/**
 * AgentGuard Suppression
 *
 * Reduces approval fatigue by preventing the same correlation rule from
 * producing repeated alerts within a configurable cooldown window.
 *
 * Typical pipeline position:
 *   decode → event-bus → correlator → suppression → alert / approval
 *
 * This module is intentionally pure: no side effects, no logging, no imports
 * from other AgentGuard modules.
 */

// ─── SuppressionManager ───────────────────────────────────────────────────────

export class SuppressionManager {
  /**
   * @param {number} [defaultCooldownMs=30000]
   *   How long a rule stays suppressed after firing, when no per-rule
   *   cooldown is specified in `record()`.
   */
  constructor(defaultCooldownMs = 30_000) {
    /** @private */
    this._defaultCooldownMs = defaultCooldownMs;
    /**
     * Maps ruleId → the wall-clock timestamp (ms) at which suppression expires.
     * @private @type {Map<string, number>}
     */
    this._expiresAt = new Map();
  }

  // ─── query ─────────────────────────────────────────────────────────────────

  /**
   * Returns true if `ruleId` is currently within its cooldown window.
   *
   * @param {string} ruleId
   * @returns {boolean}
   */
  isSuppressed(ruleId) {
    const exp = this._expiresAt.get(ruleId);
    if (exp === undefined) return false;
    if (Date.now() < exp) return true;
    // Lazily clean up expired entries.
    this._expiresAt.delete(ruleId);
    return false;
  }

  // ─── mutation ──────────────────────────────────────────────────────────────

  /**
   * Mark `ruleId` as having just fired, starting its cooldown window.
   * Calling this while a rule is already suppressed resets (extends) the timer.
   *
   * @param {string} ruleId
   * @param {number} [cooldownMs]  Per-rule override; falls back to the
   *                               constructor's `defaultCooldownMs`.
   * @returns {void}
   */
  record(ruleId, cooldownMs) {
    const ms = cooldownMs ?? this._defaultCooldownMs;
    this._expiresAt.set(ruleId, Date.now() + ms);
  }

  /**
   * Manually clear the suppression state for a single rule.
   * Has no effect if the rule is not currently suppressed.
   *
   * @param {string} ruleId
   * @returns {void}
   */
  reset(ruleId) {
    this._expiresAt.delete(ruleId);
  }

  /**
   * Clear all suppression state.
   *
   * @returns {void}
   */
  resetAll() {
    this._expiresAt.clear();
  }

  // ─── inspection ────────────────────────────────────────────────────────────

  /**
   * The ids of every rule that is currently within its cooldown window.
   * Expired entries are pruned before the list is built.
   *
   * @type {string[]}
   */
  get suppressedIds() {
    const now = Date.now();
    const active = [];
    for (const [id, exp] of this._expiresAt) {
      if (now < exp) {
        active.push(id);
      } else {
        this._expiresAt.delete(id);
      }
    }
    return active;
  }
}

// ─── filterFired ─────────────────────────────────────────────────────────────

/**
 * Filter the output of `evaluate(bus)` through a SuppressionManager.
 *
 * Rules that are currently suppressed are dropped.  Rules that pass through
 * are immediately recorded in the suppression manager (using each rule's own
 * `windowMs` as the cooldown so a rule stays quiet for at least as long as
 * its detection window).
 *
 * @param {Array<{id: string, windowMs: number, [key: string]: any}>} firedRules
 *   Array of rule objects returned by `evaluate(bus)`.
 * @param {SuppressionManager} suppression
 * @returns {Array<{id: string, windowMs: number, [key: string]: any}>}
 *   Subset of `firedRules` whose rules were not suppressed, in the same order.
 */
export function filterFired(firedRules, suppression) {
  return firedRules.filter((rule) => {
    if (suppression.isSuppressed(rule.id)) return false;
    suppression.record(rule.id, rule.windowMs);
    return true;
  });
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Shared default suppression instance.
 * Import this for application code; construct a `new SuppressionManager()`
 * in tests so each suite starts with a clean slate.
 *
 * @type {SuppressionManager}
 */
export const suppression = new SuppressionManager();
