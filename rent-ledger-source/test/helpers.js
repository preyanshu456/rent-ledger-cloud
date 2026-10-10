// Shared test setup. Each test file runs in its own process (node --test), so
// every file gets its own temporary data folder and a fresh database.
const fs = require("fs");
const os = require("os");
const path = require("path");

function setupEnv(extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rent-ledger-test-"));
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    LOG_LEVEL: "silent",
    CLIENT_IP_HEADER: "x-test-ip",
    OWNER_SETUP_CODE: "",
    OWNER_SIGNUP: "",
    RESEND_API_KEY: "", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_FROM_NUMBER: "", TWILIO_WHATSAPP_FROM: "",
    ANTHROPIC_API_KEY: "", AI_API_KEY: "", AI_PROVIDER: "", AI_MODEL: "",
    ...extra,
  });
  return dataDir;
}

async function startServer() {
  const { createServer } = require("../server");
  const srv = createServer();
  const server = srv.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipCounter = 1;
  async function request(method, url, { body, token, ip, headers = {}, raw } = {}) {
    const res = await fetch(base + url, {
      method,
      headers: {
        ...(body !== undefined && raw === undefined ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "x-test-ip": ip || "10.0.0.1",
        ...headers,
      },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, headers: res.headers, json, text };
  }
  const freshIp = () => `10.1.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;
  const close = () => new Promise((resolve) => server.close(() => { srv.db.close(); resolve(); }));
  return { ...srv, base, request, freshIp, close };
}

// An owner with one building, one room and one tenant.
async function seedOwnerWorld(ctx, { ownerContact = "owner@example.com", password = "owner-pass-1", tenantMobile = "9876543210", setupCode } = {}) {
  const ip = ctx.freshIp();
  const signup = await ctx.request("POST", "/api/auth/signup", { ip, body: { name: "Owner", contact: ownerContact, password, role: "owner", setupCode } });
  if (signup.status !== 201) throw new Error(`owner signup failed: ${signup.status} ${signup.text}`);
  const owner = signup.json.token;
  const building = (await ctx.request("POST", "/api/buildings", { token: owner, body: { name: "Sunrise", address: "MG Road", totalFloors: "2" } })).json;
  const room = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "1", label: "1A", monthlyRent: "12000", deposit: "24000" } })).json;
  const tenantRes = await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: room.id, name: "Asha", mobile: tenantMobile, moveInDate: "2026-01-01" } });
  if (tenantRes.status !== 201) throw new Error(`tenant create failed: ${tenantRes.status} ${tenantRes.text}`);
  return { owner, ownerUser: signup.json.user, building, room, tenant: tenantRes.json };
}

async function tenantLogin(ctx, world, { mobile = world.tenant.mobile, password = "tenant-pass-1", tenant = world.tenant } = {}) {
  const invite = await ctx.request("POST", `/api/tenants/${tenant.id}/invite`, { token: world.owner });
  if (invite.status !== 201) throw new Error(`invite failed: ${invite.status} ${invite.text}`);
  const res = await ctx.request("POST", "/api/auth/signup", { ip: ctx.freshIp(), body: { name: tenant.name, contact: mobile, password, role: "tenant", inviteCode: invite.json.code } });
  if (res.status !== 201) throw new Error(`tenant signup failed: ${res.status} ${res.text}`);
  return res.json.token;
}

module.exports = { setupEnv, startServer, seedOwnerWorld, tenantLogin };
