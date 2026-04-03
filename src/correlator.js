/**
 * AgentGuard Correlator
 *
 * Evaluates correlation rules against an EventBus snapshot.  This is the
 * second stage of the rule-engine pipeline, sitting after the decoder and
 * event bus and before any alerting or approval layer.
 *
 * This module is intentionally pure: no side effects, no logging, no I/O.
 */

import { CORRELATION_RULES } from "./correlation-rules.js";

export { CORRELATION_RULES };

/**
 * Run every correlation rule against the provided bus.
 *
 * Rules whose `match(bus)` returns true are collected and returned.  The
 * returned array contains references to the original rule objects (not copies)
 * so callers can access `id`, `level`, `description`, etc. directly.
 *
 * @param {import("./event-bus.js").EventBus} bus
 * @returns {import("./correlation-rules.js").CorrelationRule[]}
 *   Fired rules in declaration order.  Empty array if nothing fires.
 */
export function evaluate(bus) {
  return CORRELATION_RULES.filter((rule) => rule.match(bus));
}

/**
 * Run a single correlation rule identified by `ruleId`.
 *
 * @param {import("./event-bus.js").EventBus} bus
 * @param {string} ruleId  The `id` field of the rule to evaluate.
 * @returns {import("./correlation-rules.js").CorrelationRule|null}
 *   The rule object if it fires, or `null` if the rule does not fire *or*
 *   if `ruleId` does not match any known rule.
 */
export function evaluateOne(bus, ruleId) {
  const rule = CORRELATION_RULES.find((r) => r.id === ruleId);
  if (!rule) return null;
  return rule.match(bus) ? rule : null;
}
