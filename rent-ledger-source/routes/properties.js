// Buildings (properties), floors, rooms (units) and billing authorities.
const v = require("../lib/validate");
const { toPaise } = require("../lib/money");
const { audit } = require("../services/audit");
const { buildingView, roomView, authorityView } = require("../services/views");
const { requirePermission, ownerOnly, ctxOf, notFound } = require("./common");
const occ = require("../services/occupancy");

const PROPERTY_TYPES = ["residential", "apartment", "independent_house", "pg_hostel", "commercial", "shop", "office", "mixed", "other"];
const BUILDING_SCHEMA = {
  name: v.text({ label: "Building name", max: 120, required: true }),
  address: v.text({ label: "Address", max: 300 }),
  totalFloors: v.number({ label: "Total floors", min: 0, max: 300, integer: true }),
  notes: v.text({ label: "Notes", max: 1000 }),
  propertyType: (value) => {
    if (value === undefined || value === null || value === "") return "residential";
    if (!PROPERTY_TYPES.includes(value)) throw new v.ValidationError("Choose a valid property type.");
    return value;
  },
  amenities: (value) => {
    if (value === undefined || value === null || value === "") return [];
    const list = Array.isArray(value) ? value : String(value).split(",");
    const out = list.map((a) => String(a).trim()).filter(Boolean).slice(0, 30);
    if (out.some((a) => a.length > 60)) throw new v.ValidationError("Each amenity must be 60 characters or fewer.");
    return out;
  },
};
const FREQUENCIES = ["monthly", "quarterly", "half_yearly", "yearly"];
const ROOM_SCHEMA = {
  floorNumber: v.number({ label: "Floor number", min: -5, max: 300, integer: true }),
  label: v.text({ label: "Room / unit label", max: 60, required: true }),
  monthlyRent: v.money("Monthly rent"),
  deposit: v.money("Security deposit"),
  notes: v.text({ label: "Notes", max: 1000 }),
  electricityOnly: v.bool(),
  tags: (value) => {
    if (value === undefined || value === null || value === "") return [];
    const list = Array.isArray(value) ? value : String(value).split(",");
    const out = [...new Set(list.map((a) => String(a).trim()).filter(Boolean))].slice(0, 20);
    if (out.some((a) => a.length > 40)) throw new v.ValidationError("Each tag must be 40 characters or fewer.");
    return out;
  },
  utilityNotes: v.text({ label: "Utility details", max: 500 }),
  paymentFrequency: (value) => {
    if (value === undefined || value === null || value === "") return "monthly";
    if (!FREQUENCIES.includes(value)) throw new v.ValidationError("Choose a valid payment frequency.");
    return value;
  },
};

function hasFinancialHistory(db, roomIds) {
  if (!roomIds.length) return false;
  const ph = roomIds.map(() => "?").join(",");
  return Boolean(db.get(`SELECT 1 FROM charges WHERE room_id IN (${ph}) LIMIT 1`, ...roomIds) || db.get(`SELECT 1 FROM payments WHERE room_id IN (${ph}) LIMIT 1`, ...roomIds)
    || db.get(`SELECT 1 FROM leases WHERE room_id IN (${ph}) LIMIT 1`, ...roomIds) || db.get(`SELECT 1 FROM expenses WHERE room_id IN (${ph}) LIMIT 1`, ...roomIds));
}

function refreshRoomStatus(db, roomId) {
  const room = db.get("SELECT * FROM rooms WHERE id = ?", roomId);
  if (!room || room.status === "archived") return;
  const status = room.electricity_only ? "owner" : db.get("SELECT 1 FROM tenants WHERE room_id = ? AND active = 1", roomId) ? "occupied" : "vacant";
  if (status !== room.status) db.run("UPDATE rooms SET status = ?, updated_at = ? WHERE id = ?", status, db.nowIso(), roomId);
}

// Removes rooms (and their tenants' logins and records) that have no financial
// history. Rooms with history must be archived instead, so records stay intact.
function deleteRoomsWithoutHistory(db, ctx, roomIds, docs) {
  const ph = roomIds.map(() => "?").join(",");
  const tenantIds = db.all(`SELECT id FROM tenants WHERE room_id IN (${ph})`, ...roomIds).map((t) => t.id);
  if (tenantIds.length) {
    const tp = tenantIds.map(() => "?").join(",");
    db.run(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id IN (${tp}))`, ...tenantIds);
    db.run(`DELETE FROM users WHERE tenant_id IN (${tp})`, ...tenantIds);
    for (const d of db.all(`SELECT id FROM documents WHERE entity_type = 'tenant' AND entity_id IN (${tp})`, ...tenantIds)) docs.remove(db, ctx.orgId, d.id);
    for (const table of ["move_records", "deposit_settlements", "messages"]) db.run(`DELETE FROM ${table} WHERE tenant_id IN (${tp})`, ...tenantIds);
    db.run(`UPDATE maintenance_requests SET tenant_id = NULL WHERE tenant_id IN (${tp})`, ...tenantIds);
  }
  db.run(`UPDATE maintenance_requests SET room_id = NULL WHERE room_id IN (${ph})`, ...roomIds);
  db.run(`DELETE FROM tenants WHERE room_id IN (${ph})`, ...roomIds);
  db.run(`DELETE FROM rooms WHERE id IN (${ph})`, ...roomIds);
}

function register(app, { db, docs, todayFor }) {
  const manage = requirePermission("properties.manage");

  // ---------- buildings ----------
  app.get("/api/buildings", (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.status && ["active", "archived"].includes(req.query.status)) { where.push("status = :status"); params.status = req.query.status; }
    if (req.query.q) { where.push("(name LIKE :q OR address LIKE :q)"); params.q = `%${String(req.query.q).slice(0, 60)}%`; }
    let rows = db.all(`SELECT * FROM buildings WHERE ${where.join(" AND ")} ORDER BY created_at`, params).map(buildingView);
    if (req.query.occupancy === "vacant" || req.query.occupancy === "full") {
      rows = rows.filter((b) => {
        const rooms = db.all("SELECT status FROM rooms WHERE building_id = ? AND electricity_only = 0 AND status <> 'archived'", b.id);
        const vacant = rooms.some((r) => r.status === "vacant");
        return req.query.occupancy === "vacant" ? vacant : rooms.length > 0 && !vacant;
      });
    }
    res.json(rows);
  });

  app.post("/api/buildings", manage, (req, res) => {
    const data = v.clean(req.body, BUILDING_SCHEMA);
    const id = db.id();
    db.run(`INSERT INTO buildings (id, org_id, name, address, property_type, total_floors, amenities_json, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
      id, req.orgId, data.name, data.address, data.propertyType, data.totalFloors, JSON.stringify(data.amenities), data.notes, db.nowIso());
    audit(db, ctxOf(req), "building.created", "building", id, { name: data.name });
    res.status(201).json(buildingView(db.get("SELECT * FROM buildings WHERE id = ?", id)));
  });

  app.put("/api/buildings/:id", manage, (req, res) => {
    const b = db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Building");
    const data = v.clean(req.body, BUILDING_SCHEMA, { partial: true });
    const map = { name: "name", address: "address", totalFloors: "total_floors", notes: "notes", propertyType: "property_type" };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) if (data[k] !== undefined) { sets.push(`${col} = ?`); params.push(data[k]); }
    if (data.amenities !== undefined) { sets.push("amenities_json = ?"); params.push(JSON.stringify(data.amenities)); }
    if (sets.length) db.run(`UPDATE buildings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), b.id);
    res.json(buildingView(db.get("SELECT * FROM buildings WHERE id = ?", b.id)));
  });

  // Archive hides a property from day-to-day lists but keeps every record.
  app.post("/api/buildings/:id/archive", manage, (req, res) => {
    const b = db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Building");
    const archive = req.body?.archived !== false;
    if (archive && db.get("SELECT 1 FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE r.building_id = ? AND t.active = 1", b.id)) {
      return res.status(409).json({ error: "Move out the active tenants before archiving this property." });
    }
    db.run("UPDATE buildings SET status = ?, updated_at = ? WHERE id = ?", archive ? "archived" : "active", db.nowIso(), b.id);
    audit(db, ctxOf(req), archive ? "building.archived" : "building.unarchived", "building", b.id, {});
    res.json(buildingView(db.get("SELECT * FROM buildings WHERE id = ?", b.id)));
  });

  app.put("/api/buildings/:id/floors/:floorNumber", manage, (req, res) => {
    if (!db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", req.params.id, req.orgId)) return notFound(res, "Building");
    const floorNumber = Number(req.params.floorNumber);
    const rooms = db.all("SELECT id FROM rooms WHERE building_id = ? AND floor_number = ? AND electricity_only = 0", req.params.id, floorNumber);
    if (!rooms.length) return notFound(res, "Floor");
    const monthlyRent = Number(req.body?.monthlyRent);
    if (req.body?.monthlyRent === undefined || req.body.monthlyRent === "" || !Number.isFinite(monthlyRent) || monthlyRent < 0 || monthlyRent > 100_000_000) return res.status(400).json({ error: "Enter a valid monthly rent for this floor." });
    db.run("UPDATE rooms SET monthly_rent_paise = ?, updated_at = ? WHERE building_id = ? AND floor_number = ? AND electricity_only = 0", toPaise(monthlyRent), db.nowIso(), req.params.id, floorNumber);
    audit(db, ctxOf(req), "floor.rent_updated", "building", req.params.id, { floorNumber, monthlyRent });
    res.json({ floorNumber, monthlyRent, roomsUpdated: rooms.length });
  });

  app.delete("/api/buildings/:id/floors/:floorNumber", ownerOnly, (req, res) => {
    if (!db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", req.params.id, req.orgId)) return notFound(res, "Building");
    const floorNumber = Number(req.params.floorNumber);
    const roomIds = db.all("SELECT id FROM rooms WHERE building_id = ? AND floor_number = ?", req.params.id, floorNumber).map((r) => r.id);
    if (!roomIds.length) return notFound(res, "Floor");
    if (hasFinancialHistory(db, roomIds)) return res.status(409).json({ error: "This floor has bills, payments or leases on record, so it can't be deleted. Archive the property instead to keep the history." });
    db.tx(() => {
      deleteRoomsWithoutHistory(db, ctxOf(req), roomIds, docs);
      audit(db, ctxOf(req), "floor.deleted", "building", req.params.id, { floorNumber, roomsDeleted: roomIds.length });
    });
    res.json({ ok: true, floorNumber, roomsDeleted: roomIds.length });
  });

  app.delete("/api/buildings/:id", ownerOnly, (req, res) => {
    const b = db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Building");
    const roomIds = db.all("SELECT id FROM rooms WHERE building_id = ?", b.id).map((r) => r.id);
    if (hasFinancialHistory(db, roomIds) || db.get("SELECT 1 FROM expenses WHERE building_id = ?", b.id) || db.get("SELECT 1 FROM maintenance_requests WHERE building_id = ?", b.id)) {
      return res.status(409).json({ error: "This building has bills, payments, leases, expenses or maintenance on record, so it can't be deleted. Use Archive instead to keep the history." });
    }
    db.tx(() => {
      if (roomIds.length) deleteRoomsWithoutHistory(db, ctxOf(req), roomIds, docs);
      for (const d of db.all("SELECT id FROM documents WHERE entity_type = 'building' AND entity_id = ?", b.id)) docs.remove(db, req.orgId, d.id);
      db.run("DELETE FROM buildings WHERE id = ?", b.id);
      audit(db, ctxOf(req), "building.deleted", "building", b.id, { name: b.name });
    });
    res.json({ ok: true });
  });

  // ---------- rooms ----------
  // Rooms with their beds (status, rent, who lives there).
  const withBeds = (req, rows) => {
    const beds = occ.bedsByRoom(db, req.orgId, rows.map((r) => r.id));
    return rows.map((r) => {
      const list = beds.get(r.id) || [];
      const live = list.filter((b) => !b.disabled);
      return { ...roomView(r), beds: list, bedCount: live.length, freeBeds: live.filter((b) => b.status === "vacant" || b.status === "booked").length, sharing: occ.sharingLabel(live.length || 1) };
    });
  };
  const oneRoom = (req, id) => withBeds(req, [db.get("SELECT * FROM rooms WHERE id = ?", id)])[0];
  app.get("/api/rooms", (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.buildingId) { where.push("building_id = :buildingId"); params.buildingId = req.query.buildingId; }
    if (req.query.status) { where.push("status = :status"); params.status = String(req.query.status); }
    res.json(withBeds(req, db.all(`SELECT * FROM rooms WHERE ${where.join(" AND ")} ORDER BY floor_number, label`, params)));
  });

  app.post("/api/rooms", manage, (req, res) => {
    const buildingId = req.body?.buildingId;
    if (!buildingId) return res.status(400).json({ error: "buildingId and label are required" });
    if (!db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", buildingId, req.orgId)) return notFound(res, "Building");
    const data = v.clean(req.body, ROOM_SCHEMA);
    const bedCount = v.number({ label: "Number of beds", min: 1, max: 30, integer: true, fallback: 1 })(req.body?.beds);
    const id = db.id();
    db.tx(() => {
      db.run(`INSERT INTO rooms (id, org_id, building_id, floor_number, label, electricity_only, monthly_rent_paise, deposit_paise, status, payment_frequency, utility_notes, notes, tags_json, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, req.orgId, buildingId, data.floorNumber, data.label, data.electricityOnly ? 1 : 0, data.electricityOnly ? 0 : toPaise(data.monthlyRent), data.electricityOnly ? 0 : toPaise(data.deposit),
        data.electricityOnly ? "owner" : "vacant", data.paymentFrequency, data.utilityNotes, data.notes, JSON.stringify(data.tags), db.nowIso());
      // The first bed is added automatically; add the rest for shared rooms.
      if (!data.electricityOnly) for (let i = 1; i < bedCount; i++) db.run("INSERT INTO beds (id, org_id, room_id, label, created_at) VALUES (?,?,?,?,?)", db.id(), req.orgId, id, occ.nextBedLabel(db, id), db.nowIso());
      audit(db, ctxOf(req), "room.created", "room", id, { label: data.label, buildingId, beds: data.electricityOnly ? 0 : bedCount });
    });
    res.status(201).json(oneRoom(req, id));
  });

  app.put("/api/rooms/:id", manage, (req, res) => {
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!room) return notFound(res, "Room");
    const data = v.clean(req.body, ROOM_SCHEMA, { partial: true });
    if (data.electricityOnly && !room.electricity_only && db.get("SELECT 1 FROM tenants WHERE room_id = ? AND active = 1", room.id)) {
      return res.status(409).json({ error: "Move the current tenant out before making this an owner floor." });
    }
    const map = { floorNumber: "floor_number", label: "label", notes: "notes", utilityNotes: "utility_notes", paymentFrequency: "payment_frequency" };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) if (data[k] !== undefined) { sets.push(`${col} = ?`); params.push(data[k]); }
    if (data.monthlyRent !== undefined) { sets.push("monthly_rent_paise = ?"); params.push(toPaise(data.monthlyRent)); }
    if (data.deposit !== undefined) { sets.push("deposit_paise = ?"); params.push(toPaise(data.deposit)); }
    if (data.electricityOnly !== undefined) { sets.push("electricity_only = ?"); params.push(data.electricityOnly ? 1 : 0); }
    if (req.body?.tags !== undefined) { sets.push("tags_json = ?"); params.push(JSON.stringify(data.tags)); }
    db.tx(() => {
      if (sets.length) db.run(`UPDATE rooms SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), room.id);
      if (data.electricityOnly) db.run("UPDATE rooms SET monthly_rent_paise = 0, deposit_paise = 0 WHERE id = ?", room.id);
      occ.ensureBed(db, db.get("SELECT * FROM rooms WHERE id = ?", room.id));
      refreshRoomStatus(db, room.id);
    });
    res.json(oneRoom(req, room.id));
  });

  app.delete("/api/rooms/:id", ownerOnly, (req, res) => {
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!room) return notFound(res, "Room");
    if (hasFinancialHistory(db, [room.id])) return res.status(409).json({ error: "This room has bills, payments or leases on record, so it can't be deleted." });
    db.tx(() => {
      deleteRoomsWithoutHistory(db, ctxOf(req), [room.id], docs);
      audit(db, ctxOf(req), "room.deleted", "room", room.id, { label: room.label });
    });
    res.json({ ok: true });
  });

  // Gas meter + billing authority link. Gas companies don't share bills with
  // apps, so the owner reads the amount off the authority's own bill page.
  app.put("/api/rooms/:id/gas-meter", manage, (req, res) => {
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!room) return notFound(res, "Room");
    const meterId = v.text({ label: "Meter ID", max: 60 })(req.body?.meterId);
    const authority = db.get("SELECT * FROM authorities WHERE id = ? AND org_id = ?", req.body?.authorityId || "", req.orgId);
    if (!meterId) return res.status(400).json({ error: "Enter a meter ID." });
    if (!authority) return res.status(400).json({ error: "Choose a valid billing authority." });
    db.run("UPDATE rooms SET gas_meter_id = ?, gas_authority_id = ?, updated_at = ? WHERE id = ?", meterId, authority.id, db.nowIso(), room.id);
    res.json(roomView(db.get("SELECT * FROM rooms WHERE id = ?", room.id)));
  });

  app.delete("/api/rooms/:id/gas-meter", manage, (req, res) => {
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!room) return notFound(res, "Room");
    db.run("UPDATE rooms SET gas_meter_id = '', gas_authority_id = NULL, updated_at = ? WHERE id = ?", db.nowIso(), room.id);
    res.json(roomView(db.get("SELECT * FROM rooms WHERE id = ?", room.id)));
  });

  // ---------- billing authorities ----------
  function cleanBillUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    let url;
    try { url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`); } catch { url = null; }
    if (!url || !["http:", "https:"].includes(url.protocol) || !url.hostname.includes(".")) throw new v.ValidationError("Enter a valid website link, e.g. https://www.iglonline.net");
    return url.toString();
  }

  app.get("/api/authorities", (req, res) => {
    res.json(db.all("SELECT * FROM authorities WHERE org_id = ? ORDER BY name COLLATE NOCASE", req.orgId).map(authorityView));
  });

  app.post("/api/authorities", manage, (req, res) => {
    const name = v.text({ label: "Authority name", max: 160, required: true })(req.body?.name);
    const billUrl = cleanBillUrl(req.body?.billUrl);
    const existing = db.get("SELECT * FROM authorities WHERE org_id = ? AND name = ? COLLATE NOCASE", req.orgId, name);
    if (existing) return res.status(200).json(authorityView(existing));
    const id = db.id();
    db.run("INSERT INTO authorities (id, org_id, name, bill_url, created_at) VALUES (?,?,?,?,?)", id, req.orgId, name, billUrl, db.nowIso());
    res.status(201).json(authorityView(db.get("SELECT * FROM authorities WHERE id = ?", id)));
  });

  app.put("/api/authorities/:id", manage, (req, res) => {
    const a = db.get("SELECT * FROM authorities WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!a) return notFound(res, "Authority");
    if (req.body?.name !== undefined) db.run("UPDATE authorities SET name = ? WHERE id = ?", v.text({ label: "Authority name", max: 160, required: true })(req.body.name), a.id);
    if (req.body?.billUrl !== undefined) db.run("UPDATE authorities SET bill_url = ? WHERE id = ?", cleanBillUrl(req.body.billUrl), a.id);
    res.json(authorityView(db.get("SELECT * FROM authorities WHERE id = ?", a.id)));
  });

  app.delete("/api/authorities/:id", manage, (req, res) => {
    const a = db.get("SELECT * FROM authorities WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!a) return res.json({ ok: true });
    if (db.get("SELECT 1 FROM rooms WHERE gas_authority_id = ?", a.id)) return res.status(409).json({ error: "This authority is linked to a room. Unlink its meter first." });
    db.run("DELETE FROM authorities WHERE id = ?", a.id);
    res.json({ ok: true });
  });

  void todayFor;
}

module.exports = { register, refreshRoomStatus, hasFinancialHistory, PROPERTY_TYPES };
