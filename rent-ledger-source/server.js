const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

// Local development: read settings such as RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET
// from a .env file next to this file, if there is one. Railway sets them as
// service variables instead. Anything already set in the environment wins.
const ENV_FILE = path.join(__dirname, ".env");
if (fs.existsSync(ENV_FILE) && typeof process.loadEnvFile === "function") process.loadEnvFile(ENV_FILE);

const app = express();
const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const SEED_DB_PATH = path.join(__dirname, "data", "db.json");
const RECEIPTS_DIR = path.join(DATA_DIR, "receipts");

// Receipt images and PDFs are sent as base64 JSON so this deployment needs no
// separate multipart-upload dependency.  The server still limits decoded files
// to 10 MB below.
// rawBody is kept so Razorpay webhook signatures can be checked against the
// exact bytes Razorpay sent (re-serialising the parsed JSON would not match).
app.use(express.json({ limit: '15mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
// Browser clients use the same HTTPS origin in production. A native mobile wrapper can
// be allowed explicitly with CORS_ORIGINS, rather than exposing the API to every origin.
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed = (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (origin && allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));

// ---------- tiny JSON-file datastore ----------

function emptyDb() {
  return {
    users: [],
    buildings: [],
    rooms: [],
    tenants: [],
    rentEntries: [],
    electricityEntries: [],
    gasEntries: [],
    passwordResetOtps: [],
    authorities: [],
    payments: [],
  };
}

const sessions = new Map();
const RECEIPT_TYPES = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['application/pdf', '.pdf'],
]);
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function validPassword(user, password) {
  // Existing local users are upgraded after their next successful login.
  if (!user.passwordSalt) return user.passwordHash === crypto.createHash('sha256').update(password).digest('hex');
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function safeUser(user) { return { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId || null }; }
function contactMatches(user, contact) {
  const value = String(contact || '').trim().toLowerCase();
  return String(user.contact || '').trim().toLowerCase() === value || String(user.email || '').trim().toLowerCase() === value;
}
function revokeSessions(userIds) {
  const ids = new Set(userIds);
  for (const [token, userId] of sessions) if (ids.has(userId)) sessions.delete(token);
}
function removeTenantAccounts(db, tenantIds) {
  const ids = new Set(tenantIds);
  const userIds = (db.users || []).filter((user) => ids.has(user.tenantId)).map((user) => user.id);
  db.users = (db.users || []).filter((user) => !ids.has(user.tenantId));
  revokeSessions(userIds);
  return userIds.length;
}
function clearTenantIdentity(tenant) {
  // Keep the tenancy and financial history, but remove contact and identity details.
  tenant.mobile = '';
  tenant.altMobile = '';
  tenant.email = '';
  tenant.idProofNumber = '';
}
function removeReceiptFile(receipt) {
  if (!receipt?.fileName) return;
  const filePath = path.join(RECEIPTS_DIR, path.basename(receipt.fileName));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
function removeEntryReceipts(entries) { entries.forEach((entry) => removeReceiptFile(entry.receipt)); }
function validReceiptSignature(mimeType, bytes) {
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
}
function decodeReceiptPayload(payload) {
  const { data, mimeType, originalName } = payload || {};
  if (!RECEIPT_TYPES.has(mimeType) || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || !validReceiptSignature(mimeType, bytes)) return null;
  return { bytes, mimeType, originalName: path.basename(String(originalName || 'payment-proof')).slice(0, 120) };
}
function otpHash(otp) { return crypto.createHash('sha256').update(String(otp)).digest('hex'); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function normalizeSmsNumber(value) {
  const raw = String(value || '').replace(/[\s()\-.]/g, '');
  if (raw.startsWith('+')) return raw;
  // Rent Ledger is configured for India by default. Set DEFAULT_PHONE_COUNTRY_CODE
  // in Railway to change this for another country.
  if (/^[6-9]\d{9}$/.test(raw)) return `+${process.env.DEFAULT_PHONE_COUNTRY_CODE || '91'}${raw}`;
  return raw;
}
async function sendPasswordResetOtp(user, otp) {
  // Route strictly by what the account's contact actually is, rather than by
  // which provider happens to have variables set. Previously an email-contact
  // account could fall through to the Twilio branch and try to "text" the
  // email address, which always failed.
  const email = isEmail(user.email) ? user.email : (isEmail(user.contact) ? user.contact : '');
  if (email) {
    if (!process.env.RESEND_API_KEY || !process.env.OTP_FROM_EMAIL) {
      throw new Error('Email delivery is not configured. Add RESEND_API_KEY and OTP_FROM_EMAIL in Railway.');
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL,
        to: [email],
        subject: 'Your Rent Ledger password reset code',
        text: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset email');
    return 'email';
  }
  const phone = normalizeSmsNumber(user.contact);
  if (/^\+\d{8,15}$/.test(phone)) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
      throw new Error('SMS delivery is not configured. Add Twilio variables in Railway.');
    }
    const authHeader = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_FROM_NUMBER,
        Body: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset SMS');
    return 'sms';
  }
  throw new Error('Password reset delivery is not configured for this account.');
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = sessions.get(token);
  const user = loadDb().users?.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue' });
  req.user = user; next();
}

// ---------- Login / role accounts ----------
app.post('/api/auth/signup', (req, res) => {
  const db = loadDb();
  db.users = db.users || [];
  const { name, contact, password, role } = req.body;
  if (!name || !contact || !password || !['owner', 'tenant'].includes(role)) return res.status(400).json({ error: 'Name, contact, password and role are required' });
  if (db.users.some(u => contactMatches(u, contact))) return res.status(409).json({ error: 'An account with this contact already exists' });
  if (role === 'owner' && db.users.some(u => u.role === 'owner')) return res.status(403).json({ error: 'Owner accounts are created during initial setup only' });
  let tenantId = null;
  if (role === 'tenant') {
    const tenant = db.tenants.find(t => t.active && String(t.mobile || '').replace(/\D/g, '') === String(contact).replace(/\D/g, ''));
    if (!tenant) return res.status(400).json({ error: 'This mobile number is not linked to an active tenant record. Ask your owner to add you first.' });
    tenantId = tenant.id;
  }
  const user = { id: id(), name, contact, ...hashPassword(password), role, tenantId, createdAt: new Date().toISOString() };
  db.users.push(user); saveDb(db);
  const token = id(); sessions.set(token, user.id);
  res.status(201).json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const db = loadDb(); const { contact, password } = req.body;
  const user = (db.users || []).find(u => contactMatches(u, contact) && validPassword(u, password || ''));
  if (!user) return res.status(401).json({ error: 'Incorrect contact or password' });
  if (!user.passwordSalt) Object.assign(user, hashPassword(password));
  saveDb(db);
  const token = id(); sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/request-password-reset', async (req, res) => {
  const db = loadDb();
  db.passwordResetOtps = (db.passwordResetOtps || []).filter((record) => new Date(record.expiresAt).getTime() > Date.now());
  const user = (db.users || []).find((candidate) => contactMatches(candidate, req.body.contact));
  // This response deliberately does not reveal whether an account exists.
  const message = 'If an account matches those details, a one-time code has been sent.';
  if (!user) { saveDb(db); return res.json({ message }); }
  const recent = db.passwordResetOtps.find((record) => record.userId === user.id && Date.now() - new Date(record.createdAt).getTime() < 60_000);
  if (recent) return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
  const otp = crypto.randomInt(100000, 1000000).toString();
  try {
    const delivery = await sendPasswordResetOtp(user, otp);
    db.passwordResetOtps = db.passwordResetOtps.filter((record) => record.userId !== user.id);
    db.passwordResetOtps.push({ userId: user.id, otpHash: otpHash(otp), attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    saveDb(db);
    res.json({ message, delivery });
  } catch (error) {
    saveDb(db);
    res.status(503).json({ error: error.message || 'Unable to send a reset code right now.' });
  }
});

app.post('/api/auth/reset-password', (req, res) => {
  const { contact, otp, password } = req.body;
  if (!contact || !otp || !password || String(password).length < 4) return res.status(400).json({ error: 'Contact, 6-digit code and a password of at least 4 characters are required.' });
  const db = loadDb();
  const user = (db.users || []).find((candidate) => contactMatches(candidate, contact));
  const record = user && (db.passwordResetOtps || []).find((candidate) => candidate.userId === user.id);
  if (!record || new Date(record.expiresAt).getTime() <= Date.now() || record.attempts >= 5) return res.status(400).json({ error: 'This code is invalid or expired. Request a new code.' });
  if (!crypto.timingSafeEqual(Buffer.from(record.otpHash, 'hex'), Buffer.from(otpHash(otp), 'hex'))) {
    record.attempts += 1;
    saveDb(db);
    return res.status(400).json({ error: 'This code is invalid or expired. Request a new code.' });
  }
  Object.assign(user, hashPassword(password));
  db.passwordResetOtps = db.passwordResetOtps.filter((candidate) => candidate !== record);
  revokeSessions([user.id]);
  saveDb(db);
  res.json({ message: 'Password reset. Please sign in with your new password.' });
});

// Password hashes are deliberately never returned.  The profile endpoint exposes
// the account and tenancy information that each signed-in person is entitled to
// see, and the password endpoint requires the current password to be verified.
app.get('/api/account/profile', auth, (req, res) => {
  const db = loadDb();
  const user = db.users.find((candidate) => candidate.id === req.user.id);
  const account = { id: user.id, name: user.name, contact: user.contact, role: user.role, createdAt: user.createdAt };
  if (user.role === 'owner') {
    const buildings = db.buildings.map((building) => {
      const rooms = db.rooms.filter((room) => room.buildingId === building.id);
      return { id: building.id, name: building.name, address: building.address || '', totalFloors: building.totalFloors || 0, rooms: rooms.length, occupiedRooms: rooms.filter((room) => room.status === 'occupied').length };
    });
    return res.json({ account, buildings });
  }
  const tenant = db.tenants.find((candidate) => candidate.id === user.tenantId && candidate.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find((candidate) => candidate.id === tenant.roomId);
  const building = db.buildings.find((candidate) => candidate.id === room?.buildingId);
  res.json({ account, tenant: { name: tenant.name, mobile: tenant.mobile || '', altMobile: tenant.altMobile || '', email: tenant.email || '', idProofType: tenant.idProofType || '', moveInDate: tenant.moveInDate || '', deposit: tenant.deposit || 0 }, home: { buildingName: building?.name || '', buildingAddress: building?.address || '', roomLabel: room?.label || '', floorNumber: room?.floorNumber || '', monthlyRent: room?.monthlyRent || 0 } });
});

app.put('/api/account/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Enter your current password and a new password of at least 4 characters.' });
  const db = loadDb();
  const user = db.users.find((candidate) => candidate.id === req.user.id);
  if (!user || !validPassword(user, currentPassword)) return res.status(400).json({ error: 'Your current password is incorrect.' });
  Object.assign(user, hashPassword(newPassword));
  revokeSessions([user.id]);
  saveDb(db);
  res.json({ message: 'Password updated. Please sign in again.' });
});

app.get('/api/tenant/portal', auth, (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  const db = loadDb(); const tenant = db.tenants.find(t => t.id === req.user.tenantId && t.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find(r => r.id === tenant.roomId);
  const building = db.buildings.find(b => b.id === room?.buildingId);
  const rent = db.rentEntries.filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  const electricity = db.electricityEntries.filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  const gas = (db.gasEntries || []).filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  res.json({ tenant: { name: tenant.name }, room: { label: room.label, floorNumber: room.floorNumber, monthlyRent: room.monthlyRent, gasMeterId: room.gasMeterId || '', gasAuthorityId: room.gasAuthorityId || null }, building: { name: building?.name || '' }, rent, electricity, gas, payments: { enabled: razorpayConfigured() } });
});

function uploadTenantReceipt(entryCollection) {
  return (req, res) => {
    if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
    const db = loadDb();
    const entry = db[entryCollection].find((candidate) => candidate.id === req.params.id);
    if (!entry || entry.tenantId !== req.user.tenantId) return res.status(404).json({ error: 'This bill is not available for your tenancy.' });
    const upload = decodeReceiptPayload(req.body);
    if (!upload) return res.status(400).json({ error: 'Upload a valid JPG, PNG, WEBP image or PDF receipt up to 10 MB.' });
    const fileName = `${crypto.randomUUID()}${RECEIPT_TYPES.get(upload.mimeType)}`;
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECEIPTS_DIR, fileName), upload.bytes, { flag: 'wx' });
    removeReceiptFile(entry.receipt);
    entry.receipt = {
      id: id(),
      fileName,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.bytes.length,
      uploadedAt: new Date().toISOString(),
    };
    saveDb(db);
    res.status(201).json({ receipt: entry.receipt });
  };
}

app.post('/api/tenant/rent/:id/receipt', auth, uploadTenantReceipt('rentEntries'));
app.post('/api/tenant/electricity/:id/receipt', auth, uploadTenantReceipt('electricityEntries'));
app.post('/api/tenant/gas/:id/receipt', auth, uploadTenantReceipt('gasEntries'));

app.get('/api/receipts/:receiptId', auth, (req, res) => {
  const db = loadDb();
  const entry = [...db.rentEntries, ...db.electricityEntries, ...(db.gasEntries || [])].find((candidate) => candidate.receipt?.id === req.params.receiptId);
  if (!entry || (req.user.role === 'tenant' && entry.tenantId !== req.user.tenantId)) return res.status(404).json({ error: 'Receipt not found' });
  if (req.user.role !== 'owner' && req.user.role !== 'tenant') return res.status(403).json({ error: 'Access denied' });
  const receipt = entry.receipt;
  const receiptPath = path.join(RECEIPTS_DIR, path.basename(receipt.fileName));
  if (!fs.existsSync(receiptPath)) return res.status(404).json({ error: 'Receipt file is unavailable' });
  res.type(receipt.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${receipt.originalName.replace(/["\\]/g, '')}"`);
  res.sendFile(receiptPath);
});

// ---------- Online payments (Razorpay) ----------
// Tenants pay pending rent / electricity / gas bills through Razorpay Checkout.
// Money settles into the Razorpay account whose keys are configured here — i.e.
// the owner's Razorpay account and the bank account linked to it. Amounts are
// always worked out on the server from the stored bills; the browser only says
// *which* bills to pay, never how much.
const RAZORPAY_API = 'https://api.razorpay.com/v1';
const PAYABLE_COLLECTIONS = { rent: 'rentEntries', electricity: 'electricityEntries', gas: 'gasEntries' };
const PAYABLE_LABELS = { rent: 'Rent', electricity: 'Electricity', gas: 'Gas' };
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function razorpayRequest(method, pathname, body) {
  const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`${RAZORPAY_API}${pathname}`, {
    method,
    headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(data?.error?.description || `Razorpay request failed (${response.status})`), { razorpayStatus: response.status });
  }
  return data;
}

function outstandingAmount(kind, entry) {
  if (!entry || entry.status === 'paid') return 0;
  if (kind === 'rent') return round2(Math.max((Number(entry.rentAmount) || 0) - (Number(entry.amountPaid) || 0), 0));
  return round2(entry.amount);
}

function safeEqualText(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Marks every bill covered by a payment as paid. Called from both the browser
// callback and the webhook, so it only ever applies a payment once.
function applyPayment(db, payment, razorpayPaymentId, method) {
  if (!payment || payment.status === 'paid') return false;
  const paidAt = new Date().toISOString();
  const paidDate = paidAt.slice(0, 10);
  for (const item of payment.items) {
    const entry = (db[PAYABLE_COLLECTIONS[item.kind]] || []).find((candidate) => candidate.id === item.entryId);
    if (!entry) { item.result = 'bill-deleted'; continue; }
    if (entry.status === 'paid') { item.result = 'already-paid'; continue; }
    if (item.kind === 'rent') {
      const due = Number(entry.rentAmount) || 0;
      entry.amountPaid = round2(Math.min(due, (Number(entry.amountPaid) || 0) + item.amount));
      entry.status = entry.amountPaid <= 0 ? 'due' : entry.amountPaid < due ? 'partial' : 'paid';
    } else {
      entry.status = 'paid';
    }
    entry.paidDate = paidDate;
    entry.onlinePayment = { provider: 'razorpay', paymentId: razorpayPaymentId, orderId: payment.razorpayOrderId, amount: item.amount, paidAt };
    item.result = 'applied';
  }
  payment.status = 'paid';
  payment.razorpayPaymentId = razorpayPaymentId;
  payment.method = method || '';
  payment.paidAt = paidAt;
  return true;
}

function tenantPayableItems(db, tenant, requested) {
  const items = [];
  const seen = new Set();
  const addItem = (kind, entry) => {
    const key = `${kind}:${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const amount = outstandingAmount(kind, entry);
    if (amount > 0) items.push({ kind, entryId: entry.id, month: entry.month, year: entry.year, amount });
  };
  if (requested === 'all') {
    for (const kind of Object.keys(PAYABLE_COLLECTIONS)) {
      (db[PAYABLE_COLLECTIONS[kind]] || [])
        .filter((entry) => entry.roomId === tenant.roomId && entry.tenantId === tenant.id)
        .forEach((entry) => addItem(kind, entry));
    }
    return items;
  }
  for (const request of requested) {
    const kind = request?.kind;
    if (!PAYABLE_COLLECTIONS[kind]) throw Object.assign(new Error('Unknown bill type.'), { status: 400 });
    const entry = (db[PAYABLE_COLLECTIONS[kind]] || []).find((candidate) => candidate.id === request.id);
    if (!entry || entry.tenantId !== tenant.id || entry.roomId !== tenant.roomId) {
      throw Object.assign(new Error('This bill is not available for your tenancy.'), { status: 404 });
    }
    addItem(kind, entry);
  }
  return items;
}

// Step 1: tenant picks bills → server totals them and opens a Razorpay order.
app.post('/api/tenant/payments/order', auth, async (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  if (!razorpayConfigured()) return res.status(503).json({ error: 'Online payments are not set up yet. Please ask your owner to enable Razorpay.' });
  let db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.user.tenantId && t.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find((r) => r.id === tenant.roomId);
  const building = db.buildings.find((b) => b.id === room?.buildingId);

  let items;
  try {
    items = tenantPayableItems(db, tenant, req.body?.all ? 'all' : (Array.isArray(req.body?.items) ? req.body.items : []));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (!items.length) return res.status(400).json({ error: 'There is nothing pending to pay.' });
  const amount = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const amountPaise = Math.round(amount * 100);
  if (amountPaise < 100) return res.status(400).json({ error: 'Online payments must be at least ₹1.' });

  const payment = {
    id: id(), tenantId: tenant.id, roomId: tenant.roomId, items, amount, currency: 'INR',
    status: 'created', createdAt: new Date().toISOString(),
  };
  const kinds = [...new Set(items.map((item) => PAYABLE_LABELS[item.kind]))].join(', ');
  let order;
  try {
    order = await razorpayRequest('POST', '/orders', {
      amount: amountPaise,
      currency: 'INR',
      receipt: payment.id,
      notes: { paymentId: payment.id, tenant: tenant.name.slice(0, 200), room: String(room?.label || '').slice(0, 200), bills: kinds },
    });
  } catch (err) {
    if (err.razorpayStatus === 401) {
      console.error('Razorpay rejected the API keys — check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
      return res.status(401).json({ error: 'Online payments are misconfigured (Razorpay rejected the API keys). Please tell your owner.' });
    }
    console.error('Razorpay order creation failed:', err.message);
    return res.status(500).json({ error: `Could not start the payment: ${err.message}` });
  }
  payment.razorpayOrderId = order.id;
  // Re-read after the network call so a write made meanwhile isn't overwritten.
  db = loadDb();
  db.payments = db.payments || [];
  db.payments.push(payment);
  saveDb(db);
  res.status(201).json({
    keyId: process.env.RAZORPAY_KEY_ID,
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    name: building?.name || 'Rent Ledger',
    description: `${kinds} · ${room?.label || 'your home'}`,
    prefill: { name: tenant.name, contact: tenant.mobile || '', email: tenant.email || '' },
  });
});

// Step 2: Razorpay Checkout hands the browser a signed result → we check the
// signature, confirm with Razorpay that the money is captured, then mark bills paid.
app.post('/api/tenant/payments/verify', auth, async (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  if (!razorpayConfigured()) return res.status(503).json({ error: 'Online payments are not set up.' });
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) {
    return res.status(400).json({ error: 'Invalid payment details.' });
  }
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqualText(expected, signature)) return res.status(400).json({ error: 'Payment verification failed.' });

  let db = loadDb();
  let payment = (db.payments || []).find((p) => p.razorpayOrderId === orderId);
  if (!payment || payment.tenantId !== req.user.tenantId) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status === 'paid') return res.json({ ok: true, amount: payment.amount, alreadyRecorded: true });

  let razorpayPayment;
  try {
    razorpayPayment = await razorpayRequest('GET', `/payments/${paymentId}`);
    if (razorpayPayment.order_id !== orderId) throw new Error('payment does not belong to this order');
    if (Number(razorpayPayment.amount) !== Math.round(payment.amount * 100)) throw new Error('amount mismatch');
    // Accounts set to manual capture leave payments "authorized" — capture them here.
    if (razorpayPayment.status === 'authorized') {
      razorpayPayment = await razorpayRequest('POST', `/payments/${paymentId}/capture`, { amount: razorpayPayment.amount, currency: razorpayPayment.currency });
    }
    if (razorpayPayment.status !== 'captured') throw new Error(`payment status is "${razorpayPayment.status}"`);
  } catch (err) {
    return res.status(502).json({ error: `We could not confirm this payment yet (${err.message}). If money was deducted, share payment ID ${paymentId} with your owner.` });
  }

  db = loadDb();
  payment = (db.payments || []).find((p) => p.razorpayOrderId === orderId);
  if (applyPayment(db, payment, paymentId, razorpayPayment.method)) saveDb(db);
  res.json({ ok: true, amount: payment.amount, items: payment.items });
});

// Backup path: if the tenant closes the page right after paying, Razorpay's
// webhook still tells us. Optional — only active when RAZORPAY_WEBHOOK_SECRET is set.
app.post('/api/payments/razorpay/webhook', (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook is not configured.' });
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!safeEqualText(expected, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'Invalid signature.' });
  const event = req.body?.event;
  const entity = req.body?.payload?.payment?.entity;
  if ((event === 'payment.captured' || event === 'order.paid') && entity?.order_id && entity.status === 'captured') {
    const db = loadDb();
    const payment = (db.payments || []).find((p) => p.razorpayOrderId === entity.order_id);
    if (payment && Number(entity.amount) === Math.round(payment.amount * 100) && applyPayment(db, payment, entity.id, entity.method)) saveDb(db);
  }
  res.json({ ok: true });
});

// All management endpoints below are owner-only. Tenant accounts can only read their portal.
app.use('/api', auth, (req, res, next) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner account required' });
  next();
});

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (DB_PATH !== SEED_DB_PATH && fs.existsSync(SEED_DB_PATH)) fs.copyFileSync(SEED_DB_PATH, DB_PATH);
    else fs.writeFileSync(DB_PATH, JSON.stringify(emptyDb(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomUUID();
}

function notFound(res, what) {
  return res.status(404).json({ error: `${what} not found` });
}

// Recompute a room's occupied/vacant status from its active tenants.
function refreshRoomStatus(db, roomId) {
  const room = db.rooms.find((r) => r.id === roomId);
  if (!room) return;
  if (room.electricityOnly) { room.status = "owner"; return; }
  const hasActiveTenant = db.tenants.some((t) => t.roomId === roomId && t.active);
  room.status = hasActiveTenant ? "occupied" : "vacant";
}

// ---------- Buildings ----------

app.get("/api/buildings", (req, res) => {
  const db = loadDb();
  res.json(db.buildings);
});

app.post("/api/buildings", (req, res) => {
  const db = loadDb();
  const { name, address, totalFloors, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const building = {
    id: id(),
    name,
    address: address || "",
    totalFloors: Number(totalFloors) || 0,
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.buildings.push(building);
  saveDb(db);
  res.status(201).json(building);
});

app.put("/api/buildings/:id", (req, res) => {
  const db = loadDb();
  const building = db.buildings.find((b) => b.id === req.params.id);
  if (!building) return notFound(res, "Building");
  Object.assign(building, req.body, { id: building.id });
  if (building.totalFloors !== undefined) building.totalFloors = Number(building.totalFloors) || 0;
  saveDb(db);
  res.json(building);
});

// A floor is represented by the rooms assigned the same floor number.  This
// updates the default monthly rent for every room on that floor at once.
app.put("/api/buildings/:id/floors/:floorNumber", (req, res) => {
  const db = loadDb();
  if (!db.buildings.find((building) => building.id === req.params.id)) return notFound(res, "Building");
  const floorNumber = Number(req.params.floorNumber);
  const rooms = db.rooms.filter((room) => room.buildingId === req.params.id && Number(room.floorNumber) === floorNumber && !room.electricityOnly);
  if (!rooms.length) return notFound(res, "Floor");
  if (req.body.monthlyRent === undefined || Number(req.body.monthlyRent) < 0) return res.status(400).json({ error: "Enter a valid monthly rent for this floor." });
  const monthlyRent = Number(req.body.monthlyRent);
  rooms.forEach((room) => { room.monthlyRent = monthlyRent; });
  saveDb(db);
  res.json({ floorNumber, monthlyRent, roomsUpdated: rooms.length });
});

// Delete an entire floor, including its rooms, tenancy records, ledgers and any
// stored payment proofs.  The UI asks for explicit confirmation before calling it.
app.delete("/api/buildings/:id/floors/:floorNumber", (req, res) => {
  const db = loadDb();
  if (!db.buildings.find((building) => building.id === req.params.id)) return notFound(res, "Building");
  const floorNumber = Number(req.params.floorNumber);
  const roomIds = db.rooms.filter((room) => room.buildingId === req.params.id && Number(room.floorNumber) === floorNumber).map((room) => room.id);
  if (!roomIds.length) return notFound(res, "Floor");
  const tenantIds = db.tenants.filter((tenant) => roomIds.includes(tenant.roomId)).map((tenant) => tenant.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts(db.electricityEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => roomIds.includes(entry.roomId)));
  db.rooms = db.rooms.filter((room) => !roomIds.includes(room.id));
  db.tenants = db.tenants.filter((tenant) => !roomIds.includes(tenant.roomId));
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((entry) => !roomIds.includes(entry.roomId));
  db.electricityEntries = db.electricityEntries.filter((entry) => !roomIds.includes(entry.roomId));
  db.gasEntries = (db.gasEntries || []).filter((entry) => !roomIds.includes(entry.roomId));
  saveDb(db);
  res.json({ ok: true, floorNumber, roomsDeleted: roomIds.length });
});

app.delete("/api/buildings/:id", (req, res) => {
  const db = loadDb();
  const roomIds = db.rooms.filter((r) => r.buildingId === req.params.id).map((r) => r.id);
  const tenantIds = db.tenants.filter((t) => roomIds.includes(t.roomId)).map((t) => t.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts(db.electricityEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => roomIds.includes(entry.roomId)));
  db.rooms = db.rooms.filter((r) => r.buildingId !== req.params.id);
  db.tenants = db.tenants.filter((t) => !roomIds.includes(t.roomId));
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((e) => !roomIds.includes(e.roomId));
  db.electricityEntries = db.electricityEntries.filter((e) => !roomIds.includes(e.roomId));
  db.gasEntries = (db.gasEntries || []).filter((e) => !roomIds.includes(e.roomId));
  db.buildings = db.buildings.filter((b) => b.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Rooms (floor / room units within a building) ----------

app.get("/api/rooms", (req, res) => {
  const db = loadDb();
  let rooms = db.rooms;
  if (req.query.buildingId) rooms = rooms.filter((r) => r.buildingId === req.query.buildingId);
  res.json(rooms);
});

app.post("/api/rooms", (req, res) => {
  const db = loadDb();
  const { buildingId, floorNumber, label, monthlyRent, deposit, notes, electricityOnly } = req.body;
  if (!buildingId || !label) return res.status(400).json({ error: "buildingId and label are required" });
  if (!db.buildings.find((b) => b.id === buildingId)) return notFound(res, "Building");
  const room = {
    id: id(),
    buildingId,
    floorNumber: Number(floorNumber) || 0,
    label,
    electricityOnly: electricityOnly === true || electricityOnly === 'true',
    monthlyRent: electricityOnly === true || electricityOnly === 'true' ? 0 : Number(monthlyRent) || 0,
    deposit: electricityOnly === true || electricityOnly === 'true' ? 0 : Number(deposit) || 0,
    status: electricityOnly === true || electricityOnly === 'true' ? "owner" : "vacant",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.rooms.push(room);
  saveDb(db);
  res.status(201).json(room);
});

app.put("/api/rooms/:id", (req, res) => {
  const db = loadDb();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  Object.assign(room, req.body, { id: room.id });
  room.electricityOnly = room.electricityOnly === true || room.electricityOnly === 'true';
  if (room.electricityOnly) room.status = 'owner';
  if (room.monthlyRent !== undefined) room.monthlyRent = Number(room.monthlyRent) || 0;
  if (room.deposit !== undefined) room.deposit = Number(room.deposit) || 0;
  if (room.floorNumber !== undefined) room.floorNumber = Number(room.floorNumber) || 0;
  saveDb(db);
  res.json(room);
});

app.delete("/api/rooms/:id", (req, res) => {
  const db = loadDb();
  const tenantIds = db.tenants.filter((t) => t.roomId === req.params.id).map((t) => t.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => entry.roomId === req.params.id));
  removeEntryReceipts(db.electricityEntries.filter((entry) => entry.roomId === req.params.id));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => entry.roomId === req.params.id));
  db.tenants = db.tenants.filter((t) => t.roomId !== req.params.id);
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((e) => e.roomId !== req.params.id);
  db.electricityEntries = db.electricityEntries.filter((e) => e.roomId !== req.params.id);
  db.gasEntries = (db.gasEntries || []).filter((e) => e.roomId !== req.params.id);
  db.rooms = db.rooms.filter((r) => r.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// Link a room to a gas meter ID + billing authority (gas board / supplier). Once
// linked, gas bills for this room are entered by the owner as the amount the
// authority is showing as due for that meter — the app has no live/API access
// into any gas provider's own billing system, so this is an owner-entered
// figure, not an automatic fetch. Past bill entries keep whatever meter/
// authority they were recorded under, even if the room's meter is later
// unlinked or relinked to a different authority.
app.put("/api/rooms/:id/gas-meter", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  const meterId = String(req.body.meterId || "").trim();
  const authority = db.authorities.find((a) => a.id === req.body.authorityId);
  if (!meterId) return res.status(400).json({ error: "Enter a meter ID." });
  if (!authority) return res.status(400).json({ error: "Choose a valid billing authority." });
  room.gasMeterId = meterId;
  room.gasAuthorityId = authority.id;
  saveDb(db);
  res.json(room);
});

app.delete("/api/rooms/:id/gas-meter", (req, res) => {
  const db = loadDb();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  room.gasMeterId = "";
  room.gasAuthorityId = null;
  saveDb(db);
  res.json(room);
});

// ---------- Billing authorities (gas boards, utility companies, etc.) ----------
// A small owner-managed list the gas-meter-linking dropdown is populated from.

app.get("/api/authorities", (req, res) => {
  const db = loadDb();
  res.json((db.authorities || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
});

// The link to an authority's own "view / pay your bill" page, so the owner can
// open it straight from the gas card. Only http(s) links are accepted.
function cleanBillUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { url = null; }
  if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
    throw Object.assign(new Error("Enter a valid website link, e.g. https://www.iglonline.net"), { status: 400 });
  }
  return url.toString();
}

app.post("/api/authorities", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a name for the authority." });
  let billUrl;
  try { billUrl = cleanBillUrl(req.body.billUrl); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  const existing = db.authorities.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.status(200).json(existing);
  const authority = { id: id(), name, billUrl, createdAt: new Date().toISOString() };
  db.authorities.push(authority);
  saveDb(db);
  res.status(201).json(authority);
});

app.put("/api/authorities/:id", (req, res) => {
  const db = loadDb();
  const authority = (db.authorities || []).find((a) => a.id === req.params.id);
  if (!authority) return notFound(res, "Authority");
  if (req.body.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Enter a name for the authority." });
    authority.name = name;
  }
  if (req.body.billUrl !== undefined) {
    try { authority.billUrl = cleanBillUrl(req.body.billUrl); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  }
  saveDb(db);
  res.json(authority);
});

app.delete("/api/authorities/:id", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  if (db.rooms.some((r) => r.gasAuthorityId === req.params.id)) {
    return res.status(409).json({ error: "This authority is linked to a room. Unlink its meter first." });
  }
  db.authorities = db.authorities.filter((a) => a.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Tenants ----------

app.get("/api/tenants", (req, res) => {
  const db = loadDb();
  let tenants = db.tenants;
  if (req.query.roomId) tenants = tenants.filter((t) => t.roomId === req.query.roomId);
  res.json(tenants);
});

app.post("/api/tenants", (req, res) => {
  const db = loadDb();
  const {
    roomId, name, mobile, altMobile, email,
    idProofType, idProofNumber, moveInDate, notes,
  } = req.body;
  if (!roomId || !name || !mobile) {
    return res.status(400).json({ error: "roomId, name and mobile are required" });
  }
  const room = db.rooms.find((r) => r.id === roomId);
  if (!room) return notFound(res, "Room");

  const tenant = {
    id: id(),
    roomId,
    name,
    mobile,
    altMobile: altMobile || "",
    email: email || "",
    idProofType: idProofType || "",
    idProofNumber: idProofNumber || "",
    moveInDate: moveInDate || "",
    moveOutDate: "",
    active: true,
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.tenants.push(tenant);
  refreshRoomStatus(db, roomId);
  saveDb(db);
  res.status(201).json(tenant);
});

app.put("/api/tenants/:id", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  Object.assign(tenant, req.body, { id: tenant.id });
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json(tenant);
});

// Mark tenant as moved out, preserving rent history but removing their login and sensitive identifiers.
app.post("/api/tenants/:id/move-out", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  tenant.active = false;
  tenant.moveOutDate = req.body.moveOutDate || new Date().toISOString().slice(0, 10);
  const removedLoginAccounts = removeTenantAccounts(db, [tenant.id]);
  clearTenantIdentity(tenant);
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json({ ...tenant, removedLoginAccounts, identityCleared: true });
});

app.delete("/api/tenants/:id", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  db.tenants = db.tenants.filter((t) => t.id !== req.params.id);
  removeTenantAccounts(db, [req.params.id]);
  // Keep financial history but detach it from the now-deleted personal record.
  db.rentEntries.forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  db.electricityEntries.forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  (db.gasEntries || []).forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Rent entries ----------

app.get("/api/rent", (req, res) => {
  const db = loadDb();
  let entries = db.rentEntries;
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/rent", (req, res) => {
  const db = loadDb();
  const { roomId, tenantId, month, year, rentAmount, amountPaid, dueDate, paidDate, notes } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, 'Room');
  if (room.electricityOnly) return res.status(400).json({ error: 'Owner electricity-only floors cannot have rent entries.' });
  const paid = Number(amountPaid) || 0;
  const due = Number(rentAmount) || 0;
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    rentAmount: due,
    amountPaid: paid,
    dueDate: dueDate || "",
    paidDate: paidDate || "",
    status: paid <= 0 ? "due" : paid < due ? "partial" : "paid",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.rentEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/rent/:id", (req, res) => {
  const db = loadDb();
  const entry = db.rentEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Rent entry");
  Object.assign(entry, req.body, { id: entry.id });
  entry.rentAmount = Number(entry.rentAmount) || 0;
  entry.amountPaid = Number(entry.amountPaid) || 0;
  entry.status = entry.amountPaid <= 0 ? "due" : entry.amountPaid < entry.rentAmount ? "partial" : "paid";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/rent/:id", (req, res) => {
  const db = loadDb();
  const entry = db.rentEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.rentEntries = db.rentEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Electricity entries ----------

app.get("/api/electricity", (req, res) => {
  const db = loadDb();
  let entries = db.electricityEntries;
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/electricity", (req, res) => {
  const db = loadDb();
  const {
    roomId, tenantId, month, year,
    prevReading, currReading, ratePerUnit,
    paidDate, notes,
  } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, "Room");
  const prev = Number(prevReading) || 0;
  const curr = Number(currReading) || 0;
  const rate = Number(ratePerUnit) || 0;
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    prevReading: prev,
    currReading: curr,
    unitsConsumed: Math.max(curr - prev, 0),
    ratePerUnit: rate,
    amount: Math.round(Math.max(curr - prev, 0) * rate * 100) / 100,
    paidDate: paidDate || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  entry.status = entry.paidDate ? "paid" : "due";
  db.electricityEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/electricity/:id", (req, res) => {
  const db = loadDb();
  const entry = db.electricityEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Electricity entry");
  Object.assign(entry, req.body, { id: entry.id });
  entry.prevReading = Number(entry.prevReading) || 0;
  entry.currReading = Number(entry.currReading) || 0;
  entry.ratePerUnit = Number(entry.ratePerUnit) || 0;
  entry.unitsConsumed = Math.max(entry.currReading - entry.prevReading, 0);
  entry.amount = Math.round(entry.unitsConsumed * entry.ratePerUnit * 100) / 100;
  entry.status = entry.paidDate ? "paid" : "due";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/electricity/:id", (req, res) => {
  const db = loadDb();
  const entry = db.electricityEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.electricityEntries = db.electricityEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Gas entries ----------
// Gas is always billed through a linked meter ID + authority (gas board /
// supplier) — there's no meter-reading mode here. The "amount" on each entry
// is the due amount the owner read off that authority's own bill/portal for
// this meter; the app has no official API access into any gas provider's
// billing system, so this is entered by the owner, not fetched automatically.

app.get("/api/gas", (req, res) => {
  const db = loadDb();
  let entries = db.gasEntries || [];
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/gas", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  db.gasEntries = db.gasEntries || [];
  const { roomId, tenantId, month, year, amount, paidDate, notes } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, "Room");
  if (!room.gasMeterId || !room.gasAuthorityId) {
    return res.status(400).json({ error: "Link this room to a gas meter ID and billing authority first." });
  }
  const authority = db.authorities.find((a) => a.id === room.gasAuthorityId);
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    meterId: room.gasMeterId,
    authorityId: room.gasAuthorityId,
    authorityName: authority ? authority.name : "Unknown authority",
    amount: Math.round((Number(amount) || 0) * 100) / 100,
    paidDate: paidDate || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  entry.status = entry.paidDate ? "paid" : "due";
  db.gasEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/gas/:id", (req, res) => {
  const db = loadDb();
  db.gasEntries = db.gasEntries || [];
  const entry = db.gasEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Gas entry");
  if (req.body.month !== undefined) entry.month = Number(req.body.month);
  if (req.body.year !== undefined) entry.year = Number(req.body.year);
  if (req.body.amount !== undefined) entry.amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
  if (req.body.paidDate !== undefined) entry.paidDate = req.body.paidDate || "";
  if (req.body.notes !== undefined) entry.notes = req.body.notes || "";
  if (req.body.tenantId !== undefined) entry.tenantId = req.body.tenantId || null;
  entry.status = entry.paidDate ? "paid" : "due";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/gas/:id", (req, res) => {
  const db = loadDb();
  db.gasEntries = db.gasEntries || [];
  const entry = db.gasEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.gasEntries = db.gasEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Dashboard summary ----------

app.get("/api/dashboard", (req, res) => {
  const db = loadDb();
  const totalBuildings = db.buildings.length;
  const totalRooms = db.rooms.length;
  const occupiedRooms = db.rooms.filter((r) => r.status === "occupied").length;
  const vacantRooms = totalRooms - occupiedRooms;

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const electricityOnlyRoomIds = new Set(db.rooms.filter((room) => room.electricityOnly).map((room) => room.id));
  const rentThisMonth = db.rentEntries.filter((e) => e.month === month && e.year === year && !electricityOnlyRoomIds.has(e.roomId));
  const rentCollected = rentThisMonth.reduce((s, e) => s + e.amountPaid, 0);
  const rentPending = rentThisMonth.reduce((s, e) => s + Math.max(e.rentAmount - e.amountPaid, 0), 0);

  const elecThisMonth = db.electricityEntries.filter((e) => e.month === month && e.year === year);
  const elecPending = elecThisMonth.filter((e) => e.status !== "paid").reduce((s, e) => s + e.amount, 0);
  const elecCollected = elecThisMonth.filter((e) => e.status === "paid").reduce((s, e) => s + e.amount, 0);

  const gasThisMonth = (db.gasEntries || []).filter((e) => e.month === month && e.year === year);
  const gasPending = gasThisMonth.filter((e) => e.status !== "paid").reduce((s, e) => s + e.amount, 0);
  const gasCollected = gasThisMonth.filter((e) => e.status === "paid").reduce((s, e) => s + e.amount, 0);

  const allDueRent = db.rentEntries.filter((e) => e.status !== "paid" && !electricityOnlyRoomIds.has(e.roomId)).length;
  const allDueElec = db.electricityEntries.filter((e) => e.status !== "paid").length;
  const allDueGas = (db.gasEntries || []).filter((e) => e.status !== "paid").length;

  // Rooms linked to a gas meter that don't have this month's bill entered yet —
  // the owner's to-do list for reading bills off the gas company's site.
  const gasBillsToEnter = db.rooms
    .filter((room) => room.gasMeterId && room.gasAuthorityId)
    .filter((room) => !(db.gasEntries || []).some((e) => e.roomId === room.id && e.month === month && e.year === year))
    .map((room) => {
      const authority = (db.authorities || []).find((a) => a.id === room.gasAuthorityId);
      const building = db.buildings.find((b) => b.id === room.buildingId);
      const tenant = db.tenants.find((t) => t.roomId === room.id && t.active);
      return {
        roomId: room.id,
        roomLabel: room.label,
        buildingName: building?.name || "",
        meterId: room.gasMeterId,
        authorityName: authority?.name || "Unknown authority",
        billUrl: authority?.billUrl || "",
        tenantId: tenant?.id || null,
        tenantName: tenant?.name || "",
      };
    });

  res.json({
    totalBuildings,
    totalRooms,
    occupiedRooms,
    vacantRooms,
    month,
    year,
    rentCollected,
    rentPending,
    elecCollected,
    elecPending,
    gasCollected,
    gasPending,
    outstandingRentEntries: allDueRent,
    outstandingElectricityEntries: allDueElec,
    outstandingGasEntries: allDueGas,
    gasBillsToEnter,
    onlinePaymentsEnabled: razorpayConfigured(),
  });
});

// Owner view of online payments received through Razorpay (most recent first).
app.get("/api/payments", (req, res) => {
  const db = loadDb();
  const payments = (db.payments || [])
    .filter((payment) => payment.status === "paid")
    .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)))
    .slice(0, Number(req.query.limit) || 20)
    .map((payment) => {
      const tenant = db.tenants.find((t) => t.id === payment.tenantId);
      const room = db.rooms.find((r) => r.id === payment.roomId);
      return {
        id: payment.id,
        amount: payment.amount,
        paidAt: payment.paidAt,
        method: payment.method,
        razorpayPaymentId: payment.razorpayPaymentId,
        tenantName: tenant?.name || "Former tenant",
        roomLabel: room?.label || "",
        items: payment.items,
      };
    });
  res.json(payments);
});

// Fallback to the SPA for any non-API route
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- default billing authorities ----------
// Seeds a starter list of Delhi/UP electricity boards into the authorities
// list on boot, so the owner doesn't have to type each one in by hand. Runs
// once at startup; only adds names that aren't already present (case-
// insensitive), so it never duplicates or touches authorities already added
// or renamed by the owner.
const DEFAULT_AUTHORITIES = [
  "Uttar Pradesh Power Corporation Limited (UPPCL)",
  "Noida Power Company Limited (NPCL)",
  "Maharashtra State Electricity Distribution Company Limited (MSEDCL / Mahavitran)",
  "Tata Power Delhi Distribution Limited (TPDDL)",
  "BSES Rajdhani Power Limited (BRPL)",
  "BSES Yamuna Power Limited (BYPL)",
  "Punjab State Power Corporation Limited (PSPCL)",
  "Dakshin Haryana Bijli Vitran Nigam (DHBVN)",
  "Uttar Haryana Bijli Vitran Nigam (UHBVN)",
  "Kerala State Electricity Board Limited (KSEBL)",
  "Bangalore Electricity Supply Company Limited (BESCOM)",
];

// Common piped-gas suppliers, with the official page where a customer views or
// pays their bill. The owner can add others (and their links) from the app.
const DEFAULT_GAS_AUTHORITIES = [
  { name: "Indraprastha Gas Limited (IGL)", billUrl: "https://www.iglonline.net/electronic-payment" },
  { name: "Mahanagar Gas Limited (MGL)", billUrl: "https://www.mahanagargas.com/quick-bill-pay" },
  { name: "Maharashtra Natural Gas Limited (MNGL)", billUrl: "https://mngl.in/pay-bill" },
];

function seedDefaultAuthorities() {
  const db = loadDb();
  db.authorities = db.authorities || [];
  let changed = false;
  const defaults = [...DEFAULT_AUTHORITIES.map((name) => ({ name, billUrl: "" })), ...DEFAULT_GAS_AUTHORITIES];
  for (const { name, billUrl } of defaults) {
    const existing = db.authorities.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      db.authorities.push({ id: id(), name, billUrl, createdAt: new Date().toISOString() });
      changed = true;
    } else if (billUrl && !existing.billUrl) {
      existing.billUrl = billUrl;
      changed = true;
    }
  }
  if (changed) saveDb(db);
}
seedDefaultAuthorities();

app.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(info => info && info.family === 'IPv4' && !info.internal).map(info => info.address);
  console.log(`Rent Ledger on this Mac: http://localhost:${PORT}`);
  addresses.forEach(address => console.log(`Open on phone or another computer: http://${address}:${PORT}`));
});    users: [],
    buildings: [],
    rooms: [],
    tenants: [],
    rentEntries: [],
    electricityEntries: [],
    gasEntries: [],
    passwordResetOtps: [],
    authorities: [],
    payments: [],
  };
}

const sessions = new Map();
const RECEIPT_TYPES = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['application/pdf', '.pdf'],
]);
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(password, salt, 64).toString('hex') };
}
function validPassword(user, password) {
  // Existing local users are upgraded after their next successful login.
  if (!user.passwordSalt) return user.passwordHash === crypto.createHash('sha256').update(password).digest('hex');
  const candidate = crypto.scryptSync(password, user.passwordSalt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(user.passwordHash, 'hex'));
}
function safeUser(user) { return { id: user.id, name: user.name, role: user.role, tenantId: user.tenantId || null }; }
function contactMatches(user, contact) {
  const value = String(contact || '').trim().toLowerCase();
  return String(user.contact || '').trim().toLowerCase() === value || String(user.email || '').trim().toLowerCase() === value;
}
function revokeSessions(userIds) {
  const ids = new Set(userIds);
  for (const [token, userId] of sessions) if (ids.has(userId)) sessions.delete(token);
}
function removeTenantAccounts(db, tenantIds) {
  const ids = new Set(tenantIds);
  const userIds = (db.users || []).filter((user) => ids.has(user.tenantId)).map((user) => user.id);
  db.users = (db.users || []).filter((user) => !ids.has(user.tenantId));
  revokeSessions(userIds);
  return userIds.length;
}
function clearTenantIdentity(tenant) {
  // Keep the tenancy and financial history, but remove contact and identity details.
  tenant.mobile = '';
  tenant.altMobile = '';
  tenant.email = '';
  tenant.idProofNumber = '';
}
function removeReceiptFile(receipt) {
  if (!receipt?.fileName) return;
  const filePath = path.join(RECEIPTS_DIR, path.basename(receipt.fileName));
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
function removeEntryReceipts(entries) { entries.forEach((entry) => removeReceiptFile(entry.receipt)); }
function validReceiptSignature(mimeType, bytes) {
  if (mimeType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === 'image/webp') return bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return mimeType === 'application/pdf' && bytes.subarray(0, 5).toString() === '%PDF-';
}
function decodeReceiptPayload(payload) {
  const { data, mimeType, originalName } = payload || {};
  if (!RECEIPT_TYPES.has(mimeType) || typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || !validReceiptSignature(mimeType, bytes)) return null;
  return { bytes, mimeType, originalName: path.basename(String(originalName || 'payment-proof')).slice(0, 120) };
}
function otpHash(otp) { return crypto.createHash('sha256').update(String(otp)).digest('hex'); }
function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim()); }
function normalizeSmsNumber(value) {
  const raw = String(value || '').replace(/[\s()\-.]/g, '');
  if (raw.startsWith('+')) return raw;
  // Rent Ledger is configured for India by default. Set DEFAULT_PHONE_COUNTRY_CODE
  // in Railway to change this for another country.
  if (/^[6-9]\d{9}$/.test(raw)) return `+${process.env.DEFAULT_PHONE_COUNTRY_CODE || '91'}${raw}`;
  return raw;
}
async function sendPasswordResetOtp(user, otp) {
  // Route strictly by what the account's contact actually is, rather than by
  // which provider happens to have variables set. Previously an email-contact
  // account could fall through to the Twilio branch and try to "text" the
  // email address, which always failed.
  const email = isEmail(user.email) ? user.email : (isEmail(user.contact) ? user.contact : '');
  if (email) {
    if (!process.env.RESEND_API_KEY || !process.env.OTP_FROM_EMAIL) {
      throw new Error('Email delivery is not configured. Add RESEND_API_KEY and OTP_FROM_EMAIL in Railway.');
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL,
        to: [email],
        subject: 'Your Rent Ledger password reset code',
        text: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset email');
    return 'email';
  }
  const phone = normalizeSmsNumber(user.contact);
  if (/^\+\d{8,15}$/.test(phone)) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
      throw new Error('SMS delivery is not configured. Add Twilio variables in Railway.');
    }
    const authHeader = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_FROM_NUMBER,
        Body: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset SMS');
    return 'sms';
  }
  throw new Error('Password reset delivery is not configured for this account.');
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const userId = sessions.get(token);
  const user = loadDb().users?.find(u => u.id === userId);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue' });
  req.user = user; next();
}

// ---------- Login / role accounts ----------
app.post('/api/auth/signup', (req, res) => {
  const db = loadDb();
  db.users = db.users || [];
  const { name, contact, password, role } = req.body;
  if (!name || !contact || !password || !['owner', 'tenant'].includes(role)) return res.status(400).json({ error: 'Name, contact, password and role are required' });
  if (db.users.some(u => contactMatches(u, contact))) return res.status(409).json({ error: 'An account with this contact already exists' });
  if (role === 'owner' && db.users.some(u => u.role === 'owner')) return res.status(403).json({ error: 'Owner accounts are created during initial setup only' });
  let tenantId = null;
  if (role === 'tenant') {
    const tenant = db.tenants.find(t => t.active && String(t.mobile || '').replace(/\D/g, '') === String(contact).replace(/\D/g, ''));
    if (!tenant) return res.status(400).json({ error: 'This mobile number is not linked to an active tenant record. Ask your owner to add you first.' });
    tenantId = tenant.id;
  }
  const user = { id: id(), name, contact, ...hashPassword(password), role, tenantId, createdAt: new Date().toISOString() };
  db.users.push(user); saveDb(db);
  const token = id(); sessions.set(token, user.id);
  res.status(201).json({ token, user: safeUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const db = loadDb(); const { contact, password } = req.body;
  const user = (db.users || []).find(u => contactMatches(u, contact) && validPassword(u, password || ''));
  if (!user) return res.status(401).json({ error: 'Incorrect contact or password' });
  if (!user.passwordSalt) Object.assign(user, hashPassword(password));
  saveDb(db);
  const token = id(); sessions.set(token, user.id);
  res.json({ token, user: safeUser(user) });
});

app.post('/api/auth/request-password-reset', async (req, res) => {
  const db = loadDb();
  db.passwordResetOtps = (db.passwordResetOtps || []).filter((record) => new Date(record.expiresAt).getTime() > Date.now());
  const user = (db.users || []).find((candidate) => contactMatches(candidate, req.body.contact));
  // This response deliberately does not reveal whether an account exists.
  const message = 'If an account matches those details, a one-time code has been sent.';
  if (!user) { saveDb(db); return res.json({ message }); }
  const recent = db.passwordResetOtps.find((record) => record.userId === user.id && Date.now() - new Date(record.createdAt).getTime() < 60_000);
  if (recent) return res.status(429).json({ error: 'Please wait one minute before requesting another code.' });
  const otp = crypto.randomInt(100000, 1000000).toString();
  try {
    const delivery = await sendPasswordResetOtp(user, otp);
    db.passwordResetOtps = db.passwordResetOtps.filter((record) => record.userId !== user.id);
    db.passwordResetOtps.push({ userId: user.id, otpHash: otpHash(otp), attempts: 0, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
    saveDb(db);
    res.json({ message, delivery });
  } catch (error) {
    saveDb(db);
    res.status(503).json({ error: error.message || 'Unable to send a reset code right now.' });
  }
});

app.post('/api/auth/reset-password', (req, res) => {
  const { contact, otp, password } = req.body;
  if (!contact || !otp || !password || String(password).length < 4) return res.status(400).json({ error: 'Contact, 6-digit code and a password of at least 4 characters are required.' });
  const db = loadDb();
  const user = (db.users || []).find((candidate) => contactMatches(candidate, contact));
  const record = user && (db.passwordResetOtps || []).find((candidate) => candidate.userId === user.id);
  if (!record || new Date(record.expiresAt).getTime() <= Date.now() || record.attempts >= 5) return res.status(400).json({ error: 'This code is invalid or expired. Request a new code.' });
  if (!crypto.timingSafeEqual(Buffer.from(record.otpHash, 'hex'), Buffer.from(otpHash(otp), 'hex'))) {
    record.attempts += 1;
    saveDb(db);
    return res.status(400).json({ error: 'This code is invalid or expired. Request a new code.' });
  }
  Object.assign(user, hashPassword(password));
  db.passwordResetOtps = db.passwordResetOtps.filter((candidate) => candidate !== record);
  revokeSessions([user.id]);
  saveDb(db);
  res.json({ message: 'Password reset. Please sign in with your new password.' });
});

// Password hashes are deliberately never returned.  The profile endpoint exposes
// the account and tenancy information that each signed-in person is entitled to
// see, and the password endpoint requires the current password to be verified.
app.get('/api/account/profile', auth, (req, res) => {
  const db = loadDb();
  const user = db.users.find((candidate) => candidate.id === req.user.id);
  const account = { id: user.id, name: user.name, contact: user.contact, role: user.role, createdAt: user.createdAt };
  if (user.role === 'owner') {
    const buildings = db.buildings.map((building) => {
      const rooms = db.rooms.filter((room) => room.buildingId === building.id);
      return { id: building.id, name: building.name, address: building.address || '', totalFloors: building.totalFloors || 0, rooms: rooms.length, occupiedRooms: rooms.filter((room) => room.status === 'occupied').length };
    });
    return res.json({ account, buildings });
  }
  const tenant = db.tenants.find((candidate) => candidate.id === user.tenantId && candidate.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find((candidate) => candidate.id === tenant.roomId);
  const building = db.buildings.find((candidate) => candidate.id === room?.buildingId);
  res.json({ account, tenant: { name: tenant.name, mobile: tenant.mobile || '', altMobile: tenant.altMobile || '', email: tenant.email || '', idProofType: tenant.idProofType || '', moveInDate: tenant.moveInDate || '', deposit: tenant.deposit || 0 }, home: { buildingName: building?.name || '', buildingAddress: building?.address || '', roomLabel: room?.label || '', floorNumber: room?.floorNumber || '', monthlyRent: room?.monthlyRent || 0 } });
});

app.put('/api/account/password', auth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword || String(newPassword).length < 4) return res.status(400).json({ error: 'Enter your current password and a new password of at least 4 characters.' });
  const db = loadDb();
  const user = db.users.find((candidate) => candidate.id === req.user.id);
  if (!user || !validPassword(user, currentPassword)) return res.status(400).json({ error: 'Your current password is incorrect.' });
  Object.assign(user, hashPassword(newPassword));
  revokeSessions([user.id]);
  saveDb(db);
  res.json({ message: 'Password updated. Please sign in again.' });
});

app.get('/api/tenant/portal', auth, (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  const db = loadDb(); const tenant = db.tenants.find(t => t.id === req.user.tenantId && t.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find(r => r.id === tenant.roomId);
  const building = db.buildings.find(b => b.id === room?.buildingId);
  const rent = db.rentEntries.filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  const electricity = db.electricityEntries.filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  const gas = (db.gasEntries || []).filter(e => e.roomId === room.id && e.tenantId === tenant.id).sort((a,b) => b.year-a.year || b.month-a.month);
  res.json({ tenant: { name: tenant.name }, room: { label: room.label, floorNumber: room.floorNumber, monthlyRent: room.monthlyRent, gasMeterId: room.gasMeterId || '', gasAuthorityId: room.gasAuthorityId || null }, building: { name: building?.name || '' }, rent, electricity, gas, payments: { enabled: razorpayConfigured() } });
});

function uploadTenantReceipt(entryCollection) {
  return (req, res) => {
    if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
    const db = loadDb();
    const entry = db[entryCollection].find((candidate) => candidate.id === req.params.id);
    if (!entry || entry.tenantId !== req.user.tenantId) return res.status(404).json({ error: 'This bill is not available for your tenancy.' });
    const upload = decodeReceiptPayload(req.body);
    if (!upload) return res.status(400).json({ error: 'Upload a valid JPG, PNG, WEBP image or PDF receipt up to 10 MB.' });
    const fileName = `${crypto.randomUUID()}${RECEIPT_TYPES.get(upload.mimeType)}`;
    fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RECEIPTS_DIR, fileName), upload.bytes, { flag: 'wx' });
    removeReceiptFile(entry.receipt);
    entry.receipt = {
      id: id(),
      fileName,
      originalName: upload.originalName,
      mimeType: upload.mimeType,
      size: upload.bytes.length,
      uploadedAt: new Date().toISOString(),
    };
    saveDb(db);
    res.status(201).json({ receipt: entry.receipt });
  };
}

app.post('/api/tenant/rent/:id/receipt', auth, uploadTenantReceipt('rentEntries'));
app.post('/api/tenant/electricity/:id/receipt', auth, uploadTenantReceipt('electricityEntries'));
app.post('/api/tenant/gas/:id/receipt', auth, uploadTenantReceipt('gasEntries'));

app.get('/api/receipts/:receiptId', auth, (req, res) => {
  const db = loadDb();
  const entry = [...db.rentEntries, ...db.electricityEntries, ...(db.gasEntries || [])].find((candidate) => candidate.receipt?.id === req.params.receiptId);
  if (!entry || (req.user.role === 'tenant' && entry.tenantId !== req.user.tenantId)) return res.status(404).json({ error: 'Receipt not found' });
  if (req.user.role !== 'owner' && req.user.role !== 'tenant') return res.status(403).json({ error: 'Access denied' });
  const receipt = entry.receipt;
  const receiptPath = path.join(RECEIPTS_DIR, path.basename(receipt.fileName));
  if (!fs.existsSync(receiptPath)) return res.status(404).json({ error: 'Receipt file is unavailable' });
  res.type(receipt.mimeType);
  res.setHeader('Content-Disposition', `inline; filename="${receipt.originalName.replace(/["\\]/g, '')}"`);
  res.sendFile(receiptPath);
});

// ---------- Online payments (Razorpay) ----------
// Tenants pay pending rent / electricity / gas bills through Razorpay Checkout.
// Money settles into the Razorpay account whose keys are configured here — i.e.
// the owner's Razorpay account and the bank account linked to it. Amounts are
// always worked out on the server from the stored bills; the browser only says
// *which* bills to pay, never how much.
const RAZORPAY_API = 'https://api.razorpay.com/v1';
const PAYABLE_COLLECTIONS = { rent: 'rentEntries', electricity: 'electricityEntries', gas: 'gasEntries' };
const PAYABLE_LABELS = { rent: 'Rent', electricity: 'Electricity', gas: 'Gas' };
const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function razorpayRequest(method, pathname, body) {
  const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`${RAZORPAY_API}${pathname}`, {
    method,
    headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.description || `Razorpay request failed (${response.status})`);
  return data;
}

function outstandingAmount(kind, entry) {
  if (!entry || entry.status === 'paid') return 0;
  if (kind === 'rent') return round2(Math.max((Number(entry.rentAmount) || 0) - (Number(entry.amountPaid) || 0), 0));
  return round2(entry.amount);
}

function safeEqualText(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Marks every bill covered by a payment as paid. Called from both the browser
// callback and the webhook, so it only ever applies a payment once.
function applyPayment(db, payment, razorpayPaymentId, method) {
  if (!payment || payment.status === 'paid') return false;
  const paidAt = new Date().toISOString();
  const paidDate = paidAt.slice(0, 10);
  for (const item of payment.items) {
    const entry = (db[PAYABLE_COLLECTIONS[item.kind]] || []).find((candidate) => candidate.id === item.entryId);
    if (!entry) { item.result = 'bill-deleted'; continue; }
    if (entry.status === 'paid') { item.result = 'already-paid'; continue; }
    if (item.kind === 'rent') {
      const due = Number(entry.rentAmount) || 0;
      entry.amountPaid = round2(Math.min(due, (Number(entry.amountPaid) || 0) + item.amount));
      entry.status = entry.amountPaid <= 0 ? 'due' : entry.amountPaid < due ? 'partial' : 'paid';
    } else {
      entry.status = 'paid';
    }
    entry.paidDate = paidDate;
    entry.onlinePayment = { provider: 'razorpay', paymentId: razorpayPaymentId, orderId: payment.razorpayOrderId, amount: item.amount, paidAt };
    item.result = 'applied';
  }
  payment.status = 'paid';
  payment.razorpayPaymentId = razorpayPaymentId;
  payment.method = method || '';
  payment.paidAt = paidAt;
  return true;
}

function tenantPayableItems(db, tenant, requested) {
  const items = [];
  const seen = new Set();
  const addItem = (kind, entry) => {
    const key = `${kind}:${entry.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    const amount = outstandingAmount(kind, entry);
    if (amount > 0) items.push({ kind, entryId: entry.id, month: entry.month, year: entry.year, amount });
  };
  if (requested === 'all') {
    for (const kind of Object.keys(PAYABLE_COLLECTIONS)) {
      (db[PAYABLE_COLLECTIONS[kind]] || [])
        .filter((entry) => entry.roomId === tenant.roomId && entry.tenantId === tenant.id)
        .forEach((entry) => addItem(kind, entry));
    }
    return items;
  }
  for (const request of requested) {
    const kind = request?.kind;
    if (!PAYABLE_COLLECTIONS[kind]) throw Object.assign(new Error('Unknown bill type.'), { status: 400 });
    const entry = (db[PAYABLE_COLLECTIONS[kind]] || []).find((candidate) => candidate.id === request.id);
    if (!entry || entry.tenantId !== tenant.id || entry.roomId !== tenant.roomId) {
      throw Object.assign(new Error('This bill is not available for your tenancy.'), { status: 404 });
    }
    addItem(kind, entry);
  }
  return items;
}

// Step 1: tenant picks bills → server totals them and opens a Razorpay order.
app.post('/api/tenant/payments/order', auth, async (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  if (!razorpayConfigured()) return res.status(503).json({ error: 'Online payments are not set up yet. Please ask your owner to enable Razorpay.' });
  let db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.user.tenantId && t.active);
  if (!tenant) return res.status(404).json({ error: 'No active tenancy found' });
  const room = db.rooms.find((r) => r.id === tenant.roomId);
  const building = db.buildings.find((b) => b.id === room?.buildingId);

  let items;
  try {
    items = tenantPayableItems(db, tenant, req.body?.all ? 'all' : (Array.isArray(req.body?.items) ? req.body.items : []));
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  if (!items.length) return res.status(400).json({ error: 'There is nothing pending to pay.' });
  const amount = round2(items.reduce((sum, item) => sum + item.amount, 0));
  const amountPaise = Math.round(amount * 100);
  if (amountPaise < 100) return res.status(400).json({ error: 'Online payments must be at least ₹1.' });

  const payment = {
    id: id(), tenantId: tenant.id, roomId: tenant.roomId, items, amount, currency: 'INR',
    status: 'created', createdAt: new Date().toISOString(),
  };
  const kinds = [...new Set(items.map((item) => PAYABLE_LABELS[item.kind]))].join(', ');
  let order;
  try {
    order = await razorpayRequest('POST', '/orders', {
      amount: amountPaise,
      currency: 'INR',
      receipt: payment.id,
      notes: { paymentId: payment.id, tenant: tenant.name.slice(0, 200), room: String(room?.label || '').slice(0, 200), bills: kinds },
    });
  } catch (err) {
    return res.status(502).json({ error: `Could not start the payment: ${err.message}` });
  }
  payment.razorpayOrderId = order.id;
  // Re-read after the network call so a write made meanwhile isn't overwritten.
  db = loadDb();
  db.payments = db.payments || [];
  db.payments.push(payment);
  saveDb(db);
  res.status(201).json({
    keyId: process.env.RAZORPAY_KEY_ID,
    orderId: order.id,
    amount: amountPaise,
    currency: 'INR',
    name: building?.name || 'Rent Ledger',
    description: `${kinds} · ${room?.label || 'your home'}`,
    prefill: { name: tenant.name, contact: tenant.mobile || '', email: tenant.email || '' },
  });
});

// Step 2: Razorpay Checkout hands the browser a signed result → we check the
// signature, confirm with Razorpay that the money is captured, then mark bills paid.
app.post('/api/tenant/payments/verify', auth, async (req, res) => {
  if (req.user.role !== 'tenant') return res.status(403).json({ error: 'Tenant account required' });
  if (!razorpayConfigured()) return res.status(503).json({ error: 'Online payments are not set up.' });
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) {
    return res.status(400).json({ error: 'Invalid payment details.' });
  }
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
  if (!safeEqualText(expected, signature)) return res.status(400).json({ error: 'Payment verification failed.' });

  let db = loadDb();
  let payment = (db.payments || []).find((p) => p.razorpayOrderId === orderId);
  if (!payment || payment.tenantId !== req.user.tenantId) return res.status(404).json({ error: 'Payment not found.' });
  if (payment.status === 'paid') return res.json({ ok: true, amount: payment.amount, alreadyRecorded: true });

  let razorpayPayment;
  try {
    razorpayPayment = await razorpayRequest('GET', `/payments/${paymentId}`);
    if (razorpayPayment.order_id !== orderId) throw new Error('payment does not belong to this order');
    if (Number(razorpayPayment.amount) !== Math.round(payment.amount * 100)) throw new Error('amount mismatch');
    // Accounts set to manual capture leave payments "authorized" — capture them here.
    if (razorpayPayment.status === 'authorized') {
      razorpayPayment = await razorpayRequest('POST', `/payments/${paymentId}/capture`, { amount: razorpayPayment.amount, currency: razorpayPayment.currency });
    }
    if (razorpayPayment.status !== 'captured') throw new Error(`payment status is "${razorpayPayment.status}"`);
  } catch (err) {
    return res.status(502).json({ error: `We could not confirm this payment yet (${err.message}). If money was deducted, share payment ID ${paymentId} with your owner.` });
  }

  db = loadDb();
  payment = (db.payments || []).find((p) => p.razorpayOrderId === orderId);
  if (applyPayment(db, payment, paymentId, razorpayPayment.method)) saveDb(db);
  res.json({ ok: true, amount: payment.amount, items: payment.items });
});

// Backup path: if the tenant closes the page right after paying, Razorpay's
// webhook still tells us. Optional — only active when RAZORPAY_WEBHOOK_SECRET is set.
app.post('/api/payments/razorpay/webhook', (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook is not configured.' });
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!safeEqualText(expected, req.headers['x-razorpay-signature'])) return res.status(400).json({ error: 'Invalid signature.' });
  const event = req.body?.event;
  const entity = req.body?.payload?.payment?.entity;
  if ((event === 'payment.captured' || event === 'order.paid') && entity?.order_id && entity.status === 'captured') {
    const db = loadDb();
    const payment = (db.payments || []).find((p) => p.razorpayOrderId === entity.order_id);
    if (payment && Number(entity.amount) === Math.round(payment.amount * 100) && applyPayment(db, payment, entity.id, entity.method)) saveDb(db);
  }
  res.json({ ok: true });
});

// All management endpoints below are owner-only. Tenant accounts can only read their portal.
app.use('/api', auth, (req, res, next) => {
  if (req.user.role !== 'owner') return res.status(403).json({ error: 'Owner account required' });
  next();
});

function loadDb() {
  if (!fs.existsSync(DB_PATH)) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    if (DB_PATH !== SEED_DB_PATH && fs.existsSync(SEED_DB_PATH)) fs.copyFileSync(SEED_DB_PATH, DB_PATH);
    else fs.writeFileSync(DB_PATH, JSON.stringify(emptyDb(), null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_PATH, "utf-8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomUUID();
}

function notFound(res, what) {
  return res.status(404).json({ error: `${what} not found` });
}

// Recompute a room's occupied/vacant status from its active tenants.
function refreshRoomStatus(db, roomId) {
  const room = db.rooms.find((r) => r.id === roomId);
  if (!room) return;
  if (room.electricityOnly) { room.status = "owner"; return; }
  const hasActiveTenant = db.tenants.some((t) => t.roomId === roomId && t.active);
  room.status = hasActiveTenant ? "occupied" : "vacant";
}

// ---------- Buildings ----------

app.get("/api/buildings", (req, res) => {
  const db = loadDb();
  res.json(db.buildings);
});

app.post("/api/buildings", (req, res) => {
  const db = loadDb();
  const { name, address, totalFloors, notes } = req.body;
  if (!name) return res.status(400).json({ error: "name is required" });
  const building = {
    id: id(),
    name,
    address: address || "",
    totalFloors: Number(totalFloors) || 0,
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.buildings.push(building);
  saveDb(db);
  res.status(201).json(building);
});

app.put("/api/buildings/:id", (req, res) => {
  const db = loadDb();
  const building = db.buildings.find((b) => b.id === req.params.id);
  if (!building) return notFound(res, "Building");
  Object.assign(building, req.body, { id: building.id });
  if (building.totalFloors !== undefined) building.totalFloors = Number(building.totalFloors) || 0;
  saveDb(db);
  res.json(building);
});

// A floor is represented by the rooms assigned the same floor number.  This
// updates the default monthly rent for every room on that floor at once.
app.put("/api/buildings/:id/floors/:floorNumber", (req, res) => {
  const db = loadDb();
  if (!db.buildings.find((building) => building.id === req.params.id)) return notFound(res, "Building");
  const floorNumber = Number(req.params.floorNumber);
  const rooms = db.rooms.filter((room) => room.buildingId === req.params.id && Number(room.floorNumber) === floorNumber && !room.electricityOnly);
  if (!rooms.length) return notFound(res, "Floor");
  if (req.body.monthlyRent === undefined || Number(req.body.monthlyRent) < 0) return res.status(400).json({ error: "Enter a valid monthly rent for this floor." });
  const monthlyRent = Number(req.body.monthlyRent);
  rooms.forEach((room) => { room.monthlyRent = monthlyRent; });
  saveDb(db);
  res.json({ floorNumber, monthlyRent, roomsUpdated: rooms.length });
});

// Delete an entire floor, including its rooms, tenancy records, ledgers and any
// stored payment proofs.  The UI asks for explicit confirmation before calling it.
app.delete("/api/buildings/:id/floors/:floorNumber", (req, res) => {
  const db = loadDb();
  if (!db.buildings.find((building) => building.id === req.params.id)) return notFound(res, "Building");
  const floorNumber = Number(req.params.floorNumber);
  const roomIds = db.rooms.filter((room) => room.buildingId === req.params.id && Number(room.floorNumber) === floorNumber).map((room) => room.id);
  if (!roomIds.length) return notFound(res, "Floor");
  const tenantIds = db.tenants.filter((tenant) => roomIds.includes(tenant.roomId)).map((tenant) => tenant.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts(db.electricityEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => roomIds.includes(entry.roomId)));
  db.rooms = db.rooms.filter((room) => !roomIds.includes(room.id));
  db.tenants = db.tenants.filter((tenant) => !roomIds.includes(tenant.roomId));
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((entry) => !roomIds.includes(entry.roomId));
  db.electricityEntries = db.electricityEntries.filter((entry) => !roomIds.includes(entry.roomId));
  db.gasEntries = (db.gasEntries || []).filter((entry) => !roomIds.includes(entry.roomId));
  saveDb(db);
  res.json({ ok: true, floorNumber, roomsDeleted: roomIds.length });
});

app.delete("/api/buildings/:id", (req, res) => {
  const db = loadDb();
  const roomIds = db.rooms.filter((r) => r.buildingId === req.params.id).map((r) => r.id);
  const tenantIds = db.tenants.filter((t) => roomIds.includes(t.roomId)).map((t) => t.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts(db.electricityEntries.filter((entry) => roomIds.includes(entry.roomId)));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => roomIds.includes(entry.roomId)));
  db.rooms = db.rooms.filter((r) => r.buildingId !== req.params.id);
  db.tenants = db.tenants.filter((t) => !roomIds.includes(t.roomId));
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((e) => !roomIds.includes(e.roomId));
  db.electricityEntries = db.electricityEntries.filter((e) => !roomIds.includes(e.roomId));
  db.gasEntries = (db.gasEntries || []).filter((e) => !roomIds.includes(e.roomId));
  db.buildings = db.buildings.filter((b) => b.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Rooms (floor / room units within a building) ----------

app.get("/api/rooms", (req, res) => {
  const db = loadDb();
  let rooms = db.rooms;
  if (req.query.buildingId) rooms = rooms.filter((r) => r.buildingId === req.query.buildingId);
  res.json(rooms);
});

app.post("/api/rooms", (req, res) => {
  const db = loadDb();
  const { buildingId, floorNumber, label, monthlyRent, deposit, notes, electricityOnly } = req.body;
  if (!buildingId || !label) return res.status(400).json({ error: "buildingId and label are required" });
  if (!db.buildings.find((b) => b.id === buildingId)) return notFound(res, "Building");
  const room = {
    id: id(),
    buildingId,
    floorNumber: Number(floorNumber) || 0,
    label,
    electricityOnly: electricityOnly === true || electricityOnly === 'true',
    monthlyRent: electricityOnly === true || electricityOnly === 'true' ? 0 : Number(monthlyRent) || 0,
    deposit: electricityOnly === true || electricityOnly === 'true' ? 0 : Number(deposit) || 0,
    status: electricityOnly === true || electricityOnly === 'true' ? "owner" : "vacant",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.rooms.push(room);
  saveDb(db);
  res.status(201).json(room);
});

app.put("/api/rooms/:id", (req, res) => {
  const db = loadDb();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  Object.assign(room, req.body, { id: room.id });
  room.electricityOnly = room.electricityOnly === true || room.electricityOnly === 'true';
  if (room.electricityOnly) room.status = 'owner';
  if (room.monthlyRent !== undefined) room.monthlyRent = Number(room.monthlyRent) || 0;
  if (room.deposit !== undefined) room.deposit = Number(room.deposit) || 0;
  if (room.floorNumber !== undefined) room.floorNumber = Number(room.floorNumber) || 0;
  saveDb(db);
  res.json(room);
});

app.delete("/api/rooms/:id", (req, res) => {
  const db = loadDb();
  const tenantIds = db.tenants.filter((t) => t.roomId === req.params.id).map((t) => t.id);
  removeEntryReceipts(db.rentEntries.filter((entry) => entry.roomId === req.params.id));
  removeEntryReceipts(db.electricityEntries.filter((entry) => entry.roomId === req.params.id));
  removeEntryReceipts((db.gasEntries || []).filter((entry) => entry.roomId === req.params.id));
  db.tenants = db.tenants.filter((t) => t.roomId !== req.params.id);
  removeTenantAccounts(db, tenantIds);
  db.rentEntries = db.rentEntries.filter((e) => e.roomId !== req.params.id);
  db.electricityEntries = db.electricityEntries.filter((e) => e.roomId !== req.params.id);
  db.gasEntries = (db.gasEntries || []).filter((e) => e.roomId !== req.params.id);
  db.rooms = db.rooms.filter((r) => r.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// Link a room to a gas meter ID + billing authority (gas board / supplier). Once
// linked, gas bills for this room are entered by the owner as the amount the
// authority is showing as due for that meter — the app has no live/API access
// into any gas provider's own billing system, so this is an owner-entered
// figure, not an automatic fetch. Past bill entries keep whatever meter/
// authority they were recorded under, even if the room's meter is later
// unlinked or relinked to a different authority.
app.put("/api/rooms/:id/gas-meter", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  const meterId = String(req.body.meterId || "").trim();
  const authority = db.authorities.find((a) => a.id === req.body.authorityId);
  if (!meterId) return res.status(400).json({ error: "Enter a meter ID." });
  if (!authority) return res.status(400).json({ error: "Choose a valid billing authority." });
  room.gasMeterId = meterId;
  room.gasAuthorityId = authority.id;
  saveDb(db);
  res.json(room);
});

app.delete("/api/rooms/:id/gas-meter", (req, res) => {
  const db = loadDb();
  const room = db.rooms.find((r) => r.id === req.params.id);
  if (!room) return notFound(res, "Room");
  room.gasMeterId = "";
  room.gasAuthorityId = null;
  saveDb(db);
  res.json(room);
});

// ---------- Billing authorities (gas boards, utility companies, etc.) ----------
// A small owner-managed list the gas-meter-linking dropdown is populated from.

app.get("/api/authorities", (req, res) => {
  const db = loadDb();
  res.json((db.authorities || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
});

// The link to an authority's own "view / pay your bill" page, so the owner can
// open it straight from the gas card. Only http(s) links are accepted.
function cleanBillUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  let url;
  try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { url = null; }
  if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) {
    throw Object.assign(new Error("Enter a valid website link, e.g. https://www.iglonline.net"), { status: 400 });
  }
  return url.toString();
}

app.post("/api/authorities", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Enter a name for the authority." });
  let billUrl;
  try { billUrl = cleanBillUrl(req.body.billUrl); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  const existing = db.authorities.find((a) => a.name.toLowerCase() === name.toLowerCase());
  if (existing) return res.status(200).json(existing);
  const authority = { id: id(), name, billUrl, createdAt: new Date().toISOString() };
  db.authorities.push(authority);
  saveDb(db);
  res.status(201).json(authority);
});

app.put("/api/authorities/:id", (req, res) => {
  const db = loadDb();
  const authority = (db.authorities || []).find((a) => a.id === req.params.id);
  if (!authority) return notFound(res, "Authority");
  if (req.body.name !== undefined) {
    const name = String(req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Enter a name for the authority." });
    authority.name = name;
  }
  if (req.body.billUrl !== undefined) {
    try { authority.billUrl = cleanBillUrl(req.body.billUrl); } catch (err) { return res.status(err.status).json({ error: err.message }); }
  }
  saveDb(db);
  res.json(authority);
});

app.delete("/api/authorities/:id", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  if (db.rooms.some((r) => r.gasAuthorityId === req.params.id)) {
    return res.status(409).json({ error: "This authority is linked to a room. Unlink its meter first." });
  }
  db.authorities = db.authorities.filter((a) => a.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Tenants ----------

app.get("/api/tenants", (req, res) => {
  const db = loadDb();
  let tenants = db.tenants;
  if (req.query.roomId) tenants = tenants.filter((t) => t.roomId === req.query.roomId);
  res.json(tenants);
});

app.post("/api/tenants", (req, res) => {
  const db = loadDb();
  const {
    roomId, name, mobile, altMobile, email,
    idProofType, idProofNumber, moveInDate, notes,
  } = req.body;
  if (!roomId || !name || !mobile) {
    return res.status(400).json({ error: "roomId, name and mobile are required" });
  }
  const room = db.rooms.find((r) => r.id === roomId);
  if (!room) return notFound(res, "Room");

  const tenant = {
    id: id(),
    roomId,
    name,
    mobile,
    altMobile: altMobile || "",
    email: email || "",
    idProofType: idProofType || "",
    idProofNumber: idProofNumber || "",
    moveInDate: moveInDate || "",
    moveOutDate: "",
    active: true,
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.tenants.push(tenant);
  refreshRoomStatus(db, roomId);
  saveDb(db);
  res.status(201).json(tenant);
});

app.put("/api/tenants/:id", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  Object.assign(tenant, req.body, { id: tenant.id });
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json(tenant);
});

// Mark tenant as moved out, preserving rent history but removing their login and sensitive identifiers.
app.post("/api/tenants/:id/move-out", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  tenant.active = false;
  tenant.moveOutDate = req.body.moveOutDate || new Date().toISOString().slice(0, 10);
  const removedLoginAccounts = removeTenantAccounts(db, [tenant.id]);
  clearTenantIdentity(tenant);
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json({ ...tenant, removedLoginAccounts, identityCleared: true });
});

app.delete("/api/tenants/:id", (req, res) => {
  const db = loadDb();
  const tenant = db.tenants.find((t) => t.id === req.params.id);
  if (!tenant) return notFound(res, "Tenant");
  db.tenants = db.tenants.filter((t) => t.id !== req.params.id);
  removeTenantAccounts(db, [req.params.id]);
  // Keep financial history but detach it from the now-deleted personal record.
  db.rentEntries.forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  db.electricityEntries.forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  (db.gasEntries || []).forEach((entry) => { if (entry.tenantId === tenant.id) entry.tenantId = null; });
  refreshRoomStatus(db, tenant.roomId);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Rent entries ----------

app.get("/api/rent", (req, res) => {
  const db = loadDb();
  let entries = db.rentEntries;
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/rent", (req, res) => {
  const db = loadDb();
  const { roomId, tenantId, month, year, rentAmount, amountPaid, dueDate, paidDate, notes } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, 'Room');
  if (room.electricityOnly) return res.status(400).json({ error: 'Owner electricity-only floors cannot have rent entries.' });
  const paid = Number(amountPaid) || 0;
  const due = Number(rentAmount) || 0;
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    rentAmount: due,
    amountPaid: paid,
    dueDate: dueDate || "",
    paidDate: paidDate || "",
    status: paid <= 0 ? "due" : paid < due ? "partial" : "paid",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  db.rentEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/rent/:id", (req, res) => {
  const db = loadDb();
  const entry = db.rentEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Rent entry");
  Object.assign(entry, req.body, { id: entry.id });
  entry.rentAmount = Number(entry.rentAmount) || 0;
  entry.amountPaid = Number(entry.amountPaid) || 0;
  entry.status = entry.amountPaid <= 0 ? "due" : entry.amountPaid < entry.rentAmount ? "partial" : "paid";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/rent/:id", (req, res) => {
  const db = loadDb();
  const entry = db.rentEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.rentEntries = db.rentEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Electricity entries ----------

app.get("/api/electricity", (req, res) => {
  const db = loadDb();
  let entries = db.electricityEntries;
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/electricity", (req, res) => {
  const db = loadDb();
  const {
    roomId, tenantId, month, year,
    prevReading, currReading, ratePerUnit,
    paidDate, notes,
  } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, "Room");
  const prev = Number(prevReading) || 0;
  const curr = Number(currReading) || 0;
  const rate = Number(ratePerUnit) || 0;
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    prevReading: prev,
    currReading: curr,
    unitsConsumed: Math.max(curr - prev, 0),
    ratePerUnit: rate,
    amount: Math.round(Math.max(curr - prev, 0) * rate * 100) / 100,
    paidDate: paidDate || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  entry.status = entry.paidDate ? "paid" : "due";
  db.electricityEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/electricity/:id", (req, res) => {
  const db = loadDb();
  const entry = db.electricityEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Electricity entry");
  Object.assign(entry, req.body, { id: entry.id });
  entry.prevReading = Number(entry.prevReading) || 0;
  entry.currReading = Number(entry.currReading) || 0;
  entry.ratePerUnit = Number(entry.ratePerUnit) || 0;
  entry.unitsConsumed = Math.max(entry.currReading - entry.prevReading, 0);
  entry.amount = Math.round(entry.unitsConsumed * entry.ratePerUnit * 100) / 100;
  entry.status = entry.paidDate ? "paid" : "due";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/electricity/:id", (req, res) => {
  const db = loadDb();
  const entry = db.electricityEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.electricityEntries = db.electricityEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Gas entries ----------
// Gas is always billed through a linked meter ID + authority (gas board /
// supplier) — there's no meter-reading mode here. The "amount" on each entry
// is the due amount the owner read off that authority's own bill/portal for
// this meter; the app has no official API access into any gas provider's
// billing system, so this is entered by the owner, not fetched automatically.

app.get("/api/gas", (req, res) => {
  const db = loadDb();
  let entries = db.gasEntries || [];
  if (req.query.roomId) entries = entries.filter((e) => e.roomId === req.query.roomId);
  if (req.query.tenantId) entries = entries.filter((e) => e.tenantId === req.query.tenantId);
  if (req.query.buildingId) {
    const roomIds = db.rooms.filter((r) => r.buildingId === req.query.buildingId).map((r) => r.id);
    entries = entries.filter((e) => roomIds.includes(e.roomId));
  }
  res.json(entries);
});

app.post("/api/gas", (req, res) => {
  const db = loadDb();
  db.authorities = db.authorities || [];
  db.gasEntries = db.gasEntries || [];
  const { roomId, tenantId, month, year, amount, paidDate, notes } = req.body;
  if (!roomId || !month || !year) return res.status(400).json({ error: "roomId, month and year are required" });
  const room = db.rooms.find((candidate) => candidate.id === roomId);
  if (!room) return notFound(res, "Room");
  if (!room.gasMeterId || !room.gasAuthorityId) {
    return res.status(400).json({ error: "Link this room to a gas meter ID and billing authority first." });
  }
  const authority = db.authorities.find((a) => a.id === room.gasAuthorityId);
  const entry = {
    id: id(),
    roomId,
    tenantId: tenantId || null,
    month: Number(month),
    year: Number(year),
    meterId: room.gasMeterId,
    authorityId: room.gasAuthorityId,
    authorityName: authority ? authority.name : "Unknown authority",
    amount: Math.round((Number(amount) || 0) * 100) / 100,
    paidDate: paidDate || "",
    notes: notes || "",
    createdAt: new Date().toISOString(),
  };
  entry.status = entry.paidDate ? "paid" : "due";
  db.gasEntries.push(entry);
  saveDb(db);
  res.status(201).json(entry);
});

app.put("/api/gas/:id", (req, res) => {
  const db = loadDb();
  db.gasEntries = db.gasEntries || [];
  const entry = db.gasEntries.find((e) => e.id === req.params.id);
  if (!entry) return notFound(res, "Gas entry");
  if (req.body.month !== undefined) entry.month = Number(req.body.month);
  if (req.body.year !== undefined) entry.year = Number(req.body.year);
  if (req.body.amount !== undefined) entry.amount = Math.round((Number(req.body.amount) || 0) * 100) / 100;
  if (req.body.paidDate !== undefined) entry.paidDate = req.body.paidDate || "";
  if (req.body.notes !== undefined) entry.notes = req.body.notes || "";
  if (req.body.tenantId !== undefined) entry.tenantId = req.body.tenantId || null;
  entry.status = entry.paidDate ? "paid" : "due";
  saveDb(db);
  res.json(entry);
});

app.delete("/api/gas/:id", (req, res) => {
  const db = loadDb();
  db.gasEntries = db.gasEntries || [];
  const entry = db.gasEntries.find((e) => e.id === req.params.id);
  removeReceiptFile(entry?.receipt);
  db.gasEntries = db.gasEntries.filter((e) => e.id !== req.params.id);
  saveDb(db);
  res.json({ ok: true });
});

// ---------- Dashboard summary ----------

app.get("/api/dashboard", (req, res) => {
  const db = loadDb();
  const totalBuildings = db.buildings.length;
  const totalRooms = db.rooms.length;
  const occupiedRooms = db.rooms.filter((r) => r.status === "occupied").length;
  const vacantRooms = totalRooms - occupiedRooms;

  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  const electricityOnlyRoomIds = new Set(db.rooms.filter((room) => room.electricityOnly).map((room) => room.id));
  const rentThisMonth = db.rentEntries.filter((e) => e.month === month && e.year === year && !electricityOnlyRoomIds.has(e.roomId));
  const rentCollected = rentThisMonth.reduce((s, e) => s + e.amountPaid, 0);
  const rentPending = rentThisMonth.reduce((s, e) => s + Math.max(e.rentAmount - e.amountPaid, 0), 0);

  const elecThisMonth = db.electricityEntries.filter((e) => e.month === month && e.year === year);
  const elecPending = elecThisMonth.filter((e) => e.status !== "paid").reduce((s, e) => s + e.amount, 0);
  const elecCollected = elecThisMonth.filter((e) => e.status === "paid").reduce((s, e) => s + e.amount, 0);

  const gasThisMonth = (db.gasEntries || []).filter((e) => e.month === month && e.year === year);
  const gasPending = gasThisMonth.filter((e) => e.status !== "paid").reduce((s, e) => s + e.amount, 0);
  const gasCollected = gasThisMonth.filter((e) => e.status === "paid").reduce((s, e) => s + e.amount, 0);

  const allDueRent = db.rentEntries.filter((e) => e.status !== "paid" && !electricityOnlyRoomIds.has(e.roomId)).length;
  const allDueElec = db.electricityEntries.filter((e) => e.status !== "paid").length;
  const allDueGas = (db.gasEntries || []).filter((e) => e.status !== "paid").length;

  // Rooms linked to a gas meter that don't have this month's bill entered yet —
  // the owner's to-do list for reading bills off the gas company's site.
  const gasBillsToEnter = db.rooms
    .filter((room) => room.gasMeterId && room.gasAuthorityId)
    .filter((room) => !(db.gasEntries || []).some((e) => e.roomId === room.id && e.month === month && e.year === year))
    .map((room) => {
      const authority = (db.authorities || []).find((a) => a.id === room.gasAuthorityId);
      const building = db.buildings.find((b) => b.id === room.buildingId);
      const tenant = db.tenants.find((t) => t.roomId === room.id && t.active);
      return {
        roomId: room.id,
        roomLabel: room.label,
        buildingName: building?.name || "",
        meterId: room.gasMeterId,
        authorityName: authority?.name || "Unknown authority",
        billUrl: authority?.billUrl || "",
        tenantId: tenant?.id || null,
        tenantName: tenant?.name || "",
      };
    });

  res.json({
    totalBuildings,
    totalRooms,
    occupiedRooms,
    vacantRooms,
    month,
    year,
    rentCollected,
    rentPending,
    elecCollected,
    elecPending,
    gasCollected,
    gasPending,
    outstandingRentEntries: allDueRent,
    outstandingElectricityEntries: allDueElec,
    outstandingGasEntries: allDueGas,
    gasBillsToEnter,
    onlinePaymentsEnabled: razorpayConfigured(),
  });
});

// Owner view of online payments received through Razorpay (most recent first).
app.get("/api/payments", (req, res) => {
  const db = loadDb();
  const payments = (db.payments || [])
    .filter((payment) => payment.status === "paid")
    .sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt)))
    .slice(0, Number(req.query.limit) || 20)
    .map((payment) => {
      const tenant = db.tenants.find((t) => t.id === payment.tenantId);
      const room = db.rooms.find((r) => r.id === payment.roomId);
      return {
        id: payment.id,
        amount: payment.amount,
        paidAt: payment.paidAt,
        method: payment.method,
        razorpayPaymentId: payment.razorpayPaymentId,
        tenantName: tenant?.name || "Former tenant",
        roomLabel: room?.label || "",
        items: payment.items,
      };
    });
  res.json(payments);
});

// Fallback to the SPA for any non-API route
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ---------- default billing authorities ----------
// Seeds a starter list of Delhi/UP electricity boards into the authorities
// list on boot, so the owner doesn't have to type each one in by hand. Runs
// once at startup; only adds names that aren't already present (case-
// insensitive), so it never duplicates or touches authorities already added
// or renamed by the owner.
const DEFAULT_AUTHORITIES = [
  "Uttar Pradesh Power Corporation Limited (UPPCL)",
  "Noida Power Company Limited (NPCL)",
  "Maharashtra State Electricity Distribution Company Limited (MSEDCL / Mahavitran)",
  "Tata Power Delhi Distribution Limited (TPDDL)",
  "BSES Rajdhani Power Limited (BRPL)",
  "BSES Yamuna Power Limited (BYPL)",
  "Punjab State Power Corporation Limited (PSPCL)",
  "Dakshin Haryana Bijli Vitran Nigam (DHBVN)",
  "Uttar Haryana Bijli Vitran Nigam (UHBVN)",
  "Kerala State Electricity Board Limited (KSEBL)",
  "Bangalore Electricity Supply Company Limited (BESCOM)",
];

// Common piped-gas suppliers, with the official page where a customer views or
// pays their bill. The owner can add others (and their links) from the app.
const DEFAULT_GAS_AUTHORITIES = [
  { name: "Indraprastha Gas Limited (IGL)", billUrl: "https://www.iglonline.net/electronic-payment" },
  { name: "Mahanagar Gas Limited (MGL)", billUrl: "https://www.mahanagargas.com/quick-bill-pay" },
  { name: "Maharashtra Natural Gas Limited (MNGL)", billUrl: "https://mngl.in/pay-bill" },
];

function seedDefaultAuthorities() {
  const db = loadDb();
  db.authorities = db.authorities || [];
  let changed = false;
  const defaults = [...DEFAULT_AUTHORITIES.map((name) => ({ name, billUrl: "" })), ...DEFAULT_GAS_AUTHORITIES];
  for (const { name, billUrl } of defaults) {
    const existing = db.authorities.find((a) => a.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      db.authorities.push({ id: id(), name, billUrl, createdAt: new Date().toISOString() });
      changed = true;
    } else if (billUrl && !existing.billUrl) {
      existing.billUrl = billUrl;
      changed = true;
    }
  }
  if (changed) saveDb(db);
}
seedDefaultAuthorities();

app.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(info => info && info.family === 'IPv4' && !info.internal).map(info => info.address);
  console.log(`Rent Ledger on this Mac: http://localhost:${PORT}`);
  addresses.forEach(address => console.log(`Open on phone or another computer: http://${address}:${PORT}`));
});
