// Dues engine, receipts, WhatsApp links, leads, bookings, the public
// property page, hostel operations and the new reports.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { setupEnv, startServer, seedOwnerWorld, tenantLogin } = require("./helpers");

setupEnv();
let ctx, world, today;
before(async () => {
  ctx = await startServer();
  world = await seedOwnerWorld(ctx);
  today = require("../lib/dates").localDate("Asia/Kolkata");
});
after(async () => { await ctx.close(); });

const api = (method, url, body, token = world.owner) => ctx.request(method, url, { token, body });
const daysAgo = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const daysAhead = (n) => daysAgo(-n);

test("packages: per-unit laundry with a minimum bill, and a room bill split equally", async () => {
  const pkg = (await api("POST", "/api/dues/packages", { name: "Laundry", billingMode: "per_unit", rate: 25, unitLabel: "load", minBill: 100 })).json;
  assert.equal(pkg.rate, 25);
  const bill = await api("POST", `/api/dues/packages/${pkg.id}/bill`, { tenantIds: [world.tenant.id], units: 2, dueDate: today });
  assert.equal(bill.status, 201);
  assert.equal(bill.json.amountEach, 100, "2 loads × ₹25 = ₹50, lifted to the ₹100 minimum");
  const bill6 = await api("POST", `/api/dues/packages/${pkg.id}/bill`, { tenantIds: [world.tenant.id], units: 6 });
  assert.equal(bill6.json.amountEach, 150);

  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 1, label: "1S", monthlyRent: 5000, beds: 3 })).json;
  for (const [i, name] of ["A", "B", "C"].entries()) await api("POST", "/api/tenants", { roomId: room.id, name, mobile: `91000000${10 + i}` });
  const split = await api("POST", "/api/dues/split", { roomId: room.id, kind: "electricity", amount: 1000, description: "Electricity March", dueDate: today });
  assert.equal(split.status, 201);
  assert.equal(split.json.created, 3);
  const bills = (await api("GET", `/api/ledger/charges?kind=electricity&roomId=${room.id}`)).json;
  assert.deepEqual(bills.map((b) => b.amount * 100).sort(), [33333, 33333, 33334].sort());
});

test("monthly fixed packages are added once per tenant per month", async () => {
  await api("POST", "/api/dues/packages", { name: "Maintenance", category: "maintenance", billingMode: "fixed", rate: 500, autoMonthly: true });
  const first = (await api("POST", "/api/dues/run")).json;
  assert.ok(first.packages >= 1);
  const again = (await api("POST", "/api/dues/run")).json;
  assert.equal(again.packages, 0, "running again adds nothing");
  const charges = (await api("GET", `/api/ledger/charges?tenantId=${world.tenant.id}`)).json;
  assert.equal(charges.filter((c) => c.description === "Maintenance").length, 1);
});

test("late fees: flat once after the grace days, daily grows up to the limit", async () => {
  const r = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 6, label: "6A", monthlyRent: 9000 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: r.id, name: "Late Payer", mobile: "9100000201" })).json;
  const rent = (await api("POST", "/api/ledger/charges", { roomId: r.id, tenantId: t.id, kind: "rent", amount: 9000, dueDate: daysAgo(10) })).json;
  // Off by default: nothing happens.
  assert.equal((await api("POST", "/api/dues/run")).json.lateFees.created, 0);
  assert.equal((await api("PUT", "/api/dues/late-fees", { enabled: true, graceDays: 3, mode: "daily", amount: 50, maxAmount: 300 })).status, 200);
  const run = (await api("POST", "/api/dues/run")).json;
  assert.ok(run.lateFees.created >= 1);
  const fees = (await api("GET", `/api/ledger/charges?tenantId=${t.id}`)).json.filter((c) => c.kind === "late_fee");
  assert.equal(fees.length, 1);
  assert.equal(fees[0].amount, 300, "7 days × ₹50 = ₹350, capped at ₹300");
  assert.equal((await api("POST", "/api/dues/run")).json.lateFees.created, 0, "one fee per overdue bill");
  // Managers can't change late-fee settings.
  void rent;
  await api("PUT", "/api/dues/late-fees", { enabled: false });
});

test("discounts: given now, taken back if the bill isn't paid in time, or cancelled", async () => {
  const r = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 6, label: "6B", monthlyRent: 8000 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: r.id, name: "Disc", mobile: "9100000301" })).json;
  const c = (await api("POST", "/api/ledger/charges", { roomId: r.id, tenantId: t.id, kind: "rent", amount: 8000, dueDate: daysAhead(5) })).json;
  const d = await api("POST", `/api/dues/charges/${c.id}/discount`, { amount: 500, validUntil: today, reason: "Early payment" });
  assert.equal(d.status, 201);
  assert.equal(d.json.charge.amount, 7500);
  assert.equal(d.json.offer.status, "active");
  assert.equal((await api("POST", `/api/dues/charges/${c.id}/discount`, { amount: 99999 })).status, 400);
  // Simulate the date passing: the offer's last day is moved into the past.
  ctx.db.run("UPDATE discount_offers SET valid_until = ? WHERE id = ?", daysAgo(1), d.json.offer.id);
  const run = (await api("POST", "/api/dues/run")).json;
  assert.equal(run.discounts.expired, 1);
  const back = (await api("GET", `/api/ledger/charges/${c.id}`)).json;
  assert.equal(back.amount, 8000);
  // A second discount, withdrawn by hand.
  const d2 = (await api("POST", `/api/dues/charges/${c.id}/discount`, { amount: 200, validDays: 3 })).json;
  assert.equal((await api("POST", `/api/dues/discounts/${d2.offer.id}/cancel`)).json.status, "cancelled");
  assert.equal((await api("GET", `/api/ledger/charges/${c.id}`)).json.amount, 8000);
});

test("advance pays later bills, and the deposit can pay dues", async () => {
  const r = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 7, label: "7A", monthlyRent: 6000, deposit: 6000 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: r.id, name: "Advance", mobile: "9100000401" })).json;
  await api("POST", "/api/ledger/payments", { tenantId: t.id, amount: 2000, method: "upi", allocate: false });
  await api("POST", "/api/ledger/charges", { roomId: r.id, tenantId: t.id, kind: "rent", amount: 6000, dueDate: today });
  let money = (await api("GET", `/api/dues/tenants/${t.id}/money`)).json;
  assert.equal(money.advance, 2000);
  assert.equal((await api("POST", `/api/dues/tenants/${t.id}/apply-advance`)).json.applied, 2000);
  money = (await api("GET", `/api/dues/tenants/${t.id}/money`)).json;
  assert.equal(money.outstanding, 4000);
  assert.equal(money.advance, 0);
  // No deposit recorded yet.
  assert.equal((await api("POST", `/api/dues/tenants/${t.id}/use-deposit`, {})).status, 400);
  await api("POST", `/api/tenants/${t.id}/deposit`, { type: "received", amount: 6000, date: today, method: "cash" });
  const used = await api("POST", `/api/dues/tenants/${t.id}/use-deposit`, { amount: 1500 });
  assert.equal(used.status, 201);
  assert.equal(used.json.amount, 1500);
  assert.equal(used.json.depositLeft, 4500);
  money = (await api("GET", `/api/dues/tenants/${t.id}/money`)).json;
  assert.equal(money.outstanding, 2500);
  assert.equal(money.depositHeld, 4500);
});

test("receipts show the balance still due, and WhatsApp links are ready to send", async () => {
  const r = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 7, label: "7B", monthlyRent: 7000 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: r.id, name: "Receipt", mobile: "98765 00011" })).json;
  await api("POST", "/api/ledger/charges", { roomId: r.id, tenantId: t.id, kind: "rent", amount: 7000, dueDate: today });
  const pay = (await api("POST", "/api/ledger/payments", { tenantId: t.id, amount: 3000, method: "cash" })).json;
  const receipt = await api("GET", `/api/ledger/payments/${pay.id}/receipt`);
  assert.equal(receipt.status, 200);
  assert.match(receipt.text, /Your balance now/);
  assert.match(receipt.text, /₹4,000/);
  assert.match(receipt.text, /wa\.me\/919876500011/);
  const wa = (await api("GET", `/api/ledger/payments/${pay.id}/whatsapp`)).json;
  assert.match(wa.text, /Balance still due: ₹4,000/);
  const list = (await api("GET", "/api/dues/whatsapp")).json;
  const mine = list.find((x) => x.tenantId === t.id);
  assert.equal(mine.due, 4000);
  assert.ok(mine.link.startsWith("https://wa.me/919876500011?text="));
  assert.match(decodeURIComponent(mine.link), /Hello Receipt/);
  const hindi = (await api("GET", "/api/dues/whatsapp?language=hi")).json.find((x) => x.tenantId === t.id);
  assert.match(decodeURIComponent(hindi.link), /नमस्ते/);
});

test("leads move through stages; a booking holds a bed and moving in creates the tenant", async () => {
  const lead = (await api("POST", "/api/leads", { name: "Priya", mobile: "9100000501", source: "phone", buildingId: world.building.id, budget: 6000 })).json;
  assert.equal(lead.stage, "new");
  assert.equal((await api("PUT", `/api/leads/${lead.id}`, { stage: "visit_scheduled", visitOn: today })).json.stage, "visit_scheduled");
  await api("POST", `/api/leads/${lead.id}/notes`, { body: "Liked the room, wants AC", kind: "visit" });
  const detail = (await api("GET", `/api/leads/${lead.id}`)).json;
  assert.ok(detail.events.length >= 3);

  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 8, label: "8A", monthlyRent: 6500, deposit: 6500, beds: 2 })).json;
  const booking = await api("POST", "/api/bookings", { bedId: room.beds[0].id, leadId: lead.id, name: "Priya", mobile: "9100000501", joiningOn: daysAhead(3), token: 2000, tokenMethod: "upi", tokenReference: "UTR123" });
  assert.equal(booking.status, 201);
  assert.equal(booking.json.monthlyRent, 6500, "rent taken from the bed");
  assert.equal((await api("GET", `/api/leads/${lead.id}`)).json.stage, "token_paid");
  // The bed shows as booked, and can't be booked twice.
  const occ = (await api("GET", `/api/occupancy?buildingId=${world.building.id}`)).json;
  const bed = occ.buildings[0].floors.find((f) => f.floorNumber === 8).rooms[0].beds[0];
  assert.equal(bed.status, "booked");
  assert.equal(bed.booking.name, "Priya");
  assert.equal((await api("POST", "/api/bookings", { bedId: room.beds[0].id, name: "Other", mobile: "9100000502", joiningOn: daysAhead(4) })).status, 409);
  // Someone walking in without choosing a bed gets the unbooked one.
  const walkIn = (await api("POST", "/api/tenants", { roomId: room.id, name: "Walk In", mobile: "9100000503" })).json;
  assert.equal(walkIn.bedId, room.beds[1].id);

  const moved = await api("POST", `/api/bookings/${booking.json.id}/move-in`, { moveInDate: today });
  assert.equal(moved.status, 201);
  assert.equal(moved.json.tenant.bedId, room.beds[0].id);
  assert.ok(moved.json.draftLeaseId);
  const money = (await api("GET", `/api/dues/tenants/${moved.json.tenant.id}/money`)).json;
  assert.equal(money.advance, 2000, "token kept as advance");
  assert.equal((await api("GET", `/api/leads/${lead.id}`)).json.stage, "won");
  const lease = (await api("GET", `/api/leases/${moved.json.draftLeaseId}`)).json;
  assert.equal(lease.status, "draft");
  assert.equal(lease.rent, 6500);
});

test("a bed under notice can be booked from the leaving date, not before", async () => {
  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 8, label: "8B", monthlyRent: 6000 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: room.id, name: "Leaving", mobile: "9100000601" })).json;
  const early = await api("POST", "/api/bookings", { bedId: room.beds[0].id, name: "Next", mobile: "9100000602", joiningOn: daysAhead(10) });
  assert.equal(early.status, 409);
  await api("POST", `/api/tenants/${t.id}/notice`, { leavingOn: daysAhead(15) });
  assert.equal((await api("POST", "/api/bookings", { bedId: room.beds[0].id, name: "Next", mobile: "9100000602", joiningOn: daysAhead(10) })).status, 409);
  const ok = await api("POST", "/api/bookings", { bedId: room.beds[0].id, name: "Next", mobile: "9100000602", joiningOn: daysAhead(15) });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.currentOccupant.name, "Leaving");
  // Moving in before the old tenant leaves is refused.
  assert.equal((await api("POST", `/api/bookings/${ok.json.id}/move-in`)).status, 409);
  const cancel = await api("POST", `/api/bookings/${ok.json.id}/cancel`, { reason: "Changed plans" });
  assert.equal(cancel.json.status, "cancelled");
});

test("public property page: off until published, shows free beds, enquiry becomes a lead", async () => {
  await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 9, label: "9A", monthlyRent: 5500 });
  const site = (await api("GET", `/api/sites/${world.building.id}`)).json;
  assert.equal(site.exists, false);
  assert.equal(site.slug, "sunrise");
  assert.equal((await ctx.request("GET", "/p/sunrise")).status, 404);
  const saved = await api("PUT", `/api/sites/${world.building.id}`, { published: true, headline: "Rooms near the metro", about: "Clean rooms", contactPhone: "9876543299", gender: "girls" });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.path, "/p/sunrise");
  const pageRes = await ctx.request("GET", "/p/sunrise");
  assert.equal(pageRes.status, 200);
  assert.match(pageRes.text, /Rooms near the metro/);
  assert.match(pageRes.text, /Girls only/);
  assert.match(pageRes.text, /free now/);
  assert.match(pageRes.text, /wa\.me\/919876543299/);
  assert.doesNotMatch(pageRes.text, /<script/i);
  // Bad slug and taken slug.
  assert.equal((await api("PUT", `/api/sites/${world.building.id}`, { slug: "Bad Slug!" })).status, 400);
  // An enquiry (form post) creates a website lead; the bot trap is ignored.
  const form = await ctx.request("POST", "/p/sunrise/enquire", { raw: new URLSearchParams({ name: "Web Visitor", mobile: "9100000701", visitOn: today, message: "Need a room" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(form.status, 200);
  assert.match(form.text, /Thank you/);
  const bot = await ctx.request("POST", "/p/sunrise/enquire", { raw: new URLSearchParams({ name: "Bot", mobile: "9100000702", website: "spam" }).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });
  assert.equal(bot.status, 200);
  const leads = (await api("GET", "/api/leads?q=9100000")).json.leads;
  assert.ok(leads.some((l) => l.name === "Web Visitor" && l.source === "website" && l.stage === "visit_scheduled"));
  assert.ok(!leads.some((l) => l.name === "Bot"));
  // Unpublish hides it again.
  await api("PUT", `/api/sites/${world.building.id}`, { published: false });
  assert.equal((await ctx.request("GET", "/p/sunrise")).status, 404);
});

test("hostel: menu, meals, attendance, leave, gate passes, tasks, assets and notices", async () => {
  const b = world.building.id;
  const tenantToken = await tenantLogin(ctx, world);
  // Menu and settings.
  await api("PUT", `/api/hostel/settings/${b}`, { meals: { breakfast: { cutoff: "00:00" }, dinner: { cutoff: "23:59" } }, mealDefault: "not_going" });
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  await api("PUT", `/api/hostel/menu/${b}`, { items: [{ weekday: day, meal: "dinner", items: "Dal, rice, roti" }] });
  // Tenant sees the menu and says yes to dinner; breakfast is past its cut-off.
  const mine = (await api("GET", "/api/tenant/hostel", undefined, tenantToken)).json;
  const dinner = mine.days[0].meals.find((m) => m.meal === "dinner");
  assert.equal(dinner.menu, "Dal, rice, roti");
  assert.equal((await api("POST", "/api/tenant/hostel/meals", { date: today, meal: "dinner", going: true }, tenantToken)).status, 200);
  assert.equal((await api("POST", "/api/tenant/hostel/meals", { date: today, meal: "breakfast", going: true }, tenantToken)).status, 409);
  let meals = (await api("GET", `/api/hostel/meals?buildingId=${b}&date=${today}`)).json;
  assert.ok(meals.meals.dinner.going >= 1);
  await api("POST", "/api/hostel/meals/mark", { tenantId: world.tenant.id, date: today, meal: "dinner", served: true });
  assert.equal((await api("POST", "/api/tenant/hostel/meals/rate", { date: today, meal: "dinner", rating: 4 }, tenantToken)).status, 200);
  meals = (await api("GET", `/api/hostel/meals?buildingId=${b}&date=${today}`)).json;
  assert.equal(meals.meals.dinner.averageRating, 4);

  // Attendance: mark everyone present in one tap, then one person absent.
  const att = (await api("POST", "/api/hostel/attendance", { buildingId: b, date: today, allPresent: true })).json;
  assert.ok(att.saved >= 1);
  await api("POST", "/api/hostel/attendance", { buildingId: b, date: today, marks: [{ tenantId: world.tenant.id, status: "absent", note: "Not in room" }] });
  const list = (await api("GET", `/api/hostel/attendance?buildingId=${b}&date=${today}`)).json.list;
  assert.equal(list.find((x) => x.tenantId === world.tenant.id).status, "absent");
  assert.equal((await api("POST", "/api/hostel/attendance", { buildingId: b, date: daysAhead(1), allPresent: true })).status, 400);

  // Leave: tenant asks, owner approves, the tenant is counted as on leave.
  const leave = (await api("POST", "/api/tenant/hostel/leaves", { fromDate: daysAhead(1), toDate: daysAhead(3), reason: "Going home" }, tenantToken)).json;
  assert.equal(leave.status, "pending");
  assert.equal((await api("POST", `/api/hostel/leaves/${leave.id}/decide`, { approve: true })).json.status, "approved");
  const later = (await api("GET", `/api/hostel/attendance?buildingId=${b}&date=${daysAhead(2)}`)).json.list;
  assert.equal(later.find((x) => x.tenantId === world.tenant.id).status, "leave");

  // Gate pass: request, approve, out, back late (return time in the past).
  const pass = await api("POST", "/api/tenant/hostel/passes", { purpose: "Market", outAt: `${daysAgo(1)}T10:00`, returnBy: `${daysAgo(1)}T12:00` }, tenantToken);
  assert.equal(pass.status, 201);
  assert.equal(pass.json.status, "pending");
  assert.equal((await api("POST", `/api/hostel/passes/${pass.json.id}/out`)).status, 409, "not approved yet");
  await api("POST", `/api/hostel/passes/${pass.json.id}/decide`, { approve: true });
  assert.equal((await api("GET", `/api/hostel/passes/by-code/${pass.json.code}`)).json.id, pass.json.id);
  assert.equal((await api("POST", `/api/hostel/passes/${pass.json.id}/out`)).json.status, "out");
  const overview = (await api("GET", `/api/hostel/overview?buildingId=${b}`)).json;
  assert.equal(overview.outNow, 1);
  assert.equal(overview.overdueReturns.length, 1);
  const back = (await api("POST", `/api/hostel/passes/${pass.json.id}/in`)).json;
  assert.equal(back.status, "returned");
  assert.equal(back.late, true);
  await api("POST", "/api/hostel/gate-log", { buildingId: b, visitorName: "Courier", direction: "in", visiting: "Office" });
  const log = (await api("GET", `/api/hostel/gate-log?buildingId=${b}`)).json;
  assert.ok(log.some((g) => g.who === "Courier" && g.isVisitor));
  assert.ok(log.filter((g) => !g.isVisitor).length >= 2);

  // Tasks: a daily task makes its next copy when done.
  const task = (await api("POST", "/api/hostel/tasks", { buildingId: b, title: "Clean washrooms", repeat: "daily", dueOn: today, assignee: "Ramesh" })).json;
  const done = (await api("POST", `/api/hostel/tasks/${task.id}/done`, { note: "Done" })).json;
  assert.equal(done.status, "done");
  assert.equal(done.nextTask.dueOn, daysAhead(1));

  // Assets.
  const asset = (await api("POST", "/api/hostel/assets", { buildingId: b, roomId: world.room.id, name: "Ceiling fan", category: "electrical", quantity: 1, condition: "needs_repair" })).json;
  assert.equal(asset.roomLabel, "1A");
  assert.equal((await api("PUT", `/api/hostel/assets/${asset.id}`, { condition: "good" })).json.condition, "good");

  // Notices reach the tenant.
  await api("POST", "/api/hostel/notices", { buildingId: b, title: "Water off on Sunday", body: "10am to 2pm" });
  const tenantView = (await api("GET", "/api/tenant/hostel", undefined, tenantToken)).json;
  assert.ok(tenantView.notices.some((n) => n.title === "Water off on Sunday"));
  const notes = (await api("GET", "/api/notifications", undefined, tenantToken)).json;
  assert.ok(JSON.stringify(notes).includes("Water off on Sunday"));
  // Tenants can't reach staff hostel routes.
  assert.equal((await api("GET", `/api/hostel/overview?buildingId=${b}`, undefined, tenantToken)).status, 403);
});

test("new reports run as JSON, CSV and print pages", async () => {
  const types = (await api("GET", "/api/reports")).json;
  for (const type of ["occupancy", "rent-roll", "defaulters", "late-fees-discounts", "package-charges", "leads", "bookings", "hostel-attendance", "meal-counts"]) {
    assert.ok(types.includes(type), type);
    const r = await api("GET", `/api/reports/${type}`);
    assert.equal(r.status, 200, `${type}: ${r.text}`);
    assert.ok(Array.isArray(r.json.rows));
    assert.equal((await api("GET", `/api/reports/${type}?format=csv`)).status, 200);
    assert.equal((await api("GET", `/api/reports/${type}?format=html&buildingId=${world.building.id}`)).status, 200);
  }
  const roll = (await api("GET", "/api/reports/rent-roll")).json;
  assert.ok(roll.rows.some((r) => r[3] === "Asha"));
  const occ = (await api("GET", "/api/reports/occupancy")).json;
  assert.match(String(occ.rows.at(-1)[5]), /% occupied/);
});
