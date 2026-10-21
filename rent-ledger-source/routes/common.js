// Shared route helpers: who is signed in, what they may do, and request context.
const sessionsLib = require("../lib/sessions");
const { localDate } = require("../lib/dates");
const { config } = require("../lib/config");

// What each role may do. Owners may do everything in their organisation.
// Managers run day-to-day operations but can't change money history
// (reversals, voids, waivers), settle deposits, export data, see the audit
// log, delete properties or manage the team.
const MANAGER_PERMISSIONS = new Set([
  "properties.manage", "tenants.manage", "leases.manage", "bills.manage", "payments.record", "reconciliation.manage",
  "maintenance.manage", "expenses.manage", "reports.view", "reminders.manage", "assistant.use", "documents.manage", "hostel.manage",
]);
function can(user, permission) {
  if (!user) return false;
  if (user.role === "owner") return true;
  if (user.role === "manager") return MANAGER_PERMISSIONS.has(permission);
  return false;
}
function permissionsFor(user) {
  if (user.role === "owner") return ["*"];
  if (user.role === "manager") return [...MANAGER_PERMISSIONS];
  return [];
}

const SESSION_COOKIE = "rl_session";

function readCookie(req, name) {
  const header = String(req.headers.cookie || "");
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function isHttps(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req, res, token) {
  const maxAge = config.sessionTtlDays * 86400;
  res.append("Set-Cookie", `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`);
}
function clearSessionCookie(req, res) {
  res.append("Set-Cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${isHttps(req) ? "; Secure" : ""}`);
}

// Requests authenticated by cookie must come from this site (CSRF protection):
// browsers send Origin on POST/PUT/DELETE; a forged cross-site form can't fake it.
function sameOrigin(req) {
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  const source = req.headers.origin || req.headers.referer || "";
  if (!source) return false;
  try {
    const url = new URL(source);
    return url.host === req.headers.host || config.corsOrigins.includes(url.origin);
  } catch { return false; }
}

function createAuth(db) {
  return function auth(req, res, next) {
    let token = sessionsLib.bearerToken(req);
    let viaCookie = false;
    if (!token) {
      const cookie = readCookie(req, SESSION_COOKIE);
      if (/^[A-Za-z0-9_-]{20,200}$/.test(cookie)) { token = cookie; viaCookie = true; }
    }
    if (!token) return res.status(401).json({ error: "Please sign in to continue" });
    const session = db.get("SELECT * FROM sessions WHERE token_hash = ?", sessionsLib.hashToken(token));
    if (!session || Date.parse(session.expires_at) <= Date.now()) return res.status(401).json({ error: "Please sign in to continue" });
    const user = db.get("SELECT * FROM users WHERE id = ? AND disabled_at IS NULL", session.user_id);
    if (!user) return res.status(401).json({ error: "Please sign in to continue" });
    if (viaCookie && !["GET", "HEAD", "OPTIONS"].includes(req.method) && !sameOrigin(req)) {
      return res.status(403).json({ error: "This request came from another site and was blocked." });
    }
    if (Date.now() - Date.parse(session.last_seen_at || 0) > 3_600_000) db.run("UPDATE sessions SET last_seen_at = ? WHERE id = ?", new Date().toISOString(), session.id);
    req.user = user;
    req.sessionToken = token;
    req.orgId = user.org_id;
    next();
  };
}

const staffOnly = (req, res, next) => (["owner", "manager"].includes(req.user?.role) ? next() : res.status(403).json({ error: "Owner account required" }));
const ownerOnly = (req, res, next) => (req.user?.role === "owner" ? next() : res.status(403).json({ error: "Only the owner can do this." }));
const tenantOnly = (req, res, next) => (req.user?.role === "tenant" ? next() : res.status(403).json({ error: "Tenant account required" }));
const requirePermission = (permission) => (req, res, next) => (can(req.user, permission) ? next() : res.status(403).json({ error: "Your role doesn't allow this. Ask the owner." }));

function ctxOf(req) {
  return { orgId: req.orgId, userId: req.user?.id || null, role: req.user?.role || null, requestId: req.id };
}

function orgTimeZone(db, orgId) {
  return db.get("SELECT time_zone FROM organizations WHERE id = ?", orgId)?.time_zone || config.timeZone;
}
function todayFor(db, req) {
  return localDate(req.orgId ? orgTimeZone(db, req.orgId) : config.timeZone);
}

function notFound(res, what) { return res.status(404).json({ error: `${what} not found` }); }

// Errors thrown by services with `expose` carry a safe message and status.
function sendError(res, err) {
  return res.status(err.status || 400).json({ error: err.message });
}

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  // Prevent spreadsheet formula injection from user-entered text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
function sendCsv(res, fileName, header, rows) {
  const lines = [header.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  res.setHeader("Content-Disposition", `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
  res.type("text/csv; charset=utf-8").send("﻿" + lines.join("\r\n"));
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// A minimal, printable HTML page (Print → Save as PDF in any browser).
function printablePage(title, bodyHtml) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d2b;max-width:820px;margin:32px auto;padding:0 20px}h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:24px 0 8px}
.muted{color:#5b5b70}table{width:100%;border-collapse:collapse;margin:8px 0}th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f4f4f8}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.total td{font-weight:600;border-top:2px solid #1d1d2b}.badge{display:inline-block;padding:1px 8px;border-radius:10px;background:#eef;font-size:12px}
.print{margin:16px 0}@media print{.print{display:none}body{margin:0}}</style></head><body><p class="print muted">Use your browser’s Print option to print this or save it as a PDF.</p>${bodyHtml}</body></html>`;
}

module.exports = {
  can, permissionsFor, createAuth, staffOnly, ownerOnly, tenantOnly, requirePermission, ctxOf, todayFor, orgTimeZone, notFound, sendError,
  setSessionCookie, clearSessionCookie, readCookie, SESSION_COOKIE, sendCsv, csvEscape, escapeHtml, printablePage,
};
