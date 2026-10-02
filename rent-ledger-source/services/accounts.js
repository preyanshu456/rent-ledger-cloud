// Users, organisations and their settings.
const crypto = require("crypto");
const { config } = require("../lib/config");

function digitsOnly(value) { return String(value || "").replace(/\D/g, ""); }

// One canonical key per login, so "98765 43210", "+91 9876543210" and
// "9876543210" are the same account, and emails are case-insensitive.
function contactKey(contact) {
  const value = String(contact || "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("@")) return `e:${value}`;
  const digits = digitsOnly(value);
  if (digits.length >= 10) return `p:${digits.slice(-10)}`;
  return `r:${value}`;
}

function sameMobile(a, b) {
  const x = digitsOnly(a), y = digitsOnly(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.length >= 10 && y.length >= 10 && x.slice(-10) === y.slice(-10);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  return { password_salt: salt, password_hash: crypto.scryptSync(password, salt, 64).toString("hex") };
}

function safeEqualText(a, b) {
  const x = Buffer.from(String(a || ""), "utf8");
  const y = Buffer.from(String(b || ""), "utf8");
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validPassword(user, password) {
  if (typeof password !== "string" || !password || password.length > config.maxPasswordLength) return false;
  // Accounts created before scrypt hold an unsalted SHA-256 hash; upgraded on next login.
  if (!user.password_salt) return safeEqualText(user.password_hash, crypto.createHash("sha256").update(password).digest("hex"));
  const candidate = crypto.scryptSync(password, user.password_salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(user.password_hash, "hex"));
}

function passwordProblem(password) {
  if (typeof password !== "string" || password.length < config.minPasswordLength) return `Use a password of at least ${config.minPasswordLength} characters.`;
  if (password.length > config.maxPasswordLength) return `Use a password of at most ${config.maxPasswordLength} characters.`;
  return "";
}

function findUserByContact(db, contact) {
  const key = contactKey(contact);
  if (!key) return null;
  return db.get("SELECT * FROM users WHERE contact_key = ? AND disabled_at IS NULL", key)
    || db.get("SELECT * FROM users WHERE email <> '' AND lower(email) = lower(?) AND disabled_at IS NULL", String(contact).trim());
}

function safeUser(user) {
  return { id: user.id, name: user.name, role: user.role, tenantId: user.tenant_id || null, orgId: user.org_id || null, language: user.language || "en" };
}

// ---------- organisations ----------

const DEFAULT_SETTINGS = {
  reminders: {
    enabled: false,             // automatic sending is off until the owner turns it on
    requireApproval: true,      // drafts wait for the owner's approval
    upcomingDaysBefore: 3,
    onDueDate: true,
    overdueEveryDays: 3,
    overdueMaxCount: 3,
    leaseExpiryDays: [60, 30],
    channels: ["inapp"],
  },
  retention: { anonymizeFormerTenantsAfterDays: 0 }, // 0 = keep until removed by hand
  receipts: { footer: "" },
  // The AI model is off until the owner turns it on (and a key is configured).
  assistant: { aiEnabled: false },
};

function mergeSettings(stored) {
  const s = typeof stored === "string" ? JSON.parse(stored || "{}") : (stored || {});
  return {
    reminders: { ...DEFAULT_SETTINGS.reminders, ...(s.reminders || {}) },
    retention: { ...DEFAULT_SETTINGS.retention, ...(s.retention || {}) },
    receipts: { ...DEFAULT_SETTINGS.receipts, ...(s.receipts || {}) },
    assistant: { ...DEFAULT_SETTINGS.assistant, ...(s.assistant || {}) },
  };
}

function getOrg(db, orgId) {
  const org = db.get("SELECT * FROM organizations WHERE id = ?", orgId);
  if (!org) return null;
  return { ...org, settings: mergeSettings(org.settings_json) };
}

const DEFAULT_AUTHORITIES = [
  { name: "Uttar Pradesh Power Corporation Limited (UPPCL)", billUrl: "" },
  { name: "Noida Power Company Limited (NPCL)", billUrl: "" },
  { name: "Maharashtra State Electricity Distribution Company Limited (MSEDCL / Mahavitran)", billUrl: "" },
  { name: "Tata Power Delhi Distribution Limited (TPDDL)", billUrl: "" },
  { name: "BSES Rajdhani Power Limited (BRPL)", billUrl: "" },
  { name: "BSES Yamuna Power Limited (BYPL)", billUrl: "" },
  { name: "Punjab State Power Corporation Limited (PSPCL)", billUrl: "" },
  { name: "Dakshin Haryana Bijli Vitran Nigam (DHBVN)", billUrl: "" },
  { name: "Uttar Haryana Bijli Vitran Nigam (UHBVN)", billUrl: "" },
  { name: "Kerala State Electricity Board Limited (KSEBL)", billUrl: "" },
  { name: "Bangalore Electricity Supply Company Limited (BESCOM)", billUrl: "" },
  { name: "Indraprastha Gas Limited (IGL)", billUrl: "https://www.iglonline.net/electronic-payment" },
  { name: "Mahanagar Gas Limited (MGL)", billUrl: "https://www.mahanagargas.com/quick-bill-pay" },
  { name: "Maharashtra Natural Gas Limited (MNGL)", billUrl: "https://mngl.in/pay-bill" },
];

// Adds the starter list of billing authorities; never touches existing ones.
function seedAuthorities(db, orgId) {
  for (const a of DEFAULT_AUTHORITIES) {
    const existing = db.get("SELECT id, bill_url FROM authorities WHERE org_id = ? AND name = ? COLLATE NOCASE", orgId, a.name);
    if (!existing) db.run("INSERT INTO authorities (id, org_id, name, bill_url, created_at) VALUES (?,?,?,?,?)", db.id(), orgId, a.name, a.billUrl, db.nowIso());
    else if (a.billUrl && !existing.bill_url) db.run("UPDATE authorities SET bill_url = ? WHERE id = ?", a.billUrl, existing.id);
  }
}

function createOrg(db, { name, timeZone = config.timeZone, language = "en" }) {
  const id = db.id();
  db.run("INSERT INTO organizations (id, name, time_zone, default_language, settings_json, created_at) VALUES (?,?,?,?,?,?)",
    id, String(name || "My properties").slice(0, 120), timeZone, language === "hi" ? "hi" : "en", JSON.stringify({}), db.nowIso());
  seedAuthorities(db, id);
  return id;
}

module.exports = {
  contactKey, sameMobile, digitsOnly, hashPassword, validPassword, passwordProblem, safeEqualText, findUserByContact, safeUser,
  DEFAULT_SETTINGS, mergeSettings, getOrg, createOrg, seedAuthorities,
};
