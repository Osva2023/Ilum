// AgentGuard Team Plan — central event server.
//
// Daemons running on each developer's machine POST their audit-log events here
// (with a bearer token); the bundled dashboard reads them back so a whole team
// can watch interceptions across every machine in one place.
//
// Auth: a single fixed token in AGENTGUARD_TOKEN. Every /api route except
// /api/health requires `Authorization: Bearer <token>`. Fail-closed: if the
// env var is unset, all authenticated routes return 401.

import express from "express";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { insertEvent, queryEvents, listMachines, countEvents } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.AGENTGUARD_TOKEN || "";

if (!TOKEN) {
  console.warn(
    "[agentguard-server] WARNING: AGENTGUARD_TOKEN is not set — all authenticated " +
    "routes will reject with 401. Set it before accepting real traffic."
  );
}

const app = express();
app.use(express.json({ limit: "256kb" }));

// ── auth middleware ──
function requireAuth(req, res, next) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const provided = match ? match[1].trim() : "";
  if (!TOKEN || provided !== TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// ── POST /api/events ── receive one event from a daemon ──
app.post("/api/events", requireAuth, async (req, res) => {
  const evt = req.body;
  if (!evt || typeof evt !== "object" || Array.isArray(evt)) {
    return res.status(400).json({ error: "body must be a JSON event object" });
  }
  try {
    const id = await insertEvent(evt);
    res.status(201).json({ ok: true, id: Number(id) });
  } catch (err) {
    console.error("[agentguard-server] insert failed:", err.message);
    res.status(500).json({ error: "failed to store event" });
  }
});

// ── GET /api/events?range=today|7d|30d&machine=all|hostname ──
app.get("/api/events", requireAuth, async (req, res) => {
  const range = String(req.query.range || "7d");
  const machine = String(req.query.machine || "all");
  try {
    const events = await queryEvents({ range, machine });
    res.json({ events });
  } catch (err) {
    console.error("[agentguard-server] query failed:", err.message);
    res.status(500).json({ error: "failed to query events" });
  }
});

// ── GET /api/machines ── active machines with counts ──
app.get("/api/machines", requireAuth, async (req, res) => {
  try {
    res.json({ machines: await listMachines() });
  } catch (err) {
    console.error("[agentguard-server] machines failed:", err.message);
    res.status(500).json({ error: "failed to list machines" });
  }
});

// ── GET /api/health ── no auth ──
app.get("/api/health", async (req, res) => {
  let events = 0;
  try { events = await countEvents(); } catch { /* db may be mid-init */ }
  res.json({ status: "ok", events });
});

// ── GET / ── dashboard ──
app.get("/", (req, res) => {
  res.sendFile(join(__dirname, "dashboard.html"));
});

app.listen(PORT, () => {
  console.log(`[agentguard-server] listening on :${PORT}`);
});
