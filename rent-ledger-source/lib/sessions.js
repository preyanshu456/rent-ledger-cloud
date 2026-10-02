// Server-side sessions stored in the database, so a deploy or restart no longer
// signs everyone out. Only a SHA-256 hash of each token is stored: a copy of
// db.json (or a backup) cannot be used to sign in as anyone.
const crypto = require("crypto");

const TOUCH_INTERVAL_MS = 60 * 60 * 1000; // record activity at most hourly

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(header.trim());
  return match ? match[1] : "";
}

function pruneExpired(db, now = Date.now()) {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => Date.parse(s.expiresAt) > now);
  return before - db.sessions.length;
}

function createSession(db, userId, { ttlDays, now = Date.now(), meta = {} }) {
  const token = crypto.randomBytes(32).toString("base64url");
  pruneExpired(db, now);
  db.sessions.push({
    id: crypto.randomUUID(),
    tokenHash: hashToken(token),
    userId,
    createdAt: new Date(now).toISOString(),
    lastSeenAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
    userAgent: String(meta.userAgent || "").slice(0, 160),
  });
  return token;
}

function findSession(db, token, now = Date.now()) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const session = db.sessions.find((s) => s.tokenHash === tokenHash);
  if (!session || Date.parse(session.expiresAt) <= now) return null;
  return session;
}

// Returns true when lastSeenAt was updated (so the caller should save).
function touchSession(session, now = Date.now()) {
  if (now - Date.parse(session.lastSeenAt || 0) < TOUCH_INTERVAL_MS) return false;
  session.lastSeenAt = new Date(now).toISOString();
  return true;
}

function revokeToken(db, token) {
  const tokenHash = hashToken(token);
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
  return before !== db.sessions.length;
}

function revokeUserSessions(db, userIds) {
  const ids = new Set(userIds);
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => !ids.has(s.userId));
  return before - db.sessions.length;
}

module.exports = { hashToken, bearerToken, createSession, findSession, touchSession, revokeToken, revokeUserSessions, pruneExpired };
