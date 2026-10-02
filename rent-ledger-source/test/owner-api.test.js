const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

const dataDir = setupEnv();
let ctx;
let world;

before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
});
after(() => ctx.close());

test("existing owner flows still work: building, room, tenant, rent, electricity, gas", async () => {
  const { owner, room, tenant } = world;
  const rent = await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: tenant.id, month: "9", year: "2026", rentAmount: "12000", amountPaid: "5000", dueDate: "2026-09-05", paidDate: "", notes: "" } });
  assert.equal(rent.status, 201, rent.text);
  assert.equal(rent.json.status, "partial");
  const paid = await ctx.request("PUT", `/api/rent/${rent.json.id}`, { token: owner, body: { amountPaid: 12000, paidDate: "2026-09-10" } });
  assert.equal(paid.json.status, "paid");

  const elec = await ctx.request("POST", "/api/electricity", { token: owner, body: { roomId: room.id, tenantId: tenant.id, month: "9", year: "2026", prevReading: "100", currReading: "160", ratePerUnit: "8", paidDate: "" } });
  assert.equal(elec.status, 201, elec.text);
  assert.equal(elec.json.amount, 480);
  assert.equal(elec.json.status, "due");

  const igl = (await ctx.request("GET", "/api/authorities", { token: owner })).json;
  // authorities are seeded at start(), which tests don't call: add one
  const authority = igl[0] || (await ctx.request("POST", "/api/authorities", { token: owner, body: { name: "Test Gas Co", billUrl: "gas.example.com" } })).json;
  assert.equal((await ctx.request("PUT", `/api/rooms/${room.id}/gas-meter`, { token: owner, body: { meterId: "BP123", authorityId: authority.id } })).status, 200);
  const gas = await ctx.request("POST", "/api/gas", { token: owner, body: { roomId: room.id, tenantId: tenant.id, month: "9", year: "2026", amount: "650" } });
  assert.equal(gas.status, 201, gas.text);
  assert.equal(gas.json.meterId, "BP123");

  const dash = await ctx.request("GET", "/api/dashboard", { token: owner });
  assert.equal(dash.status, 200);
  assert.equal(dash.json.totalRooms, 1);
});

test("validation rejects bad input with a readable message", async () => {
  const { owner, room } = world;
  const badMonth = await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, month: "13", year: "2026", rentAmount: "100" } });
  assert.equal(badMonth.status, 400);
  assert.match(badMonth.json.error, /Month/);
  const negative = await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, month: "1", year: "2026", rentAmount: "-5" } });
  assert.equal(negative.status, 400);
  const notNumber = await ctx.request("POST", "/api/electricity", { token: owner, body: { roomId: room.id, month: "1", year: "2026", currReading: "abc" } });
  assert.equal(notNumber.status, 400);
  const badDate = await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, month: "1", year: "2026", dueDate: "2026-02-30" } });
  assert.equal(badDate.status, 400);
  const noName = await ctx.request("POST", "/api/buildings", { token: owner, body: { name: "  " } });
  assert.equal(noName.status, 400);
  const badMobile = await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: room.id, name: "X", mobile: "12" } });
  assert.ok([400, 409].includes(badMobile.status));
});

test("updates ignore fields that must not be changed through the API", async () => {
  const { owner, room, tenant } = world;
  const entry = (await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: tenant.id, month: "8", year: "2026", rentAmount: "12000" } })).json;
  const res = await ctx.request("PUT", `/api/rent/${entry.id}`, { token: owner, body: { roomId: "other-room", tenantId: "someone-else", status: "paid", receipt: { id: "x", fileName: "../../etc/passwd" }, id: "new-id", notes: "ok" } });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, entry.id);
  assert.equal(res.json.roomId, room.id);
  assert.equal(res.json.tenantId, tenant.id);
  assert.equal(res.json.status, "due");
  assert.equal(res.json.receipt, undefined);
  assert.equal(res.json.notes, "ok");

  const t = await ctx.request("PUT", `/api/tenants/${tenant.id}`, { token: owner, body: { active: false, roomId: "elsewhere", notes: "quiet" } });
  assert.equal(t.json.active, true);
  assert.equal(t.json.roomId, room.id);
  assert.equal(t.json.notes, "quiet");
});

test("a bill cannot be linked to a tenant from another room", async () => {
  const { owner, building, room } = world;
  const other = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "1", label: "1B", monthlyRent: "8000" } })).json;
  const otherTenant = (await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: other.id, name: "Bina", mobile: "9000000001" } })).json;
  const res = await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: otherTenant.id, month: "1", year: "2026", rentAmount: "1" } });
  assert.equal(res.status, 400);
});

test("only one active tenant per room, and mobile numbers are unique among active tenants", async () => {
  const { owner, building, room } = world;
  const second = await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: room.id, name: "Second", mobile: "9555555555" } });
  assert.equal(second.status, 409);
  const spare = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "2", label: "2C", monthlyRent: "7000" } })).json;
  const sameMobile = await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: spare.id, name: "Copy", mobile: `+91${world.tenant.mobile}` } });
  assert.equal(sameMobile.status, 409);
  const ownerFloor = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "0", label: "Owner", electricityOnly: true } })).json;
  const onOwnerFloor = await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: ownerFloor.id, name: "No", mobile: "9444444444" } });
  assert.equal(onOwnerFloor.status, 400);
});

test("tenant profile shows the room's deposit instead of ₹0", async () => {
  const token = await tenantLogin(ctx, world);
  const profile = await ctx.request("GET", "/api/account/profile", { token });
  assert.equal(profile.status, 200);
  assert.equal(profile.json.tenant.deposit, 24000);
  // Older records with no tenant.deposit fall back to the room's deposit.
  ctx.db.run("UPDATE tenants SET deposit_paise = NULL WHERE id = ?", world.tenant.id);
  assert.equal((await ctx.request("GET", "/api/account/profile", { token })).json.tenant.deposit, 24000);
  world.tenantToken = token;
});

test("tenants cannot use owner endpoints or see other tenants' bills", async () => {
  const token = world.tenantToken;
  assert.equal((await ctx.request("GET", "/api/buildings", { token })).status, 403);
  assert.equal((await ctx.request("GET", "/api/admin/export", { token })).status, 403);
  // A bill for a different tenant in another room
  const { owner, building } = world;
  const room = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "3", label: "3A", monthlyRent: "5000" } })).json;
  const other = (await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: room.id, name: "Other", mobile: "9333333333" } })).json;
  const bill = (await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: other.id, month: "9", year: "2026", rentAmount: "5000" } })).json;
  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  const upload = await ctx.request("POST", `/api/tenant/rent/${bill.id}/receipt`, { token, body: { data: pngBase64, mimeType: "image/png", originalName: "proof.png" } });
  assert.equal(upload.status, 404);
  const portal = await ctx.request("GET", "/api/tenant/portal", { token });
  assert.ok(portal.json.rent.every((e) => e.tenantId === world.tenant.id));
});

test("tenant can upload a payment proof for their own bill; it does not mark the bill paid", async () => {
  const { owner, room, tenant } = world;
  const bill = (await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: tenant.id, month: "10", year: "2026", rentAmount: "12000" } })).json;
  const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]).toString("base64");
  const upload = await ctx.request("POST", `/api/tenant/rent/${bill.id}/receipt`, { token: world.tenantToken, body: { data: pngBase64, mimeType: "image/png", originalName: "proof.png" } });
  assert.equal(upload.status, 201, upload.text);
  const rentList = (await ctx.request("GET", `/api/rent?roomId=${room.id}`, { token: owner })).json;
  const stored = rentList.find((e) => e.id === bill.id);
  assert.equal(stored.status, "due");
  assert.equal(stored.amountPaid, 0);
  assert.equal(stored.receipt.reviewStatus, "unverified");
  const view = await ctx.request("GET", `/api/receipts/${stored.receipt.id}`, { token: owner });
  assert.equal(view.status, 200);
  assert.equal(view.headers.get("x-content-type-options"), "nosniff");
});

test("moving a tenant out removes their login, invite and identity details but keeps bills", async () => {
  const { owner, building } = world;
  const room = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "4", label: "4A", monthlyRent: "5000" } })).json;
  const t = (await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: room.id, name: "Leaving", mobile: "9222222222", idProofNumber: "ABCDE1234F" } })).json;
  await ctx.request("POST", `/api/tenants/${t.id}/invite`, { token: owner });
  await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: room.id, tenantId: t.id, month: "9", year: "2026", rentAmount: "5000" } });
  const res = await ctx.request("POST", `/api/tenants/${t.id}/move-out`, { token: owner, body: {} });
  assert.equal(res.status, 200);
  assert.match(res.json.moveOutDate, /^\d{4}-\d{2}-\d{2}$/);
  const stored = ctx.db.get("SELECT * FROM tenants WHERE id = ?", t.id);
  assert.equal(stored.active, 0);
  assert.equal(stored.mobile, "");
  assert.equal(stored.id_proof_number, "");
  assert.equal(stored.invite_code_hash, null);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM charges WHERE tenant_id = ?", t.id).n, 1);
});

test("owner can download a data export without sessions or reset codes", async () => {
  const res = await ctx.request("GET", "/api/admin/export", { token: world.owner });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="rent-ledger-backup-\d{4}-\d{2}-\d{2}\.json"/);
  assert.equal(res.json.format, "rent-ledger-export-v2");
  assert.ok(Array.isArray(res.json.data.tenants));
  assert.equal(res.json.data.sessions, undefined);
  assert.equal(res.json.data.password_reset_otps, undefined);
  assert.ok(res.json.data.users.every((u) => u.password_hash === undefined));
});

test("unknown API paths return JSON 404 for a signed-in owner", async () => {
  const res = await ctx.request("GET", "/api/does-not-exist", { token: world.owner });
  assert.equal(res.status, 404);
  assert.equal(res.json.error, "Not found");
});
