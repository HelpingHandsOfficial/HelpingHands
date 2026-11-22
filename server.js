const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const express = require("express");
const Database = require("better-sqlite3");
const { Pool } = require("pg");
const { OTLPLogExporter } = require("@opentelemetry/exporter-logs-otlp-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");
const { BatchLogRecordProcessor, LoggerProvider } = require("@opentelemetry/sdk-logs");

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    process.env[match[1]] = match[2].replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
  }
}

loadEnvFile();

const app = express();
const port = Number(process.env.PORT || 3000);
const dashboardKey = process.env.DASHBOARD_KEY || "dev-change-me";
const posthogProjectToken = process.env.POSTHOG_PROJECT_TOKEN;
const posthogHost = process.env.POSTHOG_HOST;
const databaseUrl = process.env.DATABASE_URL;
const pgPool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false
    })
  : null;
const sqliteDb = pgPool ? null : new Database(path.join(__dirname, "helping-hands.sqlite"));

function placeholders(sql) {
  if (!pgPool) return sql;
  let index = 0;
  return sql.replace(/\?/g, () => "$" + (++index));
}

async function dbRun(sql, params = []) {
  if (pgPool) {
    const result = await pgPool.query(placeholders(sql), params);
    return { changes: result.rowCount || 0 };
  }
  return sqliteDb.prepare(sql).run(...params);
}

async function dbGet(sql, params = []) {
  if (pgPool) {
    const result = await pgPool.query(placeholders(sql), params);
    return result.rows[0];
  }
  return sqliteDb.prepare(sql).get(...params);
}

async function dbAll(sql, params = []) {
  if (pgPool) {
    const result = await pgPool.query(placeholders(sql), params);
    return result.rows;
  }
  return sqliteDb.prepare(sql).all(...params);
}

for (const variable of ["POSTHOG_PROJECT_TOKEN", "POSTHOG_HOST"]) {
  if (!process.env[variable] && process.env.NODE_ENV !== "production") {
    console.warn(`${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`);
  }
}

let posthogLogProvider;
let posthogLogger;

if (posthogProjectToken && posthogHost) {
  try {
    const exporter = new OTLPLogExporter({
      url: `${posthogHost.replace(/\/$/, "")}/i/v1/logs`,
      headers: { Authorization: `Bearer ${posthogProjectToken}` }
    });
    posthogLogProvider = new LoggerProvider({
      resource: resourceFromAttributes({
        "service.name": "helping-hands-landing",
        "deployment.environment": process.env.NODE_ENV || "development"
      }),
      processors: [new BatchLogRecordProcessor(exporter)]
    });
    posthogLogger = posthogLogProvider.getLogger("helping-hands-posthog-logs");
  } catch {
    if (process.env.NODE_ENV !== "production") {
      console.warn("PostHog log exporter initialization failed; application log capture is disabled.");
    }
  }
}

function emitPostHogLog(severityText, body, attributes) {
  try {
    posthogLogger?.emit({ severityText, body, attributes });
  } catch {
    // Log export is best-effort and must not interrupt application work.
  }
}

function flushPostHogLogs() {
  if (!posthogLogProvider) return Promise.resolve();
  return Promise.race([
    posthogLogProvider.shutdown(),
    new Promise(resolve => setTimeout(resolve, 1000))
  ]).catch(() => {});
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void flushPostHogLogs().finally(() => process.exit(0));
  });
}

async function initializeDatabase() {
  if (pgPool) {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id SERIAL PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        session_id TEXT,
        consent INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        session_id TEXT,
        type TEXT NOT NULL,
        page TEXT,
        referrer TEXT,
        viewport TEXT,
        data TEXT,
        ip_hash TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    `);
  } else {
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL UNIQUE,
        session_id TEXT,
        consent INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        type TEXT NOT NULL,
        page TEXT,
        referrer TEXT,
        viewport TEXT,
        data TEXT,
        ip_hash TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
      CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    `);
  }
}

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.get("/api/posthog-config", (req, res) => {
  res.json({
    projectToken: posthogProjectToken,
    host: posthogHost,
    environment: process.env.NODE_ENV || "development"
  });
});
app.use(express.static(__dirname));

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validSessionId(id) {
  return typeof id === "string" && id.length <= 80;
}

function requireDashboardKey(req, res, next) {
  if (req.query.key !== dashboardKey && req.headers["x-dashboard-key"] !== dashboardKey) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function ipHash(req) {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress || "";
  return crypto.createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

app.post("/api/leads", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  if (!validEmail(email)) return res.status(400).json({ error: "Adresă de email invalidă." });
  if (req.body.consent !== true) return res.status(400).json({ error: "Consimțământ necesar." });

  try {
    const sessionId = validSessionId(req.body.sessionId) ? req.body.sessionId : null;
    if (pgPool) {
      await dbRun(`
        INSERT INTO leads (email, session_id, consent)
        VALUES (?, ?, 1)
        ON CONFLICT(email) DO UPDATE SET consent = 1
      `, [email, sessionId]);
    } else {
      await dbRun(`
        INSERT INTO leads (email, session_id, consent)
        VALUES (?, ?, 1)
        ON CONFLICT(email) DO UPDATE SET consent = 1
      `, [email, sessionId]);
    }
    emitPostHogLog("INFO", "Waitlist lead persisted", {
      event: "waitlist_lead_persisted",
      route: "/api/leads",
      consent_received: true,
      status_code: 201
    });
    res.status(201).json({ ok: true });
  } catch (error) {
    console.error("Lead save failed:", error);
    emitPostHogLog("ERROR", "Waitlist lead persistence failed", {
      event: "waitlist_lead_persistence_failed",
      route: "/api/leads",
      status_code: 500
    });
    res.status(500).json({ error: "Nu am putut salva emailul." });
  }
});

app.post("/api/events", async (req, res) => {
  const allowedTypes = new Set(["page_view", "click", "scroll_depth", "session_end", "waitlist_submit", "waitlist_error"]);
  if (!allowedTypes.has(req.body.type)) return res.status(400).json({ error: "Invalid event." });

  try {
    await dbRun(`
      INSERT INTO events (session_id, type, page, referrer, viewport, data, ip_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      validSessionId(req.body.sessionId) ? req.body.sessionId : null,
      req.body.type,
      String(req.body.page || "").slice(0, 500),
      String(req.body.referrer || "").slice(0, 1000),
      String(req.body.viewport || "").slice(0, 30),
      JSON.stringify(req.body.data || {}).slice(0, 4000),
      ipHash(req)
    ]);
    res.status(204).end();
  } catch (error) {
    console.error("Event save failed:", error);
    res.status(500).json({ error: "Nu am putut salva evenimentul." });
  }
});

app.get("/api/admin/stats", requireDashboardKey, async (req, res) => {
  try {
    const [leadCount, sessionCount, pageViews, submissions, clickEvents, scrollEvents, recentLeads, recentEvents] = await Promise.all([
      dbGet("SELECT COUNT(*) AS count FROM leads"),
      dbGet("SELECT COUNT(DISTINCT session_id) AS count FROM events WHERE session_id IS NOT NULL"),
      dbGet("SELECT COUNT(*) AS count FROM events WHERE type = 'page_view'"),
      dbGet("SELECT COUNT(*) AS count FROM events WHERE type = 'waitlist_submit'"),
      dbAll("SELECT data FROM events WHERE type = 'click'"),
      dbAll("SELECT session_id, data FROM events WHERE type = 'scroll_depth'"),
      dbAll("SELECT email, created_at FROM leads ORDER BY id DESC LIMIT 100"),
      dbAll("SELECT type, data, created_at FROM events ORDER BY id DESC LIMIT 100")
    ]);

  const clickCounts = {};
  for (const event of clickEvents) {
    let data = {};
    try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch {}
    const label = data.label || "(fără text)";
    clickCounts[label] = (clickCounts[label] || 0) + 1;
  }
  const topClicks = Object.entries(clickCounts)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  const scrollBySession = {};
  for (const event of scrollEvents) {
    let data = {};
    try { data = typeof event.data === "string" ? JSON.parse(event.data) : event.data; } catch {}
    const percent = Number(data.percent || 0);
    scrollBySession[event.session_id] = Math.max(scrollBySession[event.session_id] || 0, percent);
  }
  const scrollDepth = Object.entries(scrollBySession).map(([session_id, percent]) => ({ session_id, percent }));

    res.json({
      leadCount: Number(leadCount.count),
      sessionCount: Number(sessionCount.count),
      pageViews: Number(pageViews.count),
      submissions: Number(submissions.count),
      topClicks,
      scrollDepth,
      recentLeads,
      recentEvents
    });
  } catch (error) {
    console.error("Admin stats failed:", error);
    res.status(500).json({ error: "Nu am putut încărca statisticile." });
  }
});

app.get("/api/admin/leads.csv", requireDashboardKey, async (req, res) => {
  try {
    const rows = await dbAll("SELECT email, consent, created_at FROM leads ORDER BY id DESC");
    const csv = ["email,consent,created_at"]
      .concat(rows.map(row => `"${row.email}",${row.consent},"${row.created_at}"`))
      .join("\n");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="helping-hands-leads.csv"');
    res.send(csv);
  } catch (error) {
    console.error("Lead CSV export failed:", error);
    res.status(500).send("Nu am putut exporta leadurile.");
  }
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "admin.html"));
});

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Helping Hands running at http://localhost:${port}`);
      console.log(`Dashboard: http://localhost:${port}/admin`);
      emitPostHogLog("INFO", "Helping Hands server started", {
        event: "server_started",
        port,
        environment: process.env.NODE_ENV || "development"
      });
    });
  })
  .catch((error) => {
    console.error("Database initialization failed:", error);
    process.exit(1);
  });
