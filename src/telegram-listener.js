/**
 * AgentGuard Telegram Listener
 *
 * Long-polls Telegram's getUpdates API for callback_query updates produced
 * by the inline Keep / Rollback buttons attached to file-change alerts.
 *
 * Lifecycle:
 *   bin/agentguard → startListener({...}) → { stop }
 *   stop() aborts the in-flight request and ends the loop.
 *
 * Wire flow:
 *   user taps button → Telegram → getUpdates → handleCallbackQuery →
 *     authorize → resolve(changeId) →
 *       action "k": markResolved + editAlertResolved (all refs) + log
 *       action "r": restoreFile + (success ? markResolved + edit : leave open) + log
 *
 * Skips entirely if isNotifierConfigured(config) is false.
 */

import { isNotifierConfigured, editAlertResolved } from "./notifier.js";
import { restoreFile } from "./snapshot.js";
import { pending as defaultPending } from "./pending-changes.js";
import { log, logFileRestore } from "./logger.js";

// ─── constants ───────────────────────────────────────────────────────────────

const BACKOFF_MS = [1000, 2000, 5000];
const POLL_TIMEOUT_SEC = 25;

// ─── internal helpers ────────────────────────────────────────────────────────

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    }
  });
}

function resolveCredentialsFromConfig(config) {
  const tg = config?.notifications?.telegram ?? {};
  const token  = tg.botToken || process.env.AGENTGUARD_TELEGRAM_BOT_TOKEN || "";
  const chatId = tg.chatId   || process.env.AGENTGUARD_TELEGRAM_CHAT_ID  || "";
  const extra  = Array.isArray(tg.extraChatIds) ? tg.extraChatIds : [];
  return { token, chatId, extra };
}

async function answerCallback(token, callbackQueryId, opts = {}) {
  if (!token || !callbackQueryId) return;
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, ...opts }),
    });
  } catch (err) {
    process.stderr.write(`[AgentGuard] answerCallbackQuery error: ${err.message}\n`);
  }
}

async function editAllRefs(token, entry, outcome, by) {
  const tasks = (entry.messageRefs || []).map(({ chatId, messageId }) =>
    editAlertResolved({
      token,
      chatId,
      messageId,
      originalText: entry.messageText || "",
      outcome,
      by,
    })
  );
  await Promise.allSettled(tasks);
}

// ─── callback_query dispatch ─────────────────────────────────────────────────

/**
 * Handle one Telegram callback_query update.
 *
 * @param {Object} cb  Telegram callback_query object
 * @param {Object} ctx
 * @param {string}             ctx.token
 * @param {Set<string>}        ctx.allowedChatIds  String-typed allowed IDs
 * @param {string}             ctx.cwd
 * @param {string}             ctx.agent
 * @param {object}             ctx.pending          PendingChanges instance
 * @param {Function}           [ctx.restoreFn]      Test seam (default: restoreFile)
 * @returns {Promise<{ handled: boolean, reason?: string, action?: string, result?: object }>}
 */
export async function handleCallbackQuery(cb, ctx) {
  const { token, allowedChatIds, cwd, agent, pending, restoreFn = restoreFile } = ctx;

  // 1. Authorization
  const fromId = cb?.from?.id != null ? String(cb.from.id) : "";
  if (!allowedChatIds.has(fromId)) {
    await answerCallback(token, cb?.id, { text: "Not authorized", show_alert: true });
    return { handled: false, reason: "unauthorized" };
  }

  // 2. Parse callback_data
  const [action, changeId] = String(cb.data || "").split(":");
  if (!changeId || (action !== "k" && action !== "r")) {
    await answerCallback(token, cb.id, { text: "Unknown action" });
    return { handled: false, reason: "unknown-action" };
  }

  // 3. Resolve entry
  const entry = pending.resolve(changeId);
  if (!entry || entry.resolved) {
    await answerCallback(token, cb.id, { text: "Already handled or expired" });
    return { handled: false, reason: "missing-or-resolved" };
  }

  const by = cb.from?.username || null;

  // 4. action "k" → Keep
  if (action === "k") {
    pending.markResolved(changeId);
    await answerCallback(token, cb.id, { text: "Kept" });
    log({ event: "telegram_keep", file: entry.path, by, agent });
    await editAllRefs(token, entry, "kept", by);
    return { handled: true, action: "kept" };
  }

  // 5. action "r" → Rollback
  const result = restoreFn({
    relPath: entry.path,
    event: entry.event,
    stashRef: entry.stashRef,
    sensitiveBackupDir: entry.sensitiveBackupDir,
    cwd,
  });
  logFileRestore(result, { file: entry.path, by }, agent);

  if (result.restored) {
    pending.markResolved(changeId);
    await answerCallback(token, cb.id, { text: "Rolled back" });
    await editAllRefs(token, entry, "rolled_back", by);
    return { handled: true, action: "rolled_back", result };
  }

  await answerCallback(token, cb.id, {
    text: `Rollback failed: ${result.message}`,
    show_alert: true,
  });
  // Leave entry unresolved — user can retry from terminal or button.
  return { handled: false, reason: "restore-failed", result };
}

// ─── long-poll worker ────────────────────────────────────────────────────────

/**
 * Start the Telegram long-poll worker.  Returns a handle whose stop()
 * aborts the in-flight request and ends the loop.  stop() is idempotent.
 *
 * Returns a no-op handle when isNotifierConfigured(config) is false.
 *
 * @param {Object} opts
 * @param {object} opts.config
 * @param {string} opts.sessionId
 * @param {string} opts.cwd
 * @param {string} opts.agent
 * @param {object} [opts.pending]   Test seam — defaults to module singleton
 * @returns {{ stop: () => void }}
 */
export function startListener({
  config,
  sessionId: _sessionId,
  cwd,
  agent,
  pending = defaultPending,
}) {
  if (!isNotifierConfigured(config)) {
    return { stop() {} };
  }

  const { token, chatId, extra } = resolveCredentialsFromConfig(config);
  const allowedChatIds = new Set([chatId, ...extra].filter(Boolean).map(String));
  const baseUrl = `https://api.telegram.org/bot${token}`;

  let stopped = false;
  let controller = null;
  let offset = 0;
  let errIdx = 0;

  async function pollOnce(params) {
    controller = new AbortController();
    const res = await fetch(`${baseUrl}/getUpdates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`getUpdates HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }

  async function loop() {
    // Startup flush: ack any updates queued before this session started.
    try {
      const flush = await pollOnce({
        offset: -1,
        timeout: 0,
        allowed_updates: ["callback_query"],
      });
      const last = (flush?.result ?? [])[0];
      if (last && typeof last.update_id === "number") {
        offset = last.update_id + 1;
      }
    } catch (err) {
      if (!stopped && err.name !== "AbortError") {
        process.stderr.write(`[AgentGuard] Telegram startup flush failed: ${err.message}\n`);
      }
    }

    while (!stopped) {
      try {
        const data = await pollOnce({
          offset,
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: ["callback_query"],
        });
        errIdx = 0;

        for (const update of data?.result ?? []) {
          if (typeof update.update_id === "number" && update.update_id >= offset) {
            offset = update.update_id + 1;
          }
          if (update.callback_query) {
            try {
              await handleCallbackQuery(update.callback_query, {
                token, allowedChatIds, cwd, agent, pending,
              });
            } catch (err) {
              process.stderr.write(`[AgentGuard] dispatch error: ${err.message}\n`);
            }
          }
        }
      } catch (err) {
        if (stopped || err.name === "AbortError") break;
        const delay = BACKOFF_MS[Math.min(errIdx, BACKOFF_MS.length - 1)];
        errIdx++;
        process.stderr.write(
          `[AgentGuard] Telegram poll error: ${err.message} — backoff ${delay}ms\n`
        );
        try {
          await sleep(delay, controller?.signal);
        } catch { /* abort during backoff is expected */ }
      }
    }
  }

  loop().catch((err) => {
    process.stderr.write(`[AgentGuard] Telegram listener crashed: ${err.message}\n`);
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      try { controller?.abort(); } catch {}
    },
  };
}

// ─── session-end cleanup ─────────────────────────────────────────────────────

/**
 * Best-effort cleanup of pending Telegram alerts at session end.  Edits
 * every unresolved alert (across every messageRef) to mark it
 * "session_ended" and clear its buttons.  Capped at timeoutMs so this
 * never delays process exit.
 *
 * Safe to call when Telegram is not configured — returns immediately.
 *
 * @param {object} config
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]
 * @param {object} [opts.pending]   Test seam — defaults to module singleton
 * @returns {Promise<void>}
 */
export async function cleanupPendingAlerts(
  config,
  { timeoutMs = 5000, pending = defaultPending } = {}
) {
  if (!isNotifierConfigured(config)) return;

  const { token } = resolveCredentialsFromConfig(config);
  if (!token) return;

  const unresolved = pending.listUnresolved();
  const tasks = [];
  for (const entry of unresolved) {
    for (const { chatId, messageId } of entry.messageRefs || []) {
      tasks.push(
        editAlertResolved({
          token,
          chatId,
          messageId,
          originalText: entry.messageText || "",
          outcome: "session_ended",
        })
      );
    }
  }

  if (tasks.length === 0) return;

  const allDone = Promise.allSettled(tasks);
  const timer = new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await Promise.race([allDone, timer]);
}
