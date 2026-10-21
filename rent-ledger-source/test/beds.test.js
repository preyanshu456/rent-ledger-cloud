const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { setupEnv, startServer, seedOwnerWorld } = require("./helpers");

setupEnv();
let ctx, world;
before(async () => { ctx = await startServer(); world = await seedOwnerWorld(ctx); });
after(async () => { await ctx.close(); });

const api = (method, url, body, token = world.owner) => ctx.request(method, url, { token, body });

test("migration 007 gives every existing room one bed and puts its tenant on it", () => {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = path.join(__dirname, "..", "migrations");
  for (const f of ["001_core.sql", "002_ledger.sql", "003_leases_reconciliation.sql", "004_operations.sql", "005_payment_accounts.sql", "006_upi_intent.sql"]) db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
  db.exec(`INSERT INTO organizations (id, name, created_at) VALUES ('o','Org','now');
    INSERT INTO buildings (id, org_id, name, created_at) VALUES ('b','o','B','now');
    INSERT INTO rooms (id, org_id, building_id, label, status, created_at) VALUES ('r1','o','b','1A','occupied','now'), ('r2','o','b','1B','vacant','now');
    INSERT INTO rooms (id, org_id, building_id, label, electricity_only, status, created_at) VALUES ('r3','o','b','Owner','1','owner','now');
    INSERT INTO tenants (id, org_id, room_id, name, active, created_at) VALUES ('t1','o','r1','Asha',1,'now'), ('t0','o','r1','Old',0,'now');`);
  db.exec(fs.readFileSync(path.join(dir, "007_beds.sql"), "utf8"));
  const beds = db.prepare("SELECT room_id, label FROM beds ORDER BY room_id").all();
  assert.deepEqual(beds.map((b) => [b.room_id, b.label]), [["r1", "Bed 1"], ["r2", "Bed 1"]]);
  assert.equal(db.prepare("SELECT bed_id FROM tenants WHERE id = 't1'").get().bed_id, "bed_r1");
  // One active tenant per bed is enforced by the database.
  db.exec("INSERT INTO tenants (id, org_id, room_id, bed_id, name, active, created_at) VALUES ('t2','o','r2','bed_r2','B',1,'now')");
  assert.throws(() => db.exec("INSERT INTO tenants (id, org_id, room_id, bed_id, name, active, created_at) VALUES ('t3','o','r2','bed_r2','C',1,'now')"), /UNIQUE/);
  // A new room gets Bed 1 by itself; a tenant without a bed gets the free one.
  db.exec("INSERT INTO rooms (id, org_id, building_id, label, created_at) VALUES ('r4','o','b','2A','now')");
  db.exec("INSERT INTO tenants (id, org_id, room_id, name, active, created_at) VALUES ('t4','o','r4','D',1,'now')");
  assert.equal(db.prepare("SELECT bed_id FROM tenants WHERE id = 't4'").get().bed_id, "bed_r4");
});

test("the seeded single room has one bed and the tenant sits in it", async () => {
  const rooms = (await api("GET", `/api/rooms?buildingId=${world.building.id}`)).json;
  const room = rooms.find((r) => r.id === world.room.id);
  assert.equal(room.bedCount, 1);
  assert.equal(room.sharing, "Private");
  assert.equal(room.beds[0].status, "occupied");
  assert.equal(room.beds[0].tenant.id, world.tenant.id);
  const tenant = (await api("GET", `/api/tenants/${world.tenant.id}`)).json;
  assert.equal(tenant.bedLabel, "Bed 1");
  // Still exactly one tenant for a one-bed room, with the old message.
  const second = await api("POST", "/api/tenants", { roomId: world.room.id, name: "Extra", mobile: "9000000001" });
  assert.equal(second.status, 409);
  assert.match(second.json.error, /already has an active tenant/);
});

test("a triple-sharing room takes three tenants, then reports it is full", async () => {
  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 2, label: "2A", monthlyRent: 6000, deposit: 6000, beds: 3, tags: ["AC", "Girls only"] })).json;
  assert.equal(room.bedCount, 3);
  assert.equal(room.sharing, "Triple sharing");
  assert.deepEqual(room.tags, ["AC", "Girls only"]);
  const chosen = room.beds[2];
  const a = await api("POST", "/api/tenants", { roomId: room.id, bedId: chosen.id, name: "Riya", mobile: "9000000011" });
  assert.equal(a.status, 201);
  assert.equal(a.json.bedId, chosen.id);
  const taken = await api("POST", "/api/tenants", { roomId: room.id, bedId: chosen.id, name: "Dup", mobile: "9000000012" });
  assert.equal(taken.status, 409);
  assert.equal((await api("POST", "/api/tenants", { roomId: room.id, name: "Meera", mobile: "9000000013" })).status, 201);
  assert.equal((await api("POST", "/api/tenants", { roomId: room.id, name: "Kiran", mobile: "9000000014" })).status, 201);
  const full = await api("POST", "/api/tenants", { roomId: room.id, name: "Late", mobile: "9000000015" });
  assert.equal(full.status, 409);
  assert.match(full.json.error, /Every bed in this room is taken/);
});

test("occupancy counts beds, notice and disabled beds", async () => {
  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 3, label: "3A", monthlyRent: 5000, beds: 2 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: room.id, name: "Neha", mobile: "9000000021" })).json;
  const notice = await api("POST", `/api/tenants/${t.id}/notice`, { leavingOn: "2099-01-31", noticeGivenOn: "2099-01-01" });
  assert.equal(notice.status, 200);
  assert.equal(notice.json.leavingOn, "2099-01-31");
  const occ = (await api("GET", `/api/occupancy?buildingId=${world.building.id}`)).json;
  const r = occ.buildings[0].floors.find((f) => f.floorNumber === 3).rooms[0];
  assert.equal(r.status, "partial");
  assert.deepEqual(r.beds.map((b) => b.status).sort(), ["notice", "vacant"]);
  assert.ok(occ.summary.notice >= 1);
  assert.equal(occ.summary.occupied + occ.summary.vacant + occ.summary.booked, occ.summary.beds);
  // Disable the free bed: it leaves the bed count.
  const free = r.beds.find((b) => b.status === "vacant");
  assert.equal((await api("PUT", `/api/beds/${free.id}`, { disabled: true })).status, 200);
  const after = (await api("GET", `/api/occupancy?buildingId=${world.building.id}`)).json;
  assert.equal(after.summary.beds, occ.summary.beds - 1);
  assert.equal(after.summary.disabled, occ.summary.disabled + 1);
  // A bed someone lives in can't be disabled.
  const lived = r.beds.find((b) => b.status === "notice");
  assert.equal((await api("PUT", `/api/beds/${lived.id}`, { disabled: true })).status, 409);
  // Withdrawing notice puts the bed back to occupied.
  assert.equal((await api("DELETE", `/api/tenants/${t.id}/notice`)).json.leavingOn, "");
});

test("beds can be added, renamed, priced and deleted only without history", async () => {
  const room = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 4, label: "4A", monthlyRent: 8000 })).json;
  const added = (await api("POST", `/api/rooms/${room.id}/beds`, { count: 2 })).json;
  assert.deepEqual(added.map((b) => b.label), ["Bed 1", "Bed 2", "Bed 3"]);
  const priced = (await api("PUT", `/api/beds/${added[2].id}`, { label: "Window bed", monthlyRent: 9000 })).json;
  assert.equal(priced.label, "Window bed");
  assert.equal(priced.monthlyRent, 9000);
  assert.equal(added[0].monthlyRent, 8000);
  assert.equal((await api("PUT", `/api/beds/${added[1].id}`, { label: "window BED" })).status, 409);
  assert.equal((await api("DELETE", `/api/beds/${added[1].id}`)).status, 200);
  const t = (await api("POST", "/api/tenants", { roomId: room.id, bedId: added[0].id, name: "Vikas", mobile: "9000000031" })).json;
  await api("POST", `/api/tenants/${t.id}/move-out`, { moveOutDate: "2026-02-01" });
  const del = await api("DELETE", `/api/beds/${added[0].id}`);
  assert.equal(del.status, 409);
  assert.match(del.json.error, /history/);
});

test("a tenant can move to a bed in another room, and the lease follows", async () => {
  const from = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 5, label: "5A", monthlyRent: 7000 })).json;
  const to = (await api("POST", "/api/rooms", { buildingId: world.building.id, floorNumber: 5, label: "5B", monthlyRent: 7000, beds: 2 })).json;
  const t = (await api("POST", "/api/tenants", { roomId: from.id, name: "Arjun", mobile: "9000000041", moveInDate: "2026-01-01" })).json;
  const moved = await api("POST", `/api/tenants/${t.id}/move-bed`, { bedId: to.beds[1].id });
  assert.equal(moved.status, 200);
  assert.equal(moved.json.roomId, to.id);
  assert.equal(moved.json.bedId, to.beds[1].id);
  const rooms = (await api("GET", `/api/rooms?buildingId=${world.building.id}`)).json;
  assert.equal(rooms.find((r) => r.id === from.id).status, "vacant");
  assert.equal(rooms.find((r) => r.id === to.id).status, "occupied");
  // The bed is now taken: another tenant can't move in.
  const other = (await api("POST", "/api/tenants", { roomId: to.id, name: "Sam", mobile: "9000000042" })).json;
  assert.equal((await api("POST", `/api/tenants/${other.id}/move-bed`, { bedId: to.beds[1].id })).status, 409);
});
