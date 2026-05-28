/**
 * AgentGuard Dashboard Server  (Phase 2)
 *
 * Serves a local web dashboard at http://localhost:7429 that reads the
 * JSON-lines audit log and exposes it via a simple REST API consumed by
 * the single-page index.html.
 *
 * Start with:  agentguard dashboard
 */

import express from "express";
import { readFileSync, existsSync } from "fs";
import { join, basename, resolve } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import { loadConfig } from "../config.js";
import { isDaemonRunning } from "../daemon-control.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const DASHBOARD_PORT = 7429;

// Events that represent a *detection moment* (a sensitive change was flagged).
// Excludes the incident_approved/incident_denied follow-ups so a single
// incident is not counted two or three times across its lifecycle.
const DETECTION_EVENTS = new Set([
  "incident_detected",
  "command_intercepted",
  "review_kept",
  "review_rolled_back",
  "review_skipped",
  "file_write",
  "file_restore",
]);

const LEVEL_RANK = { WARN: 1, HIGH: 2, CRITICAL: 3 };
const COMMAND_LINE_GROUP = "(command-line)";

// ─── audit log reader ─────────────────────────────────────────────────────────

function readAuditLog() {
  const logPath = join(homedir(), ".agentguard", "audit.log");
  if (!existsSync(logPath)) return [];

  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ─── pure helpers (exported for testing) ───────────────────────────────────────

/**
 * Derive a project name from a logged file path. The audit log stores paths
 * relative to the watched root, so the leading segment is the project.
 * e.g. "beach-flag-dashboard/.env.local" → "beach-flag-dashboard".
 * @returns {string|null}
 */
export function projectOf(file) {
  if (typeof file !== "string" || !file) return null;
  const seg = file.replace(/^\/+/, "").split("/").find(Boolean);
  return seg || null;
}

/** Expand a leading "~" to the home directory and resolve to absolute. */
export function expandPath(p) {
  if (typeof p !== "string" || !p) return null;
  if (p === "~" || p.startsWith("~/")) {
    return resolve(homedir(), p === "~" ? "." : p.slice(2));
  }
  return resolve(p);
}

/** Return the higher of two risk levels (null-safe). */
export function higherLevel(a, b) {
  const ra = LEVEL_RANK[a] ?? 0;
  const rb = LEVEL_RANK[b] ?? 0;
  return rb > ra ? b : a ?? b ?? null;
}

/**
 * True when `ts` falls within the named range, measured from `now`.
 *   "today" → since local midnight · "7d"/"30d" → trailing N days · else → all.
 */
export function withinRange(ts, range, now = Date.now()) {
  if (!ts) return false;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return false;
  if (range === "today") {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return t >= d.getTime();
  }
  if (range === "7d") return t >= now - 7 * 86400000;
  if (range === "30d") return t >= now - 30 * 86400000;
  return true;
}

/** Map basename(watchPath) → absolute path, for resolving project full paths. */
function buildWatchPathIndex(watchPaths) {
  const idx = {};
  for (const wp of Array.isArray(watchPaths) ? watchPaths : []) {
    const abs = expandPath(wp);
    if (abs) idx[basename(abs)] = abs;
  }
  return idx;
}

function minTs(list) {
  return list.reduce((m, t) => (m === null || t < m ? t : m), null);
}
function maxTs(list) {
  return list.reduce((m, t) => (m === null || t > m ? t : m), null);
}
function durationMs(start, end) {
  if (!start || !end) return 0;
  const d = new Date(end) - new Date(start);
  return d > 0 ? d : 0;
}

/**
 * Group audit events into sessions, then into projects.
 * Returns an array of { project, fullPath, sessions:[...] }.
 *
 * A session that touches file paths is attributed to one group per project
 * (the leading path segment). A session with no file paths (interactive
 * `agentguard <agent>` runs) is placed in the "(command-line)" group.
 */
export function groupByProject(events, watchPaths) {
  const wpIndex = buildWatchPathIndex(watchPaths);

  // Pass 1 — collect per-session meta + event list.
  const sessions = new Map();
  for (const e of events) {
    const id = e.sessionId;
    if (!id) continue;
    let s = sessions.get(id);
    if (!s) {
      s = { agent: "unknown", startTs: null, endTs: null, events: [] };
      sessions.set(id, s);
    }
    s.events.push(e);
    if (e.agent) s.agent = e.agent;
    if (e.event === "session_start") s.startTs = e.ts;
    if (e.event === "session_end") s.endTs = e.ts;
  }

  // Pass 2 — split each session into project buckets.
  const groups = new Map();
  const addSession = (project, fullPath, entry) => {
    let g = groups.get(project);
    if (!g) {
      g = { project, fullPath, sessions: [] };
      groups.set(project, g);
    }
    if (!g.fullPath && fullPath) g.fullPath = fullPath;
    g.sessions.push(entry);
  };

  for (const [id, s] of sessions) {
    const byProject = new Map();
    for (const e of s.events) {
      if (!e.file) continue;
      const proj = projectOf(e.file);
      if (!proj) continue;
      let p = byProject.get(proj);
      if (!p) {
        p = { tsList: [], detections: 0, maxLevel: null };
        byProject.set(proj, p);
      }
      p.tsList.push(e.ts);
      if (DETECTION_EVENTS.has(e.event)) p.detections++;
      if (e.level) p.maxLevel = higherLevel(p.maxLevel, e.level);
    }

    if (byProject.size === 0) {
      // Interactive / command-line session — no project to attribute to.
      const tsList = s.events.map((e) => e.ts).filter(Boolean);
      let maxLevel = null;
      let detections = 0;
      for (const e of s.events) {
        if (e.level) maxLevel = higherLevel(maxLevel, e.level);
        if (DETECTION_EVENTS.has(e.event)) detections++;
      }
      const start = s.startTs ?? minTs(tsList);
      const end = s.endTs ?? maxTs(tsList);
      addSession(COMMAND_LINE_GROUP, null, {
        sessionId: id,
        agent: s.agent,
        startTime: start,
        endTime: end,
        durationMs: durationMs(start, end),
        sensitiveCount: detections,
        maxLevel,
      });
    } else {
      for (const [proj, p] of byProject) {
        const start = minTs(p.tsList);
        const end = maxTs(p.tsList);
        addSession(proj, wpIndex[proj] ?? null, {
          sessionId: id,
          agent: s.agent,
          startTime: start,
          endTime: end,
          durationMs: durationMs(start, end),
          sensitiveCount: p.detections,
          maxLevel: p.maxLevel,
        });
      }
    }
  }

  // Sort sessions (newest first) within each group.
  const arr = [...groups.values()];
  for (const g of arr) {
    g.sessions.sort(
      (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
    );
  }
  // Projects by most-recent activity; "(command-line)" always last.
  arr.sort((a, b) => {
    if (a.project === COMMAND_LINE_GROUP) return 1;
    if (b.project === COMMAND_LINE_GROUP) return -1;
    const at = a.sessions[0]?.startTime || 0;
    const bt = b.sessions[0]?.startTime || 0;
    return new Date(bt) - new Date(at);
  });
  return arr;
}

// ─── session grouping (flat, for /api/sessions/:id detail view) ────────────────

function groupBySessions(events) {
  const sessionMap = {};

  for (const event of events) {
    const id = event.sessionId;
    if (!id) continue;

    if (!sessionMap[id]) {
      sessionMap[id] = {
        sessionId: id,
        agent: event.agent || "unknown",
        startTime: null,
        endTime: null,
        intercepted: 0,
        blocked: 0,
        approved: 0,
        events: [],
      };
    }

    const s = sessionMap[id];
    s.events.push(event);

    if (event.event === "session_start") {
      s.startTime = event.ts;
      if (event.agent) s.agent = event.agent;
    }
    if (event.event === "session_end") s.endTime = event.ts;
    if (event.event === "command_intercepted") s.intercepted++;
    if (event.event === "command_denied") s.blocked++;
    if (event.event === "command_approved") s.approved++;
  }

  return Object.values(sessionMap).sort(
    (a, b) => new Date(b.startTime || 0) - new Date(a.startTime || 0)
  );
}

// ─── API routes ───────────────────────────────────────────────────────────────

function buildRouter() {
  const router = express.Router();

  // Last 100 events (any kind)
  router.get("/events", (_req, res) => {
    const events = readAuditLog();
    res.json(events.slice(-100));
  });

  // Daemon running state (for the header status pill)
  router.get("/daemon-status", (_req, res) => {
    res.json({ running: isDaemonRunning() });
  });

  // Sessions grouped by project, filtered by ?range=today|7d|30d (default 7d).
  router.get("/sessions", (req, res) => {
    const range = req.query.range || "7d";
    const events = readAuditLog().filter((e) => withinRange(e.ts, range));
    const watchPaths = loadConfig().watchPaths;
    res.json({ range, projects: groupByProject(events, watchPaths) });
  });

  // Single session with full event list (used by the timeline view — TASK-008).
  router.get("/sessions/:id", (req, res) => {
    const events = readAuditLog();
    const sessions = groupBySessions(events);
    const session = sessions.find((s) => s.sessionId === req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  });

  // Aggregate stats
  router.get("/stats", (_req, res) => {
    const events = readAuditLog();
    const sessions = groupBySessions(events);
    res.json({
      totalSessions: sessions.length,
      totalIntercepted: sessions.reduce((n, s) => n + s.intercepted, 0),
      totalBlocked: sessions.reduce((n, s) => n + s.blocked, 0),
      totalApproved: sessions.reduce((n, s) => n + s.approved, 0),
    });
  });

  return router;
}

// ─── server entry point ───────────────────────────────────────────────────────

/**
 * Start the dashboard HTTP server.  Never resolves — runs until the process
 * is killed (Ctrl-C).
 */
export async function startDashboard() {
  const app = express();

  // Serve static assets (index.html, etc.)
  app.use(express.static(join(__dirname, "public")));

  // JSON API
  app.use("/api", buildRouter());

  await new Promise((resolve, reject) => {
    const server = app.listen(DASHBOARD_PORT, "127.0.0.1", () => {
      console.log(
        `\n  AgentGuard Dashboard  →  http://localhost:${DASHBOARD_PORT}\n`
      );
      console.log("  Press Ctrl-C to stop.\n");
    });
    server.on("error", reject);
  });

  // Keep the process alive
  await new Promise(() => {});
}
