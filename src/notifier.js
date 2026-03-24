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
