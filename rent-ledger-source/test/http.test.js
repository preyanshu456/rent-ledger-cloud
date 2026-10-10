const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer } = require("./helpers");

setupEnv();
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

test("no Razorpay endpoints remain", async () => {
  // Old webhook URLs are not public any more (sign-in required) and the old
  // checkout and key-management endpoints are gone.
  for (const path of ["/api/payments/razorpay/webhook", "/api/payments/razorpay/webhook/some-org-id-123"]) {
    const res = await ctx.request("POST", path, { body: {} });
    assert.equal(res.status, 401, path);
  }
  const { seedOwnerWorld, tenantLogin } = require("./helpers");
  const world = await seedOwnerWorld(ctx);
  const token = await tenantLogin(ctx, world);
  for (const path of ["/api/tenant/payments/order", "/api/tenant/payments/verify", "/api/tenant/payments/failed"]) {
    assert.equal((await ctx.request("POST", path, { token, body: { all: true } })).status, 404, path);
  }
  assert.equal((await ctx.request("GET", "/api/org/payment-account", { token: world.owner })).status, 404);
  const page = await ctx.request("GET", "/");
  assert.ok(!/razorpay/i.test(page.headers.get("content-security-policy-report-only") || page.headers.get("content-security-policy") || ""));
});

test("the Android and iPhone apps may call the API from inside the app; other sites may not", async () => {
  for (const origin of ["capacitor://localhost", "https://localhost"]) {
    const pre = await ctx.request("OPTIONS", "/api/auth/login", { headers: { origin, "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get("access-control-allow-origin"), origin);
  }
  const other = await ctx.request("OPTIONS", "/api/auth/login", { headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
  // A cookie-signed request from the app's origin is still refused (the apps use tokens).
  const cookie = await ctx.request("POST", "/api/buildings", { headers: { origin: "https://localhost", cookie: "rl_session=" + "x".repeat(40) }, body: { name: "X" } });
  assert.equal(cookie.status, 401);
});
