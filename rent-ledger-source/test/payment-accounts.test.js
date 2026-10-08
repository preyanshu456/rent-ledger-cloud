// Each owner connects their own Razorpay account; tenants pay into the account
// of the owner who bills them, never into another owner's or a shared account.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

const dataDir = setupEnv({ OWNER_SIGNUP: "open" });
let ctx;

// A fake Razorpay API: which keys were used, and what it answers.
const KEYS = {
  rzp_test_OwnerAAAA1: "secretOwnerA0000001",
  rzp_test_OwnerBBBB2: "secretOwnerB0000002",
};
const calls = [];
let orderSeq = 0;
const realFetch = global.fetch;
before(async () => {
  global.fetch = async (url, opts = {}) => {
    if (!String(url).startsWith("https://api.razorpay.com/")) return realFetch(url, opts);
    const [keyId, secret] = Buffer.from(String(opts.headers?.Authorization || "").replace("Basic ", ""), "base64").toString().split(":");
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, keyId });
    const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (KEYS[keyId] !== secret) return json(401, { error: { description: "Authentication failed" } });
    if (opts.method === "GET" && u.pathname === "/v1/orders") return json(200, { items: [] });
    if (opts.method === "POST" && u.pathname === "/v1/orders") return json(200, { id: `order_T${++orderSeq}`, amount: JSON.parse(opts.body).amount });
    return json(404, { error: { description: "not mocked" } });
  };
  ctx = await startServer();
});
after(async () => { global.fetch = realFetch; await ctx.close(); });

async function ownerWithBill(contact, mobile) {
  const world = await seedOwnerWorld(ctx, { ownerContact: contact, tenantMobile: mobile });
  const r = await ctx.request("POST", "/api/rent", { token: world.owner, body: { roomId: world.room.id, tenantId: world.tenant.id, month: "10", year: "2026", rentAmount: "12000", dueDate: "2026-10-05" } });
  assert.equal(r.status, 201, r.text);
  world.tenantToken = await tenantLogin(ctx, world);
  return world;
}

let A, B;
test("owners start without online payments and tenants see no Pay button", async () => {
  A = await ownerWithBill("owner-a@example.com", "9000000001");
  B = await ownerWithBill("owner-b@example.com", "9000000002");
  const view = await ctx.request("GET", "/api/org/payment-account", { token: A.owner });
  assert.equal(view.status, 200);
  assert.equal(view.json.connected, false);
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portal.json.payments.enabled, false);
  const order = await ctx.request("POST", "/api/tenant/payments/order", { token: A.tenantToken, body: { all: true } });
  assert.equal(order.status, 503);
});

test("keys are checked with Razorpay and bad ones are refused", async () => {
  const shape = await ctx.request("PUT", "/api/org/payment-account", { token: A.owner, body: { keyId: "not-a-key", keySecret: "whatever123" } });
  assert.equal(shape.status, 400);
  const wrong = await ctx.request("PUT", "/api/org/payment-account", { token: A.owner, body: { keyId: "rzp_test_OwnerAAAA1", keySecret: "wrongSecret00001" } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.json.error, /rejected/);
  assert.equal((await ctx.request("GET", "/api/org/payment-account", { token: A.owner })).json.connected, false);
});

test("only the owner can see or change the payment account", async () => {
  assert.equal((await ctx.request("GET", "/api/org/payment-account", { token: A.tenantToken })).status, 403);
  assert.equal((await ctx.request("PUT", "/api/org/payment-account", { token: A.tenantToken, body: {} })).status, 403);
});

test("each owner's tenants pay into that owner's own Razorpay account", async () => {
  const saveA = await ctx.request("PUT", "/api/org/payment-account", { token: A.owner, body: { keyId: "rzp_test_OwnerAAAA1", keySecret: KEYS.rzp_test_OwnerAAAA1, webhookSecret: "hookA-secret" } });
  assert.equal(saveA.status, 200, saveA.text);
  assert.equal(saveA.json.connected, true);
  assert.equal(saveA.json.mode, "test");
  assert.equal(saveA.json.webhookConfigured, true);
  assert.ok(!JSON.stringify(saveA.json).includes(KEYS.rzp_test_OwnerAAAA1), "the secret is never sent back");

  // Owner B hasn't connected yet: B's tenant still can't pay, and nothing falls back to A's account.
  assert.equal((await ctx.request("POST", "/api/tenant/payments/order", { token: B.tenantToken, body: { all: true } })).status, 503);

  const orderA = await ctx.request("POST", "/api/tenant/payments/order", { token: A.tenantToken, body: { all: true } });
  assert.equal(orderA.status, 201, orderA.text);
  assert.equal(orderA.json.keyId, "rzp_test_OwnerAAAA1");
  assert.equal(calls.filter((c) => c.method === "POST").at(-1).keyId, "rzp_test_OwnerAAAA1");

  await ctx.request("PUT", "/api/org/payment-account", { token: B.owner, body: { keyId: "rzp_test_OwnerBBBB2", keySecret: KEYS.rzp_test_OwnerBBBB2 } });
  const orderB = await ctx.request("POST", "/api/tenant/payments/order", { token: B.tenantToken, body: { all: true } });
  assert.equal(orderB.status, 201, orderB.text);
  assert.equal(orderB.json.keyId, "rzp_test_OwnerBBBB2");
  assert.equal(calls.filter((c) => c.method === "POST").at(-1).keyId, "rzp_test_OwnerBBBB2");
  A.orderId = orderA.json.orderId;
  B.orderId = orderB.json.orderId;
});

test("a payment signature is checked with the paying owner's own secret", async () => {
  const sign = (secret) => crypto.createHmac("sha256", secret).update(`${A.orderId}|pay_Test1`).digest("hex");
  const withB = await ctx.request("POST", "/api/tenant/payments/verify", { token: A.tenantToken, body: { razorpay_order_id: A.orderId, razorpay_payment_id: "pay_Test1", razorpay_signature: sign(KEYS.rzp_test_OwnerBBBB2) } });
  assert.equal(withB.status, 400);
  // Correct signature: the server then asks Razorpay (mock says not found) instead of trusting the browser.
  const withA = await ctx.request("POST", "/api/tenant/payments/verify", { token: A.tenantToken, body: { razorpay_order_id: A.orderId, razorpay_payment_id: "pay_Test1", razorpay_signature: sign(KEYS.rzp_test_OwnerAAAA1) } });
  assert.equal(withA.status, 502);
  assert.equal(calls.at(-1).keyId, "rzp_test_OwnerAAAA1");
  // B's tenant can't confirm A's order.
  const cross = await ctx.request("POST", "/api/tenant/payments/verify", { token: B.tenantToken, body: { razorpay_order_id: A.orderId, razorpay_payment_id: "pay_Test1", razorpay_signature: sign(KEYS.rzp_test_OwnerAAAA1) } });
  assert.equal(cross.status, 404);
});

test("each owner's webhook only accepts that owner's secret and that owner's orders", async () => {
  const orgA = A.ownerUser.orgId || (await ctx.request("GET", "/api/org", { token: A.owner })).json.id;
  const orgB = (await ctx.request("GET", "/api/org", { token: B.owner })).json.id;
  const event = (orderId) => JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { id: "pay_Hook1", order_id: orderId, status: "captured", amount: 1200000, method: "upi" } } } });
  const post = (org, body, secret) => ctx.request("POST", `/api/payments/razorpay/webhook/${org}`, { raw: body, headers: { "content-type": "application/json", "x-razorpay-signature": crypto.createHmac("sha256", secret).update(body).digest("hex") } });

  assert.equal((await post(orgA, event(A.orderId), "wrong")).status, 400);
  assert.equal((await post(orgB, event(A.orderId), "hookA-secret")).status, 503, "B has no webhook secret");
  // Valid for A, but naming B's order: ignored.
  assert.equal((await post(orgA, event(B.orderId), "hookA-secret")).status, 200);
  const portalB = await ctx.request("GET", "/api/tenant/portal", { token: B.tenantToken });
  assert.equal(portalB.json.balance.outstanding, 12000);

  const ok = await post(orgA, event(A.orderId), "hookA-secret");
  assert.equal(ok.status, 200);
  const portalA = await ctx.request("GET", "/api/tenant/portal", { token: A.tenantToken });
  assert.equal(portalA.json.balance.outstanding, 0);
});

test("the key secret is stored encrypted, not as plain text", () => {
  const dbFile = fs.readdirSync(dataDir).find((f) => f.endsWith(".sqlite"));
  const raw = fs.readFileSync(path.join(dataDir, dbFile));
  for (const f of fs.readdirSync(dataDir).filter((n) => n.includes(".sqlite"))) {
    const bytes = fs.readFileSync(path.join(dataDir, f));
    assert.ok(!bytes.includes(Buffer.from(KEYS.rzp_test_OwnerAAAA1)), `${f} must not contain the secret`);
  }
  assert.ok(raw.length > 0);
});

test("the data export never includes payment keys", async () => {
  const res = await ctx.request("GET", "/api/admin/export", { token: A.owner });
  assert.equal(res.status, 200);
  assert.ok(!res.text.includes(KEYS.rzp_test_OwnerAAAA1));
  assert.ok(!res.text.includes("key_secret_enc"));
});

test("disconnecting turns the Pay button off again", async () => {
  const off = await ctx.request("DELETE", "/api/org/payment-account", { token: B.owner });
  assert.equal(off.status, 200);
  assert.equal(off.json.connected, false);
  const portal = await ctx.request("GET", "/api/tenant/portal", { token: B.tenantToken });
  assert.equal(portal.json.payments.enabled, false);
});
