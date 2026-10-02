// Tenants: records, login invites, move-out, removal (anonymisation) and the
// owner-tenant message history.
const v = require("../lib/validate");
const { config } = require("../lib/config");
const { toPaise } = require("../lib/money");
const accounts = require("../services/accounts");
const { audit } = require("../services/audit");
const { tenantView } = require("../services/views");
const { notify } = require("../services/notify");
const { inviteHash, newInviteCode } = require("./auth");
const { refreshRoomStatus } = require("./properties");
const { requirePermission, ownerOnly, ctxOf, notFound } = require("./common");

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
const COLUMN = {
  name: "name", mobile: "mobile", altMobile: "alt_mobile", email: "email", idProofType: "id_proof_type", idProofNumber: "id_proof_number",
  moveInDate: "move_in_date", notes: "notes", notifyEmail: "notify_email", notifySms: "notify_sms", notifyWhatsapp: "notify_whatsapp",
};

function mobileInUse(db, orgId, mobile, exceptId) {
  return db.all("SELECT id, mobile FROM tenants WHERE org_id = ? AND active = 1 AND id <> ?", orgId, exceptId || "").some((t) => accounts.sameMobile(t.mobile, mobile));
}

function removeTenantLogins(db, tenantIds) {
  if (!tenantIds.length) return 0;
  const ph = tenantIds.map(() => "?").join(",");
  db.run(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id IN (${ph}))`, ...tenantIds);
  return db.run(`DELETE FROM users WHERE tenant_id IN (${ph})`, ...tenantIds).changes;
}

// Keeps the tenancy and its money history, removes contact and ID details.
function clearIdentity(db, tenantId) {
  db.run("UPDATE tenants SET mobile = '', alt_mobile = '', email = '', id_proof_number = '', invite_code_hash = NULL, invite_expires_at = NULL, invite_attempts = 0, notify_email = 0, notify_sms = 0, notify_whatsapp = 0, updated_at = ? WHERE id = ?", new Date().toISOString(), tenantId);
}

function register(app, { db, todayFor }) {
  const manage = requirePermission("tenants.manage");

  app.get("/api/tenants", (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.roomId) { where.push("room_id = :roomId"); params.roomId = req.query.roomId; }
    if (req.query.active === "1" || req.query.active === "0") { where.push("active = :active"); params.active = Number(req.query.active); }
    if (req.query.q) { where.push("(name LIKE :q OR mobile LIKE :q)"); params.q = `%${String(req.query.q).slice(0, 60)}%`; }
    res.json(db.all(`SELECT * FROM tenants WHERE ${where.join(" AND ")} ORDER BY created_at`, params).map((t) => tenantView(db, t)));
  });

  app.get("/api/tenants/:id", (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    res.json(tenantView(db, t));
  });

  app.post("/api/tenants", manage, (req, res) => {
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "roomId, name and mobile are required" });
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", roomId, req.orgId);
    if (!room) return notFound(res, "Room");
    if (room.electricity_only) return res.status(400).json({ error: "Owner electricity-only floors cannot have tenants." });
    if (room.status === "archived") return res.status(400).json({ error: "This room is archived." });
    if (db.get("SELECT 1 FROM tenants WHERE room_id = ? AND active = 1", roomId)) return res.status(409).json({ error: "This room already has an active tenant. Mark them as moved out first." });
    const data = v.clean(req.body, TENANT_SCHEMA);
    if (mobileInUse(db, req.orgId, data.mobile)) return res.status(409).json({ error: "Another active tenant already uses this mobile number." });
    const id = db.id();
    db.tx(() => {
      db.run(`INSERT INTO tenants (id, org_id, room_id, name, mobile, alt_mobile, email, id_proof_type, id_proof_number, move_in_date, active, deposit_paise, notes, notify_email, notify_sms, notify_whatsapp, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?)`,
        id, req.orgId, roomId, data.name, data.mobile, data.altMobile, data.email, data.idProofType, data.idProofNumber, data.moveInDate,
        // Deposit agreed for this tenancy, taken from the room at move-in (or given explicitly).
        req.body?.deposit !== undefined && req.body.deposit !== "" ? toPaise(v.money("Deposit")(req.body.deposit)) : room.deposit_paise,
        data.notes, data.notifyEmail ? 1 : 0, data.notifySms ? 1 : 0, data.notifyWhatsapp ? 1 : 0, db.nowIso());
      refreshRoomStatus(db, roomId);
      audit(db, ctxOf(req), "tenant.created", "tenant", id, { roomId });
    });
    res.status(201).json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", id)));
  });

  app.put("/api/tenants/:id", manage, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    const data = v.clean(req.body, TENANT_SCHEMA, { partial: true });
    if (data.mobile && t.active && mobileInUse(db, req.orgId, data.mobile, t.id)) return res.status(409).json({ error: "Another active tenant already uses this mobile number." });
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(COLUMN)) if (data[k] !== undefined) { sets.push(`${col} = ?`); params.push(typeof data[k] === "boolean" ? (data[k] ? 1 : 0) : data[k]); }
    if (req.body?.deposit !== undefined) { sets.push("deposit_paise = ?"); params.push(toPaise(v.money("Deposit")(req.body.deposit))); }
    if (sets.length) {
      db.run(`UPDATE tenants SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), t.id);
      audit(db, ctxOf(req), "tenant.updated", "tenant", t.id, { fields: Object.keys(data) });
    }
    res.json(tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", t.id)));
  });

  // One-time invite code the tenant uses to create their login.
  app.post("/api/tenants/:id/invite", manage, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    if (!t.active) return res.status(400).json({ error: "This tenant has moved out." });
    if (!t.mobile) return res.status(400).json({ error: "Add the tenant's mobile number first." });
    if (db.get("SELECT 1 FROM users WHERE tenant_id = ?", t.id)) return res.status(409).json({ error: "This tenant already has a login." });
    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + config.inviteTtlDays * 86_400_000).toISOString();
    db.run("UPDATE tenants SET invite_code_hash = ?, invite_expires_at = ?, invite_attempts = 0, invite_created_at = ? WHERE id = ?", inviteHash(code), expiresAt, db.nowIso(), t.id);
    audit(db, ctxOf(req), "tenant.invite_created", "tenant", t.id, {});
    res.status(201).json({ code, expiresAt, mobile: t.mobile });
  });

  app.delete("/api/tenants/:id/invite", manage, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    db.run("UPDATE tenants SET invite_code_hash = NULL, invite_expires_at = NULL, invite_attempts = 0 WHERE id = ?", t.id);
    res.json({ ok: true });
  });

  // Marks the tenant as moved out: keeps their bills, removes their login and
  // personal contact/ID details.
  app.post("/api/tenants/:id/move-out", manage, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    const moveOutDate = v.date({ label: "Move-out date" })(req.body?.moveOutDate) || todayFor(req);
    let removedLoginAccounts = 0;
    db.tx(() => {
      db.run("UPDATE tenants SET active = 0, move_out_date = ?, updated_at = ? WHERE id = ?", moveOutDate, db.nowIso(), t.id);
      db.run("UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'Tenant moved out' WHERE tenant_id = ? AND status = 'active'", db.nowIso(), t.id);
      removedLoginAccounts = removeTenantLogins(db, [t.id]);
      clearIdentity(db, t.id);
      refreshRoomStatus(db, t.room_id);
      audit(db, ctxOf(req), "tenant.moved_out", "tenant", t.id, { moveOutDate });
    });
    res.json({ ...tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", t.id)), removedLoginAccounts, identityCleared: true });
  });

  // "Remove record" for a former tenant. Their money history must stay intact,
  // so the record is anonymised instead of deleted.
  app.delete("/api/tenants/:id", ownerOnly, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    if (t.active) return res.status(409).json({ error: "Mark the tenant as moved out first." });
    db.tx(() => {
      removeTenantLogins(db, [t.id]);
      clearIdentity(db, t.id);
      db.run("UPDATE tenants SET name = ?, id_proof_type = '', notes = '', anonymized_at = ? WHERE id = ?", `Former tenant ${t.id.slice(0, 4).toUpperCase()}`, db.nowIso(), t.id);
      audit(db, ctxOf(req), "tenant.anonymized", "tenant", t.id, {});
    });
    res.json({ ok: true, anonymized: true });
  });

  // ---------- communication history ----------
  app.get("/api/tenants/:id/messages", manage, (req, res) => {
    const t = db.get("SELECT id FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    db.run("UPDATE messages SET read_at = ? WHERE tenant_id = ? AND direction = 'to_owner' AND read_at IS NULL", db.nowIso(), t.id);
    const messages = db.all("SELECT m.*, u.name AS author FROM messages m LEFT JOIN users u ON u.id = m.created_by WHERE m.tenant_id = ? ORDER BY m.created_at", t.id);
    const outbox = db.all("SELECT id, channel, subject, body, status, created_at, sent_at FROM outbox WHERE tenant_id = ? AND status IN ('sent','simulated','failed') ORDER BY created_at", t.id);
    res.json({ messages: messages.map((m) => ({ id: m.id, direction: m.direction, body: m.body, author: m.author || "", createdAt: m.created_at, readAt: m.read_at })), sentNotices: outbox });
  });

  app.post("/api/tenants/:id/messages", manage, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    const body = v.text({ label: "Message", max: 2000, required: true })(req.body?.body);
    const id = db.id();
    db.run("INSERT INTO messages (id, org_id, tenant_id, direction, body, created_by, created_at) VALUES (?,?,?,?,?,?,?)", id, req.orgId, t.id, "to_tenant", body, req.user.id, db.nowIso());
    const tenantUser = db.get("SELECT id FROM users WHERE tenant_id = ?", t.id);
    if (tenantUser) notify(db, { orgId: req.orgId, userId: tenantUser.id, kind: "message", title: "New message from your owner", body: body.slice(0, 200), link: "tenant:messages" });
    res.status(201).json({ id });
  });
}

module.exports = { register, removeTenantLogins, clearIdentity };
