// Rent Ledger server: assembles the app from route modules.
//   node server.js   -> starts the server (Railway runs this)
//   require(...)     -> tests create the app without listening
const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Local development: read settings from a .env file next to this file.
// Railway sets them as service variables instead; tests never read .env.
const ENV_FILE = path.join(__dirname, ".env");
if (process.env.NODE_ENV !== "test" && fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === "function") process.loadEnvFile(ENV_FILE);

const { config, configWarnings } = require("./lib/config");
const log = require("./lib/log");
const v = require("./lib/validate");
const { openDatabase } = require("./lib/db");
const { localDate } = require("./lib/dates");
const { securityHeaders, cors, clientIp, requestContext, createRateLimiter } = require("./lib/security");
const { createDocumentStore } = require("./services/documents");
const { importLegacyJson } = require("./services/importer");
const { createAuth, orgTimeZone } = require("./routes/common");

// Requests that work without signing in.
const PUBLIC_API = new Set([
  "/api/auth/signup", "/api/auth/login", "/api/auth/logout", "/api/auth/request-password-reset", "/api/auth/reset-password",
]);
// The only API paths a tenant account may reach (everything else is staff-only).
const TENANT_ALLOWED = [
  /^\/api\/tenant\//, /^\/api\/account\//, /^\/api\/auth\//, /^\/api\/receipts\/[^/]+$/, /^\/api\/documents\/[^/]+\/file$/,
  /^\/api\/notifications(\/|$)/, /^\/api\/ledger\/payments\/[^/]+\/receipt$/,
];
// Routes that accept large JSON bodies (base64 uploads, CSV statements). They
// authenticate before the body is read.
const LARGE_BODY_PATHS = [
  /^\/api\/tenant\/(rent|electricity|gas)\/[^/]+\/receipt$/, /^\/api\/documents$/, /^\/api\/tenant\/maintenance(\/[^/]+\/attachments)?$/,
  /^\/api\/maintenance\/[^/]+\/attachments$/, /^\/api\/reconciliation\/imports$/, /^\/api\/leases\/extract$/, /^\/api\/leases\/[^/]+\/documents$/,
];

function createServer({ dataDir = config.dataDir } = {}) {
  const db = openDatabase({ dataDir, backupKeep: config.backupKeep, backupIntervalHours: config.backupIntervalHours, log });
  const docs = createDocumentStore(dataDir);
  const app = express();
  app.disable("x-powered-by");

  const todayFor = (req) => localDate(req?.orgId ? orgTimeZone(db, req.orgId) : config.timeZone);
  const jsonSmall = express.json({ limit: "100kb" });
  const jsonLarge = express.json({ limit: "15mb" });
  const limits = {
    loginPerIp: createRateLimiter({ windowMs: 15 * 60_000, max: 100 }),
    loginFailuresPerContact: createRateLimiter({ windowMs: 15 * 60_000, max: 10 }),
    signupPerIp: createRateLimiter({ windowMs: 60 * 60_000, max: 20 }),
    resetPerIp: createRateLimiter({ windowMs: 60 * 60_000, max: 20 }),
    assistantPerUser: createRateLimiter({ windowMs: 60 * 60_000, max: 60 }),
  };
  const ipOf = (req) => clientIp(req, config.clientIpHeader);
  const contactLimitKey = (value) => String(value || "").trim().toLowerCase().slice(0, 200);
  const auth = createAuth(db);

  app.use(requestContext());
  app.use(securityHeaders({ cspEnforce: config.cspEnforce }));
  // The Android and iPhone apps load their screens from inside the app
  // (capacitor://localhost on iPhone, https://localhost on Android) and call
  // this server. They sign in with a token, never a cookie.
  app.use(cors([...config.corsOrigins, ...NATIVE_APP_ORIGINS]));
  app.use((req, res, next) => (req.method !== "GET" && LARGE_BODY_PATHS.some((r) => r.test(req.path)) ? next() : jsonSmall(req, res, next)));

  // Health check for Railway: the database answers and the data folder is writable.
  app.get("/health", (req, res) => {
    try {
      db.get("SELECT 1 AS ok");
      fs.accessSync(dataDir, fs.constants.W_OK);
      res.json({ status: "ok", uptimeSeconds: Math.round(process.uptime()) });
    } catch (error) {
      log.error("health check failed", { error });
      res.status(503).json({ status: "error" });
    }
  });

  app.use(express.static(path.join(__dirname, "public")));

  // Everything under /api needs a signed-in user, except the public paths.
  const isPublic = (p) => PUBLIC_API.has(p);
  app.use("/api", (req, res, next) => (isPublic(req.baseUrl + req.path) ? next() : auth(req, res, next)));
  // Defence in depth: tenant accounts can only reach their own portal routes.
  app.use("/api", (req, res, next) => {
    if (req.user?.role === "tenant" && !TENANT_ALLOWED.some((r) => r.test(req.baseUrl + req.path))) return res.status(403).json({ error: "Owner account required" });
    next();
  });
  // Large bodies are parsed only now, after authentication.
  app.use((req, res, next) => (req.method !== "GET" && LARGE_BODY_PATHS.some((r) => r.test(req.path)) ? jsonLarge(req, res, next) : next()));

  const deps = { db, docs, config, log, limits, ipOf, contactLimitKey, auth, todayFor, jsonLarge };
  for (const name of ["auth", "properties", "tenants", "bills", "portal", "payments", "dashboard", "team", "platform-admin", ...OPTIONAL_MODULES]) {
    require(`./routes/${name}`).register(app, deps);
  }

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

  // One place that turns errors into safe JSON. Details go to the log only.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ error: "This request is too large." });
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request could not be read." });
    if (err instanceof v.ValidationError) return res.status(400).json({ error: err.message });
    if (err.expose && err.status && !err.type) return res.status(err.status).json({ error: err.message });
    if (/UNIQUE constraint failed: tenants\.room_id/.test(err.message)) return res.status(409).json({ error: "This room already has an active tenant." });
    if (/UNIQUE constraint failed: leases\.tenant_id/.test(err.message)) return res.status(409).json({ error: "This tenant already has an active lease." });
    if (/FOREIGN KEY constraint failed/.test(err.message)) return res.status(409).json({ error: "This record is linked to other records and can't be changed this way." });
    log.error("unhandled error", { requestId: req.id, method: req.method, path: req.path, error: err });
    if (res.headersSent) return;
    res.status(500).json({ error: "Something went wrong. Please try again.", requestId: req.id });
  });

  return { app, db, docs, limits, dataDir };
}

// Modules added stage by stage; each registers its own routes.
const NATIVE_APP_ORIGINS = ["capacitor://localhost", "https://localhost", "http://localhost"];
const OPTIONAL_MODULES = ["ledger", "leases", "reconciliation", "documents", "notifications", "maintenance", "expenses", "finance", "insights", "tenancy", "assistant"]
  .filter((name) => fs.existsSync(path.join(__dirname, "routes", `${name}.js`)));

function start({ port = config.port } = {}) {
  for (const warning of configWarnings()) log.warn("configuration", { warning });
  const server = createServer();
  const { db, app, dataDir } = server;
  // First start after the SQLite upgrade: bring the old db.json across (verified).
  const result = importLegacyJson(db, { dataDir, log, today: localDate(config.timeZone) });
  if (result.status === "imported") log.info("legacy data imported", { bills: result.bills, tenants: result.tenants });
  const backupName = db.backup("startup");
  const jobs = fs.existsSync(path.join(__dirname, "services", "jobs.js")) ? require("./services/jobs").startJobs(server, { log }) : null;
  const listener = app.listen(port, "0.0.0.0", () => {
    log.info("server started", { port: listener.address().port, dataDir, timeZone: config.timeZone, backup: backupName });
    if (!config.isProduction && !config.isTest) {
      const addresses = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
      console.log(`Rent Ledger on this computer: http://localhost:${listener.address().port}`);
      addresses.forEach((address) => console.log(`Open on phone or another computer: http://${address}:${listener.address().port}`));
    }
  });
  // Railway sends SIGTERM before replacing the container: finish open requests first.
  const shutdown = (signal) => {
    log.info("shutting down", { signal });
    jobs?.stop();
    listener.close(() => { db.close(); process.exit(0); });
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { ...server, listener, jobs };
}

if (require.main === module) {
  try { start(); } catch (err) {
    log.error("server failed to start", { error: err });
    process.exit(1);
  }
}

module.exports = { createServer, start };
