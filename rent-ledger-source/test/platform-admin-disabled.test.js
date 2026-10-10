const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv({ PLATFORM_ADMIN_CONTACT: "" });
let ctx;
let world;

before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
});

after(() => ctx.close());

test("platform routes remain unavailable when no account is allowlisted", async () => {
  const response = await ctx.request("GET", "/api/platform-admin/organizations", { token: world.owner });
  assert.equal(response.status, 404);
});

test("the console shell is served without exposing owner data", async () => {
  const page = await ctx.request("GET", "/platform-admin.html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /Private owner-account operations/);
});
