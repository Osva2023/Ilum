// SQLite storage for the AgentGuard team server.
//
// One table, `events`, holds every audit-log event POSTed by a daemon, tagged
// with the originating machine's hostname.  The full original event is kept
// verbatim in `payload` (JSON) so the dashboard can surface any field without a
// schema migration; the hot columns (machine, ts, level, …) are denormalised
// out of the payload for fast filtering.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// DB lives under data/ (git-ignored, created on first boot). Railway gives the
// container a writable filesystem; for a persistent volume mount it at this path.
const DATA_DIR = process.env.AGENTGUARD_DATA_DIR || join(__dirname, "data");
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, "events.db"));
db.pragma("journal_mode = WAL");

db.exec(`
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
  );
  CREATE INDEX IF NOT EXISTS idx_events_machine ON events(machine);
  CREATE INDEX IF NOT EXISTS idx_events_ts      ON events(ts);
`);

const insertStmt = db.prepare(`
  INSERT INTO events (machine, ts, received_at, level, event, source, file, command, payload)
  VALUES (@machine, @ts, @received_at, @level, @event, @source, @file, @command, @payload)
`);

// Store one event. `evt` is the raw audit-log object (must already carry a
// `machine` field, but we accept an explicit override too). Returns the new id.
export function insertEvent(evt, machineOverride) {
  const machine = machineOverride || evt.machine || "unknown";
  const info = insertStmt.run({
    machine,
    ts: typeof evt.ts === "string" ? evt.ts : (evt.ts ? new Date(evt.ts).toISOString() : null),
    received_at: new Date().toISOString(),
    level: evt.level ?? null,
    event: evt.event ?? null,
    source: evt.source ?? null,
    file: evt.file ?? null,
    command: evt.command ?? null,
    payload: JSON.stringify(evt),
  });
  return info.lastInsertRowid;
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
export function queryEvents({ range = "7d", machine = "all", limit = 2000 } = {}) {
  const cutoff = rangeCutoff(range);
  const where = [];
  const params = {};
  if (cutoff) { where.push("ts >= @cutoff"); params.cutoff = cutoff; }
  if (machine && machine !== "all") { where.push("machine = @machine"); params.machine = machine; }
  params.limit = limit;

  const sql = `
    SELECT machine, ts, payload FROM events
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY ts DESC, id DESC
    LIMIT @limit
  `;
  return db.prepare(sql).all(params).map((row) => {
    let evt = {};
    try { evt = JSON.parse(row.payload); } catch { /* keep empty */ }
    return { ...evt, machine: row.machine, ts: row.ts ?? evt.ts };
  });
}

// Distinct machines that have ever reported, with their event count and the
// timestamp of their most recent event.
export function listMachines() {
  return db.prepare(`
    SELECT machine AS hostname,
           COUNT(*) AS count,
           MAX(ts)  AS lastEvent
    FROM events
    GROUP BY machine
    ORDER BY lastEvent DESC
  `).all();
}

export function countEvents() {
  return db.prepare(`SELECT COUNT(*) AS n FROM events`).get().n;
}

export default db;
