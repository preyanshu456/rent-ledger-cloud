// Leases: create, edit (while draft), activate (starts the rent schedule),
// renew, end/terminate, documents, and lease-document field extraction.
// Generated agreements are not legal advice; uploaded documents are stored as-is.
const v = require("../lib/validate");
const { toPaise, toRupees } = require("../lib/money");
const { audit } = require("../services/audit");
const { generateForLease } = require("../services/schedules");
const { decodeUpload, documentView } = require("../services/documents");
const { extractFromUpload, extractLeaseFields } = require("../services/extract");
const { requirePermission, ctxOf, notFound } = require("./common");

const LEASE_SCHEMA = {
  startDate: (val) => { const d = v.date({ label: "Start date" })(val); if (!d) throw new v.ValidationError("Start date is required."); return d; },
  endDate: v.date({ label: "End date" }),
  rent: v.number({ label: "Rent", min: 0, max: 100_000_000, required: true }),
  deposit: v.money("Deposit"),
  frequency: (val) => { const f = val || "monthly"; if (!["monthly", "quarterly", "half_yearly", "yearly"].includes(f)) throw new v.ValidationError("Choose a valid rent frequency."); return f; },
  dueDay: v.number({ label: "Due day", min: 1, max: 28, integer: true, fallback: 5 }),
  noticeDays: v.number({ label: "Notice period (days)", min: 0, max: 365, integer: true, fallback: 30 }),
  terms: v.text({ label: "Terms", max: 5000 }),
  autoGenerateRent: (val) => val === undefined ? true : (val === true || val === "true" || val === "on" || val === 1 || val === "1"),
};

function leaseView(db, l, today) {
  const tenant = db.get("SELECT name FROM tenants WHERE id = ?", l.tenant_id);
  const room = db.get("SELECT r.label, b.name AS building_name, b.id AS building_id FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", l.room_id);
  const daysToEnd = l.end_date ? Math.round((Date.parse(`${l.end_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
  return {
    id: l.id, tenantId: l.tenant_id, roomId: l.room_id, tenantName: tenant?.name || "", roomLabel: room?.label || "", buildingName: room?.building_name || "", buildingId: room?.building_id || null,
    startDate: l.start_date, endDate: l.end_date, rent: toRupees(l.rent_paise), deposit: toRupees(l.deposit_paise), frequency: l.frequency, dueDay: l.due_day,
    status: l.status, autoGenerateRent: Boolean(l.auto_generate_rent), scheduleStart: l.schedule_start, noticeDays: l.notice_days, terms: l.terms,
    renewalOfLeaseId: l.renewal_of_lease_id, createdAt: l.created_at, activatedAt: l.activated_at, endedAt: l.ended_at, endReason: l.end_reason,
    daysToEnd, expiringSoon: l.status === "active" && daysToEnd !== null && daysToEnd <= 60,
    documents: db.all("SELECT * FROM documents WHERE entity_type = 'lease' AND entity_id = ? AND status = 'active' ORDER BY created_at", l.id).map(documentView),
  };
}

function register(app, { db, docs, todayFor }) {
  const manage = requirePermission("leases.manage");
  const getLease = (req) => db.get("SELECT * FROM leases WHERE id = ? AND org_id = ?", req.params.id, req.orgId);

  app.get("/api/leases", (req, res) => {
    const today = todayFor(req);
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.status) { where.push("status = :status"); params.status = String(req.query.status); }
    if (req.query.tenantId) { where.push("tenant_id = :tenantId"); params.tenantId = String(req.query.tenantId); }
    if (req.query.roomId) { where.push("room_id = :roomId"); params.roomId = String(req.query.roomId); }
    let rows = db.all(`SELECT * FROM leases WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, end_date`, params).map((l) => leaseView(db, l, today));
    const within = Number(req.query.expiringWithinDays);
    if (within > 0) rows = rows.filter((l) => l.status === "active" && l.daysToEnd !== null && l.daysToEnd <= within);
    res.json(rows);
  });

  app.get("/api/leases/:id", (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    res.json(leaseView(db, l, todayFor(req)));
  });

  app.post("/api/leases", manage, (req, res) => {
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.body?.tenantId || "", req.orgId);
    if (!tenant) return notFound(res, "Tenant");
    if (!tenant.active) return res.status(400).json({ error: "This tenant has moved out." });
    const d = v.clean(req.body, LEASE_SCHEMA);
    if (d.endDate && d.endDate <= d.startDate) return res.status(400).json({ error: "The end date must be after the start date." });
    const id = db.id();
    db.run(`INSERT INTO leases (id, org_id, tenant_id, room_id, start_date, end_date, rent_paise, deposit_paise, frequency, due_day, status, auto_generate_rent, notice_days, terms, renewal_of_lease_id, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`,
      id, req.orgId, tenant.id, tenant.room_id, d.startDate, d.endDate, toPaise(d.rent), toPaise(d.deposit), d.frequency, d.dueDay, d.autoGenerateRent ? 1 : 0, d.noticeDays, d.terms,
      req.body?.renewalOfLeaseId || null, req.user.id, db.nowIso());
    audit(db, ctxOf(req), "lease.created", "lease", id, { tenantId: tenant.id });
    res.status(201).json(leaseView(db, db.get("SELECT * FROM leases WHERE id = ?", id), todayFor(req)));
  });

  // Terms can change freely while a lease is a draft. Once active, only the
  // end date, notice period, terms text and auto-billing switch can change;
  // rent changes need a renewal (a new lease), so history stays clear.
  app.put("/api/leases/:id", manage, (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    if (["ended", "terminated"].includes(l.status)) return res.status(409).json({ error: "This lease has ended and can't be edited." });
    const d = v.clean(req.body, LEASE_SCHEMA, { partial: true });
    const allowedActive = ["endDate", "noticeDays", "terms", "autoGenerateRent"];
    if (l.status === "active" && Object.keys(d).some((k) => !allowedActive.includes(k))) {
      return res.status(409).json({ error: "An active lease's rent, dates and frequency can't be changed. Renew it to start a new lease with new terms." });
    }
    const map = { startDate: "start_date", endDate: "end_date", frequency: "frequency", dueDay: "due_day", noticeDays: "notice_days", terms: "terms" };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    if (d.rent !== undefined) { sets.push("rent_paise = ?"); params.push(toPaise(d.rent)); }
    if (d.deposit !== undefined) { sets.push("deposit_paise = ?"); params.push(toPaise(d.deposit)); }
    if (d.autoGenerateRent !== undefined) { sets.push("auto_generate_rent = ?"); params.push(d.autoGenerateRent ? 1 : 0); }
    const start = d.startDate || l.start_date;
    const end = d.endDate !== undefined ? d.endDate : l.end_date;
    if (end && end <= start) return res.status(400).json({ error: "The end date must be after the start date." });
    if (sets.length) {
      db.run(`UPDATE leases SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), l.id);
      audit(db, ctxOf(req), "lease.updated", "lease", l.id, { fields: Object.keys(d) });
    }
    res.json(leaseView(db, db.get("SELECT * FROM leases WHERE id = ?", l.id), todayFor(req)));
  });

  // Activating a lease starts its rent schedule. By default billing starts
  // with the current month (earlier months are usually already recorded);
  // `billFrom` (YYYY-MM) can start it earlier.
  app.post("/api/leases/:id/activate", manage, (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    if (l.status !== "draft") return res.status(409).json({ error: "Only a draft lease can be activated." });
    const tenant = db.get("SELECT * FROM tenants WHERE id = ?", l.tenant_id);
    if (!tenant?.active) return res.status(400).json({ error: "This tenant has moved out." });
    const today = todayFor(req);
    const billFrom = /^\d{4}-\d{2}$/.test(String(req.body?.billFrom || "")) ? req.body.billFrom : today.slice(0, 7);
    const created = db.tx(() => {
      const previous = db.get("SELECT id FROM leases WHERE tenant_id = ? AND status = 'active'", l.tenant_id);
      if (previous) db.run("UPDATE leases SET status = 'ended', ended_at = ?, end_reason = ? WHERE id = ?", db.nowIso(), "Replaced by renewal", previous.id);
      db.run("UPDATE leases SET status = 'active', activated_at = ?, schedule_start = ? WHERE id = ?", db.nowIso(), billFrom, l.id);
      db.run("UPDATE rooms SET monthly_rent_paise = ?, updated_at = ? WHERE id = ? AND electricity_only = 0", l.frequency === "monthly" ? l.rent_paise : db.get("SELECT monthly_rent_paise FROM rooms WHERE id = ?", l.room_id).monthly_rent_paise, db.nowIso(), l.room_id);
      if (tenant.deposit_paise === null || tenant.deposit_paise === undefined || tenant.deposit_paise !== l.deposit_paise) db.run("UPDATE tenants SET deposit_paise = ? WHERE id = ?", l.deposit_paise, tenant.id);
      audit(db, ctxOf(req), "lease.activated", "lease", l.id, { billFrom });
      return generateForLease(db, db.get("SELECT * FROM leases WHERE id = ?", l.id), today, { userId: req.user.id });
    });
    res.json({ ...leaseView(db, db.get("SELECT * FROM leases WHERE id = ?", l.id), today), chargesCreated: created.length });
  });

  app.post("/api/leases/:id/end", manage, (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    if (!["active", "draft"].includes(l.status)) return res.status(409).json({ error: "This lease has already ended." });
    const terminated = req.body?.terminate === true || req.body?.terminate === "true";
    const reason = v.text({ label: "Reason", max: 300 })(req.body?.reason) || (terminated ? "Terminated" : "Ended");
    db.run("UPDATE leases SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?", terminated ? "terminated" : "ended", db.nowIso(), reason, l.id);
    audit(db, ctxOf(req), terminated ? "lease.terminated" : "lease.ended", "lease", l.id, { reason });
    res.json(leaseView(db, db.get("SELECT * FROM leases WHERE id = ?", l.id), todayFor(req)));
  });

  // Renewal = a new draft lease starting the day after this one ends.
  app.post("/api/leases/:id/renew", manage, (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    if (l.status !== "active") return res.status(409).json({ error: "Only an active lease can be renewed." });
    const nextStart = l.end_date ? new Date(Date.parse(`${l.end_date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : todayFor(req);
    const body = { startDate: nextStart, rent: toRupees(l.rent_paise), deposit: toRupees(l.deposit_paise), frequency: l.frequency, dueDay: l.due_day, noticeDays: l.notice_days, terms: l.terms, ...req.body };
    const d = v.clean(body, LEASE_SCHEMA);
    if (d.endDate && d.endDate <= d.startDate) return res.status(400).json({ error: "The end date must be after the start date." });
    const id = db.id();
    db.run(`INSERT INTO leases (id, org_id, tenant_id, room_id, start_date, end_date, rent_paise, deposit_paise, frequency, due_day, status, auto_generate_rent, notice_days, terms, renewal_of_lease_id, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?)`,
      id, req.orgId, l.tenant_id, l.room_id, d.startDate, d.endDate, toPaise(d.rent), toPaise(d.deposit), d.frequency, d.dueDay, d.autoGenerateRent ? 1 : 0, d.noticeDays, d.terms, l.id, req.user.id, db.nowIso());
    audit(db, ctxOf(req), "lease.renewal_drafted", "lease", id, { renews: l.id });
    res.status(201).json(leaseView(db, db.get("SELECT * FROM leases WHERE id = ?", id), todayFor(req)));
  });

  app.post("/api/leases/:id/documents", manage, (req, res) => {
    const l = getLease(req);
    if (!l) return notFound(res, "Lease");
    const upload = decodeUpload(req.body);
    if (!upload) return res.status(400).json({ error: "Upload a valid PDF or image up to 10 MB." });
    const id = docs.save(db, ctxOf(req), { entityType: "lease", entityId: l.id, kind: "lease_document", upload, visibleToTenant: req.body?.visibleToTenant !== false });
    audit(db, ctxOf(req), "lease.document_added", "lease", l.id, { documentId: id });
    res.status(201).json(documentView(db.get("SELECT * FROM documents WHERE id = ?", id)));
  });

  // Suggest lease fields from an uploaded agreement or pasted text. Nothing
  // is saved; the owner reviews the suggestions and fills the form.
  app.post("/api/leases/extract", manage, (req, res) => {
    if (typeof req.body?.text === "string") {
      const text = req.body.text.slice(0, 50_000);
      return res.json({ fields: extractLeaseFields(text), note: "Suggestions only. Check every value against the agreement before saving." });
    }
    const upload = decodeUpload(req.body);
    if (!upload) return res.status(400).json({ error: "Upload a PDF or paste the agreement text." });
    const result = extractFromUpload(upload);
    res.json({ fields: result.fields, note: result.note || "Suggestions only. Check every value against the agreement before saving.", textPreview: result.text.slice(0, 1500) });
  });
}

module.exports = { register, leaseView };
