/**
 * AgentGuard notifier.js tests  (plain Node.js, no test runner)
 *
 * Tests:
 *   1. isNotifierConfigured() → false when no credentials
 *   2. isNotifierConfigured() → false when enabled=true but missing token
 *   3. isNotifierConfigured() → true from env vars alone
 *   4. isNotifierConfigured() → true from config object
 *   5. sendTelegramAlert — message body contains expected fields (fetch mocked)
 *   6. sendTelegramAlert — skips silently with no credentials
 */

import assert from "assert";
import {
  isNotifierConfigured,
  sendTelegramAlert,
  sendFileChangeAlert,
  editAlertResolved,
  sendSystemNotification,
  meetsThreshold,
  isEmailConfigured,
  sendEmailAlert,
  isSlackConfigured,
  isDiscordConfigured,
  sendSlackAlert,
  sendDiscordAlert,
} from "../src/notifier.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ─── tests ────────────────────────────────────────────────────────────────────

console.log("\nnotifier.test.js\n");

// 1. No credentials at all → false
test("isNotifierConfigured() → false when no config and no env vars", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      assert.strictEqual(isNotifierConfigured({}), false);
    }
  );
});

// 2. enabled:true but token missing → false
test("isNotifierConfigured() → false when enabled but botToken missing", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      const config = {
        notifications: { telegram: { enabled: true, botToken: "", chatId: "" } },
      };
      assert.strictEqual(isNotifierConfigured(config), false);
    }
  );
});

// 3. env vars only → true
test("isNotifierConfigured() → true from env vars alone", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: "tok123",
      AGENTGUARD_TELEGRAM_CHAT_ID: "chat456",
    },
    () => {
      assert.strictEqual(isNotifierConfigured({}), true);
    }
  );
});

// 4. config object → true
test("isNotifierConfigured() → true from config object", () => {
  withEnv(
    {
      AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
      AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
    },
    () => {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "tok-from-config",
            chatId: "chat-from-config",
          },
        },
      };
      assert.strictEqual(isNotifierConfigured(config), true);
    }
  );
});

// 5. sendTelegramAlert — check message body via mocked fetch
await testAsync(
  "sendTelegramAlert() sends correct message body",
  async () => {
    let capturedUrl;
    let capturedBody;

    // Temporarily replace globalThis.fetch
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };

    try {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "test-token",
            chatId: "test-chat",
          },
        },
      };

      await sendTelegramAlert(
        {
          command: "rm -rf ./src",
          level: "CRITICAL",
          reason: "Recursive or forced file deletion",
          sessionId: "abc12345def",
          agent: "codex",
        },
        config
      );

      assert.ok(capturedUrl, "fetch should have been called");
      assert.ok(
        capturedUrl.includes("test-token"),
        "URL should include bot token"
      );
      assert.strictEqual(capturedBody.chat_id, "test-chat");

      const msg = capturedBody.text;
      assert.ok(msg.includes("AgentGuard Alert"), "message has header");
      assert.ok(msg.includes("codex"), "message has agent name");
      assert.ok(msg.includes("abc12345"), "message has short session id");
      assert.ok(msg.includes("CRITICAL"), "message has risk level");
      assert.ok(msg.includes("rm -rf ./src"), "message has command");
      assert.ok(msg.includes("/approve_abc12345"), "message has approve command");
      assert.ok(msg.includes("/deny_abc12345"), "message has deny command");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// 5b. sendTelegramAlert — raw `text` is sent verbatim (TASK-013 daily report)
await testAsync(
  "sendTelegramAlert() sends raw text verbatim when text provided",
  async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };
    try {
      const config = {
        notifications: { telegram: { enabled: true, botToken: "t", chatId: "c" } },
      };
      const report = "AgentGuard Report — 2026-05-29\n(today)\n\nSessions: 2";
      await sendTelegramAlert({ text: report }, config);
      assert.strictEqual(capturedBody.text, report, "body is the raw text");
      assert.ok(!capturedBody.text.includes("/approve_"), "no templated footer");
      assert.ok(!capturedBody.text.includes("🚨 AgentGuard Alert"), "no templated header");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// 6. sendTelegramAlert — silently skips when no credentials
await testAsync(
  "sendTelegramAlert() skips silently with no credentials",
  async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return { ok: true };
    };

    try {
      await withEnv(
        {
          AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
          AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
        },
        async () => {
          await sendTelegramAlert(
            {
              command: "rm -rf .",
              level: "CRITICAL",
              reason: "test",
              sessionId: "abc",
              agent: "codex",
            },
            {}
          );
        }
      );
      assert.strictEqual(fetchCalled, false, "fetch must not be called when no credentials");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// ─── sendFileChangeAlert ──────────────────────────────────────────────────────

await testAsync(
  "sendFileChangeAlert() embeds inline_keyboard with correct callback_data",
  async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ result: { message_id: 42 } }) };
    };
    try {
      const config = {
        notifications: {
          telegram: { enabled: true, botToken: "t", chatId: "c" },
        },
      };
      await sendFileChangeAlert(
        {
          file: "src/.env",
          level: "HIGH",
          event: "modified",
          sessionId: "abc12345def",
          changeId: "deadbeef",
          agent: "claude",
        },
        config
      );
      const kb = capturedBody.reply_markup.inline_keyboard;
      assert.strictEqual(kb.length, 1);
      assert.strictEqual(kb[0].length, 2);
      assert.strictEqual(kb[0][0].callback_data, "k:deadbeef");
      assert.strictEqual(kb[0][1].callback_data, "r:deadbeef");
      assert.ok(kb[0][0].text.includes("Keep"));
      assert.ok(kb[0][1].text.includes("Rollback"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "sendFileChangeAlert() body contains file, level, event, short session",
  async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ result: { message_id: 1 } }) };
    };
    try {
      const config = {
        notifications: {
          telegram: { enabled: true, botToken: "t", chatId: "c" },
        },
      };
      await sendFileChangeAlert(
        {
          file: "secrets/.env",
          level: "CRITICAL",
          event: "modified",
          sessionId: "abc12345def",
          changeId: "x",
          agent: "claude",
        },
        config
      );
      const msg = capturedBody.text;
      assert.ok(msg.includes("secrets/.env"), "has file path");
      assert.ok(msg.includes("CRITICAL"), "has level");
      assert.ok(msg.includes("modified"), "has event");
      assert.ok(msg.includes("abc12345"), "has short session id");
      assert.ok(msg.includes("claude"), "has agent name");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "sendFileChangeAlert() returns text + refs for successful sends",
  async () => {
    let counter = 100;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ result: { message_id: counter++ } }),
    });
    try {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "t",
            chatId: "primary",
            extraChatIds: ["extra1", "extra2"],
          },
        },
      };
      const out = await sendFileChangeAlert(
        {
          file: "x", level: "HIGH", event: "modified",
          sessionId: "s", changeId: "c", agent: "a",
        },
        config
      );
      assert.ok(typeof out.text === "string" && out.text.length > 0);
      assert.deepStrictEqual(out.refs, [
        { chatId: "primary", messageId: 100 },
        { chatId: "extra1",  messageId: 101 },
        { chatId: "extra2",  messageId: 102 },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "sendFileChangeAlert() returns {text:'', refs:[]} when not configured",
  async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return { ok: true }; };
    try {
      await withEnv(
        {
          AGENTGUARD_TELEGRAM_BOT_TOKEN: undefined,
          AGENTGUARD_TELEGRAM_CHAT_ID: undefined,
        },
        async () => {
          const out = await sendFileChangeAlert(
            { file: "x", level: "HIGH", event: "modified",
              sessionId: "s", changeId: "c", agent: "a" },
            {}
          );
          assert.deepStrictEqual(out, { text: "", refs: [] });
        }
      );
      assert.strictEqual(called, false, "fetch must not be called");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "sendFileChangeAlert() per-chat failure does not abort other chats",
  async () => {
    let n = 0;
    const originalFetch = globalThis.fetch;
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = () => true;
    globalThis.fetch = async (_url, opts) => {
      n++;
      const body = JSON.parse(opts.body);
      if (body.chat_id === "fails") {
        return { ok: false, status: 400, text: async () => "bad chat" };
      }
      return { ok: true, json: async () => ({ result: { message_id: 7 } }) };
    };
    try {
      const config = {
        notifications: {
          telegram: {
            enabled: true,
            botToken: "t",
            chatId: "primary",
            extraChatIds: ["fails", "ok2"],
          },
        },
      };
      const out = await sendFileChangeAlert(
        { file: "x", level: "HIGH", event: "modified",
          sessionId: "s", changeId: "c", agent: "a" },
        config
      );
      assert.strictEqual(n, 3, "all 3 chats attempted");
      assert.deepStrictEqual(
        out.refs.map((r) => r.chatId).sort(),
        ["ok2", "primary"]
      );
    } finally {
      globalThis.fetch = originalFetch;
      process.stderr.write = originalWrite;
    }
  }
);

// ─── editAlertResolved ────────────────────────────────────────────────────────

await testAsync(
  "editAlertResolved() POSTs editMessageText with appended resolution and empty keyboard",
  async () => {
    let capturedUrl, capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };
    try {
      const ok = await editAlertResolved({
        token: "tok",
        chatId: "c1",
        messageId: 42,
        originalText: "📁 AgentGuard File Alert\n\nFile: x",
        outcome: "rolled_back",
        by: "morphius101",
      });
      assert.strictEqual(ok, true);
      assert.ok(capturedUrl.endsWith("/editMessageText"));
      assert.strictEqual(capturedBody.chat_id, "c1");
      assert.strictEqual(capturedBody.message_id, 42);
      assert.ok(capturedBody.text.startsWith("📁 AgentGuard File Alert"));
      assert.ok(capturedBody.text.includes("↩️ Rolled back by @morphius101"));
      assert.deepStrictEqual(capturedBody.reply_markup, { inline_keyboard: [] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "editAlertResolved() — resolution-line strings for each outcome",
  async () => {
    let capturedBody;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return { ok: true };
    };
    try {
      await editAlertResolved({
        token: "t", chatId: "c", messageId: 1,
        originalText: "ORIG", outcome: "kept", by: "alice",
      });
      assert.ok(capturedBody.text.endsWith("✅ Kept by @alice"));

      await editAlertResolved({
        token: "t", chatId: "c", messageId: 1,
        originalText: "ORIG", outcome: "kept", by: null,
      });
      assert.ok(capturedBody.text.endsWith("✅ Kept"));

      await editAlertResolved({
        token: "t", chatId: "c", messageId: 1,
        originalText: "ORIG", outcome: "session_ended",
      });
      assert.ok(capturedBody.text.endsWith("⌛ Session ended — no action taken"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

await testAsync(
  "editAlertResolved() returns false on missing params",
  async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { called = true; return { ok: true }; };
    try {
      const r1 = await editAlertResolved({
        token: "", chatId: "c", messageId: 1,
        originalText: "x", outcome: "kept",
      });
      const r2 = await editAlertResolved({
        token: "t", chatId: "c", messageId: null,
        originalText: "x", outcome: "kept",
      });
      const r3 = await editAlertResolved({
        token: "t", chatId: "c", messageId: 1,
        originalText: "x", outcome: "what?",
      });
      assert.strictEqual(r1, false);
      assert.strictEqual(r2, false);
      assert.strictEqual(r3, false);
      assert.strictEqual(called, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
);

// ─── Email notifier (TASK-012) ────────────────────────────────────────────────

const emailConfig = (over = {}) => ({
  notifications: {
    email: {
      enabled: true,
      smtp: { host: "smtp.example.com", port: 465, user: "u@example.com", pass: "secret", secure: true },
      to: ["a@x.com", "b@y.com"],
      ...over,
    },
  },
});

test("isEmailConfigured → false when disabled", () => {
  assert.strictEqual(isEmailConfigured(emailConfig({ enabled: false })), false);
});

test("isEmailConfigured → false when host missing", () => {
  assert.strictEqual(isEmailConfigured(emailConfig({ smtp: { host: "" } })), false);
});

test("isEmailConfigured → false when no recipients", () => {
  assert.strictEqual(isEmailConfigured(emailConfig({ to: [] })), false);
  assert.strictEqual(isEmailConfigured(emailConfig({ to: "" })), false);
});

test("isEmailConfigured → true with enabled + host + recipient (string or array)", () => {
  assert.strictEqual(isEmailConfigured(emailConfig()), true);
  assert.strictEqual(isEmailConfigured(emailConfig({ to: "one@x.com" })), true);
});

// Build a fake nodemailer transport that captures the createTransport options
// and the sendMail message — no real SMTP, no nodemailer dependency exercised.
function captureTransport() {
  const cap = {};
  const createTransport = (opts) => {
    cap.transportOpts = opts;
    return {
      sendMail: async (msg) => {
        cap.message = msg;
        return { messageId: "test-id" };
      },
    };
  };
  return { cap, createTransport };
}

await testAsync("sendEmailAlert → subject, recipients, body, transport opts", async () => {
  const { cap, createTransport } = captureTransport();
  const out = await sendEmailAlert(
    { file: ".env", level: "HIGH", event: "modified", sessionId: "abc12345def", agent: "claude", project: "project-name" },
    emailConfig(),
    { createTransport }
  );

  assert.strictEqual(out.sent, true);
  // Subject format: "[AgentGuard] HIGH: .env modified in project-name"
  assert.strictEqual(out.subject, "[AgentGuard] HIGH: .env modified in project-name");
  assert.strictEqual(cap.message.subject, out.subject);
  assert.strictEqual(cap.message.to, "a@x.com, b@y.com");

  // Plain-text body mirrors the Telegram fields.
  const t = cap.message.text;
  assert.ok(t.includes(".env"), "text has file");
  assert.ok(t.includes("HIGH"), "text has level");
  assert.ok(t.includes("modified"), "text has event");
  assert.ok(t.includes("abc12345"), "text has short session");
  assert.ok(/Time:\s+\d{4}-\d{2}-\d{2}T/.test(t), "text has ISO timestamp");

  // HTML body present + informational (no rollback wording).
  assert.ok(cap.message.html.includes("AgentGuard Alert"), "html header");
  assert.ok(/no action/i.test(cap.message.html), "html is informational");

  // Transport opts: secure defaults true, auth from smtp user/pass.
  assert.strictEqual(cap.transportOpts.host, "smtp.example.com");
  assert.strictEqual(cap.transportOpts.secure, true);
  assert.deepStrictEqual(cap.transportOpts.auth, { user: "u@example.com", pass: "secret" });
});

await testAsync("sendEmailAlert → derives project from file path when not provided", async () => {
  const { cap, createTransport } = captureTransport();
  await sendEmailAlert(
    { file: "beach-flag/.env.local", level: "CRITICAL", event: "created", sessionId: "s" },
    emailConfig(),
    { createTransport }
  );
  assert.strictEqual(cap.message.subject, "[AgentGuard] CRITICAL: beach-flag/.env.local created in beach-flag");
});

await testAsync("sendEmailAlert → secure:false honored (STARTTLS)", async () => {
  const { cap, createTransport } = captureTransport();
  await sendEmailAlert(
    { file: ".env", level: "HIGH", event: "modified", sessionId: "s" },
    emailConfig({ smtp: { host: "smtp.example.com", port: 587, secure: false } }),
    { createTransport }
  );
  assert.strictEqual(cap.transportOpts.secure, false);
  assert.strictEqual(cap.transportOpts.port, 587);
  assert.strictEqual(cap.transportOpts.auth, undefined, "no auth when user/pass absent");
});

await testAsync("sendEmailAlert → skips (no transport) when not configured", async () => {
  let created = false;
  const createTransport = () => { created = true; return { sendMail: async () => ({}) }; };
  const out = await sendEmailAlert(
    { file: ".env", level: "HIGH", event: "modified", sessionId: "s" },
    { notifications: { email: { enabled: false } } },
    { createTransport }
  );
  assert.deepStrictEqual(out, { sent: false, skipped: "not-configured" });
  assert.strictEqual(created, false, "createTransport must not be called");
});

// ─── Webhook notifiers: Slack / Discord (TASK-020) ────────────────────────────

const slackCfg = { notifications: { slack: { webhookUrl: "https://hooks.slack.com/services/T/B/X" } } };
const discordCfg = { notifications: { discord: { webhookUrl: "https://discord.com/api/webhooks/1/abc" } } };

test("isSlackConfigured / isDiscordConfigured reflect webhookUrl presence", () => {
  assert.strictEqual(isSlackConfigured(slackCfg), true);
  assert.strictEqual(isSlackConfigured({}), false);
  assert.strictEqual(isSlackConfigured({ notifications: { slack: { webhookUrl: "" } } }), false);
  assert.strictEqual(isDiscordConfigured(discordCfg), true);
  assert.strictEqual(isDiscordConfigured({}), false);
});

function captureFetch() {
  const cap = {};
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    cap.url = url;
    cap.body = JSON.parse(opts.body);
    return { ok: true, text: async () => "" };
  };
  return { cap, restore: () => { globalThis.fetch = original; } };
}

await testAsync("sendSlackAlert → posts Block Kit payload to the webhook", async () => {
  const { cap, restore } = captureFetch();
  try {
    const out = await sendSlackAlert(
      { file: ".env", level: "HIGH", event: "modified", sessionId: "abc12345", project: "proj" },
      slackCfg
    );
    assert.strictEqual(out.sent, true);
    assert.strictEqual(cap.url, slackCfg.notifications.slack.webhookUrl);
    assert.strictEqual(cap.body.blocks[0].type, "header");
    assert.strictEqual(cap.body.blocks[0].text.text, "[AgentGuard] HIGH: .env modified");
    const fields = cap.body.blocks[1].fields.map((f) => f.text);
    assert.ok(fields.includes("*File:*\n.env"));
    assert.ok(fields.includes("*Project:*\nproj"));
    assert.ok(fields.includes("*Level:*\nHIGH"));
    assert.ok(fields.some((t) => t.startsWith("*Time:*\n")));
  } finally {
    restore();
  }
});

await testAsync("sendDiscordAlert → posts embed with level color + fields", async () => {
  const { cap, restore } = captureFetch();
  try {
    const out = await sendDiscordAlert(
      { file: ".env", level: "HIGH", event: "modified", sessionId: "abc12345", project: "proj" },
      discordCfg
    );
    assert.strictEqual(out.sent, true);
    assert.strictEqual(cap.url, discordCfg.notifications.discord.webhookUrl);
    const embed = cap.body.embeds[0];
    assert.strictEqual(embed.title, "[AgentGuard] HIGH: .env modified");
    assert.strictEqual(embed.color, 0xe67e22); // HIGH = orange
    const names = embed.fields.map((f) => f.name);
    assert.deepStrictEqual(names, ["File", "Project", "Level", "Time"]);
    assert.strictEqual(embed.fields[0].value, ".env");
    assert.strictEqual(embed.fields[1].value, "proj");
  } finally {
    restore();
  }
});

await testAsync("sendDiscordAlert → CRITICAL=red, WARN=yellow", async () => {
  for (const [level, color] of [["CRITICAL", 0xe74c3c], ["WARN", 0xf39c12]]) {
    const { cap, restore } = captureFetch();
    try {
      await sendDiscordAlert({ file: "x", level, event: "modified", sessionId: "s" }, discordCfg);
      assert.strictEqual(cap.body.embeds[0].color, color, `${level} color`);
    } finally {
      restore();
    }
  }
});

await testAsync("sendSlackAlert / sendDiscordAlert → skip when not configured", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, text: async () => "" }; };
  try {
    const s = await sendSlackAlert({ file: ".env", level: "HIGH", event: "modified", sessionId: "s" }, {});
    const d = await sendDiscordAlert({ file: ".env", level: "HIGH", event: "modified", sessionId: "s" }, {});
    assert.deepStrictEqual(s, { sent: false, skipped: "not-configured" });
    assert.deepStrictEqual(d, { sent: false, skipped: "not-configured" });
    assert.strictEqual(called, false, "fetch must not be called");
  } finally {
    globalThis.fetch = original;
  }
});

// ─── sendSystemNotification ───────────────────────────────────────────────────

function withPlatform(platform, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", desc);
  }
}

function captureSpawn() {
  const calls = [];
  const spawnFn = (cmd, argv, opts) => {
    calls.push({ cmd, argv, opts });
    return { on() {} };
  };
  return { spawnFn, calls };
}

test("sendSystemNotification → WARN level is a no-op", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: "package-lock.json", message: "modified", level: "WARN" },
      {},
      { spawnFn },
    );
    assert.strictEqual(result.skipped, "level");
    assert.strictEqual(calls.length, 0);
  });
});

test("sendSystemNotification → non-darwin platform is a no-op", () => {
  withPlatform("linux", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: ".env", message: "modified", level: "HIGH" },
      {},
      { spawnFn },
    );
    assert.strictEqual(result.skipped, "platform");
    assert.strictEqual(calls.length, 0);
  });
});

test("sendSystemNotification → system.enabled:false is a no-op", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: ".env", message: "modified", level: "HIGH" },
      { notifications: { system: { enabled: false } } },
      { spawnFn },
    );
    assert.strictEqual(result.skipped, "disabled");
    assert.strictEqual(calls.length, 0);
  });
});

test("sendSystemNotification → HIGH on darwin spawns osascript with correct argv", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: ".env", message: "modified by claude", level: "HIGH" },
      { notifications: { system: { enabled: true } } },
      { spawnFn },
    );
    assert.strictEqual(result.skipped, null);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, "osascript");
    assert.strictEqual(calls[0].argv[0], "-e");
    const script = calls[0].argv[1];
    // Notification must be attributed to System Events (faceless background agent)
    // so a click never opens Script Editor. (TASK-003)
    assert.ok(
      script.startsWith('tell application "System Events" to display notification'),
      `script should route through System Events: ${script}`,
    );
    assert.ok(script.includes("🔶 AgentGuard HIGH"), `script missing HIGH prefix: ${script}`);
    assert.ok(script.includes("— .env"), `script missing title context: ${script}`);
    assert.ok(script.includes("modified by claude"), `script missing message: ${script}`);
    assert.strictEqual(calls[0].opts.stdio, "ignore");
  });
});

test("sendSystemNotification → CRITICAL on darwin prefixes title with ⚠️ AgentGuard CRITICAL", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: "id_rsa", message: "deleted", level: "CRITICAL" },
      { notifications: { system: { enabled: true } } },
      { spawnFn },
    );
    assert.strictEqual(result.skipped, null);
    assert.strictEqual(calls.length, 1);
    const script = calls[0].argv[1];
    assert.ok(
      script.includes("⚠️ AgentGuard CRITICAL"),
      `script missing CRITICAL prefix: ${script}`,
    );
    assert.ok(script.includes("— id_rsa"), `script missing title context: ${script}`);
  });
});

// ─── meetsThreshold ───────────────────────────────────────────────────────────

test("meetsThreshold — WARN min admits all severities", () => {
  assert.strictEqual(meetsThreshold("WARN", "WARN"), true);
  assert.strictEqual(meetsThreshold("HIGH", "WARN"), true);
  assert.strictEqual(meetsThreshold("CRITICAL", "WARN"), true);
});

test("meetsThreshold — HIGH min admits HIGH and CRITICAL only", () => {
  assert.strictEqual(meetsThreshold("WARN", "HIGH"), false);
  assert.strictEqual(meetsThreshold("HIGH", "HIGH"), true);
  assert.strictEqual(meetsThreshold("CRITICAL", "HIGH"), true);
});

test("meetsThreshold — CRITICAL min admits CRITICAL only", () => {
  assert.strictEqual(meetsThreshold("WARN", "CRITICAL"), false);
  assert.strictEqual(meetsThreshold("HIGH", "CRITICAL"), false);
  assert.strictEqual(meetsThreshold("CRITICAL", "CRITICAL"), true);
});

test("meetsThreshold — unknown level fails closed", () => {
  assert.strictEqual(meetsThreshold("SAFE", "WARN"), false);
  assert.strictEqual(meetsThreshold(undefined, "WARN"), false);
});

test("meetsThreshold — missing/unknown minLevel defaults to HIGH", () => {
  assert.strictEqual(meetsThreshold("WARN", undefined), false);
  assert.strictEqual(meetsThreshold("HIGH", undefined), true);
  assert.strictEqual(meetsThreshold("CRITICAL", "bogus"), true);
  assert.strictEqual(meetsThreshold("WARN", "bogus"), false);
});

// ─── sendSystemNotification honors config.notifications.minLevel ──────────────

test("sendSystemNotification → WARN passes when config.notifications.minLevel='WARN'", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: "package-lock.json", message: "modified", level: "WARN" },
      { notifications: { minLevel: "WARN" } },
      { spawnFn },
    );
    assert.strictEqual(result.skipped, null);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, "osascript");
  });
});

test("sendSystemNotification → HIGH is a no-op when config.notifications.minLevel='CRITICAL'", () => {
  withPlatform("darwin", () => {
    const { spawnFn, calls } = captureSpawn();
    const result = sendSystemNotification(
      { title: ".env", message: "modified", level: "HIGH" },
      { notifications: { minLevel: "CRITICAL" } },
      { spawnFn },
    );
    assert.strictEqual(result.skipped, "level");
    assert.strictEqual(calls.length, 0);
  });
});

// ─── summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);

if (failed > 0) process.exit(1);
