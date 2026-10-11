const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv();
let ctx;
let world;

before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
});

after(() => ctx.close());

test("owner accounts can use the console without an allowlist", async () => {
  const response = await ctx.request("GET", "/api/platform-admin/organizations", { token: world.owner });
  assert.equal(response.status, 200, response.text);
});

test("the console shell is served without exposing owner data", async () => {
  const page = await ctx.request("GET", "/platform-admin.html");
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  assert.match(page.text, /owner or manager account/);
});
