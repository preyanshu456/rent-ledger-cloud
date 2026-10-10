// Rent in instalments: set the total rent, add amounts as they come in, and
// see received and remaining. The simple way of recording rent keeps working.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv({ OWNER_SIGNUP: "open" });
let ctx, world, entry;

before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
});
after(() => ctx.close());

test("simple mode is the default and the owner can choose instalments", async () => {
  const org = await ctx.request("GET", "/api/org", { token: world.owner });
  assert.equal(org.json.settings.bills.rentMode, "simple");
  const saved = await ctx.request("PUT", "/api/org", { token: world.owner, body: { settings: { bills: { paymentDetails: "UPI: me@upi", rentMode: "instalments" } } } });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.settings.bills.rentMode, "instalments");
  // Saving only the payment details (e.g. from the Make bills screen) keeps the choice.
  const again = await ctx.request("PUT", "/api/org", { token: world.owner, body: { settings: { bills: { paymentDetails: "UPI: new@upi" } } } });
  assert.equal(again.json.settings.bills.rentMode, "instalments");
  assert.equal(again.json.settings.bills.paymentDetails, "UPI: new@upi");
  const bad = await ctx.request("PUT", "/api/org", { token: world.owner, body: { settings: { bills: { rentMode: "weird" } } } });
  assert.equal(bad.json.settings.bills.rentMode, "instalments");
});

test("total ₹1,00,000 with ₹10,000 received shows ₹90,000 remaining", async () => {
  const res = await ctx.request("POST", "/api/rent", { token: world.owner, body: { roomId: world.room.id, tenantId: world.tenant.id, month: "10", year: "2026", rentAmount: "100000", amountPaid: "10000", paidDate: "2026-10-03" } });
  assert.equal(res.status, 201, res.text);
  entry = res.json;
  assert.equal(entry.rentAmount, 100000);
  assert.equal(entry.amountPaid, 10000);
  assert.equal(entry.outstanding, 90000);
  assert.equal(entry.status, "partial");
  assert.equal(entry.receipts.length, 1);
  assert.equal(entry.receipts[0].amount, 10000);
  assert.equal(entry.receipts[0].receivedOn, "2026-10-03");
});

test("each amount received is added on top, with its own date and method", async () => {
  const r1 = await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: 25000, method: "upi", receivedOn: "2026-10-10", reference: "UPI123" } });
  assert.equal(r1.status, 201, r1.text);
  assert.equal(r1.json.amountPaid, 35000);
  assert.equal(r1.json.outstanding, 65000);
  assert.equal(r1.json.rentAmount, 100000, "the total rent never changes");
  assert.equal(r1.json.receipts.length, 2);
  assert.deepEqual(r1.json.receipts.map((x) => x.amount), [25000, 10000]);
  assert.equal(r1.json.receipts[0].method, "upi");
  assert.equal(r1.json.receipts[0].reference, "UPI123");
});

test("more than the remaining amount is refused, and bad amounts too", async () => {
  const over = await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: 70000 } });
  assert.equal(over.status, 400);
  assert.match(over.json.error, /65,000/);
  assert.equal((await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: 0 } })).status, 400);
  assert.equal((await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: -5 } })).status, 400);
});

test("receiving the rest marks the month paid; nothing more can be added", async () => {
  const done = await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: 65000, method: "cash" } });
  assert.equal(done.status, 201, done.text);
  assert.equal(done.json.outstanding, 0);
  assert.equal(done.json.status, "paid");
  const extra = await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: world.owner, body: { amount: 1 } });
  assert.equal(extra.status, 400);
  const list = await ctx.request("GET", `/api/rent?roomId=${world.room.id}`, { token: world.owner });
  assert.equal(list.json.find((e) => e.id === entry.id).receipts.length, 3);
});

test("the simple way (set the amount paid) still works alongside", async () => {
  const res = await ctx.request("POST", "/api/rent", { token: world.owner, body: { roomId: world.room.id, tenantId: world.tenant.id, month: "11", year: "2026", rentAmount: "100000" } });
  const paid = await ctx.request("PUT", `/api/rent/${res.json.id}`, { token: world.owner, body: { amountPaid: 40000 } });
  assert.equal(paid.json.amountPaid, 40000);
  assert.equal(paid.json.outstanding, 60000);
  const more = await ctx.request("POST", `/api/rent/${res.json.id}/receive`, { token: world.owner, body: { amount: 10000 } });
  assert.equal(more.json.outstanding, 50000);
});

test("another owner can't add money to this rent", async () => {
  const other = await seedOwnerWorld(ctx, { ownerContact: "other@example.com", tenantMobile: "9123456789" });
  const res = await ctx.request("POST", `/api/rent/${entry.id}/receive`, { token: other.owner, body: { amount: 10 } });
  assert.equal(res.status, 404);
});
