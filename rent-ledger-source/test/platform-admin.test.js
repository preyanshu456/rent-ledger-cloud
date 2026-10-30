const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv({ OWNER_SIGNUP: "open" });
let ctx;
let manager;
let secondManager;
let tenantSession;
let owner;
let targetRoom;
let targetBuilding;
let newTenant;

before(async () => {
  ctx = await startServer();
  manager = await seedOwnerWorld(ctx, { ownerContact: "manager@example.com" });
  tenantSession = await tenantLogin(ctx, manager);
  const signup = await ctx.request("POST", "/api/auth/signup", {
    ip: ctx.freshIp(),
    body: { name: "Second Owner", contact: "second-owner@example.com", password: "owner-pass-2", role: "owner" },
  });
  assert.equal(signup.status, 201, signup.text);
  owner = signup.json;
  const secondManagerSignup = await ctx.request("POST", "/api/auth/signup", {
    ip: ctx.freshIp(),
    body: { name: "Second Platform Manager", contact: "second-manager@example.com", password: "manager-pass-2", role: "owner" },
  });
  assert.equal(secondManagerSignup.status, 201, secondManagerSignup.text);
  secondManager = secondManagerSignup.json;
  targetBuilding = (await ctx.request("POST", "/api/buildings", { token: owner.token, body: { name: "Cedar House" } })).json;
  targetRoom = (await ctx.request("POST", "/api/rooms", { token: owner.token, body: { buildingId: targetBuilding.id, floorNumber: 1, label: "1A" } })).json;
});

after(() => ctx.close());

test("owner and manager accounts can view and manage selected owner data through scoped routes", async () => {
  const listed = await ctx.request("GET", "/api/platform-admin/organizations", { token: manager.owner });
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.length, 3);
  const targetId = owner.user.orgId;
  const detail = await ctx.request("GET", `/api/platform-admin/organizations/${targetId}`, { token: manager.owner });
  assert.equal(detail.status, 200, detail.text);
  assert.equal(detail.json.organization.id, targetId);
  assert.equal(detail.json.rooms[0].id, targetRoom.id);
  const tenantResponse = await ctx.request("GET", "/api/platform-admin/organizations/" + targetId, { token: tenantSession });
  assert.equal(tenantResponse.status, 403);
  const secondManagerDetail = await ctx.request("GET", `/api/platform-admin/organizations/${targetId}`, { token: secondManager.token });
  assert.equal(secondManagerDetail.status, 200, secondManagerDetail.text);
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE org_id = ? AND actor_user_id = ? AND actor_role = 'platform_admin'", targetId, manager.ownerUser.id));
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE org_id = ? AND actor_user_id = ? AND actor_role = 'platform_admin'", targetId, secondManager.user.id));

  const created = await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/tenants`, {
    token: manager.owner,
    body: { roomId: targetRoom.id, name: "Synthetic Tenant", mobile: "9888800011", moveInDate: "2026-01-01" },
  });
  assert.equal(created.status, 201, created.text);
  newTenant = created.json;
  assert.equal(newTenant.roomId, targetRoom.id);

  const invalidRoom = await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/tenants`, {
    token: manager.owner,
    body: { roomId: manager.room.id, name: "Wrong Scope", mobile: "9888800012" },
  });
  assert.equal(invalidRoom.status, 404);

  const bill = await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/electricity`, {
    token: manager.owner,
    body: { roomId: targetRoom.id, tenantId: newTenant.id, month: "9", year: "2026", prevReading: "120", currReading: "150", ratePerUnit: "8", dueDate: "2026-10-20" },
  });
  assert.equal(bill.status, 201, bill.text);
  assert.equal(bill.json.unitsConsumed, 30);
  assert.equal(bill.json.amountPaise, 24000);
  const adminHistory = await ctx.request("GET", `/api/platform-admin/organizations/${targetId}/electricity?roomId=${targetRoom.id}`, { token: manager.owner });
  assert.equal(adminHistory.status, 200, adminHistory.text);
  assert.equal(adminHistory.json.length, 1);
  assert.equal(adminHistory.json[0].currReading, 150);
  assert.equal(adminHistory.json[0].amount, 240);
  const invalidReading = await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/electricity`, {
    token: manager.owner,
    body: { roomId: targetRoom.id, tenantId: newTenant.id, month: "10", year: "2026", prevReading: "150", currReading: "149", ratePerUnit: "8" },
  });
  assert.equal(invalidReading.status, 400);
  const targetBills = await ctx.request("GET", `/api/electricity?roomId=${targetRoom.id}`, { token: owner.token });
  assert.equal(targetBills.status, 200);
  assert.equal(targetBills.json[0].amount, 240);

  assert.equal((await ctx.request("GET", "/api/platform-admin/organizations/" + targetId, { token: owner.token })).status, 200);
  assert.equal((await ctx.request("GET", `/api/tenants/${newTenant.id}`, { token: manager.owner })).status, 404);

  const movedOut = await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/tenants/${newTenant.id}/move-out`, {
    token: manager.owner,
    body: { moveOutDate: "2026-10-01" },
  });
  assert.equal(movedOut.status, 200, movedOut.text);
  assert.equal(movedOut.json.active, false);
  assert.equal(movedOut.json.identityCleared, true);
  assert.equal(movedOut.json.mobile, "");
  const history = await ctx.request("GET", `/api/electricity?roomId=${targetRoom.id}`, { token: owner.token });
  assert.equal(history.json.length, 1);
  assert.equal(history.json[0].amount, 240);
  assert.equal((await ctx.request("POST", `/api/platform-admin/organizations/${targetId}/tenants/${newTenant.id}/move-out`, { token: manager.owner, body: {} })).status, 409);
  assert.ok(ctx.db.get("SELECT 1 FROM audit_log WHERE org_id = ? AND actor_role = 'platform_admin' AND action = 'platform_admin.electricity_bill_created'", targetId));
});

test("unauthenticated requests cannot use platform routes", async () => {
  const response = await ctx.request("GET", "/api/platform-admin/organizations", { token: owner.token });
  assert.equal(response.status, 200);
  assert.equal((await ctx.request("GET", "/api/platform-admin/organizations")).status, 401);
});
