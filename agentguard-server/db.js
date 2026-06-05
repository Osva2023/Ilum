// SQLite storage for the AgentGuard team server.
//
// One table, `events`, holds every audit-log event POSTed by a daemon, tagged
// with the originating machine's hostname.  The full original event is kept
// verbatim in `payload` (JSON) so the dashboard can surface any field without a
// schema migration; the hot columns (machine, ts, level, …) are denormalised
// out of the payload for fast filtering.
//
// Uses `sqlite3` (async/callback) rather than better-sqlite3: it ships
// node-pre-gyp prebuilt binaries for common Linux targets, so it deploys
// cleanly on Railway containers. The exported API (insertEvent, queryEvents,
// listMachines, countEvents) is promise-based — server.js awaits each call.

import sqlite3pkg from "sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const sqlite3 = sqlite3pkg.verbose();
const __dirname = dirname(fileURLToPath(import.meta.url));

// DB lives under data/ (git-ignored, created on first boot). Railway gives the
// container a writable filesystem; for a persistent volume mount it at this path.
const DATA_DIR = process.env.AGENTGUARD_DATA_DIR || join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new sqlite3.Database(join(DATA_DIR, "events.db"));

// ── promise wrappers over the callback API ──
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this); // `this` carries lastID / changes
    });
  });
}
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}
function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

// Schema is created once at startup; every query awaits `ready` first so callers
// never race the table creation.
const ready = (async () => {
  await run("PRAGMA journal_mode = WAL");
  await run(`
    CREATE TABLE IF NOT EXISTS events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      machine     TEXT NOT NULL,
      ts          TEXT,           -- ISO timestamp from the originating event
      received_at TEXT NOT NULL,  -- ISO timestamp the server stored it
      level       TEXT,
      event       TEXT,
      source      TEXT,
      file        TEXT,
      command     TEXT,
      payload     TEXT NOT NULL   -- full original event as JSON
    )
  `);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_machine ON events(machine)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts)`);
})();

// Surface a schema-init failure loudly rather than letting it reject silently.
ready.catch((err) => {
  console.error("[agentguard-server] DB init failed:", err.message);
});

// Store one event. `evt` is the raw audit-log object (must already carry a
// `machine` field, but we accept an explicit override too). Returns the new id.
export async function insertEvent(evt, machineOverride) {
  await ready;
  const machine = machineOverride || evt.machine || "unknown";
  const ts = typeof evt.ts === "string"
    ? evt.ts
    : (evt.ts ? new Date(evt.ts).toISOString() : null);
  const r = await run(
    `INSERT INTO events (machine, ts, received_at, level, event, source, file, command, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      machine,
      ts,
      new Date().toISOString(),
      evt.level ?? null,
      evt.event ?? null,
      evt.source ?? null,
      evt.file ?? null,
      evt.command ?? null,
      JSON.stringify(evt),
    ]
  );
  return r.lastID;
}

// Translate a range keyword into an ISO cutoff. Unknown ranges → no lower bound.
function rangeCutoff(range) {
  const now = Date.now();
  switch (range) {
    case "today": {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "7d":  return new Date(now - 7 * 86400_000).toISOString();
    case "30d": return new Date(now - 30 * 86400_000).toISOString();
    default:    return null;
  }
}

// Fetch events filtered by range and machine ("all"/falsy = every machine).
// Returns the parsed payloads (so the dashboard sees the original event shape),
// newest first, capped to avoid unbounded responses.
export async function queryEvents({ range = "7d", machine = "all", limit = 2000 } = {}) {
  await ready;
  const cutoff = rangeCutoff(range);
  const where = [];
  const params = [];
  if (cutoff) { where.push("ts >= ?"); params.push(cutoff); }
  if (machine && machine !== "all") { where.push("machine = ?"); params.push(machine); }
  params.push(limit);

  const sql = `
    SELECT machine, ts, payload FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ts DESC, id DESC
    LIMIT ?
  `;
  const rows = await all(sql, params);
  return rows.map((row) => {
    let evt = {};
    try { evt = JSON.parse(row.payload); } catch { /* keep empty */ }
    return { ...evt, machine: row.machine, ts: row.ts ?? evt.ts };
  });
}

// Distinct machines that have ever reported, with their event count and the
// timestamp of their most recent event.
export async function listMachines() {
  await ready;
  return all(`
    SELECT machine AS hostname,
           COUNT(*) AS count,
           MAX(ts)  AS lastEvent
    FROM events
    GROUP BY machine
    ORDER BY lastEvent DESC
  `);
}

export async function countEvents() {
  await ready;
  const row = await get(`SELECT COUNT(*) AS n FROM events`);
  return row ? row.n : 0;
}

export default db;
