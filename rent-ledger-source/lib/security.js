// HTTP hardening without extra dependencies: security headers, CORS allowlist,
// request IDs with access logging, a client-IP helper and an in-memory rate
// limiter (fine for a single Railway instance; see README for limits).
const crypto = require("crypto");
const log = require("./log");

const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  // The UI sets many inline style="" attributes, so inline styles stay allowed.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "frame-src 'none'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

function securityHeaders({ cspEnforce }) {
  return (req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader(cspEnforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", CSP_DIRECTIVES);
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=15552000");
    }
    if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
    next();
  };
}

// Browser clients use the same origin. A native wrapper can be allowed
// explicitly with CORS_ORIGINS (unchanged behaviour from before).
function cors(allowedOrigins) {
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  };
}

function clientIp(req, header) {
  if (header) {
    const value = String(req.headers[header] || "").split(",")[0].trim();
    if (value) return value.slice(0, 64);
  }
  return String(req.socket?.remoteAddress || "unknown");
}

function requestContext() {
  return (req, res, next) => {
    const incoming = String(req.headers["x-railway-request-id"] || "");
    req.id = /^[A-Za-z0-9_-]{8,80}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader("X-Request-Id", req.id);
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      // Static files are not logged unless they fail; API calls always are.
      if (!req.path.startsWith("/api/") && res.statusCode < 400) return;
      const ms = Number((process.hrtime.bigint() - started) / 1_000_000n);
      const level = res.statusCode >= 500 ? "error" : "info";
      log[level]("request", { requestId: req.id, method: req.method, path: req.path, status: res.statusCode, ms, userId: req.user?.id });
    });
    next();
  };
}

// Fixed-window counter keyed by any string (IP, contact, ...).
function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  function prune(now) {
    for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
  }
  return {
    hit(key, now = Date.now()) {
      if (hits.size > 5000) prune(now);
      let entry = hits.get(key);
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowMs };
        hits.set(key, entry);
      }
      entry.count += 1;
      return { allowed: entry.count <= max, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
    },
    peek(key, now = Date.now()) {
      const entry = hits.get(key);
      return Boolean(entry && entry.resetAt > now && entry.count >= max);
    },
    reset(key) { hits.delete(key); },
    clear() { hits.clear(); },
  };
}

function tooMany(res, retryAfterSeconds, message) {
  res.setHeader("Retry-After", String(retryAfterSeconds));
  const minutes = Math.ceil(retryAfterSeconds / 60);
  return res.status(429).json({ error: message || `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
}

module.exports = { securityHeaders, cors, clientIp, requestContext, createRateLimiter, tooMany, CSP_DIRECTIVES };
