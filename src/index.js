/**
 * AgentGuard — main public API
 *
 * Re-exports the primary modules so downstream code (tests, integrations)
 * can import everything from a single entry point.
 */

export { classify, requiresApproval } from "./classifier.js";
export { rules, RISK_LEVELS } from "./rules.js";
export { promptApproval, buildDiffPreview } from "./approval.js";
export { buildIncidentPreview } from "./preview.js";
export { createSnapshot, restoreSnapshot } from "./snapshot.js";
export { runInterceptor } from "./interceptor.js";
export { runPtyInterceptor, PTY_AVAILABLE } from "./pty-interceptor.js";
export { loadConfig, mergeConfig, DEFAULT_CONFIG, POLICY_PACKS } from "./config.js";
export { printSessionSummary } from "./summary.js";
export { showPostActionReview } from "./reviewer.js";
export {
  log,
  setSink,
  logSessionStart,
  logSessionEnd,
  logSnapshot,
  logIntercepted,
  logApproved,
  logDenied,
  logDetected,
  logIncidentApproved,
  logIncidentDenied,
  sessionId,
  LOG_FILE,
  AGENTGUARD_DIR,
} from "./logger.js";
