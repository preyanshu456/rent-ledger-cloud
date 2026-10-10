// UPI Intent payments. The tenant's UPI app (Google Pay, PhonePe, Paytm, BHIM,
// any bank app) pays the owner's own UPI ID directly. Rent Ledger only builds
// the payment link; it never touches the money.
//
// Everything that ends up in the link (recipient, amount, reference) is worked
// out here on the server from the database. Nothing comes from the browser.
//
// There is no automatic confirmation in this phase: opening the UPI app, or the
// tenant coming back to the site, does NOT mean the money arrived. Initiations
// stay "pending" (unverified) until the owner records the payment themselves.
const crypto = require("crypto");
const qrcode = require("qrcode-generator");
const { getOrg } = require("./accounts");

// A VPA ("UPI ID") is handle@psp: e.g. asha.verma@okaxis, 9876543210@ybl.
// The handle after "@" never has a dot, which also keeps email addresses out.
const VPA_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9-]{1,63}$/;
const VPA_IN_TEXT_RE = /(?:^|[\s:,;(])([a-zA-Z0-9][a-zA-Z0-9._-]{1,255}@[a-zA-Z][a-zA-Z0-9-]{1,63})(?=$|[\s,;)])/;

function normaliseVpa(value) {
  const v = String(value || "").trim();
  return VPA_RE.test(v) ? v : "";
}

// Finds a UPI ID inside the free-text "How to pay" box, e.g. "UPI: me@okaxis".
// Email addresses (anything with a dot after the @, like a@gmail.com) are
// skipped: UPI handles never contain a dot.
function vpaFromText(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = VPA_IN_TEXT_RE.exec(line);
    if (m && VPA_RE.test(m[1])) return m[1];
  }
  return "";
}

// The UPI ID tenants of this organisation pay into. The dedicated setting
// (Settings → UPI payments) wins; otherwise the UPI ID the owner already wrote
// in "How to pay" is used, so existing owners don't have to type it again.
function payeeFor(db, orgId) {
  const org = getOrg(db, orgId);
  if (!org) return null;
  const s = org.settings.payments || {};
  const fromSetting = normaliseVpa(s.upiId);
  const vpa = fromSetting || vpaFromText(org.settings.bills?.paymentDetails);
  if (!vpa) return null;
  const ownerName = db.get("SELECT name FROM users WHERE org_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", orgId)?.name;
  const name = cleanText(s.payeeName || ownerName || org.name || "Owner", 50);
  return { vpa, name, source: fromSetting ? "setting" : "payment_details" };
}

// UPI apps are picky about the note: keep it short and plain.
function cleanText(value, max) {
  return String(value || "").normalize("NFKC").replace(/[^\p{L}\p{N} .,\-/]/gu, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// Unique, alphanumeric transaction reference (UPI "tr", at most 35 chars).
function newReference() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(12);
  let out = "RL";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out; // e.g. RL7KQ2M9XW4HTB3P
}

function formatAmount(paise) {
  if (!Number.isInteger(paise) || paise <= 0) throw new Error("Invalid amount");
  return `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

// upi://pay?pa=…&pn=…&am=…&cu=INR&tr=…&tn=…  (NPCI UPI linking specification).
// "@" is kept as is in the UPI ID because some apps don't decode %40.
function buildUri({ vpa, name, amountPaise, reference, note }) {
  if (!VPA_RE.test(vpa)) throw new Error("Invalid UPI ID");
  const enc = (v) => encodeURIComponent(v);
  const params = [
    `pa=${enc(vpa).replace(/%40/g, "@")}`,
    `pn=${enc(cleanText(name, 50) || "Owner")}`,
    `am=${formatAmount(amountPaise)}`,
    "cu=INR",
    `tr=${enc(reference)}`,
    `tn=${enc(cleanText(note, 80))}`,
  ];
  return `upi://pay?${params.join("&")}`;
}

function qrSvg(text) {
  const qr = qrcode(0, "M");
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 4;
  const size = n + quiet * 2;
  let path = "";
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="UPI QR code"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

module.exports = { VPA_RE, normaliseVpa, vpaFromText, payeeFor, newReference, formatAmount, buildUri, qrSvg, cleanText };
