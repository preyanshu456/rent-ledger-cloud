// Each owner's own Razorpay account. Tenant payments are created with the
// owner's keys, so the money settles to the bank account that owner linked in
// their Razorpay dashboard. The key secret is stored encrypted and is never
// sent to a browser.
const { config } = require("../lib/config");
const secrets = require("./secrets");

const RAZORPAY_API = "https://api.razorpay.com/v1";
const KEY_ID_RE = /^rzp_(test|live)_[A-Za-z0-9]{6,40}$/;

function modeOf(keyId) {
  const m = KEY_ID_RE.exec(String(keyId || ""));
  return m ? m[1] : null;
}

// Credentials for an organisation, or null when it hasn't connected Razorpay.
function getAccount(db, orgId) {
  const row = db.get("SELECT * FROM org_payment_accounts WHERE org_id = ?", orgId);
  if (!row) return null;
  try {
    return {
      keyId: row.key_id,
      keySecret: secrets.decrypt(config.dataDir, row.key_secret_enc),
      webhookSecret: row.webhook_secret_enc ? secrets.decrypt(config.dataDir, row.webhook_secret_enc) : "",
      mode: row.mode, verifiedAt: row.verified_at, updatedAt: row.updated_at,
    };
  } catch {
    // The encryption key changed (e.g. SECRETS_KEY replaced): treat as not connected.
    return null;
  }
}

function isConnected(db, orgId) {
  return Boolean(getAccount(db, orgId));
}

// What the owner's Settings screen may see. Never includes secrets.
function publicView(db, orgId) {
  const row = db.get("SELECT key_id, mode, verified_at, updated_at, webhook_secret_enc FROM org_payment_accounts WHERE org_id = ?", orgId);
  const usable = row ? isConnected(db, orgId) : false;
  return {
    connected: usable,
    needsReentry: Boolean(row) && !usable,
    keyId: row?.key_id || "",
    mode: row?.mode || "",
    verifiedAt: row?.verified_at || null,
    updatedAt: row?.updated_at || null,
    webhookConfigured: Boolean(row?.webhook_secret_enc),
    webhookPath: `/api/payments/razorpay/webhook/${orgId}`,
  };
}

function saveAccount(db, orgId, userId, { keyId, keySecret, webhookSecret }) {
  const now = db.nowIso();
  const enc = (v) => secrets.encrypt(config.dataDir, v);
  const existing = db.get("SELECT webhook_secret_enc FROM org_payment_accounts WHERE org_id = ?", orgId);
  // An empty webhook field keeps the saved one; "none" is handled by the caller.
  const webhookEnc = webhookSecret === null ? null : webhookSecret ? enc(webhookSecret) : existing?.webhook_secret_enc || null;
  db.run(`INSERT INTO org_payment_accounts (org_id, provider, key_id, key_secret_enc, webhook_secret_enc, mode, verified_at, updated_by, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(org_id) DO UPDATE SET key_id = excluded.key_id, key_secret_enc = excluded.key_secret_enc, webhook_secret_enc = excluded.webhook_secret_enc,
            mode = excluded.mode, verified_at = excluded.verified_at, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    orgId, "razorpay", keyId, enc(keySecret), webhookEnc, modeOf(keyId), now, userId, now, now);
}

function removeAccount(db, orgId) {
  db.run("DELETE FROM org_payment_accounts WHERE org_id = ?", orgId);
}

async function razorpayRequest(creds, method, pathname, body, fetchImpl = fetch) {
  const authHeader = Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString("base64");
  const response = await fetchImpl(`${RAZORPAY_API}${pathname}`, {
    method, headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.description || `Razorpay request failed (${response.status})`), { razorpayStatus: response.status });
  return data;
}

// Checks keys with a harmless read-only call before saving them.
async function checkKeys(creds, fetchImpl = fetch) {
  try {
    await razorpayRequest(creds, "GET", "/orders?count=1", null, fetchImpl);
    return { ok: true };
  } catch (err) {
    if (err.razorpayStatus === 401) return { ok: false, error: "Razorpay rejected these keys. Copy the Key ID and Key Secret again (as one pair) from Razorpay → Account & Settings → API Keys." };
    return { ok: false, error: `Could not reach Razorpay to check the keys (${err.message}). Please try again.` };
  }
}

// Old orders (created before owners had their own keys) were made with the
// server-wide keys; keep checking those with the same keys.
function legacyCreds() {
  return process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
    ? { keyId: process.env.RAZORPAY_KEY_ID, keySecret: process.env.RAZORPAY_KEY_SECRET, webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || "" }
    : null;
}

// The account that created an order. Keys regenerated in the same Razorpay
// account still work, so fall back to the owner's current keys.
function credsForOrder(db, order) {
  const acct = getAccount(db, order.org_id);
  const legacy = legacyCreds();
  if (order.key_id) {
    if (acct && acct.keyId === order.key_id) return acct;
    if (legacy && legacy.keyId === order.key_id) return legacy;
    return acct;
  }
  return legacy || acct;
}

module.exports = { KEY_ID_RE, modeOf, getAccount, isConnected, publicView, saveAccount, removeAccount, razorpayRequest, checkKeys, credsForOrder, legacyCreds };
