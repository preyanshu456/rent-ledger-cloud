// Stages 4-7: organisations and roles, leases and rent schedules, the ledger
// API, payment proofs, reconciliation and documents.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv({ OWNER_SIGNUP: "open" });
let ctx, A, B;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
const PDF = Buffer.from("%PDF-1.4\n% test\n").toString("base64");

before(async () => {
  ctx = await startServer();
  A = await seedOwnerWorld(ctx, { ownerContact: "a@example.com", tenantMobile: "9811111111" });
  B = await seedOwnerWorld(ctx, { ownerContact: "b@example.com", tenantMobile: "9822222222" });
});
after(() => ctx.close());

test("each landlord sees only their own records", async () => {
  const roomsA = (await ctx.request("GET", "/api/rooms", { token: A.owner })).json;
  assert.ok(roomsA.every((r) => r.id !== B.room.id));
  assert.equal((await ctx.request("PUT", `/api/rooms/${B.room.id}`, { token: A.owner, body: { label: "hijack" } })).status, 404);
  assert.equal((await ctx.request("GET", `/api/tenants/${B.tenant.id}`, { token: A.owner })).status, 404);
  assert.equal((await ctx.request("POST", "/api/rent", { token: A.owner, body: { roomId: B.room.id, month: 1, year: 2026, rentAmount: 1 } })).status, 404);
  assert.equal((await ctx.request("GET", `/api/ledger/tenants/${B.tenant.id}/statement`, { token: A.owner })).status, 404);
  const bAuth = (await ctx.request("GET", "/api/authorities", { token: B.owner })).json;
  const aAuth = (await ctx.request("GET", "/api/authorities", { token: A.owner })).json;
  assert.ok(bAuth.length > 0 && aAuth.every((a) => !bAuth.some((b) => b.id === a.id)));
});

test("managers run day-to-day work but can't reverse money, export data or manage the team", async () => {
  const invite = await ctx.request("POST", "/api/team/invites", { token: A.owner, body: { name: "Manny", contact: "manny@example.com" } });
  assert.equal(invite.status, 201);
  const wrong = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Manny", contact: "manny@example.com", password: "manager-pass-1", role: "manager", inviteCode: "AAAA-BBBB" } });
  assert.equal(wrong.status, 400);
  const signup = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Manny", contact: "manny@example.com", password: "manager-pass-1", role: "manager", inviteCode: invite.json.code } });
  assert.equal(signup.status, 201, signup.text);
  const m = signup.json.token;
  A.manager = m;
  assert.equal(signup.json.user.role, "manager");
  const room = await ctx.request("POST", "/api/rooms", { token: m, body: { buildingId: A.building.id, floorNumber: 2, label: "2B", monthlyRent: 9000 } });
  assert.equal(room.status, 201);
  const pay = await ctx.request("POST", "/api/ledger/payments", { token: m, body: { tenantId: A.tenant.id, amount: 100, method: "cash" } });
  assert.equal(pay.status, 201);
  assert.equal((await ctx.request("POST", `/api/ledger/payments/${pay.json.id}/reverse`, { token: m, body: { reason: "x" } })).status, 403);
  assert.equal((await ctx.request("GET", "/api/admin/export", { token: m })).status, 403);
  assert.equal((await ctx.request("GET", "/api/team", { token: m })).status, 403);
  assert.equal((await ctx.request("GET", "/api/audit", { token: m })).status, 403);
  assert.equal((await ctx.request("DELETE", `/api/buildings/${A.building.id}`, { token: m })).status, 403);
  const me = await ctx.request("GET", "/api/auth/me", { token: m });
  assert.ok(me.json.permissions.includes("payments.record") && !me.json.permissions.includes("*"));
  // owner reverses the manager's test payment
  assert.equal((await ctx.request("POST", `/api/ledger/payments/${pay.json.id}/reverse`, { token: A.owner, body: { reason: "Test entry" } })).status, 200);
});

test("leases: draft → active creates rent charges once; active terms are locked; renewal and end", async () => {
  const lease = await ctx.request("POST", "/api/leases", { token: A.owner, body: { tenantId: A.tenant.id, startDate: "2026-07-01", endDate: "2027-05-31", rent: 12000, deposit: 24000, dueDay: 5 } });
  assert.equal(lease.status, 201, lease.text);
  assert.equal(lease.json.status, "draft");
  const act = await ctx.request("POST", `/api/leases/${lease.json.id}/activate`, { token: A.owner, body: { billFrom: "2026-08" } });
  assert.equal(act.status, 200, act.text);
  assert.ok(act.json.chargesCreated >= 2); // Aug .. current month
  const rent = (await ctx.request("GET", `/api/rent?roomId=${A.room.id}`, { token: A.owner })).json.filter((r) => r.leaseId === lease.json.id);
  assert.ok(rent.some((r) => r.month === 8 && r.year === 2026 && r.dueDate === "2026-08-05" && r.rentAmount === 12000));
  assert.ok(!rent.some((r) => r.month === 7 && r.year === 2026)); // before billFrom
  // the job can run again without duplicating
  const { generateDueCharges } = require("../services/schedules");
  assert.equal(generateDueCharges(ctx.db, () => new Date().toISOString().slice(0, 10)), 0);
  assert.equal((await ctx.request("PUT", `/api/leases/${lease.json.id}`, { token: A.owner, body: { rent: 15000 } })).status, 409);
  assert.equal((await ctx.request("PUT", `/api/leases/${lease.json.id}`, { token: A.owner, body: { terms: "No pets" } })).status, 200);
  const renew = await ctx.request("POST", `/api/leases/${lease.json.id}/renew`, { token: A.owner, body: { rent: 13000, endDate: "2028-05-31" } });
  assert.equal(renew.status, 201);
  assert.equal(renew.json.startDate, "2027-06-01");
  assert.equal(renew.json.renewalOfLeaseId, lease.json.id);
  const expiring = (await ctx.request("GET", "/api/leases?expiringWithinDays=400", { token: A.owner })).json;
  assert.ok(expiring.some((l) => l.id === lease.json.id));
  A.lease = lease.json;
});

test("ledger API: record a cash payment, print a receipt, statement CSV is formula-safe", async () => {
  const bill = (await ctx.request("POST", "/api/ledger/charges", { token: A.owner, body: { roomId: A.room.id, tenantId: A.tenant.id, kind: "other", amount: 500, description: "=cmd|' /C calc'!A0", dueDate: "2026-09-01" } })).json;
  assert.equal(bill.status, "overdue");
  const pay = await ctx.request("POST", "/api/ledger/payments", { token: A.owner, body: { tenantId: A.tenant.id, amount: 500, method: "upi", reference: "UPI123", allocations: [{ chargeId: bill.id, amount: 500 }], idempotencyKey: "k1" } });
  assert.equal(pay.status, 201, pay.text);
  assert.equal(pay.json.verification, "recorded");
  const again = await ctx.request("POST", "/api/ledger/payments", { token: A.owner, body: { tenantId: A.tenant.id, amount: 500, method: "upi", allocations: [{ chargeId: bill.id, amount: 500 }], idempotencyKey: "k1" } });
  assert.equal(again.status, 200);
  assert.equal(again.json.duplicate, true);
  const receipt = await ctx.request("GET", `/api/ledger/payments/${pay.json.id}/receipt`, { token: A.owner });
  assert.match(receipt.text, /Payment receipt/);
  assert.match(receipt.text, /₹500/);
  assert.ok(!receipt.text.includes("<script"));
  const csv = await ctx.request("GET", `/api/ledger/tenants/${A.tenant.id}/statement?format=csv`, { token: A.owner });
  assert.match(csv.headers.get("content-type"), /text\/csv/);
  assert.ok(!csv.text.split(/\r?\n/).some((line) => line.split(",").some((cell) => /^"?[=+@]/.test(cell))), "no cell starts with a formula");
  // a tenant sees their own receipt, not other tenants'
  const tA = await tenantLogin(ctx, A, { password: "tenant-pass-1" });
  A.tenantToken = tA;
  assert.equal((await ctx.request("GET", `/api/ledger/payments/${pay.json.id}/receipt`, { token: tA })).status, 200);
  const tB = await tenantLogin(ctx, B, { password: "tenant-pass-2" });
  B.tenantToken = tB;
  assert.equal((await ctx.request("GET", `/api/ledger/payments/${pay.json.id}/receipt`, { token: tB })).status, 404);
  assert.equal((await ctx.request("GET", "/api/ledger/payments", { token: tA })).status, 403);
});

test("waivers are owner-only and need a reason", async () => {
  const bill = (await ctx.request("POST", "/api/ledger/charges", { token: A.owner, body: { roomId: A.room.id, tenantId: A.tenant.id, kind: "late_fee", amount: 200 } })).json;
  assert.equal((await ctx.request("POST", `/api/ledger/charges/${bill.id}/adjust`, { token: A.manager, body: { kind: "waiver", amount: 200, reason: "goodwill" } })).status, 403);
  assert.equal((await ctx.request("POST", `/api/ledger/charges/${bill.id}/adjust`, { token: A.owner, body: { kind: "waiver", amount: 200 } })).status, 400);
  const ok = await ctx.request("POST", `/api/ledger/charges/${bill.id}/adjust`, { token: A.owner, body: { kind: "waiver", amount: 200, reason: "Goodwill" } });
  assert.equal(ok.json.status, "waived");
  const detail = await ctx.request("GET", `/api/ledger/charges/${bill.id}`, { token: A.owner });
  assert.equal(detail.json.adjustments[0].reason, "Goodwill");
});

test("payment proof: tenant uploads, owner accepts, payment is recorded with the evidence", async () => {
  const bill = (await ctx.request("POST", "/api/rent", { token: A.owner, body: { roomId: A.room.id, tenantId: A.tenant.id, month: 12, year: 2026, rentAmount: 12000 } })).json;
  const up = await ctx.request("POST", `/api/tenant/rent/${bill.id}/receipt`, { token: A.tenantToken, body: { data: PNG, mimeType: "image/png", originalName: "upi.png" } });
  assert.equal(up.status, 201, up.text);
  assert.equal((await ctx.request("GET", `/api/rent?roomId=${A.room.id}`, { token: A.owner })).json.find((r) => r.id === bill.id).status, "due");
  const review = await ctx.request("POST", `/api/receipts/${up.json.receipt.id}/review`, { token: A.owner, body: { decision: "accept", method: "upi", reference: "UTR999" } });
  assert.equal(review.status, 200, review.text);
  const after = (await ctx.request("GET", `/api/rent?roomId=${A.room.id}`, { token: A.owner })).json.find((r) => r.id === bill.id);
  assert.equal(after.status, "paid");
  assert.equal(after.receipt.reviewStatus, "accepted");
  const p = ctx.db.get("SELECT * FROM payments WHERE id = ?", review.json.paymentId);
  assert.equal(p.evidence_document_id, up.json.receipt.id);
  assert.equal(p.verification, "recorded");
});

test("reconciliation: import, de-duplicate, suggest with evidence, confirm once", async () => {
  const bill = (await ctx.request("POST", "/api/rent", { token: A.owner, body: { roomId: A.room.id, tenantId: A.tenant.id, month: 11, year: 2026, rentAmount: 12345, dueDate: "2026-11-05" } })).json;
  const csv = [
    "Txn Date,Narration,Ref No,Debit,Credit,Balance",
    `03/11/2026,UPI/CR/412345678901/ASHA/SBIN/asha@okaxis/Rent,412345678901,,"12,345.00",50000`,
    "04/11/2026,ATM WITHDRAWAL,ATM1,2000.00,,48000",
    "05/11/2026,NEFT FROM UNKNOWN PERSON,N123,,777.00,48777",
  ].join("\n");
  const imp = await ctx.request("POST", "/api/reconciliation/imports", { token: A.owner, body: { csv, fileName: "nov.csv" } });
  assert.equal(imp.status, 201, imp.text);
  assert.equal(imp.json.imported, 2);
  assert.equal(imp.json.skipped, 1);
  const again = await ctx.request("POST", "/api/reconciliation/imports", { token: A.owner, body: { csv, fileName: "nov.csv" } });
  assert.equal(again.json.imported, 0);
  assert.equal(again.json.duplicates, 2);
  const txns = (await ctx.request("GET", "/api/reconciliation/transactions?status=unmatched", { token: A.owner })).json;
  const credit = txns.find((t) => t.amount === 12345);
  assert.equal(credit.reference, "412345678901");
  const sug = (await ctx.request("GET", `/api/reconciliation/transactions/${credit.id}/suggestions`, { token: A.owner })).json;
  const top = sug.suggestions[0];
  assert.equal(top.tenantId, A.tenant.id);
  assert.equal(top.confidence, "high");
  assert.ok(top.evidence.some((e) => /name/.test(e)) && top.evidence.some((e) => /Amount equals/.test(e)));
  assert.equal(top.allocations[0].chargeId, bill.id);
  const confirm = await ctx.request("POST", `/api/reconciliation/transactions/${credit.id}/confirm`, { token: A.owner, body: { tenantId: A.tenant.id, allocations: top.allocations } });
  assert.equal(confirm.status, 200, confirm.text);
  const twice = await ctx.request("POST", `/api/reconciliation/transactions/${credit.id}/confirm`, { token: A.owner, body: { tenantId: A.tenant.id } });
  assert.equal(twice.json.alreadyMatched, true);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM payments WHERE idempotency_key = ?", `bank:${credit.id}`).n, 1);
  const paid = (await ctx.request("GET", `/api/rent?roomId=${A.room.id}`, { token: A.owner })).json.find((r) => r.id === bill.id);
  assert.equal(paid.status, "paid");
  assert.equal(ctx.db.get("SELECT verification FROM payments WHERE id = ?", confirm.json.paymentId).verification, "verified");
  const unknown = txns.find((t) => t.amount === 777);
  assert.equal((await ctx.request("POST", `/api/reconciliation/transactions/${unknown.id}/ignore`, { token: A.owner, body: { reason: "Not rent" } })).status, 200);
});

test("documents: tenants see only files shared with them", async () => {
  const up = await ctx.request("POST", `/api/leases/${A.lease.id}/documents`, { token: A.owner, body: { data: PDF, mimeType: "application/pdf", originalName: "lease.pdf" } });
  assert.equal(up.status, 201, up.text);
  const priv = await ctx.request("POST", "/api/documents", { token: A.owner, body: { entityType: "tenant", entityId: A.tenant.id, kind: "id_proof", data: PNG, mimeType: "image/png", originalName: "id.png" } });
  assert.equal(priv.status, 201);
  const list = (await ctx.request("GET", "/api/tenant/documents", { token: A.tenantToken })).json;
  assert.deepEqual(list.map((d) => d.id), [up.json.id]);
  assert.equal((await ctx.request("GET", `/api/documents/${up.json.id}/file`, { token: A.tenantToken })).status, 200);
  assert.equal((await ctx.request("GET", `/api/documents/${priv.json.id}/file`, { token: A.tenantToken })).status, 404);
  assert.equal((await ctx.request("GET", `/api/documents/${up.json.id}/file`, { token: B.tenantToken })).status, 404);
  assert.equal((await ctx.request("GET", `/api/documents/${up.json.id}/file`, { token: B.owner })).status, 404);
  const bad = await ctx.request("POST", "/api/documents", { token: A.owner, body: { entityType: "tenant", entityId: A.tenant.id, data: Buffer.from("<svg onload=alert(1)>").toString("base64"), mimeType: "image/png" } });
  assert.equal(bad.status, 400);
});

test("lease details can be suggested from pasted agreement text", async () => {
  const res = await ctx.request("POST", "/api/leases/extract", { token: A.owner, body: { text: "The monthly rent is Rs. 15,500/- payable on or before the 7th day of each month. Security deposit of ₹31,000. The tenancy shall commence from 01/12/2026." } });
  assert.equal(res.json.fields.rent.value, 15500);
  assert.equal(res.json.fields.deposit.value, 31000);
  assert.equal(res.json.fields.dueDay.value, 7);
  assert.equal(res.json.fields.startDate.value, "2026-12-01");
});

test("a building with financial history can't be deleted, only archived", async () => {
  const del = await ctx.request("DELETE", `/api/buildings/${A.building.id}`, { token: A.owner });
  assert.equal(del.status, 409);
  const arch = await ctx.request("POST", `/api/buildings/${A.building.id}/archive`, { token: A.owner });
  assert.equal(arch.status, 409); // active tenant still there
  const empty = (await ctx.request("POST", "/api/buildings", { token: A.owner, body: { name: "Empty plot", propertyType: "commercial", amenities: "parking, lift" } })).json;
  assert.deepEqual(empty.amenities, ["parking", "lift"]);
  assert.equal((await ctx.request("POST", `/api/buildings/${empty.id}/archive`, { token: A.owner })).json.status, "archived");
  assert.equal((await ctx.request("DELETE", `/api/buildings/${empty.id}`, { token: A.owner })).status, 200);
});

test("audit log records sensitive actions for the owner", async () => {
  const log = (await ctx.request("GET", "/api/audit?limit=500", { token: A.owner })).json;
  const actions = new Set(log.map((r) => r.action));
  for (const a of ["payment.recorded", "payment.reversed", "charge.adjusted", "lease.activated", "reconciliation.matched", "team.invite_created"]) assert.ok(actions.has(a), a);
  const bLog = (await ctx.request("GET", "/api/audit?limit=500", { token: B.owner })).json;
  assert.ok(!bLog.some((r) => r.action === "reconciliation.matched"));
});
