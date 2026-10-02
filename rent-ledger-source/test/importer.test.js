// Upgrading from the old db.json: every bill and payment must come across exactly.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setupEnv } = require("./helpers");

setupEnv();
const { openDatabase } = require("../lib/db");
const { importLegacyJson } = require("../services/importer");
const ledger = require("../services/ledger");

const hp = (p) => { const salt = crypto.randomBytes(16).toString("hex"); return { passwordSalt: salt, passwordHash: crypto.scryptSync(p, salt, 64).toString("hex") }; };

function legacyFixture() {
  return {
    users: [
      { id: "u-owner", name: "Owner", contact: "owner@example.com", ...hp("1234"), role: "owner", tenantId: null, createdAt: "2026-09-01T00:00:00.000Z" },
      { id: "u-ten", name: "Asha", contact: "9876543210", ...hp("abcd"), role: "tenant", tenantId: "t1", createdAt: "2026-09-02T00:00:00.000Z" },
    ],
    buildings: [{ id: "b1", name: "Sunrise", address: "Pune", totalFloors: 2, notes: "", createdAt: "x" }],
    rooms: [
      { id: "r1", buildingId: "b1", floorNumber: 1, label: "1A", electricityOnly: false, monthlyRent: 12000, deposit: 24000, status: "occupied", notes: "", createdAt: "x", gasMeterId: "BP1", gasAuthorityId: "a1" },
      { id: "r0", buildingId: "b1", floorNumber: 0, label: "Owner", electricityOnly: true, monthlyRent: 0, deposit: 0, status: "owner", notes: "", createdAt: "x" },
    ],
    tenants: [{ id: "t1", roomId: "r1", name: "Asha", mobile: "9876543210", altMobile: "", email: "", idProofType: "Aadhaar", idProofNumber: "1234", moveInDate: "2026-01-01", moveOutDate: "", active: true, notes: "", createdAt: "x" }],
    rentEntries: [
      { id: "re1", roomId: "r1", tenantId: "t1", month: 8, year: 2026, rentAmount: 12000, amountPaid: 12000, dueDate: "", paidDate: "2026-08-05", status: "paid", notes: "", createdAt: "2026-08-01T00:00:00.000Z" },
      { id: "re2", roomId: "r1", tenantId: "t1", month: 9, year: 2026, rentAmount: 12000, amountPaid: 12000, dueDate: "", paidDate: "2026-09-05", status: "paid", notes: "", createdAt: "x",
        onlinePayment: { provider: "razorpay", paymentId: "pay_1", orderId: "order_1", amount: 12000, paidAt: "2026-09-05T10:00:00.000Z" } },
      { id: "re3", roomId: "r1", tenantId: "t1", month: 10, year: 2026, rentAmount: 12000, amountPaid: 5000.5, dueDate: "2026-10-05", paidDate: "2026-10-02", status: "partial", notes: "", createdAt: "x",
        receipt: { id: "rcpt1", fileName: "abc.png", originalName: "proof.png", mimeType: "image/png", size: 10, uploadedAt: "x" } },
    ],
    electricityEntries: [
      { id: "e1", roomId: "r0", tenantId: null, month: 9, year: 2026, prevReading: 1, currReading: 11, unitsConsumed: 10, ratePerUnit: 8, amount: 80, paidDate: "", notes: "", createdAt: "x", status: "due" },
      { id: "e2", roomId: "r1", tenantId: "t1", month: 9, year: 2026, prevReading: 0, currReading: 50, unitsConsumed: 50, ratePerUnit: 8, amount: 400, paidDate: "2026-09-10", notes: "", createdAt: "x", status: "paid" },
    ],
    gasEntries: [{ id: "g1", roomId: "r1", tenantId: "t1", month: 9, year: 2026, meterId: "BP1", authorityId: "a1", authorityName: "IGL", amount: 650, paidDate: "", notes: "", createdAt: "x", status: "paid",
      onlinePayment: { provider: "razorpay", paymentId: "pay_1", orderId: "order_1", amount: 650, paidAt: "2026-09-05T10:00:00.000Z" } }],
    passwordResetOtps: [],
    authorities: [{ id: "a1", name: "Indraprastha Gas Limited (IGL)", billUrl: "https://www.iglonline.net/electronic-payment", createdAt: "x" }],
    payments: [
      { id: "p1", tenantId: "t1", roomId: "r1", items: [{ kind: "rent", entryId: "re2", month: 9, year: 2026, amount: 12000, result: "applied" }, { kind: "gas", entryId: "g1", month: 9, year: 2026, amount: 650, result: "applied" }],
        amount: 12650, currency: "INR", status: "paid", razorpayOrderId: "order_1", razorpayPaymentId: "pay_1", method: "upi", paidAt: "2026-09-05T10:00:00.000Z", createdAt: "x" },
      { id: "p2", tenantId: "t1", roomId: "r1", items: [{ kind: "rent", entryId: "re1", month: 8, year: 2026, amount: 12000, result: "already-paid" }], amount: 12000, currency: "INR", status: "paid",
        razorpayOrderId: "order_2", razorpayPaymentId: "pay_2", method: "card", paidAt: "2026-08-06T00:00:00.000Z", createdAt: "x" },
    ],
  };
}

function setup(fixture = legacyFixture()) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-import-"));
  fs.writeFileSync(path.join(dataDir, "db.json"), JSON.stringify(fixture));
  return { dataDir, db: openDatabase({ dataDir }) };
}

test("imports every record and matches every bill exactly", () => {
  const { dataDir, db } = setup();
  const original = fs.readFileSync(path.join(dataDir, "db.json"), "utf-8");
  const result = importLegacyJson(db, { dataDir, today: "2026-10-10" });
  assert.equal(result.status, "imported");
  assert.equal(result.bills, 6);
  const orgId = result.orgId;
  const get = (id) => ledger.getCharge(db, orgId, id, "2026-10-10");
  assert.equal(get("re1").status, "paid");
  assert.equal(get("re2").paid_paise, 1200000);
  assert.equal(get("re3").paid_paise, 500050);
  assert.equal(get("re3").status, "partial");
  assert.equal(get("e1").status, "due"); // no due date: never overdue
  assert.equal(get("e1").outstanding_paise, 8000);
  assert.equal(get("e2").status, "paid");
  assert.equal(get("g1").status, "paid");
  // One online payment covered rent + gas; it is one verified payment.
  const online = db.get("SELECT * FROM payments WHERE provider_payment_id = 'pay_1'");
  assert.equal(online.amount_paise, 1265000);
  assert.equal(online.verification, "verified");
  // A paid online order that hit an already-paid bill is kept as tenant credit.
  const credit = db.get("SELECT * FROM payments WHERE provider_payment_id = 'pay_2'");
  assert.equal(credit.amount_paise, 1200000);
  assert.equal(ledger.tenantBalance(db, orgId, "t1", "2026-10-10").creditPaise, 1200000);
  // Logins keep working (same password hashes); the receipt keeps its id.
  assert.equal(db.get("SELECT COUNT(*) AS n FROM users").n, 2);
  assert.ok(db.get("SELECT 1 FROM documents WHERE id = 'rcpt1' AND review_status = 'unverified'"));
  // db.json is never changed; a copy is kept in backups.
  assert.equal(fs.readFileSync(path.join(dataDir, "db.json"), "utf-8"), original);
  assert.ok(fs.readdirSync(path.join(dataDir, "backups")).some((f) => f.endsWith("-pre-sqlite.json")));
  assert.ok(fs.existsSync(path.join(dataDir, "db.json.MIGRATED-TO-SQLITE.txt")));
  // Running again does nothing.
  assert.equal(importLegacyJson(db, { dataDir, today: "2026-10-10" }).status, "already-done");
  db.close();
});

test("a second active tenant in one room is imported as moved out, with a warning", () => {
  const fixture = legacyFixture();
  fixture.tenants.push({ ...fixture.tenants[0], id: "t2", name: "Duplicate", mobile: "9000000000", createdAt: "y" });
  const { dataDir, db } = setup(fixture);
  const result = importLegacyJson(db, { dataDir, today: "2026-10-10" });
  assert.equal(db.get("SELECT active FROM tenants WHERE id = 't2'").active, 0);
  assert.ok(result.warnings.some((w) => w.includes("Duplicate")));
  db.close();
});

test("an unreadable db.json stops the start-up and changes nothing", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-import-bad-"));
  fs.writeFileSync(path.join(dataDir, "db.json"), "{ broken");
  const db = openDatabase({ dataDir });
  assert.throws(() => importLegacyJson(db, { dataDir, today: "2026-10-10" }), /not valid JSON/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM organizations").n, 0);
  db.close();
});

test("no db.json (fresh install) is fine", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-import-none-"));
  const db = openDatabase({ dataDir });
  assert.equal(importLegacyJson(db, { dataDir, today: "2026-10-10" }).status, "no-legacy-file");
  db.close();
});
