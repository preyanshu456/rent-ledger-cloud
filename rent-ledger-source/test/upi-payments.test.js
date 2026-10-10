// UPI Intent payments: the tenant's Pay button gets a upi://pay link for the
// right owner's UPI ID and the exact outstanding amount, worked out on the
// server. Nothing is marked paid automatically.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv({ OWNER_SIGNUP: "open" });
const upi = require("../services/upi"); // after setupEnv: config reads DATA_DIR on load
let ctx;
before(async () => { ctx = await startServer(); });
after(() => ctx.close());

const params = (uri) => {
  assert.ok(uri.startsWith("upi://pay?"), uri);
  return Object.fromEntries(uri.slice("upi://pay?".length).split("&").map((kv) => { const [k, ...rest] = kv.split("="); return [k, decodeURIComponent(rest.join("="))]; }));
};

async function ownerWithBills(contact, mobile, months = [["9", "12000"], ["10", "12500"]]) {
  const world = await seedOwnerWorld(ctx, { ownerContact: contact, tenantMobile: mobile });
  world.bills = [];
  for (const [month, amount] of months) {
    const r = await ctx.request("POST", "/api/rent", { token: world.owner, body: { roomId: world.room.id, tenantId: world.tenant.id, month, year: "2026", rentAmount: amount } });
    assert.equal(r.status, 201, r.text);
    world.bills.push(r.json);
  }
  world.tenantToken = await tenantLogin(ctx, world);
  return world;
}

// ---------- the link itself ----------
test("builds a valid UPI link with exact amount, INR, reference and note", () => {
  const uri = upi.buildUri({ vpa: "asha.verma@okaxis", name: "Asha Verma", amountPaise: 1250050, reference: "RLABCDEFGH23", note: "Rent Oct 2026 Room 1A RLABCDEFGH23" });
  assert.match(uri, /^upi:\/\/pay\?pa=asha\.verma@okaxis&/, "the @ is not escaped");
  const p = params(uri);
  assert.deepEqual(p, { pa: "asha.verma@okaxis", pn: "Asha Verma", am: "12500.50", cu: "INR", tr: "RLABCDEFGH23", tn: "Rent Oct 2026 Room 1A RLABCDEFGH23" });
  assert.equal(upi.formatAmount(100), "1.00");
  assert.equal(upi.formatAmount(1_00_000_00), "100000.00");
  assert.throws(() => upi.formatAmount(0));
  assert.throws(() => upi.formatAmount(-5));
  assert.throws(() => upi.formatAmount(10.5));
  assert.throws(() => upi.buildUri({ vpa: "not a vpa", name: "x", amountPaise: 100, reference: "R", note: "" }));
});

test("references are unique and alphanumeric; UPI IDs are validated", () => {
  const refs = new Set(Array.from({ length: 500 }, () => upi.newReference()));
  assert.equal(refs.size, 500);
  for (const r of refs) assert.match(r, /^RL[A-Z0-9]{12}$/);
  for (const ok of ["asha@okaxis", "9876543210@ybl", "a.b-c_d@paytm"]) assert.equal(upi.normaliseVpa(ok), ok);
  for (const bad of ["", "asha", "asha@", "@ybl", "asha@gmail.com", "a b@ybl", "asha@ok axis"]) assert.equal(upi.normaliseVpa(bad), "", bad);
  assert.equal(upi.vpaFromText("UPI: sunrise@upi\nBank: SBI 1234"), "sunrise@upi");
  assert.equal(upi.vpaFromText("Email me at owner@gmail.com"), "");
  assert.equal(upi.vpaFromText("Cash at the office"), "");
});

test("the QR code is an SVG of the link", () => {
  const svg = upi.qrSvg("upi://pay?pa=a1@ybl&am=1.00&cu=INR");
  assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
  assert.ok(svg.includes("<path d=\"M"));
});

// ---------- owner settings ----------
let A, B;
test("tenants can't pay by UPI until the owner has a UPI ID", async () => {
  A = await ownerWithBills("upi-a@example.com", "9000000101");
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portal.json.payments.enabled, false);
  const res = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { all: true } });
  assert.equal(res.status, 409);
  assert.equal(res.json.code, "no_upi_id");
  assert.equal((await ctx.request("GET", "/api/dashboard", { token: A.owner })).json.onlinePaymentsEnabled, false);
});

test("the owner saves a UPI ID; bad ones are refused; only the owner can change it", async () => {
  const bad = await ctx.request("PUT", "/api/org", { token: A.owner, body: { settings: { payments: { upiId: "owner@gmail.com" } } } });
  assert.equal(bad.status, 400);
  const tenantTry = await ctx.request("PUT", "/api/org", { token: A.tenantToken, body: { settings: { payments: { upiId: "evil@ybl" } } } });
  assert.equal(tenantTry.status, 403);
  const ok = await ctx.request("PUT", "/api/org", { token: A.owner, body: { settings: { payments: { upiId: "owner.a@okaxis", payeeName: "Ravi Sharma" } } } });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.upi, { upiId: "owner.a@okaxis", payeeName: "Ravi Sharma", source: "setting" });
  // Saving other settings keeps it.
  const other = await ctx.request("PUT", "/api/org", { token: A.owner, body: { settings: { bills: { paymentDetails: "Cash at the office" } } } });
  assert.equal(other.json.settings.payments.upiId, "owner.a@okaxis");
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portal.json.payments.enabled, true);
  assert.equal(portal.json.payments.upiId, "owner.a@okaxis");
});

test("an owner who only wrote their UPI ID in 'How to pay' is picked up too", async () => {
  B = await ownerWithBills("upi-b@example.com", "9000000102", [["10", "8000"]]);
  await ctx.request("PUT", "/api/org", { token: B.owner, body: { settings: { bills: { paymentDetails: "UPI: owner-b@ybl\nCash at the office" } } } });
  const org = await ctx.request("GET", "/api/org", { token: B.owner });
  assert.deepEqual(org.json.upi, { upiId: "owner-b@ybl", payeeName: "Owner", source: "payment_details" });
});

// ---------- paying ----------
let first;
test("Pay all: amount and recipient come from the server, not the browser", async () => {
  const res = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { all: true, amount: 1, upiId: "attacker@ybl", vpa: "attacker@ybl", payee: { upiId: "attacker@ybl" } } });
  assert.equal(res.status, 201, res.text);
  first = res.json;
  assert.equal(first.amount, 24500);
  assert.equal(first.status, "pending");
  assert.equal(first.verified, false);
  assert.deepEqual(first.payee, { upiId: "owner.a@okaxis", name: "Ravi Sharma" });
  const p = params(first.uri);
  assert.equal(p.pa, "owner.a@okaxis");
  assert.equal(p.pn, "Ravi Sharma");
  assert.equal(p.am, "24500.00");
  assert.equal(p.cu, "INR");
  assert.equal(p.tr, first.reference);
  assert.ok(p.tn.endsWith(first.reference) && p.tn.includes("Rent") && p.tn.includes("1A"), p.tn);
  assert.match(first.qrSvg, /^<svg /);
  assert.equal(first.items.length, 2);
});

test("starting a payment does not mark anything paid or create a ledger payment", async () => {
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portal.json.balance.outstanding, 24500);
  assert.ok(portal.json.rent.every((r) => r.status !== "paid"));
  assert.equal(portal.json.payments.pending.length, 1);
  assert.equal(portal.json.payments.pending[0].reference, first.reference);
  const payments = await ctx.request("GET", "/api/ledger/payments", { token: A.owner });
  assert.equal(payments.status, 200);
  assert.equal(payments.json.length, 0);
});

test("asking again for the same bills reuses the same request (no duplicates)", async () => {
  const again = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { all: true } });
  assert.equal(again.status, 200);
  assert.equal(again.json.reused, true);
  assert.equal(again.json.id, first.id);
  assert.equal(again.json.reference, first.reference);
  const dash = await ctx.request("GET", "/api/payments", { token: A.owner });
  assert.equal(dash.json.filter((p) => p.provider === "upi").length, 1);
});

test("paying a single bill replaces the earlier unfinished request", async () => {
  const one = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { items: [{ kind: "rent", id: A.bills[0].id, amount: 5 }] } });
  assert.equal(one.status, 201, one.text);
  assert.equal(one.json.amount, 12000);
  assert.notEqual(one.json.reference, first.reference);
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.deepEqual(portal.json.payments.pending.map((p) => p.reference), [one.json.reference]);
  // The replaced request can't be reported as paid any more.
  assert.equal((await ctx.request("POST", `/api/tenant/payments/upi/${first.id}/reported`, { token: A.tenantToken })).status, 409);
  first = one.json;
});

test("the tenant can say they paid: the owner is told, but it stays pending and unpaid", async () => {
  const rep = await ctx.request("POST", `/api/tenant/payments/upi/${first.id}/reported`, { token: A.tenantToken });
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.json.status, "pending");
  assert.equal(rep.json.verified, false);
  assert.ok(rep.json.reportedAt);
  const notes = await ctx.request("GET", "/api/notifications", { token: A.owner });
  const list = Array.isArray(notes.json) ? notes.json : notes.json.items || notes.json.notifications || [];
  assert.ok(list.some((n) => String(n.body || "").includes(first.reference)), JSON.stringify(notes.json).slice(0, 300));
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portal.json.balance.outstanding, 24500, "nothing is marked paid");
  const dash = await ctx.request("GET", "/api/payments", { token: A.owner });
  const row = dash.json.find((p) => p.id === first.id);
  assert.equal(row.status, "pending");
  assert.equal(row.verified, false);
  assert.ok(row.reportedAt);
  // Once reported it can't be cancelled, and a new request doesn't replace it.
  assert.equal((await ctx.request("POST", `/api/tenant/payments/upi/${first.id}/cancel`, { token: A.tenantToken })).status, 409);
});

test("cancelling (no UPI app, changed mind) closes the request", async () => {
  const res = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { items: [{ id: A.bills[1].id }] } });
  assert.equal(res.status, 201);
  const cancel = await ctx.request("POST", `/api/tenant/payments/upi/${res.json.id}/cancel`, { token: A.tenantToken, body: { reason: "No UPI app" } });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.status, "cancelled");
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.ok(!portal.json.payments.pending.some((p) => p.id === res.json.id));
});

test("each tenant pays their own owner's UPI ID, and can't touch another tenant's request", async () => {
  const resB = await ctx.request("POST", "/api/tenant/payments/upi", { token: B.tenantToken, body: { all: true } });
  assert.equal(resB.status, 201, resB.text);
  assert.equal(params(resB.json.uri).pa, "owner-b@ybl");
  assert.equal(resB.json.amount, 8000);
  // B's tenant can't ask to pay A's bill, or report/cancel A's request.
  assert.equal((await ctx.request("POST", "/api/tenant/payments/upi", { token: B.tenantToken, body: { items: [{ id: A.bills[0].id }] } })).status, 404);
  assert.equal((await ctx.request("POST", `/api/tenant/payments/upi/${first.id}/reported`, { token: B.tenantToken })).status, 404);
  assert.equal((await ctx.request("POST", `/api/tenant/payments/upi/${first.id}/cancel`, { token: B.tenantToken })).status, 404);
  // A's owner doesn't see B's requests.
  const dashA = await ctx.request("GET", "/api/payments", { token: A.owner });
  assert.ok(!dashA.json.some((p) => p.id === resB.json.id));
  // Staff can't start tenant payments.
  assert.equal((await ctx.request("POST", "/api/tenant/payments/upi", { token: A.owner, body: { all: true } })).status, 403);
});

test("nothing pending means nothing to pay; paid bills drop out of the amount", async () => {
  // The owner records the money they received for September (as usual).
  const paid = await ctx.request("PUT", `/api/rent/${A.bills[0].id}`, { token: A.owner, body: { amountPaid: 12000 } });
  assert.equal(paid.status, 200, paid.text);
  const res = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { all: true } });
  assert.equal(res.json.amount, 12500);
  assert.equal(params(res.json.uri).am, "12500.00");
  await ctx.request("PUT", `/api/rent/${A.bills[1].id}`, { token: A.owner, body: { amountPaid: 12500 } });
  const none = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: { all: true } });
  assert.equal(none.status, 400);
  const empty = await ctx.request("POST", "/api/tenant/payments/upi", { token: A.tenantToken, body: {} });
  assert.equal(empty.status, 400);
});

// ---------- the database change ----------
test("the migration keeps old Razorpay payment history and removes saved Razorpay keys", () => {
  const dir = path.join(__dirname, "..", "migrations");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  for (const f of fs.readdirSync(dir).filter((n) => /^00[1-5]_/.test(n)).sort()) db.exec(fs.readFileSync(path.join(dir, f), "utf-8"));
  db.prepare("INSERT INTO payment_orders (id, org_id, tenant_id, room_id, razorpay_order_id, amount_paise, currency, items_json, status, payment_id, method, created_at, paid_at, key_id) VALUES ('o1','org','t','r','order_X',120000,'INR','[]','paid','p1','upi','2026-09-01','2026-09-01','rzp_live_X')").run();
  db.prepare("INSERT INTO org_payment_accounts (org_id, key_id, key_secret_enc, mode, created_at, updated_at) VALUES ('org','rzp_live_X','enc','live','x','x')").run();
  db.exec(fs.readFileSync(path.join(dir, "006_upi_intent.sql"), "utf-8"));
  const row = db.prepare("SELECT * FROM payment_orders WHERE id = 'o1'").get();
  assert.equal(row.provider, "razorpay");
  assert.equal(row.razorpay_order_id, "order_X");
  assert.equal(row.status, "paid");
  assert.equal(row.amount_paise, 120000);
  assert.equal(row.payment_id, "p1");
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'org_payment_accounts'").get(), undefined);
  assert.throws(() => db.prepare("INSERT INTO payment_orders (id, org_id, tenant_id, room_id, provider, amount_paise, items_json, status, created_at) VALUES ('o2','org','t','r','upi',100,'[]','paid_ish','x')").run());
});
