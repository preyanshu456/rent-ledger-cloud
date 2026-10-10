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

// UPI IDs are case-insensitive; apps and banks store them in lower case.
function normaliseVpa(value) {
  const v = String(value || "").trim().toLowerCase();
  return VPA_RE.test(v) ? v : "";
}

// Finds a UPI ID inside the free-text "How to pay" box, e.g. "UPI: me@okaxis".
// Email addresses (anything with a dot after the @, like a@gmail.com) are
// skipped: UPI handles never contain a dot.
function vpaFromText(text) {
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = VPA_IN_TEXT_RE.exec(line);
    if (m && VPA_RE.test(m[1])) return m[1].toLowerCase();
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
  // First of these that still has something left after cleaning (a name
  // written only in Devanagari, say, cleans to nothing).
  const name = [s.payeeName, ownerName, org.name].map((v) => cleanText(v, 50)).find(Boolean) || "Owner";
  return { vpa, name, source: fromSetting ? "setting" : "payment_details" };
}

// UPI apps are picky about the name and note: keep them short, plain ASCII
// (letters, digits, space and . , - /). Accents are dropped; other scripts
// (e.g. Devanagari) are removed, and callers fall back to a plain default.
function cleanText(value, max) {
  return String(value || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9 .,\-/]/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

// Unique, alphanumeric payment reference. It is shown in the UPI note (not
// sent as "tr", see buildUri) and stored with the request.
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

// Longest note we send. NPCI allows more, but several apps cut or reject long
// notes; 50 characters keeps the reference visible everywhere.
const NOTE_MAX = 50;

// upi://pay?pa=…&pn=…&am=…&cu=INR&tn=…  (NPCI UPI linking specification).
//
// This is a person-to-person payment to the owner's own UPI ID, so the link
// carries only the person-to-person fields. Merchant-only fields are left out
// on purpose:
//   tr  (transaction reference) is "mandatory for merchant transactions"; on a
//       payment to a personal UPI ID it makes the request look like an unsigned
//       merchant request, which UPI apps decline under their risk policy.
//   mc, tid, url, mode, orgid, sign: merchant code / PSP-generated id / signed
//       merchant intents. A landlord is not a merchant, so none of them apply.
// Our own reference (RL…) goes at the end of the note instead, where it shows
// in both people's UPI history so the owner can match the payment.
// "@" is kept as is in the UPI ID because some apps don't decode %40.
function buildUri({ vpa, name, amountPaise, note }) {
  const pa = normaliseVpa(vpa);
  if (!pa) throw new Error("Invalid UPI ID");
  const enc = (v) => encodeURIComponent(v);
  const params = [
    `pa=${enc(pa).replace(/%40/g, "@")}`,
    `pn=${enc(cleanText(name, 50) || "Owner")}`,
    `am=${formatAmount(amountPaise)}`,
    "cu=INR",
  ];
  const tn = cleanText(note, NOTE_MAX);
  if (tn) params.push(`tn=${enc(tn)}`);
  return `upi://pay?${params.join("&")}`;
}

// "ab***@okaxis": enough to spot a typo in logs without printing the full UPI ID.
function maskVpa(vpa) {
  const [handle, psp] = String(vpa || "").split("@");
  if (!psp) return "invalid";
  return `${handle.slice(0, 2)}***@${psp}`;
}

// What a link contains, for diagnostic logs: parameter names, amount, currency,
// note length and the masked UPI ID. No full UPI ID, no tenant details, and
// nothing about the tenant's bank (Rent Ledger never sees PINs or accounts).
function describeUri(uri) {
  const out = { scheme: "", params: [], payee: "invalid", payeeHandle: "", amount: "", currency: "", nameLength: 0, noteLength: 0, merchantFields: [] };
  const m = /^([a-z]+):\/\/pay\?(.*)$/i.exec(String(uri || ""));
  if (!m) return out;
  out.scheme = m[1];
  const fields = {};
  for (const kv of m[2].split("&")) {
    const i = kv.indexOf("=");
    const key = i < 0 ? kv : kv.slice(0, i);
    let value = i < 0 ? "" : kv.slice(i + 1);
    try { value = decodeURIComponent(value); } catch { value = "[bad encoding]"; }
    out.params.push(key);
    fields[key] = value;
  }
  out.payee = maskVpa(fields.pa);
  out.payeeHandle = String(fields.pa || "").split("@")[1] || "";
  out.amount = fields.am || "";
  out.currency = fields.cu || "";
  out.nameLength = (fields.pn || "").length;
  out.noteLength = (fields.tn || "").length;
  out.merchantFields = out.params.filter((k) => ["tr", "mc", "tid", "url", "mode", "orgid", "sign", "purpose"].includes(k));
  return out;
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

module.exports = { VPA_RE, NOTE_MAX, normaliseVpa, vpaFromText, payeeFor, newReference, formatAmount, buildUri, describeUri, maskVpa, qrSvg, cleanText };
