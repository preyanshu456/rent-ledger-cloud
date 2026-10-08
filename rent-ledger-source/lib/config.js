// Central place for settings read from environment variables. Everything has a
// safe default so the app still runs locally with no configuration at all.
const path = require("path");

const ROOT = path.join(__dirname, "..");

function int(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

function flag(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

const onRailway = Boolean(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);

const config = {
  root: ROOT,
  env: process.env.NODE_ENV || "development",
  isTest: process.env.NODE_ENV === "test",
  isProduction: process.env.NODE_ENV === "production",
  port: int("PORT", 4000, { min: 0, max: 65535 }),
  dataDir: process.env.DATA_DIR || path.join(ROOT, "data"),
  seedDbPath: path.join(ROOT, "data", "db.json"),
  publicDir: path.join(ROOT, "public"),

  // Business dates (this month's bills, "paid on" dates) follow this time zone,
  // not the server clock, which runs in UTC on Railway.
  timeZone: process.env.APP_TIMEZONE || "Asia/Kolkata",

  // Sessions are stored server-side (hashed) and expire after this many days.
  sessionTtlDays: int("SESSION_TTL_DAYS", 30, { min: 1, max: 365 }),
  minPasswordLength: 8,
  maxPasswordLength: 200,

  // Optional: when set, creating the first owner account requires this code.
  ownerSetupCode: process.env.OWNER_SETUP_CODE || "",

  // Tenant invite codes, created by the owner, replace "anyone with the
  // tenant's mobile number can claim the login".
  inviteTtlDays: int("INVITE_TTL_DAYS", 7, { min: 1, max: 90 }),
  inviteMaxAttempts: 5,

  backupKeep: int("BACKUP_KEEP", 30, { min: 1, max: 1000 }),
  backupIntervalHours: int("BACKUP_INTERVAL_HOURS", 24, { min: 1, max: 24 * 30 }),

  // Railway puts the visitor's real IP in X-Real-IP (docs.railway.com,
  // "Specs & Limits"). Elsewhere we use the socket address unless told otherwise.
  clientIpHeader: (process.env.CLIENT_IP_HEADER || (onRailway ? "x-real-ip" : "")).toLowerCase(),

  // Content-Security-Policy starts in report-only mode so it cannot break
  // Razorpay Checkout or fonts. Set CSP_ENFORCE=true once the browser console
  // shows no CSP reports.
  cspEnforce: flag("CSP_ENFORCE", false),

  logLevel: process.env.LOG_LEVEL || (process.env.NODE_ENV === "test" ? "silent" : "info"),
  corsOrigins: (process.env.CORS_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean),
};

// Warnings only — never print secret values.
function configWarnings(env = process.env) {
  const warnings = [];
  const pair = (a, b, label) => {
    if (Boolean(env[a]) !== Boolean(env[b])) warnings.push(`${label}: set both ${a} and ${b}, or neither.`);
  };
  pair("RAZORPAY_KEY_ID", "RAZORPAY_KEY_SECRET", "Razorpay");
  pair("RESEND_API_KEY", "OTP_FROM_EMAIL", "Email (Resend)");
  const twilio = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"].filter((k) => env[k]);
  if (twilio.length && twilio.length < 3) warnings.push("SMS (Twilio): set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER together.");
  if (env.RAZORPAY_KEY_ID) warnings.push("RAZORPAY_KEY_ID is set on the server, but each owner now connects their own Razorpay account in Settings → Online payments. The server keys are only used to finish payments started before that change; remove them once those are done.");
  if (env.SECRETS_KEY && !/^[0-9a-f]{64}$/i.test(env.SECRETS_KEY) && Buffer.from(env.SECRETS_KEY, "base64").length !== 32) warnings.push("SECRETS_KEY must be 32 bytes (64 hex characters or base64).");
  if (env.NODE_ENV === "production" && !env.DATA_DIR) warnings.push("DATA_DIR is not set in production; data will be stored inside the container and lost on redeploy.");
  if (env.OWNER_SETUP_CODE && env.OWNER_SETUP_CODE.length < 8) warnings.push("OWNER_SETUP_CODE is shorter than 8 characters.");
  const aiProvider = String(env.AI_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : "")).toLowerCase();
  if (aiProvider && !["anthropic", "openai"].includes(aiProvider)) warnings.push(`AI_PROVIDER "${aiProvider}" isn't supported (use anthropic or openai); the assistant stays in basic mode.`);
  if (aiProvider && !(env.AI_API_KEY || (aiProvider === "anthropic" && env.ANTHROPIC_API_KEY))) warnings.push("AI: AI_PROVIDER is set but there is no API key (AI_API_KEY); the assistant stays in basic mode.");
  if (aiProvider && !env.AI_MODEL) warnings.push("AI: set AI_MODEL to a model your provider offers; the assistant stays in basic mode until then.");
  if (env.NOTIFY_MODE && !["live", "simulate"].includes(String(env.NOTIFY_MODE).toLowerCase())) warnings.push('NOTIFY_MODE must be "live" or "simulate".');
  if (env.TWILIO_WHATSAPP_FROM && !(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN)) warnings.push("WhatsApp (Twilio): TWILIO_WHATSAPP_FROM needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.");
  try { new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }); } catch { warnings.push(`APP_TIMEZONE "${config.timeZone}" is not a valid time zone.`); }
  return warnings;
}

module.exports = { config, configWarnings };
