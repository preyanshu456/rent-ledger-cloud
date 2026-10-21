// Beds and occupancy: which beds are free, taken, under notice or booked.
//
// Bed status (one of):
//   occupied  - an active tenant holds the bed
//   notice    - the tenant has given notice (leaving_on is set)
//   booked    - free now, but a booking is waiting to move in
//   vacant    - free and not booked
//   disabled  - not for rent (repairs, owner use)
const { toRupees } = require("../lib/money");

const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function hasTable(db, name) {
  return Boolean(db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name));
}

// Open bookings by bed (pending or confirmed, not yet moved in).
function openBookingsByBed(db, orgId) {
  const map = new Map();
  if (!hasTable(db, "bookings")) return map;
  for (const b of db.all("SELECT * FROM bookings WHERE org_id = ? AND status IN ('pending', 'confirmed') ORDER BY joining_on", orgId)) {
    if (!map.has(b.bed_id)) map.set(b.bed_id, b);
  }
  return map;
}

function bedStatus(bed, tenant, booking) {
  if (tenant) return tenant.leaving_on ? "notice" : "occupied";
  if (bed.disabled) return "disabled";
  return booking ? "booked" : "vacant";
}

function bedRentPaise(bed, room) {
  return bed.monthly_rent_paise === null || bed.monthly_rent_paise === undefined ? room.monthly_rent_paise : bed.monthly_rent_paise;
}

function bedView(bed, room, tenant, booking) {
  return {
    id: bed.id, roomId: bed.room_id, label: bed.label, disabled: Boolean(bed.disabled), notes: bed.notes || "",
    monthlyRent: toRupees(bedRentPaise(bed, room)), ownRent: bed.monthly_rent_paise !== null && bed.monthly_rent_paise !== undefined,
    status: bedStatus(bed, tenant, booking),
    tenant: tenant ? { id: tenant.id, name: tenant.name, mobile: tenant.mobile || "", moveInDate: tenant.move_in_date || "", leavingOn: tenant.leaving_on || "" } : null,
    booking: booking ? { id: booking.id, name: booking.name, joiningOn: booking.joining_on, status: booking.status } : null,
  };
}

// Beds of the given rooms, with their tenant and booking, grouped by room id.
function bedsByRoom(db, orgId, roomIds) {
  const out = new Map(roomIds.map((id) => [id, []]));
  if (!roomIds.length) return out;
  const ph = roomIds.map(() => "?").join(",");
  const rooms = new Map(db.all(`SELECT * FROM rooms WHERE id IN (${ph})`, ...roomIds).map((r) => [r.id, r]));
  const tenants = new Map(db.all(`SELECT * FROM tenants WHERE active = 1 AND bed_id IS NOT NULL AND room_id IN (${ph})`, ...roomIds).map((t) => [t.bed_id, t]));
  const bookings = openBookingsByBed(db, orgId);
  for (const bed of db.all(`SELECT * FROM beds WHERE room_id IN (${ph}) ORDER BY created_at, label`, ...roomIds)) {
    out.get(bed.room_id).push(bedView(bed, rooms.get(bed.room_id), tenants.get(bed.id), bookings.get(bed.id)));
  }
  return out;
}

// Free beds in a room: not disabled and nobody living in them. Beds that are
// booked for someone else come last.
function freeBeds(db, roomId) {
  const room = db.get("SELECT org_id FROM rooms WHERE id = ?", roomId);
  if (!room) return [];
  const bookings = openBookingsByBed(db, room.org_id);
  return db.all(`SELECT b.* FROM beds b WHERE b.room_id = ? AND b.disabled = 0
                 AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.bed_id = b.id AND t.active = 1)
                 ORDER BY b.created_at, b.label`, roomId)
    .sort((a, b) => Number(bookings.has(a.id)) - Number(bookings.has(b.id)));
}

// Makes sure a rentable room has at least one bed (e.g. after an owner floor
// is turned into a normal room).
function ensureBed(db, room) {
  if (room.electricity_only) return;
  if (db.get("SELECT 1 FROM beds WHERE room_id = ?", room.id)) return;
  db.run("INSERT INTO beds (id, org_id, room_id, label, created_at) VALUES (?,?,?,?,?)", db.id(), room.org_id, room.id, "Bed 1", db.nowIso());
}

function nextBedLabel(db, roomId) {
  const labels = new Set(db.all("SELECT lower(label) AS l FROM beds WHERE room_id = ?", roomId).map((b) => b.l));
  for (let n = 1; n < 1000; n++) if (!labels.has(`bed ${n}`)) return `Bed ${n}`;
  return `Bed ${Date.now()}`;
}

function sharingLabel(bedCount) {
  return { 1: "Private", 2: "Double sharing", 3: "Triple sharing", 4: "Four sharing" }[bedCount] || `${bedCount} sharing`;
}

function emptyCounts() {
  return { beds: 0, occupied: 0, notice: 0, booked: 0, vacant: 0, disabled: 0, rooms: 0, fullRooms: 0, partialRooms: 0, vacantRooms: 0 };
}
function addBed(counts, status) {
  if (status === "disabled") { counts.disabled++; return; }
  counts.beds++;
  if (status === "occupied") counts.occupied++;
  else if (status === "notice") { counts.occupied++; counts.notice++; }
  else if (status === "booked") counts.booked++;
  else counts.vacant++;
}
function finish(counts) {
  counts.occupancyRate = counts.beds ? Math.round((counts.occupied / counts.beds) * 1000) / 10 : 0;
  return counts;
}

// The whole picture: buildings → floors → rooms → beds, with totals.
function occupancy(db, orgId, { buildingId } = {}) {
  const where = ["org_id = ?", "status = 'active'"];
  const params = [orgId];
  if (buildingId) { where.push("id = ?"); params.push(buildingId); }
  const buildings = db.all(`SELECT * FROM buildings WHERE ${where.join(" AND ")} ORDER BY created_at`, ...params);
  const total = emptyCounts();
  const result = [];
  for (const b of buildings) {
    const rooms = db.all("SELECT * FROM rooms WHERE building_id = ? AND electricity_only = 0 AND status <> 'archived' ORDER BY floor_number, label", b.id);
    const beds = bedsByRoom(db, orgId, rooms.map((r) => r.id));
    const counts = emptyCounts();
    const floors = new Map();
    for (const r of rooms) {
      const list = beds.get(r.id) || [];
      const live = list.filter((x) => x.status !== "disabled");
      const taken = live.filter((x) => x.status === "occupied" || x.status === "notice").length;
      const roomStatus = !live.length ? "disabled" : taken === 0 ? "vacant" : taken === live.length ? "full" : "partial";
      for (const bed of list) { addBed(counts, bed.status); addBed(total, bed.status); }
      if (live.length) {
        for (const c of [counts, total]) {
          c.rooms++;
          if (roomStatus === "full") c.fullRooms++;
          else if (roomStatus === "partial") c.partialRooms++;
          else c.vacantRooms++;
        }
      }
      if (!floors.has(r.floor_number)) floors.set(r.floor_number, []);
      floors.get(r.floor_number).push({
        id: r.id, label: r.label, floorNumber: r.floor_number, monthlyRent: toRupees(r.monthly_rent_paise), deposit: toRupees(r.deposit_paise),
        tags: json(r.tags_json, []), sharing: sharingLabel(live.length || list.length), status: roomStatus, beds: list,
      });
    }
    result.push({
      id: b.id, name: b.name, address: b.address || "", propertyType: b.property_type,
      summary: finish(counts),
      floors: [...floors.entries()].sort((x, y) => x[0] - y[0]).map(([floorNumber, list]) => ({ floorNumber, rooms: list })),
    });
  }
  return { summary: finish(total), buildings: result };
}

module.exports = { occupancy, bedsByRoom, freeBeds, ensureBed, nextBedLabel, sharingLabel, bedRentPaise, openBookingsByBed, hasTable };
