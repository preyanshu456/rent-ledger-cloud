// Beds, room tags, notice, moving a tenant to another bed, and the occupancy view.
const v = require("../lib/validate");
const { toPaise } = require("../lib/money");
const { audit } = require("../services/audit");
const { tenantView } = require("../services/views");
const occ = require("../services/occupancy");
const { refreshRoomStatus } = require("./properties");
const { requirePermission, ctxOf, notFound } = require("./common");

const TAGS = (value) => {
  if (value === undefined || value === null || value === "") return [];
  const list = Array.isArray(value) ? value : String(value).split(",");
  const out = [...new Set(list.map((a) => String(a).trim()).filter(Boolean))].slice(0, 20);
  if (out.some((a) => a.length > 40)) throw new v.ValidationError("Each tag must be 40 characters or fewer.");
  return out;
};

function register(app, { db, todayFor }) {
  const manageProps = requirePermission("properties.manage");
  const manageTenants = requirePermission("tenants.manage");
  const roomOf = (req, id) => db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", id, req.orgId);
  const bedsJson = (req, roomId) => occ.bedsByRoom(db, req.orgId, [roomId]).get(roomId) || [];

  // ---------- occupancy ----------
  app.get("/api/occupancy", (req, res) => {
    res.json(occ.occupancy(db, req.orgId, { buildingId: req.query.buildingId || undefined }));
  });

  // ---------- beds ----------
  app.get("/api/rooms/:id/beds", (req, res) => {
    const room = roomOf(req, req.params.id);
    if (!room) return notFound(res, "Room");
    res.json(bedsJson(req, room.id));
  });

  // Add one bed, or `count` beds named Bed 2, Bed 3...
  app.post("/api/rooms/:id/beds", manageProps, (req, res) => {
    const room = roomOf(req, req.params.id);
    if (!room) return notFound(res, "Room");
    if (room.electricity_only) return res.status(400).json({ error: "Owner electricity-only floors cannot have beds." });
    const count = v.number({ label: "Number of beds", min: 1, max: 30, integer: true, fallback: 1 })(req.body?.count);
    const label = v.text({ label: "Bed name", max: 40 })(req.body?.label);
    const rent = req.body?.monthlyRent === undefined || req.body.monthlyRent === "" ? null : toPaise(v.money("Bed rent")(req.body.monthlyRent));
    if (db.get("SELECT COUNT(*) AS n FROM beds WHERE room_id = ?", room.id).n + count > 30) return res.status(400).json({ error: "A room can have at most 30 beds." });
    db.tx(() => {
      for (let i = 0; i < count; i++) {
        const name = label && count === 1 ? label : occ.nextBedLabel(db, room.id);
        if (db.get("SELECT 1 FROM beds WHERE room_id = ? AND label = ? COLLATE NOCASE", room.id, name)) throw Object.assign(new Error("A bed with this name already exists in the room."), { status: 409, expose: true });
        db.run("INSERT INTO beds (id, org_id, room_id, label, monthly_rent_paise, created_at) VALUES (?,?,?,?,?,?)", db.id(), req.orgId, room.id, name, rent, db.nowIso());
      }
      audit(db, ctxOf(req), "beds.added", "room", room.id, { count });
    });
    res.status(201).json(bedsJson(req, room.id));
  });

  app.put("/api/beds/:id", manageProps, (req, res) => {
    const bed = db.get("SELECT * FROM beds WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!bed) return notFound(res, "Bed");
    const sets = [];
    const params = [];
    if (req.body?.label !== undefined) {
      const label = v.text({ label: "Bed name", max: 40, required: true })(req.body.label);
      if (db.get("SELECT 1 FROM beds WHERE room_id = ? AND label = ? COLLATE NOCASE AND id <> ?", bed.room_id, label, bed.id)) return res.status(409).json({ error: "A bed with this name already exists in the room." });
      sets.push("label = ?"); params.push(label);
    }
    if (req.body?.monthlyRent !== undefined) { sets.push("monthly_rent_paise = ?"); params.push(req.body.monthlyRent === "" || req.body.monthlyRent === null ? null : toPaise(v.money("Bed rent")(req.body.monthlyRent))); }
    if (req.body?.notes !== undefined) { sets.push("notes = ?"); params.push(v.text({ label: "Notes", max: 500 })(req.body.notes)); }
    if (req.body?.disabled !== undefined) {
      const disabled = v.bool()(req.body.disabled);
      if (disabled && db.get("SELECT 1 FROM tenants WHERE bed_id = ? AND active = 1", bed.id)) return res.status(409).json({ error: "Someone lives in this bed. Move them out or to another bed first." });
      sets.push("disabled = ?"); params.push(disabled ? 1 : 0);
    }
    if (sets.length) {
      db.run(`UPDATE beds SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), bed.id);
      audit(db, ctxOf(req), "bed.updated", "bed", bed.id, { fields: Object.keys(req.body || {}) });
    }
    res.json(bedsJson(req, bed.room_id).find((b) => b.id === bed.id));
  });

  // A bed with any history (a tenant ever lived there, or a booking) is
  // disabled instead of deleted, so old records keep pointing at it.
  app.delete("/api/beds/:id", manageProps, (req, res) => {
    const bed = db.get("SELECT * FROM beds WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!bed) return notFound(res, "Bed");
    if (db.get("SELECT COUNT(*) AS n FROM beds WHERE room_id = ?", bed.room_id).n <= 1) return res.status(409).json({ error: "A room needs at least one bed." });
    const used = db.get("SELECT 1 FROM tenants WHERE bed_id = ?", bed.id) || (occ.hasTable(db, "bookings") && db.get("SELECT 1 FROM bookings WHERE bed_id = ?", bed.id));
    if (used) return res.status(409).json({ error: "This bed has tenant or booking history, so it can't be deleted. Mark it as not for rent instead." });
    db.run("DELETE FROM beds WHERE id = ?", bed.id);
    audit(db, ctxOf(req), "bed.deleted", "bed", bed.id, { label: bed.label });
    res.json({ ok: true });
  });

  app.put("/api/rooms/:id/tags", manageProps, (req, res) => {
    const room = roomOf(req, req.params.id);
    if (!room) return notFound(res, "Room");
    const tags = TAGS(req.body?.tags);
    db.run("UPDATE rooms SET tags_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(tags), db.nowIso(), room.id);
    res.json({ id: room.id, tags });
  });

  // ---------- notice ----------
  app.post("/api/tenants/:id/notice", manageTenants, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    if (!t.active) return res.status(400).json({ error: "This tenant has moved out." });
    const leavingOn = v.date({ label: "Leaving on" })(req.body?.leavingOn);
    if (!leavingOn) return res.status(400).json({ error: "Enter the date the tenant will leave." });
    const givenOn = v.date({ label: "Notice given on" })(req.body?.noticeGivenOn) || todayFor(req);
    if (leavingOn < givenOn) return res.status(400).json({ error: "The leaving date can't be before the notice date." });
    db.run("UPDATE tenants SET notice_given_on = ?, leaving_on = ?, updated_at = ? WHERE id = ?", givenOn, leavingOn, db.nowIso(), t.id);
    audit(db, ctxOf(req), "tenant.notice_given", "tenant", t.id, { leavingOn, givenOn });
    res.json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", t.id)));
  });

  app.delete("/api/tenants/:id/notice", manageTenants, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    db.run("UPDATE tenants SET notice_given_on = '', leaving_on = '', updated_at = ? WHERE id = ?", db.nowIso(), t.id);
    audit(db, ctxOf(req), "tenant.notice_withdrawn", "tenant", t.id, {});
    res.json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", t.id)));
  });

  // ---------- move a tenant to another bed (same or another room) ----------
  // Past bills stay with the old room; the active lease and future bills
  // follow the tenant.
  app.post("/api/tenants/:id/move-bed", manageTenants, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    if (!t.active) return res.status(400).json({ error: "This tenant has moved out." });
    const bed = db.get("SELECT * FROM beds WHERE id = ? AND org_id = ?", req.body?.bedId || "", req.orgId);
    if (!bed) return notFound(res, "Bed");
    if (bed.id === t.bed_id) return res.json(tenantView(db, t));
    if (bed.disabled) return res.status(409).json({ error: "That bed is marked as not for rent." });
    if (db.get("SELECT 1 FROM tenants WHERE bed_id = ? AND active = 1", bed.id)) return res.status(409).json({ error: "Someone already lives in that bed." });
    const room = db.get("SELECT * FROM rooms WHERE id = ?", bed.room_id);
    if (room.status === "archived") return res.status(400).json({ error: "That room is archived." });
    db.tx(() => {
      db.run("UPDATE tenants SET bed_id = ?, room_id = ?, updated_at = ? WHERE id = ?", bed.id, bed.room_id, db.nowIso(), t.id);
      if (bed.room_id !== t.room_id) {
        db.run("UPDATE leases SET room_id = ?, updated_at = ? WHERE tenant_id = ? AND status IN ('active', 'draft')", bed.room_id, db.nowIso(), t.id);
        refreshRoomStatus(db, t.room_id);
        refreshRoomStatus(db, bed.room_id);
      }
      audit(db, ctxOf(req), "tenant.moved_bed", "tenant", t.id, { fromBedId: t.bed_id, toBedId: bed.id, fromRoomId: t.room_id, toRoomId: bed.room_id });
    });
    res.json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", t.id)));
  });
}

module.exports = { register };
