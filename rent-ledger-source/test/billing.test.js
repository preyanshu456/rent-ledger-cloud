const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");
const { encode, wrap, widthOf } = require("../services/billpdf");
const billing = require("../services/billing");

setupEnv();
let ctx;
let world;
let ground;
let ravi;

// Pending rent/electricity in two rooms on two floors; one room has a tenant who moved out.
before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
  const { owner, building, room, tenant } = world;
  ground = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "0", label: "G1", monthlyRent: "9000" } })).json;
  ravi = (await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: ground.id, name: "Ravi Kumar", mobile: "9876500001", moveInDate: "2026-01-01" } })).json;
  const add = async (path, body) => {
    const r = await ctx.request("POST", path, { token: owner, body });
    assert.equal(r.status, 201, r.text);
    return r.json;
  };
  // Floor 1, Asha: Sep rent part paid, Sep electricity, Aug rent fully paid.
  await add("/api/rent", { roomId: room.id, tenantId: tenant.id, month: "9", year: "2026", rentAmount: "12000", amountPaid: "2000", dueDate: "2026-09-05" });
  await add("/api/rent", { roomId: room.id, tenantId: tenant.id, month: "8", year: "2026", rentAmount: "12000", amountPaid: "12000", dueDate: "2026-08-05", paidDate: "2026-08-04" });
  await add("/api/electricity", { roomId: room.id, tenantId: tenant.id, month: "9", year: "2026", prevReading: "1200", currReading: "1275", ratePerUnit: "8" });
  // Ground floor, Ravi: rent + electricity, and an advance of 500 kept as credit.
  await add("/api/rent", { roomId: ground.id, tenantId: ravi.id, month: "9", year: "2026", rentAmount: "9000", dueDate: "2099-01-05" });
  await add("/api/electricity", { roomId: ground.id, tenantId: ravi.id, month: "9", year: "2026", prevReading: "50", currReading: "100", ratePerUnit: "7.5" });
  const advance = await ctx.request("POST", "/api/ledger/payments", { token: owner, body: { tenantId: ravi.id, amount: 500, method: "cash", allocate: false } });
  assert.equal(advance.status, 201, advance.text);
});
after(() => ctx.close());

const preview = (query = "") => ctx.request("GET", `/api/bills/preview${query}`, { token: world.owner });

test("preview lists what each room owes, by type", async () => {
  const r = await preview(`?buildingId=${world.building.id}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.bills.length, 2);
  const [g, first] = r.json.bills; // ground floor first
  assert.equal(g.roomLabel, "G1");
  assert.equal(g.floorName, "Ground floor");
  assert.equal(g.rent, 9000);
  assert.equal(g.electricity, 375);
  assert.equal(g.pending, 9375);
  assert.equal(g.credit, 500);
  assert.equal(g.payable, 8875);
  assert.equal(g.overdue, false);
  assert.equal(first.tenantName, "Asha");
  assert.equal(first.rent, 10000); // 12000 - 2000 paid; August is fully paid and left out
  assert.equal(first.electricity, 600); // 75 units x 8
  assert.equal(first.payable, 10600);
  assert.equal(first.overdue, true);
  assert.equal(first.items, 2);
  assert.equal(r.json.totals.payable, 19475);
});

test("filters: floor, room and type", async () => {
  const floor0 = await preview("?floor=0");
  assert.deepEqual(floor0.json.bills.map((b) => b.roomLabel), ["G1"]);
  const room = await preview(`?roomId=${world.room.id}`);
  assert.deepEqual(room.json.bills.map((b) => b.roomLabel), ["1A"]);
  const elecOnly = await preview("?kinds=electricity");
  assert.equal(elecOnly.json.bills.length, 2);
  assert.ok(elecOnly.json.bills.every((b) => b.rent === 0 && b.electricity > 0));
  const rentOnly = await preview("?kinds=rent&floor=1");
  assert.equal(rentOnly.json.bills[0].pending, 10000);
  const none = await preview("?kinds=gas");
  assert.equal(none.json.bills.length, 0);
});

test("tenants who moved out are left out unless asked for", async () => {
  const { owner, building } = world;
  const old = (await ctx.request("POST", "/api/rooms", { token: owner, body: { buildingId: building.id, floorNumber: "2", label: "2A", monthlyRent: "8000" } })).json;
  const gone = (await ctx.request("POST", "/api/tenants", { token: owner, body: { roomId: old.id, name: "Meera", mobile: "9876500002", moveInDate: "2026-01-01" } })).json;
  assert.equal((await ctx.request("POST", "/api/rent", { token: owner, body: { roomId: old.id, tenantId: gone.id, month: "7", year: "2026", rentAmount: "8000", dueDate: "2026-07-05" } })).status, 201);
  ctx.db.run("UPDATE tenants SET active = 0, move_out_date = '2026-07-31' WHERE id = ?", gone.id);
  const without = await preview("?floor=2");
  assert.equal(without.json.bills.length, 0);
  assert.deepEqual(without.json.former, { count: 1, pending: 8000 });
  const withFormer = await preview("?floor=2&includeFormer=1");
  assert.equal(withFormer.json.bills.length, 1);
  assert.equal(withFormer.json.bills[0].tenantActive, false);
});

function pdfText(buf) {
  // Collects the text drawn on every page (content streams are compressed).
  const raw = buf.toString("latin1");
  const out = [];
  const re = /stream\n([\s\S]*?)\nendstream/g;
  let m;
  while ((m = re.exec(raw))) out.push(zlib.inflateSync(Buffer.from(m[1], "latin1")).toString("latin1"));
  return out.join("\n");
}

function checkPdfStructure(buf) {
  const raw = buf.toString("latin1");
  assert.ok(raw.startsWith("%PDF-1.4"));
  assert.ok(raw.trimEnd().endsWith("%%EOF"));
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(raw)[1]);
  assert.ok(raw.slice(startxref).startsWith("xref"));
  const entries = raw.slice(startxref).split("\n").slice(3).filter((l) => / 00000 n $/.test(l));
  entries.forEach((line, i) => {
    const offset = Number(line.slice(0, 10));
    assert.ok(raw.slice(offset).startsWith(`${i + 1} 0 obj`), `object ${i + 1} is at its xref offset`);
  });
  return Number(/\/Type \/Pages \/Kids \[[^\]]*\] \/Count (\d+)/.exec(raw)[1]);
}

test("PDF: one page per bill, readable structure, the amounts on it", async () => {
  const r = await ctx.request("POST", "/api/bills/pdf", { token: world.owner, body: { buildingId: world.building.id, kinds: ["rent", "electricity"] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("content-type"), "application/pdf");
  assert.match(r.headers.get("content-disposition"), /attachment; filename="bills-Sunrise-\d{4}-\d{2}-\d{2}\.pdf"/);
  const res = await fetch(`${ctx.base}/api/bills/pdf`, { method: "POST", headers: { authorization: `Bearer ${world.owner}`, "content-type": "application/json", "x-test-ip": "10.0.0.1" }, body: JSON.stringify({ buildingId: world.building.id }) });
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(checkPdfStructure(buf), 2);
  const text = pdfText(buf);
  for (const s of ["(Ravi Kumar)", "(Asha)", "(Rs. 8,875)", "(Rs. 10,600)", "(Already paid in advance)", "(Overdue \x96 please pay now)", "(Meter 1,200 to 1,275 = 75 units \xD7 Rs. 8.00)", "(Room 1A \xB7 Floor 1)", "(Room G1 \xB7 Ground floor)"]) {
    assert.ok(text.includes(s), `PDF shows ${s}`);
  }
});

test("PDF: chosen bills only, payment details from Settings, audit entry", async () => {
  const { owner } = world;
  const saved = await ctx.request("PUT", "/api/org", { token: owner, body: { settings: { bills: { paymentDetails: "UPI: sunrise@upi\nCash at the office, 10am-6pm" } } } });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.settings.bills.paymentDetails, "UPI: sunrise@upi\nCash at the office, 10am-6pm");
  const list = (await preview()).json.bills;
  const key = list.find((b) => b.roomLabel === "G1").key;
  const res = await fetch(`${ctx.base}/api/bills/pdf`, { method: "POST", headers: { authorization: `Bearer ${owner}`, "content-type": "application/json", "x-test-ip": "10.0.0.1" }, body: JSON.stringify({ keys: [key] }) });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /filename="bill-Sunrise-G1-Ravi-Kumar-/);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(checkPdfStructure(buf), 1);
  const text = pdfText(buf);
  assert.ok(text.includes("(UPI: sunrise@upi)") && text.includes("(Cash at the office, 10am-6pm)"));
  assert.ok(!text.includes("(Asha)"));
  const auditRow = ctx.db.get("SELECT * FROM audit_log WHERE action = 'bills.pdf_created' ORDER BY id DESC LIMIT 1");
  assert.equal(JSON.parse(auditRow.details_json).bills, 1);
});

test("PDF: nothing pending gives a clear message; tenants can't make bills", async () => {
  const empty = await ctx.request("POST", "/api/bills/pdf", { token: world.owner, body: { kinds: ["gas"] } });
  assert.equal(empty.status, 404);
  assert.match(empty.json.error, /Nothing is pending/);
  const tenantToken = await tenantLogin(ctx, world);
  assert.equal((await ctx.request("GET", "/api/bills/preview", { token: tenantToken })).status, 403);
  assert.equal((await ctx.request("POST", "/api/bills/pdf", { token: tenantToken, body: {} })).status, 403);
  assert.equal((await ctx.request("GET", "/api/bills/preview")).status, 401);
});

test("long bills continue on a second page", () => {
  const lines = Array.from({ length: 40 }, (_, i) => ({ id: String(i), kind: "rent", title: "Rent", period: `M${i}`, dueDate: "2026-01-05", overdue: true, amountPaise: 100000, paidPaise: 0, pendingPaise: 100000, detail: "" }));
  const bill = { key: "r:t", ref: "B-2610-ABCDEF", buildingName: "Sunrise", buildingAddress: "MG Road", floor: 3, roomLabel: "3B", roomStatus: "occupied", tenantName: "Long Dues", tenantMobile: "", tenantActive: true, lines, byKind: { rent: 4000000 }, pendingPaise: 4000000, creditPaise: 0, payablePaise: 4000000, overdue: true, dueBy: "2026-01-05" };
  const buf = billing.renderBillsPdf({ orgName: "Owner", bills: [bill], today: "2026-10-03", paymentDetails: "" });
  assert.equal(checkPdfStructure(buf), 2);
  const text = pdfText(buf);
  assert.ok(text.includes("(Page 2 of 2)") && text.includes("(Owner \xB7 Bill B-2610-ABCDEF \\(continued\\))"));
});

test("text helpers: rupee sign, other scripts, wrapping", () => {
  assert.equal(encode("₹500"), "Rs. 500");
  assert.equal(encode("Café – ok"), "Caf\xE9 \x96 ok");
  assert.equal(encode("राम"), "???");
  const lines = wrap("Pay by UPI to sunrise@upi or by bank transfer to account 1234567890", 120, 10);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((l) => widthOf(l, 10) <= 120));
  assert.deepEqual(billing.parseFilters({ kinds: "rent,bogus", floor: "0", includeFormer: "1" }).kinds, ["rent"]);
  assert.equal(billing.parseFilters({ floor: "" }).floor, null);
  assert.deepEqual(billing.parseFilters({}).kinds, ["rent", "electricity"]);
  assert.equal(billing.roomName("101"), "Room 101");
  assert.equal(billing.roomName("Flat 2B"), "Flat 2B");
});
