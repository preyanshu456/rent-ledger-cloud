// Stages 8-11: finance dashboard and reports, reminders and the outbox,
// tenant portal additions, maintenance and expenses, background jobs.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv({ NOTIFY_MODE: "simulate" });
let ctx, W, tenantToken;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]).toString("base64");
const today = () => require("../lib/dates").localDate("Asia/Kolkata");
const ymNow = () => today().slice(0, 7);

before(async () => {
  ctx = await startServer();
  W = await seedOwnerWorld(ctx);
  tenantToken = await tenantLogin(ctx, W);
});
after(() => ctx.close());

test("finance summary and reports are derived from the ledger", async () => {
  const [y, m] = ymNow().split("-").map(Number);
  const bill = (await ctx.request("POST", "/api/rent", { token: W.owner, body: { roomId: W.room.id, tenantId: W.tenant.id, month: m, year: y, rentAmount: 10000, amountPaid: 4000, dueDate: `${ymNow()}-01` } })).json;
  assert.equal(bill.status, "partial");
  await ctx.request("POST", "/api/expenses", { token: W.owner, body: { buildingId: W.building.id, category: "repairs", amount: 1500, vendor: "Ravi Plumbing", spentOn: today() } });
  const s = (await ctx.request("GET", "/api/finance/summary", { token: W.owner })).json;
  assert.equal(s.totals.billed, 10000);
  assert.equal(s.totals.collectedOnBills, 4000);
  assert.equal(s.totals.collectionRate, 40);
  assert.equal(s.totals.received, 4000);
  assert.equal(s.totals.expenses, 1500);
  assert.equal(s.totals.netCashFlow, 2500);
  assert.equal(s.totals.outstanding, 6000);
  assert.equal(s.trend.at(-1).month, ymNow());
  assert.equal(s.byProperty[0].net, 2500);
  assert.ok(s.basis);
  const out = (await ctx.request("GET", "/api/reports/outstanding", { token: W.owner })).json;
  assert.equal(out.rows[0][6], 6000);
  const csv = await ctx.request("GET", "/api/reports/rent-collection?format=csv", { token: W.owner });
  assert.match(csv.text, /Month,Property,Room,Tenant,Rent,Collected,Outstanding,Status/);
  const html = await ctx.request("GET", "/api/reports/cash-flow?format=html", { token: W.owner });
  assert.match(html.text, /Monthly cash flow/);
  assert.equal((await ctx.request("GET", "/api/reports/nope", { token: W.owner })).status, 404);
  const dash = (await ctx.request("GET", "/api/dashboard", { token: W.owner })).json;
  assert.equal(dash.rentCollected, 4000);
  assert.equal(dash.rentPending, 6000);
});

test("reminders: preview, draft, edit, approve; in-app delivered, others simulated; no duplicates", async () => {
  await ctx.request("PUT", `/api/tenants/${W.tenant.id}`, { token: W.owner, body: { email: "asha@example.com", notifyEmail: true } });
  await ctx.request("PUT", "/api/org", { token: W.owner, body: { settings: { reminders: { channels: ["inapp", "email"], requireApproval: true } } } });
  const prev = (await ctx.request("GET", "/api/reminders/preview?kind=overdue", { token: W.owner })).json;
  const mine = prev.find((p) => p.tenantId === W.tenant.id);
  assert.ok(mine, "overdue tenant appears in the preview");
  assert.deepEqual(mine.channels.sort(), ["email", "inapp"]);
  assert.match(mine.body, /Asha/);
  assert.match(mine.body, /6,000/);
  const drafts = (await ctx.request("POST", "/api/reminders/drafts", { token: W.owner, body: { kind: "overdue" } })).json;
  assert.equal(drafts.created, 2);
  const again = (await ctx.request("POST", "/api/reminders/drafts", { token: W.owner, body: { kind: "overdue" } })).json;
  assert.equal(again.created, 0);
  assert.equal(again.skippedDuplicates, 2);
  const outbox = (await ctx.request("GET", "/api/outbox?status=draft", { token: W.owner })).json;
  const email = outbox.find((m) => m.channel === "email");
  assert.equal((await ctx.request("PUT", `/api/outbox/${email.id}`, { token: W.owner, body: { body: "Edited reminder text" } })).json.body, "Edited reminder text");
  // nothing is sent before approval
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE tenant_id = ?)", W.tenant.id).n, 0);
  const approve = (await ctx.request("POST", "/api/outbox/approve", { token: W.owner, body: { ids: outbox.map((m) => m.id) } })).json;
  assert.equal(approve.approved, 2);
  assert.equal(approve.mode, "simulate");
  const after = (await ctx.request("GET", "/api/outbox", { token: W.owner })).json;
  assert.equal(after.find((m) => m.channel === "inapp").status, "sent");
  assert.equal(after.find((m) => m.channel === "email").status, "simulated");
  const notes = (await ctx.request("GET", "/api/notifications", { token: tenantToken })).json;
  assert.ok(notes.items.some((n) => /Overdue/.test(n.title)));
});

test("in live mode, a channel without a provider fails clearly (no pretending)", async () => {
  process.env.NOTIFY_MODE = "live";
  try {
    const delivery = require("../services/delivery");
    const orgId = ctx.db.get("SELECT org_id FROM tenants WHERE id = ?", W.tenant.id).org_id;
    ctx.db.run("INSERT INTO outbox (id, org_id, tenant_id, channel, recipient, body, status, created_at) VALUES ('live1', ?, ?, 'sms', '9876543210', 'Hi', 'queued', ?)", orgId, W.tenant.id, new Date().toISOString());
    await delivery.processOutbox(ctx.db);
    const m = ctx.db.get("SELECT * FROM outbox WHERE id = 'live1'");
    assert.equal(m.status, "failed");
    assert.match(m.last_error, /SMS isn't set up/);
  } finally { process.env.NOTIFY_MODE = "simulate"; }
});

test("templates can be edited per language (Hindi included) and reset", async () => {
  const list = (await ctx.request("GET", "/api/reminders/templates", { token: W.owner })).json;
  const hi = list.find((t) => t.key === "rent_overdue" && t.language === "hi");
  assert.match(hi.body, /बकाया/);
  assert.equal((await ctx.request("PUT", "/api/reminders/templates/rent_overdue/hi", { token: W.owner, body: { subject: "बकाया", body: "नमस्ते {{tenantName}}, ₹{{amount}} बकाया है।" } })).status, 200);
  ctx.db.run("UPDATE users SET language = 'hi' WHERE tenant_id = ?", W.tenant.id);
  const prev = (await ctx.request("GET", "/api/reminders/preview?kind=overdue", { token: W.owner })).json.find((p) => p.tenantId === W.tenant.id);
  assert.equal(prev.body, "नमस्ते Asha, ₹6,000 बकाया है।");
  assert.equal((await ctx.request("PUT", "/api/reminders/templates/rent_overdue/hi", { token: W.owner, body: { reset: true } })).json.reset, true);
  ctx.db.run("UPDATE users SET language = 'en' WHERE tenant_id = ?", W.tenant.id);
});

test("tenant portal: balance, upcoming dues, statement, receipts, messages", async () => {
  const portal = (await ctx.request("GET", "/api/tenant/portal", { token: tenantToken })).json;
  assert.equal(portal.balance.outstanding, 6000);
  assert.ok(portal.upcoming.length >= 1);
  const st = (await ctx.request("GET", "/api/tenant/statement", { token: tenantToken })).json;
  assert.equal(st.balance.outstanding, 6000);
  const html = await ctx.request("GET", "/api/tenant/statement?format=html", { token: tenantToken });
  assert.match(html.text, /Statement of account/);
  const receipts = (await ctx.request("GET", "/api/tenant/receipts", { token: tenantToken })).json;
  assert.equal(receipts.length, 1);
  assert.equal((await ctx.request("POST", "/api/tenant/messages", { token: tenantToken, body: { body: "The tap is leaking" } })).status, 201);
  const ownerView = (await ctx.request("GET", `/api/tenants/${W.tenant.id}/messages`, { token: W.owner })).json;
  assert.equal(ownerView.messages[0].body, "The tap is leaking");
  await ctx.request("POST", `/api/tenants/${W.tenant.id}/messages`, { token: W.owner, body: { body: "Plumber coming tomorrow" } });
  const thread = (await ctx.request("GET", "/api/tenant/messages", { token: tenantToken })).json;
  assert.deepEqual(thread.map((m) => m.direction), ["to_owner", "to_tenant"]);
  const prefs = await ctx.request("PUT", "/api/account/preferences", { token: tenantToken, body: { language: "hi", notifySms: true, altMobile: "9000011111" } });
  assert.equal(prefs.json.user.language, "hi");
  assert.equal(ctx.db.get("SELECT notify_sms FROM tenants WHERE id = ?", W.tenant.id).notify_sms, 1);
});

test("maintenance: tenant request with photo → owner workflow → tenant confirms; expense linked once", async () => {
  const created = await ctx.request("POST", "/api/tenant/maintenance", { token: tenantToken, body: { category: "plumbing", title: "Kitchen tap leaking", description: "Drips all night", priority: "high", photos: [{ data: PNG, mimeType: "image/png", originalName: "tap.png" }] } });
  assert.equal(created.status, 201, created.text);
  const id = created.json.id;
  assert.equal(created.json.attachments.length, 1);
  const list = (await ctx.request("GET", "/api/maintenance?status=open", { token: W.owner })).json;
  assert.ok(list.some((r) => r.id === id && r.tenantName === "Asha"));
  assert.equal((await ctx.request("POST", `/api/maintenance/${id}/status`, { token: W.owner, body: { status: "closed_wrong" } })).status, 400);
  await ctx.request("PUT", `/api/maintenance/${id}`, { token: W.owner, body: { assignedTo: "Ravi Plumbing (98xxxx)" } });
  await ctx.request("POST", `/api/maintenance/${id}/status`, { token: W.owner, body: { status: "in_progress", comment: "Plumber booked" } });
  await ctx.request("POST", `/api/maintenance/${id}/comments`, { token: W.owner, body: { comment: "Internal: quote ₹800", visibleToTenant: false } });
  await ctx.request("POST", "/api/expenses", { token: W.owner, body: { buildingId: W.building.id, roomId: W.room.id, maintenanceRequestId: id, category: "maintenance", amount: 800, vendor: "Ravi Plumbing" } });
  await ctx.request("POST", `/api/maintenance/${id}/status`, { token: W.owner, body: { status: "resolved", comment: "Washer replaced" } });
  const tView = (await ctx.request("GET", `/api/tenant/maintenance/${id}`, { token: tenantToken })).json;
  assert.ok(!tView.timeline.some((e) => /Internal/.test(e.comment)), "internal notes are hidden from tenants");
  assert.equal(tView.status, "resolved");
  assert.equal(tView.assignedTo, "Assigned"); // vendor contact not shown to tenant
  const confirm = (await ctx.request("POST", `/api/tenant/maintenance/${id}/confirm`, { token: tenantToken, body: { fixed: true } })).json;
  assert.equal(confirm.status, "closed");
  const detail = (await ctx.request("GET", `/api/maintenance/${id}`, { token: W.owner })).json;
  assert.equal(detail.cost, 800);
  assert.deepEqual(detail.timeline.map((e) => e.to).filter(Boolean), ["submitted", "in_progress", "resolved", "closed"]);
  const expRep = (await ctx.request("GET", "/api/reports/maintenance-expenses", { token: W.owner })).json;
  assert.equal(expRep.rows.filter((r) => r[5] === "Kitchen tap leaking").length, 1);
  const notes = (await ctx.request("GET", "/api/notifications", { token: tenantToken })).json;
  assert.ok(notes.items.some((n) => n.kind === "maintenance"));
});

test("expenses: amounts can't be edited, voiding is owner-only and excluded from totals", async () => {
  const e = (await ctx.request("POST", "/api/expenses", { token: W.owner, body: { buildingId: W.building.id, category: "insurance", amount: 5000 } })).json;
  assert.equal((await ctx.request("PUT", `/api/expenses/${e.id}`, { token: W.owner, body: { amount: 4000 } })).status, 409);
  assert.equal((await ctx.request("PUT", `/api/expenses/${e.id}`, { token: W.owner, body: { vendor: "LIC" } })).json.vendor, "LIC");
  const before = (await ctx.request("GET", "/api/finance/summary", { token: W.owner })).json.totals.expenses;
  assert.equal((await ctx.request("POST", `/api/expenses/${e.id}/void`, { token: W.owner, body: { reason: "Duplicate" } })).json.voided, true);
  const after = (await ctx.request("GET", "/api/finance/summary", { token: W.owner })).json.totals.expenses;
  assert.equal(before - after, 5000);
  assert.equal((await ctx.request("GET", "/api/expenses", { token: tenantToken })).status, 403);
});

test("hourly jobs: rent schedule, automatic reminders (when enabled) and retention", async () => {
  const { runHourly } = require("../services/jobs");
  // automatic reminders off by default: nothing drafted
  const r1 = runHourly(ctx.db);
  assert.equal(r1.reminders, 0);
  // a former tenant past the retention period is anonymised
  const room = (await ctx.request("POST", "/api/rooms", { token: W.owner, body: { buildingId: W.building.id, floorNumber: 3, label: "3A", monthlyRent: 5000 } })).json;
  const old = (await ctx.request("POST", "/api/tenants", { token: W.owner, body: { roomId: room.id, name: "Old Tenant", mobile: "9333300000" } })).json;
  await ctx.request("POST", `/api/tenants/${old.id}/move-out`, { token: W.owner, body: { moveOutDate: "2025-01-01" } });
  await ctx.request("PUT", "/api/org", { token: W.owner, body: { settings: { retention: { anonymizeFormerTenantsAfterDays: 180 } } } });
  const r2 = runHourly(ctx.db);
  assert.equal(r2.anonymized, 1);
  assert.match(ctx.db.get("SELECT name FROM tenants WHERE id = ?", old.id).name, /^Former tenant/);
});
