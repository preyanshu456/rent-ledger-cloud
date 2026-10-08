// Home screen numbers: "Received this month" is the money that came in this
// month, whichever month's bill it paid.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv({ NOTIFY_MODE: "simulate" });
let ctx, W;
const today = () => require("../lib/dates").localDate("Asia/Kolkata");

before(async () => {
  ctx = await startServer();
  W = await seedOwnerWorld(ctx);
});
after(() => ctx.close());

test("a payment received today counts as received this month, even for an older bill", async () => {
  const [y, m] = today().split("-").map(Number);
  const prev = m === 1 ? { month: 12, year: y - 1 } : { month: m - 1, year: y };
  const old = await ctx.request("POST", "/api/rent", { token: W.owner, body: { roomId: W.room.id, tenantId: W.tenant.id, ...prev, rentAmount: 12000, dueDate: `${prev.year}-${String(prev.month).padStart(2, "0")}-05` } });
  assert.equal(old.status, 201);
  const dash = (await ctx.request("GET", "/api/dashboard", { token: W.owner })).json;
  assert.equal(dash.receivedThisMonth, 0);
  const pay = await ctx.request("POST", "/api/ledger/payments", { token: W.owner, body: { tenantId: W.tenant.id, amount: 5000, method: "cash", receivedOn: today() } });
  assert.equal(pay.status, 201);
  const after1 = (await ctx.request("GET", "/api/dashboard", { token: W.owner })).json;
  assert.equal(after1.receivedThisMonth, 5000);
  assert.equal(after1.rentCollected, 0, "this month's bills are unchanged");
  // A reversed payment is no longer counted.
  const rev = await ctx.request("POST", `/api/ledger/payments/${pay.json.id}/reverse`, { token: W.owner, body: { reason: "Entered twice" } });
  assert.ok([200, 201].includes(rev.status), rev.text);
  const after2 = (await ctx.request("GET", "/api/dashboard", { token: W.owner })).json;
  assert.equal(after2.receivedThisMonth, 0);
});
