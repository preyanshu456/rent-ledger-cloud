const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");
const { hashToken } = require("../lib/sessions");

const dataDir = setupEnv();
let ctx;
let world;

before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
});
after(() => ctx.close());

test("a second owner cannot sign up", async () => {
  const res = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Mallory", contact: "mallory@example.com", password: "password-123", role: "owner" } });
  assert.equal(res.status, 403);
});

test("new passwords must be at least 8 characters", async () => {
  const res = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "X", contact: "x@example.com", password: "1234567", role: "tenant", inviteCode: "AAAA-AAAA" } });
  assert.equal(res.status, 400);
  assert.match(res.json.error, /at least 8/);
});

test("sessions are stored hashed in the database, never as the raw token", async () => {
  const login = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-1" } });
  assert.equal(login.status, 200);
  const rows = ctx.db.all("SELECT * FROM sessions");
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((s) => /^[0-9a-f]{64}$/.test(s.token_hash) && s.expires_at && s.token_hash !== login.json.token));
  assert.ok(rows.some((s) => s.token_hash === hashToken(login.json.token)));
  assert.match(login.headers.get("set-cookie"), /rl_session=.+; HttpOnly; Path=\/; SameSite=Lax/);
});

test("sign out ends the session on the server", async () => {
  const login = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-1" } });
  const token = login.json.token;
  assert.equal((await ctx.request("GET", "/api/buildings", { token })).status, 200);
  assert.equal((await ctx.request("POST", "/api/auth/logout", { token })).status, 200);
  assert.equal((await ctx.request("GET", "/api/buildings", { token })).status, 401);
});

test("expired sessions are rejected", async () => {
  const login = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-1" } });
  ctx.db.run("UPDATE sessions SET expires_at = ? WHERE token_hash = ?", new Date(Date.now() - 1000).toISOString(), hashToken(login.json.token));
  assert.equal((await ctx.request("GET", "/api/buildings", { token: login.json.token })).status, 401);
});

test("a malformed or unknown token gets 401", async () => {
  assert.equal((await ctx.request("GET", "/api/buildings", { token: "not-a-real-token-but-long-enough" })).status, 401);
  assert.equal((await ctx.request("GET", "/api/buildings", { headers: { authorization: "Bearer <script>" } })).status, 401);
});

test("repeated wrong passwords for one account are locked out for a while", async () => {
  const contact = "owner@example.com";
  for (let i = 0; i < 10; i++) {
    const res = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact, password: `wrong-${i}` } });
    assert.equal(res.status, 401);
  }
  const blocked = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact, password: "owner-pass-1" } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  ctx.limits.loginFailuresPerContact.clear();
  const ok = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact, password: "owner-pass-1" } });
  assert.equal(ok.status, 200);
});

test("one IP address is limited across many login attempts", async () => {
  const ip = ctx.freshIp();
  let last;
  for (let i = 0; i < 101; i++) last = await ctx.request("POST", "/api/auth/login", { ip, body: { contact: `nobody${i}@example.com`, password: "whatever-123" } });
  assert.equal(last.status, 429);
  ctx.limits.loginPerIp.clear();
});

test("a tenant cannot claim a login with only their mobile number", async () => {
  const res = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Imposter", contact: world.tenant.mobile, password: "imposter-123", role: "tenant" } });
  assert.equal(res.status, 400);
  assert.equal(ctx.db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'tenant'").n, 0);
});

test("tenant invite: wrong code, then correct code, then single use", async () => {
  const invite = await ctx.request("POST", `/api/tenants/${world.tenant.id}/invite`, { token: world.owner });
  assert.equal(invite.status, 201);
  assert.match(invite.json.code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  // The owner's tenant list shows that an invite is active, but never the hash.
  const list = await ctx.request("GET", "/api/tenants", { token: world.owner });
  const listed = list.json.find((t) => t.id === world.tenant.id);
  assert.ok(listed.login.inviteExpiresAt);
  assert.equal(listed.invite, undefined);
  assert.ok(!list.text.includes("codeHash"));

  const wrong = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Asha", contact: world.tenant.mobile, password: "tenant-pass-1", role: "tenant", inviteCode: "ZZZZ-ZZZZ" } });
  assert.equal(wrong.status, 400);
  // Lower-case and missing dash are accepted.
  const right = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Asha", contact: `+91 ${world.tenant.mobile}`, password: "tenant-pass-1", role: "tenant", inviteCode: invite.json.code.toLowerCase().replace("-", "") } });
  assert.equal(right.status, 201, right.text);
  assert.equal(right.json.user.role, "tenant");
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: right.json.token });
  assert.equal(portal.status, 200);

  const again = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Asha2", contact: "98765 43210", password: "tenant-pass-2", role: "tenant", inviteCode: invite.json.code } });
  assert.equal(again.status, 409);
  const afterList = await ctx.request("GET", "/api/tenants", { token: world.owner });
  assert.equal(afterList.json.find((t) => t.id === world.tenant.id).login.hasAccount, true);
  // No new invite once the tenant has a login.
  assert.equal((await ctx.request("POST", `/api/tenants/${world.tenant.id}/invite`, { token: world.owner })).status, 409);
});

test("an invite stops working after 5 wrong codes", async () => {
  const room = (await ctx.request("POST", "/api/rooms", { token: world.owner, body: { buildingId: world.building.id, floorNumber: "2", label: "2A", monthlyRent: "9000" } })).json;
  const tenant = (await ctx.request("POST", "/api/tenants", { token: world.owner, body: { roomId: room.id, name: "Ravi", mobile: "9123456780" } })).json;
  const invite = (await ctx.request("POST", `/api/tenants/${tenant.id}/invite`, { token: world.owner })).json;
  for (let i = 0; i < 5; i++) {
    const res = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Ravi", contact: "9123456780", password: "tenant-pass-1", role: "tenant", inviteCode: `WRNG-000${i}` } });
    assert.equal(res.status, 400);
  }
  const late = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: "Ravi", contact: "9123456780", password: "tenant-pass-1", role: "tenant", inviteCode: invite.code } });
  assert.equal(late.status, 400);
});

test("changing the password signs out every session of that user", async () => {
  const a = (await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-1" } })).json.token;
  const b = (await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-1" } })).json.token;
  const short = await ctx.request("PUT", "/api/account/password", { token: a, body: { currentPassword: "owner-pass-1", newPassword: "short" } });
  assert.equal(short.status, 400);
  const changed = await ctx.request("PUT", "/api/account/password", { token: a, body: { currentPassword: "owner-pass-1", newPassword: "owner-pass-2" } });
  assert.equal(changed.status, 200);
  assert.equal((await ctx.request("GET", "/api/buildings", { token: a })).status, 401);
  assert.equal((await ctx.request("GET", "/api/buildings", { token: b })).status, 401);
  const relogin = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "owner@example.com", password: "owner-pass-2" } });
  assert.equal(relogin.status, 200);
  world.owner = relogin.json.token;
});

test("a legacy SHA-256 password still works once and is upgraded to scrypt", async () => {
  const crypto = require("crypto");
  const orgId = ctx.db.get("SELECT org_id FROM users WHERE role = 'owner'").org_id;
  ctx.db.run("INSERT INTO users (id, org_id, name, contact, contact_key, email, password_hash, password_salt, role, created_at) VALUES (?,?,?,?,?,?,?,NULL,'manager',?)",
    "legacy-user", orgId, "Legacy", "legacy@example.com", "e:legacy@example.com", "", crypto.createHash("sha256").update("old").digest("hex"), new Date().toISOString());
  const res = await ctx.request("POST", "/api/auth/login", { ip: ctx.freshIp(), body: { contact: "legacy@example.com", password: "old" } });
  assert.equal(res.status, 200);
  assert.ok(ctx.db.get("SELECT password_salt FROM users WHERE id = 'legacy-user'").password_salt);
  ctx.db.run("DELETE FROM sessions WHERE user_id = 'legacy-user'");
  ctx.db.run("DELETE FROM users WHERE id = 'legacy-user'");
});

test("password reset request does not reveal whether an account exists", async () => {
  const res = await ctx.request("POST", "/api/auth/request-password-reset", { ip: ctx.freshIp(), body: { contact: "nobody@example.com" } });
  assert.equal(res.status, 200);
  assert.match(res.json.message, /If an account matches/);
});
