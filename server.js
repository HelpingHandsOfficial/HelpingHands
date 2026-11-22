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
app.get(["/", "/index.html"], (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get(["/LOGO.png", "/mesteri.png"], (req, res) => {
  res.sendFile(path.join(__dirname, path.basename(req.path)));
});
app.get("/vendor/posthog.js", (req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "posthog-js", "dist", "array.full.js"));
});
app.get("/api/posthog-config", (req, res) => {
  res.json({
    projectToken: posthogProjectToken,
    host: posthogHost,
    environment: process.env.NODE_ENV || "development"
  });
});

function validEmail(email) {
  return typeof email === "string" && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validSessionId(id) {
  return typeof id === "string" && id.length <= 80;
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

initializeDatabase()
  .then(() => {
    app.listen(port, () => {
      console.log(`Helping Hands running at http://localhost:${port}`);
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
