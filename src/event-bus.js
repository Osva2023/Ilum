/**
 * AgentGuard Event Bus
 *
 * Lightweight in-memory buffer that sits between the decoder and the
 * correlator.  Decoded events are pushed in and retrieved via filter queries.
 *
 * Time-windowed: events older than `windowMs` are evicted lazily on every
 * push() — no background timers are used.
 *
 * This module is intentionally pure: no side effects, no logging, no imports
 * from other AgentGuard modules.
 */

// ─── EventBus class ───────────────────────────────────────────────────────────

export class EventBus {
  /**
   * @param {number} [windowMs=60000]  How long to retain events (milliseconds).
   *                                   Events older than this are evicted on push.
   */
  constructor(windowMs = 60_000) {
    /** @private */
    this._windowMs = windowMs;
    /** @private @type {Array<Object>} */
    this._buffer = [];
  }

  // ─── write ──────────────────────────────────────────────────────────────────

  /**
   * Add a decoded event to the buffer, then evict events that have aged out
   * of the time window.
   *
   * Eviction is based on the event's own `time` field (ISO string), not the
   * wall-clock moment of the push() call.  This lets tests inject events with
   * synthetic timestamps without needing to mock the system clock.
   *
   * @param {Object} event  A canonical event object produced by decoder.js.
   *                        Must have a `time` field (ISO timestamp string).
   * @returns {void}
   */
  push(event) {
    this._buffer.push(event);
    const cutoff = Date.now() - this._windowMs;
    this._buffer = this._buffer.filter((e) => Date.parse(e.time) > cutoff);
  }

  // ─── read ───────────────────────────────────────────────────────────────────

  /**
   * Return all buffered events that match the given filters.
   * Every filter field is optional; omitting it means "match any value".
   *
   * @param {Object}  [filters={}]
   * @param {string}  [filters.type]     Exact match on event.type
   * @param {string}  [filters.subtype]  Exact match on event.subtype
   * @param {string}  [filters.since]    ISO timestamp; only events at or after
   *                                     this time are included.
   * @returns {Array<Object>}  Shallow copy — mutations do not affect the buffer.
   */
  query({ type, subtype, since } = {}) {
    const sinceMs = since ? Date.parse(since) : -Infinity;

    return this._buffer.filter((e) => {
      if (type    !== undefined && e.type    !== type)    return false;
      if (subtype !== undefined && e.subtype !== subtype) return false;
      if (Date.parse(e.time) < sinceMs)                  return false;
      return true;
    });
  }

  /**
   * Return the last `n` events from the buffer, in insertion order.
   * If the buffer has fewer than `n` events, all events are returned.
   *
   * @param {number} n  Maximum number of events to return.
   * @returns {Array<Object>}  Shallow copy — mutations do not affect the buffer.
   */
  recent(n) {
    if (n <= 0) return [];
    return this._buffer.slice(-n);
  }

  // ─── management ─────────────────────────────────────────────────────────────

  /**
   * Remove all events from the buffer.
   *
   * @returns {void}
   */
  clear() {
    this._buffer = [];
  }

  /**
   * Number of events currently in the buffer.
   *
   * @type {number}
   */
  get size() {
    return this._buffer.length;
  }
}

// ─── Default singleton ────────────────────────────────────────────────────────

/**
 * Shared default bus instance.
 * Import this for application code; create a `new EventBus()` in tests so
 * each test suite starts with a clean slate.
 *
 * @type {EventBus}
 */
export const bus = new EventBus();
