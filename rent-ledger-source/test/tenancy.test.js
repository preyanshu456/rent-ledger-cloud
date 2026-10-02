// Stages 13-14: move-in/move-out records, deposits and settlement; cash-flow
// insights and review alerts.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv({ NOTIFY_MODE: "simulate" });
let ctx, W, manager;

before(async () => {
  ctx = await startServer();
  W = await seedOwnerWorld(ctx);
  const invite = (await ctx.request("POST", "/api/team/invites", { token: W.owner, body: { name: "Meera", contact: "meera@example.com" } })).json;
  manager = (await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Meera", contact: "meera@example.com", password: "manager-pass-1", role: "manager", inviteCode: invite.code } })).json.token;
  assert.ok(manager, "manager signed up");
});
after(() => ctx.close());

test("move-in/move-out records, deposit, and an agreed settlement that flows through the ledger", async () => {
  const t = W.tenant;
  const dep = await ctx.request("POST", `/api/tenants/${t.id}/deposit`, { token: W.owner, body: { amount: 24000, date: "2026-01-01", method: "upi", reference: "UTR-DEP" } });
  assert.equal(dep.status, 201);
  assert.equal(dep.json.held, 24000);
  assert.equal((await ctx.request("POST", `/api/tenants/${t.id}/deposit`, { token: manager, body: { type: "refunded", amount: 100 } })).status, 403, "managers can't refund deposits");

  const rent = await ctx.request("POST", "/api/ledger/charges", { token: W.owner, body: { kind: "rent", roomId: W.room.id, tenantId: t.id, amount: 12000, dueDate: "2026-02-05", month: 2, year: 2026 } });
  assert.equal(rent.status, 201);

  const moveIn = await ctx.request("PUT", `/api/tenants/${t.id}/move-records/move_in`, { token: manager, body: { recordDate: "2026-01-01", meterReadings: { electricity: 1200 }, keysCount: 2, conditionNotes: "Freshly painted" } });
  assert.equal(moveIn.status, 200);
  assert.equal(moveIn.json.checklist.length, 6);
  assert.equal(moveIn.json.meterReadings.electricity, 1200);
  const moveOutRec = await ctx.request("PUT", `/api/tenants/${t.id}/move-records/move_out`, { token: manager, body: { recordDate: "2026-03-01", meterReadings: { electricity: 1650 }, keysCount: 2, checklist: [{ item: "Keys returned", done: true }] } });
  assert.equal(moveOutRec.json.checklist[0].done, true);
  assert.equal((await ctx.request("PUT", `/api/tenants/${t.id}/move-records/other`, { token: W.owner, body: {} })).status, 404);

  let tenancy = (await ctx.request("GET", `/api/tenants/${t.id}/tenancy`, { token: W.owner })).json;
  assert.equal(tenancy.deposit.held, 24000);
  assert.equal(tenancy.balance.outstanding, 12000);
  assert.equal(tenancy.records.move_in.keysCount, 2);
  assert.equal(tenancy.agreedDeposit, 24000);

  assert.equal((await ctx.request("POST", `/api/tenants/${t.id}/move-out`, { token: W.owner, body: { moveOutDate: "2026-03-01" } })).status, 200);

  const draft = await ctx.request("PUT", `/api/tenants/${t.id}/settlement`, { token: manager, body: { deductions: [{ reason: "Broken window", amount: 2000 }], notes: "Window glass replaced" } });
  assert.equal(draft.status, 200);
  assert.equal(draft.json.status, "draft");
  assert.equal(draft.json.depositHeld, 24000);
  assert.equal(draft.json.outstandingDues, 12000);
  assert.equal(draft.json.deductionsTotal, 2000);
  assert.equal(draft.json.refund, 10000);

  assert.equal((await ctx.request("POST", `/api/tenants/${t.id}/settlement/agree`, { token: manager })).status, 403, "only the owner agrees settlements");
  const agreed = await ctx.request("POST", `/api/tenants/${t.id}/settlement/agree`, { token: W.owner });
  assert.equal(agreed.status, 200);
  assert.equal(agreed.json.status, "agreed");
  assert.equal(agreed.json.refund, 10000);
  assert.equal((await ctx.request("POST", `/api/tenants/${t.id}/settlement/agree`, { token: W.owner })).status, 409);
  assert.equal((await ctx.request("PUT", `/api/tenants/${t.id}/settlement`, { token: W.owner, body: { deductions: [] } })).status, 409, "agreed settlements are locked");

  tenancy = (await ctx.request("GET", `/api/tenants/${t.id}/tenancy`, { token: W.owner })).json;
  assert.equal(tenancy.balance.outstanding, 0, "deposit cleared rent and damage");
  assert.equal(tenancy.deposit.appliedToDues, 14000);
  assert.equal(tenancy.deposit.held, 10000);
  const charges = (await ctx.request("GET", `/api/ledger/charges?tenantId=${t.id}`, { token: W.owner })).json;
  const damage = charges.find((c) => c.kind === "damage");
  assert.ok(damage, "deduction became a damage charge");
  assert.equal(damage.amount, 2000);
  assert.equal(damage.status, "paid");
  const payments = (await ctx.request("GET", `/api/ledger/payments?tenantId=${t.id}`, { token: W.owner })).json;
  assert.ok(payments.some((p) => p.method === "deposit_adjustment" && p.amount === 14000));

  const refund = await ctx.request("POST", `/api/tenants/${t.id}/settlement/refund`, { token: W.owner, body: { method: "upi", reference: "UTR-REFUND" } });
  assert.equal(refund.json.status, "refunded");
  tenancy = (await ctx.request("GET", `/api/tenants/${t.id}/tenancy`, { token: W.owner })).json;
  assert.equal(tenancy.deposit.held, 0);
  assert.equal(tenancy.deposit.refunded, 10000);
  assert.equal((await ctx.request("POST", `/api/tenants/${t.id}/deposit`, { token: W.owner, body: { type: "refunded", amount: 1 } })).status, 400, "can't refund more than held");

  const statement = await ctx.request("GET", `/api/tenants/${t.id}/settlement/statement`, { token: W.owner });
  assert.match(statement.text, /Refund due to tenant/);
  assert.match(statement.text, /10,000/);
  assert.match(statement.text, /Broken window/);
  assert.doesNotMatch(statement.text, /<script/i);

  const auditRows = (await ctx.request("GET", "/api/audit?limit=200", { token: W.owner })).json.map((a) => a.action);
  for (const action of ["deposit.received", "deposit.settlement_agreed", "deposit.refunded", "tenancy.move_in_recorded"]) assert.ok(auditRows.includes(action), action);
});

test("insights: labelled forecast with assumptions, and review alerts for duplicate references", async () => {
  const room = (await ctx.request("POST", "/api/rooms", { token: W.owner, body: { buildingId: W.building.id, floorNumber: "2", label: "2B", monthlyRent: "9000" } })).json;
  const tenant = (await ctx.request("POST", "/api/tenants", { token: W.owner, body: { roomId: room.id, name: "Bharat", mobile: "9811111111", moveInDate: "2026-01-01" } })).json;
  for (let i = 0; i < 2; i++) {
    const p = await ctx.request("POST", "/api/ledger/payments", { token: W.owner, body: { tenantId: tenant.id, amount: 9000, method: "upi", reference: "UTR-DUP-1", receivedOn: "2026-04-02", allocate: false } });
    assert.equal(p.status, 201);
  }
  const alerts = (await ctx.request("GET", "/api/insights/anomalies", { token: manager })).json;
  assert.ok(alerts.alerts.some((a) => a.type === "duplicate_reference" && /UTR-DUP-1/.test(a.title)));
  assert.ok(alerts.alerts.some((a) => a.type === "possible_duplicate_payment"));
  assert.ok(alerts.alerts.some((a) => a.type === "unapplied_credit"));
  assert.match(alerts.note, /not conclusions/);

  const cash = (await ctx.request("GET", "/api/insights/cashflow", { token: W.owner })).json;
  assert.equal(cash.forecast.expectedRent, 9000, "only the active tenant's room rent is expected");
  assert.equal(cash.forecast.assumptions.length, 4);
  assert.ok(["falling", "rising", "steady", "not enough history"].includes(cash.forecast.collectionTrend));
  assert.ok(Array.isArray(cash.facts.collectionHistory));
});
