// The accounting rules, tested directly against the ledger service.
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setupEnv } = require("./helpers");

setupEnv();
const { openDatabase } = require("../lib/db");
const ledger = require("../services/ledger");

const TODAY = "2026-10-10";
let db, ctx, room, tenant;

beforeEach(() => {
  db = openDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "rl-ledger-")) });
  db.run("INSERT INTO organizations (id, name, created_at) VALUES ('org','Org','now')");
  db.run("INSERT INTO buildings (id, org_id, name, created_at) VALUES ('b','org','B','now')");
  db.run("INSERT INTO rooms (id, org_id, building_id, label, monthly_rent_paise, status, created_at) VALUES ('r','org','b','1A',1200000,'occupied','now')");
  db.run("INSERT INTO tenants (id, org_id, room_id, name, mobile, created_at) VALUES ('t','org','r','Asha','9876543210','now')");
  ctx = { orgId: "org", userId: "u", role: "owner", requestId: "test" };
  room = "r"; tenant = "t";
});

const rent = (amount, extra = {}) => ledger.createCharge(db, ctx, { roomId: room, tenantId: tenant, kind: "rent", periodYear: 2026, periodMonth: 10, dueDate: "2026-10-05", amountPaise: amount, ...extra });

test("charge status: due, overdue, partial, paid", () => {
  const future = rent(1000, { dueDate: "2026-10-20" });
  assert.equal(ledger.getCharge(db, "org", future, TODAY).status, "due");
  const past = rent(1000);
  assert.equal(ledger.getCharge(db, "org", past, TODAY).status, "overdue");
  ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 400, method: "cash", allocations: [{ chargeId: past, amountPaise: 400 }] }, TODAY);
  const c = ledger.getCharge(db, "org", past, TODAY);
  assert.equal(c.status, "partial");
  assert.equal(c.outstanding_paise, 600);
  ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 600, method: "upi", allocations: [{ chargeId: past, amountPaise: 600 }] }, TODAY);
  assert.equal(ledger.getCharge(db, "org", past, TODAY).status, "paid");
});

test("allocation can't exceed what's due; extra money stays as tenant credit", () => {
  const c = rent(1000);
  assert.throws(() => ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 1500, method: "cash", allocations: [{ chargeId: c, amountPaise: 1500 }] }, TODAY), /more than/);
  ledger.setPaidAmount(db, ctx, c, 1500, {}, TODAY); // legacy "amount paid" with an advance
  const b = ledger.tenantBalance(db, "org", tenant, TODAY);
  assert.equal(b.outstandingPaise, 0);
  assert.equal(b.creditPaise, 500);
});

test("reducing 'amount paid' reverses and re-records, keeping full history", () => {
  const c = rent(1200000);
  ledger.setPaidAmount(db, ctx, c, 1200000, { receivedOn: "2026-10-03" }, TODAY);
  ledger.setPaidAmount(db, ctx, c, 1000000, {}, TODAY);
  const charge = ledger.getCharge(db, "org", c, TODAY);
  assert.equal(charge.paid_paise, 1000000);
  const payments = ledger.listPayments(db, "org", { tenantId: tenant });
  assert.equal(payments.length, 2);
  assert.equal(payments.filter((p) => p.reversed).length, 1);
  assert.equal(payments.find((p) => !p.reversed).amount_paise, 1000000);
  assert.equal(payments.find((p) => !p.reversed).received_on, "2026-10-03");
  assert.ok(db.get("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'payment.reversed'").n >= 1);
});

test("verified (online/bank) money can't be removed by editing or deleting the bill", () => {
  const c = rent(1000);
  ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 1000, method: "razorpay", verification: "verified", source: "razorpay", providerPaymentId: "pay_1", allocations: [{ chargeId: c, amountPaise: 1000 }] }, TODAY);
  assert.throws(() => ledger.setPaidAmount(db, ctx, c, 0, {}, TODAY), /paid online or matched/);
  assert.throws(() => ledger.voidCharge(db, ctx, c, "oops", TODAY), /verified payment/);
  const p = ledger.listPayments(db, "org", {})[0];
  assert.throws(() => ledger.reversePayment(db, ctx, p.id, "refunded"), /refund/);
  ledger.reversePayment(db, ctx, p.id, "Refunded in Razorpay", { allowVerified: true });
  assert.equal(ledger.getCharge(db, "org", c, TODAY).paid_paise, 0);
});

test("lowering a charge below what was paid leaves the excess as credit", () => {
  const c = rent(1000);
  ledger.setPaidAmount(db, ctx, c, 1000, {}, TODAY);
  ledger.adjustCharge(db, ctx, c, { amountPaise: -300, kind: "discount", reason: "Agreed discount" }, TODAY);
  const charge = ledger.getCharge(db, "org", c, TODAY);
  assert.equal(charge.amount_paise, 700);
  assert.equal(charge.paid_paise, 700);
  assert.equal(ledger.tenantBalance(db, "org", tenant, TODAY).creditPaise, 300);
  assert.throws(() => ledger.adjustCharge(db, ctx, c, { amountPaise: -100, reason: "" }, TODAY), /reason/);
});

test("waiving a charge entirely marks it waived", () => {
  const c = rent(1000);
  ledger.adjustCharge(db, ctx, c, { amountPaise: -1000, kind: "waiver", reason: "Festival waiver" }, TODAY);
  assert.equal(ledger.getCharge(db, "org", c, TODAY).status, "waived");
});

test("auto-allocation pays the oldest bills first", () => {
  const oct = rent(1000, { periodMonth: 10, dueDate: "2026-10-05" });
  const sep = rent(1000, { periodMonth: 9, dueDate: "2026-09-05" });
  ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 1500, method: "upi", allocations: "auto" }, TODAY);
  assert.equal(ledger.getCharge(db, "org", sep, TODAY).status, "paid");
  assert.equal(ledger.getCharge(db, "org", oct, TODAY).paid_paise, 500);
});

test("idempotency: the same payment key is recorded once", () => {
  const a = ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 500, method: "upi", idempotencyKey: "bank:abc" }, TODAY);
  const b = ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 500, method: "upi", idempotencyKey: "bank:abc" }, TODAY);
  assert.equal(a.paymentId, b.paymentId);
  assert.equal(b.duplicate, true);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM payments").n, 1);
});

test("the database refuses to edit or delete money records", () => {
  const c = rent(1000);
  const { paymentId } = ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 1000, method: "cash", allocations: [{ chargeId: c, amountPaise: 1000 }] }, TODAY);
  assert.throws(() => db.run("UPDATE payments SET amount_paise = 1 WHERE id = ?", paymentId), /immutable/);
  assert.throws(() => db.run("DELETE FROM payments WHERE id = ?", paymentId), /cannot be deleted/);
  assert.throws(() => db.run("UPDATE allocations SET amount_paise = 1"), /immutable/);
  assert.throws(() => db.run("DELETE FROM charges WHERE id = ?", c), /voided/);
  assert.throws(() => db.run("UPDATE charges SET base_amount_paise = 1 WHERE id = ?", c), /adjustments/);
  assert.throws(() => db.run("UPDATE audit_log SET action = 'x'"), /append-only/);
});

test("deleting a bill voids it and corrects recorded payments", () => {
  const c = rent(1000);
  ledger.setPaidAmount(db, ctx, c, 400, {}, TODAY);
  ledger.voidCharge(db, ctx, c, "Entered twice", TODAY);
  const charge = ledger.getCharge(db, "org", c, TODAY);
  assert.equal(charge.status, "void");
  assert.equal(charge.paid_paise, 0);
  assert.equal(ledger.listCharges(db, "org", { tenantId: tenant }, TODAY).length, 0);
  assert.equal(ledger.tenantBalance(db, "org", tenant, TODAY).creditPaise, 0);
});

test("statement shows a running balance", () => {
  const c = rent(1000, { dueDate: "2026-10-01" });
  ledger.recordPayment(db, ctx, { tenantId: tenant, amountPaise: 600, method: "cash", receivedOn: "2026-10-02", allocations: [{ chargeId: c, amountPaise: 600 }] }, TODAY);
  const st = ledger.tenantStatement(db, "org", tenant, TODAY);
  assert.deepEqual(st.entries.map((e) => e.balancePaise), [1000, 400]);
  assert.equal(st.balance.outstandingPaise, 400);
});

test("a bill can't be linked to a tenant of another room, and owner floors can't get rent", () => {
  db.run("INSERT INTO rooms (id, org_id, building_id, label, electricity_only, status, created_at) VALUES ('r2','org','b','Owner',1,'owner','now')");
  assert.throws(() => ledger.createCharge(db, ctx, { roomId: "r2", tenantId: tenant, kind: "electricity", amountPaise: 1 }), /does not belong/);
  assert.throws(() => ledger.createCharge(db, ctx, { roomId: "r2", kind: "rent", amountPaise: 1 }), /electricity-only/);
});
