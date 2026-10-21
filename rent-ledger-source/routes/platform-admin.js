// Cross-organisation property-manager operations. This module is deliberately
// separate from owner routes and is disabled unless the deployment allowlists
// up to two existing account contacts.
const v = require("../lib/validate");
const { toPaise } = require("../lib/money");
const accounts = require("../services/accounts");
const ledger = require("../services/ledger");
const { tenantView, electricityView, chargeExtras } = require("../services/views");
const { audit } = require("../services/audit");
const { removeTenantLogins, clearIdentity } = require("./tenants");
const { refreshRoomStatus } = require("./properties");
const { freeBeds } = require("../services/occupancy");
const { notFound, orgTimeZone } = require("./common");
const { localDate } = require("../lib/dates");

const TENANT_SCHEMA = {
  name: v.text({ label: "Full name", max: 120, required: true }),
  mobile: v.mobile({ label: "Mobile number", required: true }),
  altMobile: v.mobile({ label: "Alternate mobile" }),
  email: v.email(),
  idProofType: v.text({ label: "ID proof type", max: 40 }),
  idProofNumber: v.text({ label: "ID proof number", max: 40 }),
  moveInDate: v.date({ label: "Move-in date" }),
  notes: v.text({ label: "Notes", max: 1000 }),
  notifyEmail: v.bool(),
  notifySms: v.bool(),
  notifyWhatsapp: v.bool(),
};

const ELECTRICITY_SCHEMA = {
  month: v.month(),
  year: v.year(),
  prevReading: v.number({ label: "Previous reading", min: 0, max: 1e9 }),
  currReading: v.number({ label: "Current reading", min: 0, max: 1e9 }),
  ratePerUnit: v.money("Rate per unit"),
  dueDate: v.date({ label: "Due date" }),
  notes: v.text({ label: "Notes", max: 1000 }),
};

function platformContext(req, orgId = null) {
  return { orgId, userId: req.user.id, role: "platform_admin", requestId: req.id };
}

function register(app, { db, config }) {
  const allowedContacts = new Set((config.platformAdminContacts || []).map(accounts.contactKey).filter(Boolean));
  const onlyPlatformAdmin = (req, res, next) => {
    if (!allowedContacts.size) return res.status(404).json({ error: "Not found" });
    if (!allowedContacts.has(req.user?.contact_key) || !["owner", "manager"].includes(req.user?.role)) {
      return res.status(403).json({ error: "Property manager access required." });
    }
    next();
  };

  app.get("/api/platform-admin/organizations", onlyPlatformAdmin, (req, res) => {
    audit(db, platformContext(req), "platform_admin.organizations_listed", "organization", null, {});
    const organizations = db.all(`
      SELECT o.id, o.name, o.created_at,
        (SELECT u.name FROM users u WHERE u.org_id = o.id AND u.role = 'owner' AND u.disabled_at IS NULL ORDER BY u.created_at LIMIT 1) AS owner_name
      FROM organizations o ORDER BY o.name COLLATE NOCASE, o.created_at`);
    res.json(organizations);
  });

  app.get("/api/platform-admin/organizations/:orgId", onlyPlatformAdmin, (req, res) => {
    const org = db.get("SELECT id, name FROM organizations WHERE id = ?", req.params.orgId);
    if (!org) return notFound(res, "Owner account");
    audit(db, platformContext(req, org.id), "platform_admin.organization_viewed", "organization", org.id, {});
    const buildings = db.all("SELECT id, name, address FROM buildings WHERE org_id = ? AND status <> 'archived' ORDER BY name COLLATE NOCASE", org.id);
    const rooms = db.all(`
      SELECT r.id, r.building_id AS buildingId, r.label, r.floor_number AS floorNumber,
        r.status, r.electricity_only AS electricityOnly,
        t.id AS tenant_id, t.name AS tenant_name, t.mobile AS tenant_mobile, t.active AS tenant_active
      FROM rooms r LEFT JOIN tenants t ON t.room_id = r.id AND t.active = 1
      WHERE r.org_id = ? AND r.status <> 'archived'
      ORDER BY r.building_id, r.floor_number, r.label`, org.id).map((room) => ({
      id: room.id, buildingId: room.buildingId, label: room.label, floorNumber: room.floorNumber,
      status: room.status, electricityOnly: Boolean(room.electricityOnly),
      tenant: room.tenant_id ? { id: room.tenant_id, name: room.tenant_name, mobile: room.tenant_mobile } : null,
    }));
    const tenants = db.all(`SELECT id, room_id AS roomId, name, mobile, active, move_in_date AS moveInDate, move_out_date AS moveOutDate
      FROM tenants WHERE org_id = ? ORDER BY active DESC, name COLLATE NOCASE`, org.id)
      .map((tenant) => ({ ...tenant, active: Boolean(tenant.active) }));
    res.json({ organization: org, buildings, rooms, tenants });
  });

  app.post("/api/platform-admin/organizations/:orgId/tenants", onlyPlatformAdmin, (req, res) => {
    const orgId = req.params.orgId;
    if (!db.get("SELECT 1 FROM organizations WHERE id = ?", orgId)) return notFound(res, "Owner account");
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "Room, name and mobile are required." });
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", roomId, orgId);
    if (!room) return notFound(res, "Room");
    if (room.electricity_only) return res.status(400).json({ error: "Owner electricity-only floors cannot have tenants." });
    if (room.status === "archived") return res.status(400).json({ error: "This room is archived." });
    if (!freeBeds(db, roomId).length) return res.status(409).json({ error: "This room already has an active tenant." });
    const data = v.clean(req.body, TENANT_SCHEMA);
    if (db.all("SELECT id, mobile FROM tenants WHERE org_id = ? AND active = 1", orgId).some((t) => accounts.sameMobile(t.mobile, data.mobile))) {
      return res.status(409).json({ error: "Another active tenant already uses this mobile number." });
    }
    const id = db.id();
    const ctx = platformContext(req, orgId);
    db.tx(() => {
      db.run(`INSERT INTO tenants (id, org_id, room_id, name, mobile, alt_mobile, email, id_proof_type, id_proof_number, move_in_date, active, deposit_paise, notes, notify_email, notify_sms, notify_whatsapp, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        id, orgId, roomId, data.name, data.mobile, data.altMobile, data.email, data.idProofType, data.idProofNumber, data.moveInDate,
        req.body?.deposit !== undefined && req.body.deposit !== "" ? toPaise(v.money("Deposit")(req.body.deposit)) : room.deposit_paise,
        data.notes, data.notifyEmail ? 1 : 0, data.notifySms ? 1 : 0, data.notifyWhatsapp ? 1 : 0, db.nowIso());
      refreshRoomStatus(db, roomId);
      audit(db, ctx, "platform_admin.tenant_created", "tenant", id, { roomId });
    });
    res.status(201).json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", id, orgId)));
  });

  app.post("/api/platform-admin/organizations/:orgId/tenants/:tenantId/move-out", onlyPlatformAdmin, (req, res) => {
    const orgId = req.params.orgId;
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.tenantId, orgId);
    if (!tenant) return notFound(res, "Tenant");
    if (!tenant.active) return res.status(409).json({ error: "This tenant has already moved out." });
    const moveOutDate = v.date({ label: "Move-out date" })(req.body?.moveOutDate) || localDate(orgTimeZone(db, orgId));
    const ctx = platformContext(req, orgId);
    let removedLoginAccounts = 0;
    db.tx(() => {
      db.run("UPDATE tenants SET active = 0, move_out_date = ?, leaving_on = '', updated_at = ? WHERE id = ? AND org_id = ?", moveOutDate, db.nowIso(), tenant.id, orgId);
      db.run("UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'Tenant moved out' WHERE tenant_id = ? AND status = 'active'", db.nowIso(), tenant.id);
      removedLoginAccounts = removeTenantLogins(db, [tenant.id]);
      clearIdentity(db, tenant.id);
      refreshRoomStatus(db, tenant.room_id);
      audit(db, ctx, "platform_admin.tenant_moved_out", "tenant", tenant.id, { moveOutDate });
    });
    res.json({ ...tenantView(db, db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", tenant.id, orgId)), removedLoginAccounts, identityCleared: true });
  });

  app.post("/api/platform-admin/organizations/:orgId/electricity", onlyPlatformAdmin, (req, res) => {
    const orgId = req.params.orgId;
    if (!db.get("SELECT 1 FROM organizations WHERE id = ?", orgId)) return notFound(res, "Owner account");
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "Room, month and year are required." });
    const data = v.clean(req.body, ELECTRICITY_SCHEMA);
    if (data.currReading < data.prevReading) return res.status(400).json({ error: "Current reading cannot be lower than the previous reading." });
    const units = data.currReading - data.prevReading;
    const amountPaise = Math.round(units * data.ratePerUnit * 100);
    const ctx = platformContext(req, orgId);
    const today = localDate(orgTimeZone(db, orgId));
    const chargeId = db.tx(() => {
      const id = ledger.createCharge(db, ctx, {
        roomId, tenantId: req.body?.tenantId || null, kind: "electricity", periodYear: data.year, periodMonth: data.month,
        dueDate: data.dueDate, amountPaise, notes: data.notes,
        details: { prevReading: data.prevReading, currReading: data.currReading, unitsConsumed: units, ratePerUnit: data.ratePerUnit },
      });
      audit(db, ctx, "platform_admin.electricity_bill_created", "charge", id, { roomId, unitsConsumed: units, amountPaise });
      return id;
    });
    const charge = ledger.getCharge(db, orgId, chargeId, today);
    res.status(201).json({ id: chargeId, roomId, tenantId: charge.tenant_id, unitsConsumed: units, amountPaise: charge.amount_paise, periodMonth: data.month, periodYear: data.year, dueDate: data.dueDate });
  });

  app.get("/api/platform-admin/organizations/:orgId/electricity", onlyPlatformAdmin, (req, res) => {
    const orgId = req.params.orgId;
    if (!db.get("SELECT 1 FROM organizations WHERE id = ?", orgId)) return notFound(res, "Owner account");
    const roomId = req.query.roomId;
    if (!roomId) return res.status(400).json({ error: "Room is required." });
    if (!db.get("SELECT 1 FROM rooms WHERE id = ? AND org_id = ? AND status <> 'archived'", roomId, orgId)) return notFound(res, "Room");
    const today = localDate(orgTimeZone(db, orgId));
    const entries = ledger.listCharges(db, orgId, { kind: "electricity", roomId }, today);
    const extras = chargeExtras(db, entries.map((entry) => entry.id));
    audit(db, platformContext(req, orgId), "platform_admin.electricity_history_viewed", "room", roomId, { count: entries.length });
    res.json(entries.map((entry) => electricityView(entry, extras.get(entry.id))));
  });
}

module.exports = { register };
