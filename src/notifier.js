/**
 * AgentGuard Telegram Notifier  (Phase 2)
 *
 * Sends a Telegram message when AgentGuard intercepts a risky command and
 * the operator may not be watching the terminal (e.g. CI, headless runs, or
 * when notifications.telegram.enabled is set in the config).
 *
 * Configuration (in priority order):
 *   1. agentguard.config.json  →  notifications.telegram.botToken / chatId
 *   2. Environment variables   →  AGENTGUARD_TELEGRAM_BOT_TOKEN / AGENTGUARD_TELEGRAM_CHAT_ID
 *
 * Uses native fetch (Node 18+) — no extra dependencies.
 */

import { spawn } from "child_process";

// ─── config resolution ────────────────────────────────────────────────────────

function getTelegramConfig(config) {
  return config?.notifications?.telegram ?? {};
}

function resolveCredentials(config) {
  const tg = getTelegramConfig(config);
  const token =
    tg.botToken || process.env.AGENTGUARD_TELEGRAM_BOT_TOKEN || "";
  const chatId =
    tg.chatId || process.env.AGENTGUARD_TELEGRAM_CHAT_ID || "";
  // extraChatIds: additional recipients (array of strings)
  const extraChatIds = Array.isArray(tg.extraChatIds) ? tg.extraChatIds : [];
  return { token, chatId, extraChatIds };
}

// ─── public API ───────────────────────────────────────────────────────────────

/**
 * Returns true when both a bot token and chat ID are available, regardless of
 * whether the `enabled` flag is set.  Use this to guard calls to
 * sendTelegramAlert.
 *
 * @param {object} [config]  Merged AgentGuard config (optional — falls back to
 *                           env vars alone when omitted).
 * @returns {boolean}
 */
export function isNotifierConfigured(config) {
  const tg = getTelegramConfig(config);
  // Must be explicitly enabled (or env vars alone are enough when no config)
  const enabled =
    tg.enabled !== undefined
      ? tg.enabled
      : !!(
          process.env.AGENTGUARD_TELEGRAM_BOT_TOKEN &&
          process.env.AGENTGUARD_TELEGRAM_CHAT_ID
        );

  if (!enabled) return false;

  const { token, chatId } = resolveCredentials(config);
  return !!(token && chatId);
}

/**
 * Send a Telegram alert for an intercepted risky command.
 *
 * @param {Object} params
 * @param {string} params.command    - The intercepted command string
 * @param {string} params.level      - Risk level (CRITICAL / HIGH / WARN)
 * @param {string} params.reason     - Human-readable rule reason
 * @param {string} params.sessionId  - AgentGuard session ID
 * @param {string} params.agent      - Agent name (e.g. "codex")
 * @param {object} [config]          - Merged AgentGuard config
 */
export async function sendTelegramAlert(
  { command, level, reason, sessionId, agent },
  config
) {
  const { token, chatId, extraChatIds } = resolveCredentials(config);

  if (!token || !chatId) {
    process.stderr.write(
      "[AgentGuard] Telegram notifier: botToken or chatId not configured — skipping.\n"
    );
    return;
  }

  const shortSession = sessionId ? sessionId.slice(0, 8) : "unknown";

  const text = [
    "🚨 AgentGuard Alert",
    "",
    `Agent: ${agent}`,
    `Session: ${shortSession}`,
    `Risk: ${level}`,
    `Command: ${command}`,
    `Reason: ${reason}`,
    "",
    `Reply /approve_${shortSession} or /deny_${shortSession}`,
  ].join("\n");
  const allChatIds = [chatId, ...extraChatIds].filter(Boolean);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  for (const id of allChatIds) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id, text }),
      });

      if (!res.ok) {
        const body = await res.text();
        process.stderr.write(
          `[AgentGuard] Telegram notification failed for ${id} (HTTP ${res.status}): ${body}\n`
        );
      }
    } catch (err) {
      process.stderr.write(
        `[AgentGuard] Telegram notification error for ${id}: ${err.message}\n`
      );
    }
  }
}

// ─── File-change alert with inline buttons (Telegram-driven approval) ────────

/**
 * Send a Telegram alert for a sensitive file change with inline
 * "✅ Keep" / "↩️ Rollback" buttons.  Returns one {chatId, messageId} per
 * successful send so the caller can later edit the message (e.g. to clear
 * the buttons after action).
 *
 * Fan-out: sends to chatId + every entry in extraChatIds.  An individual
 * send failure is logged to stderr and skipped; successful sends are still
 * returned.
 *
 * Silently returns { text: "", refs: [] } when the notifier is not configured.
 *
 * @param {Object} params
 * @param {string} params.file        Path relative to cwd
 * @param {string} params.level       Risk level (HIGH / CRITICAL / WARN)
 * @param {string} params.event       "created" | "modified" | "deleted"
 * @param {string} params.sessionId
 * @param {string} params.changeId    Opaque id from pending-changes
 * @param {string} params.agent
 * @param {object} [config]
 * @returns {Promise<{ text: string, refs: Array<{chatId:string, messageId:number}> }>}
 */
export async function sendFileChangeAlert(
  { file, level, event, sessionId, changeId, agent },
  config
) {
  if (!isNotifierConfigured(config)) return { text: "", refs: [] };

  const { token, chatId, extraChatIds } = resolveCredentials(config);
  const shortSession = sessionId ? sessionId.slice(0, 8) : "unknown";

  const text = [
    "📁 AgentGuard File Alert",
    "",
    `Agent: ${agent}`,
    `Session: ${shortSession}`,
    `Risk: ${level}`,
    `File: ${file}`,
    `Event: ${event}`,
    "",
    "Tap a button below to keep or rollback this change.",
  ].join("\n");

  const reply_markup = {
    inline_keyboard: [
      [
        { text: "✅ Keep",     callback_data: `k:${changeId}` },
        { text: "↩️ Rollback", callback_data: `r:${changeId}` },
      ],
    ],
  };

  const allChatIds = [chatId, ...extraChatIds].filter(Boolean);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const refs = [];

  for (const id of allChatIds) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: id, text, reply_markup }),
      });

      if (!res.ok) {
        const body = await res.text();
        process.stderr.write(
          `[AgentGuard] Telegram file-alert failed for ${id} (HTTP ${res.status}): ${body}\n`
        );
        continue;
      }

      const data = await res.json();
      const messageId = data?.result?.message_id;
      if (typeof messageId === "number") {
        refs.push({ chatId: String(id), messageId });
      }
    } catch (err) {
      process.stderr.write(
        `[AgentGuard] Telegram file-alert error for ${id}: ${err.message}\n`
      );
    }
  }

  return { text, refs };
}

/**
 * Edit a previously-sent file-change alert to mark it resolved: replaces
 * the message body with the original text plus a resolution line, and
 * clears the inline keyboard so the buttons cannot be tapped again.
 *
 * Requires `originalText` because Telegram's editMessageText replaces the
 * body wholesale — we re-send the original plus an appended resolution.
 *
 * @param {Object} params
 * @param {string} params.token            Bot token (resolved by caller)
 * @param {string|number} params.chatId
 * @param {number} params.messageId
 * @param {string} params.originalText     Text the alert was sent with
 * @param {"kept"|"rolled_back"|"session_ended"} params.outcome
 * @param {string|null} [params.by]        Telegram username (no @) — null/undefined for session_ended
 * @returns {Promise<boolean>}             true if the edit succeeded
 */
export async function editAlertResolved({
  token,
  chatId,
  messageId,
  originalText,
  outcome,
  by,
}) {
  if (!token || !chatId || messageId == null) return false;

  const resolutionLine = resolutionLineFor(outcome, by);
  if (!resolutionLine) return false;

  const url = `https://api.telegram.org/bot${token}/editMessageText`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: `${originalText}\n\n${resolutionLine}`,
        reply_markup: { inline_keyboard: [] },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      process.stderr.write(
        `[AgentGuard] Telegram editMessageText failed for ${chatId} (HTTP ${res.status}): ${body}\n`
      );
      return false;
    }
    return true;
  } catch (err) {
    process.stderr.write(
      `[AgentGuard] Telegram editMessageText error for ${chatId}: ${err.message}\n`
    );
    return false;
  }
}

function resolutionLineFor(outcome, by) {
  switch (outcome) {
    case "kept":
      return by ? `✅ Kept by @${by}` : "✅ Kept";
    case "rolled_back":
      return by ? `↩️ Rolled back by @${by}` : "↩️ Rolled back";
    case "session_ended":
      return "⌛ Session ended — no action taken";
    default:
      return null;
  }
}

// ─── severity threshold ───────────────────────────────────────────────────────

const LEVEL_ORDER = { WARN: 0, HIGH: 1, CRITICAL: 2 };

/**
 * Return true when `level` is at least as severe as `minLevel`.
 * Used to gate noisy notification channels (Telegram, macOS popup).
 *
 * Level order: WARN < HIGH < CRITICAL.
 *
 * Unknown `level`           → false (fail closed; never fire on noise).
 * Unknown / missing minLevel → treated as "HIGH" (current default behavior).
 *
 * @param {"WARN"|"HIGH"|"CRITICAL"|string} level
 * @param {"WARN"|"HIGH"|"CRITICAL"|string|undefined} minLevel
 * @returns {boolean}
 */
export function meetsThreshold(level, minLevel) {
  const lv = LEVEL_ORDER[level];
  if (lv === undefined) return false;
  const min = LEVEL_ORDER[minLevel];
  if (min === undefined) return lv >= LEVEL_ORDER.HIGH;
  return lv >= min;
}

// ─── macOS system notification ───────────────────────────────────────────────

/**
 * Display a native macOS notification via `osascript`.  Fire-and-forget:
 * returns synchronously, never throws, never blocks the caller.
 *
 * No-ops when:
 *   • level is not HIGH or CRITICAL
 *   • process.platform !== "darwin"
 *   • config.notifications.system.enabled === false
 *   • osascript is missing or fails (silent — captured on the child's 'error' event)
 *
 * @param {Object} params
 * @param {string} params.title   Context appended after the level prefix.
 * @param {string} params.message Notification body.
 * @param {"HIGH"|"CRITICAL"|string} params.level
 * @param {object} [config]       Merged AgentGuard config.
 * @param {Object} [opts]         Test seam.
 * @param {Function} [opts.spawnFn] Override spawn for testing.
 * @returns {{ skipped: string|null, argv: string[]|null }}
 *   `skipped` names the reason a notification was not produced (level,
 *   platform, disabled, spawn-error), or `null` on a successful spawn.
 *   `argv` is the osascript argv used, or null when skipped.
 */
export function sendSystemNotification({ title, message, level }, config, opts = {}) {
  if (!meetsThreshold(level, config?.notifications?.minLevel)) {
    return { skipped: "level", argv: null };
  }
  if (process.platform !== "darwin") {
    return { skipped: "platform", argv: null };
  }

  const sys = config?.notifications?.system ?? {};
  if (sys.enabled === false) {
    return { skipped: "disabled", argv: null };
  }

  const prefix =
    level === "CRITICAL" ? "⚠️ AgentGuard CRITICAL" : "🔶 AgentGuard HIGH";
  const fullTitle = title ? `${prefix} — ${title}` : prefix;

  // AppleScript string literals: escape backslashes + double quotes, and
  // collapse newlines so the -e script stays a single statement.
  const escape = (s) =>
    String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ");

  const script =
    `display notification "${escape(message)}" with title "${escape(fullTitle)}"`;
  const argv = ["-e", script];

  const spawnFn = opts.spawnFn ?? spawn;
  try {
    const child = spawnFn("osascript", argv, { stdio: "ignore" });
    child?.on?.("error", () => {}); // ENOENT, EACCES, etc — silent fail
  } catch {
    return { skipped: "spawn-error", argv };
  }
  return { skipped: null, argv };
}
