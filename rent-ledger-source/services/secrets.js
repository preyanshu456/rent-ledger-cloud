// Encrypts small secrets (each owner's Razorpay key secret) before they are
// stored in the database, so a copy of the database or a backup alone does not
// reveal them.
//
// The encryption key comes from SECRETS_KEY (32 bytes, as 64 hex characters or
// base64). Without it, a random key is created once in DATA_DIR/secrets.key
// (readable only by the server) and reused. Database backups don't include
// that file. If the key is lost, owners simply enter their Razorpay keys again.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

let cached = null;

function parseKey(raw) {
  const text = String(raw || "").trim();
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, "hex");
  try {
    const b = Buffer.from(text, "base64");
    if (b.length === 32) return b;
  } catch { /* not base64 */ }
  return null;
}

function loadKey(dataDir) {
  if (cached && cached.dir === dataDir) return cached.key;
  let key = process.env.SECRETS_KEY ? parseKey(process.env.SECRETS_KEY) : null;
  if (process.env.SECRETS_KEY && !key) throw new Error("SECRETS_KEY must be 32 bytes (64 hex characters or base64).");
  if (!key) {
    const file = path.join(dataDir, "secrets.key");
    if (fs.existsSync(file)) key = parseKey(fs.readFileSync(file, "utf8"));
    if (!key) {
      key = crypto.randomBytes(32);
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, key.toString("hex"), { mode: 0o600 });
    }
  }
  cached = { dir: dataDir, key };
  return key;
}

// "v1:<iv>:<tag>:<ciphertext>", all base64. AES-256-GCM.
function encrypt(dataDir, plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(dataDir), iv);
  const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(":");
}

function decrypt(dataDir, stored) {
  const [v, iv, tag, enc] = String(stored || "").split(":");
  if (v !== "v1" || !iv || !tag || enc === undefined) throw new Error("Unreadable stored secret");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(dataDir), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(enc, "base64")), decipher.final()]).toString("utf8");
}

function resetCache() { cached = null; }

module.exports = { encrypt, decrypt, resetCache };
