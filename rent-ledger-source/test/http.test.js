const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { setupEnv, startServer } = require("./helpers");

setupEnv({ RAZORPAY_WEBHOOK_SECRET: "test-webhook-secret" });
let ctx;

before(async () => { ctx = await startServer(); });
after(() => ctx.close());

test("health check reports ok without revealing data", async () => {
  const res = await ctx.request("GET", "/health");
  assert.equal(res.status, 200);
  assert.deepEqual(Object.keys(res.json).sort(), ["status", "uptimeSeconds"]);
});

test("security headers are set and Express is not advertised", async () => {
  const res = await ctx.request("GET", "/");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.match(res.headers.get("content-security-policy-report-only"), /frame-ancestors 'none'/);
  assert.ok(res.headers.get("x-request-id"));
});

test("HSTS is sent when the request came in over HTTPS (Railway sets X-Forwarded-Proto)", async () => {
  const res = await ctx.request("GET", "/", { headers: { "x-forwarded-proto": "https" } });
  assert.match(res.headers.get("strict-transport-security"), /max-age=/);
});

test("API responses are not cached", async () => {
  const res = await ctx.request("GET", "/api/buildings");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("large bodies are refused on normal routes", async () => {
  const big = JSON.stringify({ contact: "x".repeat(200_000), password: "y" });
  const res = await ctx.request("POST", "/api/auth/login", { raw: big, headers: { "content-type": "application/json" } });
  assert.equal(res.status, 413);
  assert.equal(res.json.error, "This request is too large.");
});

test("receipt upload routes need sign-in before accepting a large body", async () => {
  const big = JSON.stringify({ data: "A".repeat(500_000), mimeType: "image/png" });
  const res = await ctx.request("POST", "/api/tenant/rent/some-id/receipt", { raw: big, headers: { "content-type": "application/json" } });
  assert.equal(res.status, 401);
});

test("broken JSON gets a clean 400", async () => {
  const res = await ctx.request("POST", "/api/auth/login", { raw: "{not json", headers: { "content-type": "application/json" } });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, "The request could not be read.");
});

test("the web app is served for page routes", async () => {
  const res = await ctx.request("GET", "/some/page");
  assert.equal(res.status, 200);
  assert.match(res.text, /<div id="app">/);
});

test("Razorpay webhook rejects a wrong signature and accepts a correct one", async () => {
  const body = JSON.stringify({ event: "payment.captured", payload: { payment: { entity: { order_id: "order_unknown", status: "captured", amount: 100, id: "pay_x" } } } });
  const bad = await ctx.request("POST", "/api/payments/razorpay/webhook", { raw: body, headers: { "content-type": "application/json", "x-razorpay-signature": "bad" } });
  assert.equal(bad.status, 400);
  const sig = crypto.createHmac("sha256", "test-webhook-secret").update(body).digest("hex");
  const good = await ctx.request("POST", "/api/payments/razorpay/webhook", { raw: body, headers: { "content-type": "application/json", "x-razorpay-signature": sig } });
  assert.equal(good.status, 200);
});

test("online payment endpoints say payments are off when Razorpay keys are missing", async () => {
  const { seedOwnerWorld, tenantLogin } = require("./helpers");
  const world = await seedOwnerWorld(ctx);
  const token = await tenantLogin(ctx, world);
  const res = await ctx.request("POST", "/api/tenant/payments/order", { token, body: { all: true } });
  assert.equal(res.status, 503);
});
