// Maintenance requests (from tenants or staff), their status timeline,
// comments and photos, plus expenses linked to them.
const v = require("../lib/validate");
const { toRupees } = require("../lib/money");
const { audit } = require("../services/audit");
const { notify, notifyStaff } = require("../services/notify");
const { decodeUpload, documentView } = require("../services/documents");
const { requirePermission, tenantOnly, ctxOf, notFound } = require("./common");

const CATEGORIES = ["plumbing", "electrical", "appliance", "carpentry", "painting", "cleaning", "pest_control", "security", "internet", "other"];
const PRIORITIES = ["low", "normal", "high", "urgent"];
const STATUS_LABELS = { submitted: "Submitted", under_review: "Under review", approved: "Approved", assigned: "Assigned", in_progress: "In progress", awaiting_tenant: "Waiting for you", resolved: "Resolved", closed: "Closed" };
// Which status changes staff may make.
const NEXT = {
  submitted: ["under_review", "approved", "assigned", "in_progress", "resolved", "closed"],
  under_review: ["approved", "assigned", "in_progress", "closed"],
  approved: ["assigned", "in_progress", "closed"],
  assigned: ["in_progress", "awaiting_tenant", "resolved", "closed"],
  in_progress: ["awaiting_tenant", "resolved", "assigned"],
  awaiting_tenant: ["in_progress", "resolved", "closed"],
  resolved: ["closed", "in_progress"],
  closed: ["in_progress"],
};

const pick = (list, label, fallback) => (val) => {
  if (val === undefined || val === null || val === "") { if (fallback !== undefined) return fallback; throw new v.ValidationError(`${label} is required.`); }
  if (!list.includes(val)) throw new v.ValidationError(`Choose a valid ${label.toLowerCase()}.`);
  return val;
};

function register(app, { db, docs }) {
  const manage = requirePermission("maintenance.manage");

  function addEvent(req, requestId, { type, from = null, to = null, comment = "", visible = true }) {
    db.run("INSERT INTO maintenance_events (id, org_id, request_id, actor_user_id, actor_role, type, from_status, to_status, comment, visible_to_tenant, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      db.id(), req.orgId, requestId, req.user.id, req.user.role, type, from, to, String(comment || "").slice(0, 2000), visible ? 1 : 0, db.nowIso());
  }
  function tellTenant(req, r, title, body) {
    if (!r.tenant_id) return;
    const user = db.get("SELECT id FROM users WHERE tenant_id = ?", r.tenant_id);
    if (user) notify(db, { orgId: req.orgId, userId: user.id, kind: "maintenance", title, body, link: `tenant:maintenance:${r.id}` });
  }
  function requestView(r, { forTenant = false } = {}) {
    const room = r.room_id ? db.get("SELECT label FROM rooms WHERE id = ?", r.room_id) : null;
    const building = db.get("SELECT name FROM buildings WHERE id = ?", r.building_id);
    const tenant = r.tenant_id ? db.get("SELECT name FROM tenants WHERE id = ?", r.tenant_id) : null;
    const out = {
      id: r.id, buildingId: r.building_id, buildingName: building?.name || "", roomId: r.room_id, roomLabel: room?.label || "", tenantId: r.tenant_id, tenantName: tenant?.name || "",
      category: r.category, title: r.title, description: r.description, priority: r.priority, status: r.status, statusLabel: STATUS_LABELS[r.status],
      assignedTo: forTenant ? (r.assigned_to ? "Assigned" : "") : r.assigned_to, resolution: r.resolution, createdByRole: r.created_by_role,
      createdAt: r.created_at, updatedAt: r.updated_at, resolvedAt: r.resolved_at, closedAt: r.closed_at,
    };
    if (!forTenant) {
      const cost = db.get("SELECT COALESCE(SUM(amount_paise),0) AS s, COUNT(*) AS n FROM expenses WHERE maintenance_request_id = ? AND voided_at IS NULL", r.id);
      out.cost = toRupees(cost.s);
      out.expenseCount = cost.n;
      out.nextStatuses = NEXT[r.status];
    }
    return out;
  }
  function detail(r, { forTenant = false, userId } = {}) {
    const events = db.all(`SELECT e.*, u.name AS actor FROM maintenance_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.request_id = ? ${forTenant ? "AND e.visible_to_tenant = 1" : ""} ORDER BY e.created_at`, r.id);
    const attachments = db.all(`SELECT * FROM documents WHERE entity_type = 'maintenance' AND entity_id = ? AND status = 'active' ${forTenant ? "AND (visible_to_tenant = 1 OR uploaded_by_user_id = ?)" : ""} ORDER BY created_at`, ...(forTenant ? [r.id, userId] : [r.id]));
    const out = {
      ...requestView(r, { forTenant }),
      timeline: events.map((e) => ({ type: e.type, from: e.from_status, to: e.to_status, toLabel: e.to_status ? STATUS_LABELS[e.to_status] : null, comment: e.comment, by: forTenant && e.actor_role !== "tenant" ? "Owner" : (e.actor || ""), role: e.actor_role, visibleToTenant: Boolean(e.visible_to_tenant), at: e.created_at })),
      attachments: attachments.map(documentView),
    };
    if (!forTenant) out.expenses = db.all("SELECT id, amount_paise, spent_on, vendor, description FROM expenses WHERE maintenance_request_id = ? AND voided_at IS NULL ORDER BY spent_on", r.id).map((e) => ({ id: e.id, amount: toRupees(e.amount_paise), spentOn: e.spent_on, vendor: e.vendor, description: e.description }));
    return out;
  }
  function saveAttachments(req, requestId, uploads, visibleToTenant) {
    const list = Array.isArray(uploads) ? uploads.slice(0, 3) : [];
    const saved = [];
    for (const u of list) {
      const upload = decodeUpload(u);
      if (!upload) throw new v.ValidationError("Photos must be JPG, PNG, WEBP or PDF files up to 10 MB.");
      saved.push(docs.save(db, ctxOf(req), { entityType: "maintenance", entityId: requestId, kind: "photo", upload, visibleToTenant }));
    }
    return saved;
  }

  // ---------- staff ----------
  app.get("/api/maintenance", manage, (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.status === "open") where.push("status NOT IN ('resolved','closed')");
    else if (STATUS_LABELS[req.query.status]) { where.push("status = :status"); params.status = req.query.status; }
    if (req.query.buildingId) { where.push("building_id = :buildingId"); params.buildingId = String(req.query.buildingId); }
    if (PRIORITIES.includes(req.query.priority)) { where.push("priority = :priority"); params.priority = req.query.priority; }
    if (req.query.q) { where.push("(title LIKE :q OR description LIKE :q)"); params.q = `%${String(req.query.q).slice(0, 60)}%`; }
    const rows = db.all(`SELECT * FROM maintenance_requests WHERE ${where.join(" AND ")} ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, updated_at DESC LIMIT 500`, params);
    res.json(rows.map((r) => requestView(r)));
  });

  app.post("/api/maintenance", manage, (req, res) => {
    const b = req.body || {};
    const building = db.get("SELECT id FROM buildings WHERE id = ? AND org_id = ?", b.buildingId || "", req.orgId);
    if (!building) return notFound(res, "Building");
    const room = b.roomId ? db.get("SELECT id FROM rooms WHERE id = ? AND building_id = ?", b.roomId, building.id) : null;
    if (b.roomId && !room) return res.status(400).json({ error: "That room isn't in this building." });
    const tenant = room ? db.get("SELECT id FROM tenants WHERE room_id = ? AND active = 1", room.id) : null;
    const id = db.id();
    db.tx(() => {
      db.run(`INSERT INTO maintenance_requests (id, org_id, building_id, room_id, tenant_id, category, title, description, priority, status, created_by, created_by_role, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,'submitted',?,?,?,?)`,
        id, req.orgId, building.id, room?.id || null, tenant?.id || null, pick(CATEGORIES, "Category", "other")(b.category), v.text({ label: "Title", max: 120, required: true })(b.title),
        v.text({ label: "Description", max: 2000 })(b.description), pick(PRIORITIES, "Priority", "normal")(b.priority), req.user.id, req.user.role, db.nowIso(), db.nowIso());
      addEvent(req, id, { type: "created", to: "submitted", comment: "Request created" });
      audit(db, ctxOf(req), "maintenance.created", "maintenance", id, {});
    });
    res.status(201).json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", id)));
  });

  app.get("/api/maintenance/:id", manage, (req, res) => {
    const r = db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!r) return notFound(res, "Maintenance request");
    res.json(detail(r));
  });

  app.put("/api/maintenance/:id", manage, (req, res) => {
    const r = db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!r) return notFound(res, "Maintenance request");
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.title !== undefined) { sets.push("title = ?"); params.push(v.text({ label: "Title", max: 120, required: true })(b.title)); }
    if (b.description !== undefined) { sets.push("description = ?"); params.push(v.text({ label: "Description", max: 2000 })(b.description)); }
    if (b.category !== undefined) { sets.push("category = ?"); params.push(pick(CATEGORIES, "Category")(b.category)); }
    if (b.priority !== undefined) { sets.push("priority = ?"); params.push(pick(PRIORITIES, "Priority")(b.priority)); }
    if (b.assignedTo !== undefined) { sets.push("assigned_to = ?"); params.push(v.text({ label: "Assigned to", max: 120 })(b.assignedTo)); }
    if (b.resolution !== undefined) { sets.push("resolution = ?"); params.push(v.text({ label: "Resolution", max: 2000 })(b.resolution)); }
    if (sets.length) {
      db.run(`UPDATE maintenance_requests SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), r.id);
      if (b.assignedTo !== undefined && b.assignedTo !== r.assigned_to) addEvent(req, r.id, { type: "assigned", comment: b.assignedTo ? `Assigned to ${b.assignedTo}` : "Unassigned", visible: false });
    }
    res.json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", r.id)));
  });

  app.post("/api/maintenance/:id/status", manage, (req, res) => {
    const r = db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!r) return notFound(res, "Maintenance request");
    const to = req.body?.status;
    if (!NEXT[r.status]?.includes(to)) return res.status(400).json({ error: `Can't move from "${STATUS_LABELS[r.status]}" to "${STATUS_LABELS[to] || to}".` });
    const comment = v.text({ label: "Comment", max: 2000 })(req.body?.comment);
    const visible = req.body?.visibleToTenant !== false;
    db.tx(() => {
      db.run(`UPDATE maintenance_requests SET status = ?, updated_at = ?, resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE resolved_at END, closed_at = CASE WHEN ? = 'closed' THEN ? ELSE NULL END WHERE id = ?`,
        to, db.nowIso(), to, db.nowIso(), to, db.nowIso(), r.id);
      if (to === "resolved" && comment) db.run("UPDATE maintenance_requests SET resolution = ? WHERE id = ?", comment, r.id);
      addEvent(req, r.id, { type: "status", from: r.status, to, comment, visible });
      audit(db, ctxOf(req), "maintenance.status", "maintenance", r.id, { from: r.status, to });
      if (visible) tellTenant(req, r, `Maintenance: ${STATUS_LABELS[to]}`, `"${r.title}" is now ${STATUS_LABELS[to].toLowerCase()}.${comment ? ` ${comment}` : ""}`);
    });
    res.json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", r.id)));
  });

  app.post("/api/maintenance/:id/comments", manage, (req, res) => {
    const r = db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!r) return notFound(res, "Maintenance request");
    const comment = v.text({ label: "Comment", max: 2000, required: true })(req.body?.comment);
    const visible = req.body?.visibleToTenant !== false;
    addEvent(req, r.id, { type: "comment", comment, visible });
    db.run("UPDATE maintenance_requests SET updated_at = ? WHERE id = ?", db.nowIso(), r.id);
    if (visible) tellTenant(req, r, "New maintenance update", `"${r.title}": ${comment.slice(0, 160)}`);
    res.status(201).json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", r.id)));
  });

  app.post("/api/maintenance/:id/attachments", manage, (req, res) => {
    const r = db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!r) return notFound(res, "Maintenance request");
    saveAttachments(req, r.id, [req.body], req.body?.visibleToTenant !== false);
    res.status(201).json(detail(r));
  });

  // ---------- tenant ----------
  const tenantRequest = (req) => db.get("SELECT * FROM maintenance_requests WHERE id = ? AND org_id = ? AND tenant_id = ?", req.params.id, req.orgId, req.user.tenant_id);

  app.get("/api/tenant/maintenance", tenantOnly, (req, res) => {
    res.json(db.all("SELECT * FROM maintenance_requests WHERE org_id = ? AND tenant_id = ? ORDER BY updated_at DESC", req.orgId, req.user.tenant_id).map((r) => requestView(r, { forTenant: true })));
  });

  app.post("/api/tenant/maintenance", tenantOnly, (req, res) => {
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND active = 1", req.user.tenant_id);
    if (!tenant) return res.status(404).json({ error: "No active tenancy found" });
    const room = db.get("SELECT * FROM rooms WHERE id = ?", tenant.room_id);
    const b = req.body || {};
    const id = db.id();
    db.tx(() => {
      db.run(`INSERT INTO maintenance_requests (id, org_id, building_id, room_id, tenant_id, category, title, description, priority, status, created_by, created_by_role, created_at, updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,'submitted',?,'tenant',?,?)`,
        id, req.orgId, room.building_id, room.id, tenant.id, pick(CATEGORIES, "Category", "other")(b.category), v.text({ label: "Title", max: 120, required: true })(b.title),
        v.text({ label: "Description", max: 2000, required: true })(b.description), pick(["low", "normal", "high", "urgent"], "Priority", "normal")(b.priority), req.user.id, db.nowIso(), db.nowIso());
      addEvent(req, id, { type: "created", to: "submitted", comment: "Request submitted" });
      saveAttachments(req, id, b.photos, true);
      notifyStaff(db, req.orgId, { kind: "maintenance", title: `New maintenance request: ${b.title}`, body: `${tenant.name} (${room.label})`, link: `maintenance:${id}` });
    });
    res.status(201).json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", id), { forTenant: true, userId: req.user.id }));
  });

  app.get("/api/tenant/maintenance/:id", tenantOnly, (req, res) => {
    const r = tenantRequest(req);
    if (!r) return notFound(res, "Maintenance request");
    res.json(detail(r, { forTenant: true, userId: req.user.id }));
  });

  app.post("/api/tenant/maintenance/:id/comments", tenantOnly, (req, res) => {
    const r = tenantRequest(req);
    if (!r) return notFound(res, "Maintenance request");
    const comment = v.text({ label: "Comment", max: 2000, required: true })(req.body?.comment);
    db.tx(() => {
      addEvent(req, r.id, { type: "comment", comment });
      // A reply while "waiting for you" hands the request back to the owner.
      if (r.status === "awaiting_tenant") {
        db.run("UPDATE maintenance_requests SET status = 'in_progress' WHERE id = ?", r.id);
        addEvent(req, r.id, { type: "status", from: "awaiting_tenant", to: "in_progress", comment: "Tenant replied" });
      }
      db.run("UPDATE maintenance_requests SET updated_at = ? WHERE id = ?", db.nowIso(), r.id);
      notifyStaff(db, req.orgId, { kind: "maintenance", title: `Tenant replied: ${r.title}`, body: comment.slice(0, 160), link: `maintenance:${r.id}` });
    });
    res.status(201).json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", r.id), { forTenant: true, userId: req.user.id }));
  });

  // Tenant confirms the fix (closes) or says it isn't fixed (reopens).
  app.post("/api/tenant/maintenance/:id/confirm", tenantOnly, (req, res) => {
    const r = tenantRequest(req);
    if (!r) return notFound(res, "Maintenance request");
    if (r.status !== "resolved") return res.status(409).json({ error: "You can confirm once the owner marks it resolved." });
    const fixed = req.body?.fixed !== false;
    const to = fixed ? "closed" : "in_progress";
    const comment = v.text({ label: "Comment", max: 2000 })(req.body?.comment) || (fixed ? "Tenant confirmed it's fixed" : "Tenant says it isn't fixed yet");
    db.tx(() => {
      db.run("UPDATE maintenance_requests SET status = ?, updated_at = ?, closed_at = ? WHERE id = ?", to, db.nowIso(), fixed ? db.nowIso() : null, r.id);
      addEvent(req, r.id, { type: "status", from: "resolved", to, comment });
      notifyStaff(db, req.orgId, { kind: "maintenance", title: fixed ? `Closed by tenant: ${r.title}` : `Reopened by tenant: ${r.title}`, body: comment, link: `maintenance:${r.id}` });
    });
    res.json(detail(db.get("SELECT * FROM maintenance_requests WHERE id = ?", r.id), { forTenant: true, userId: req.user.id }));
  });

  app.post("/api/tenant/maintenance/:id/attachments", tenantOnly, (req, res) => {
    const r = tenantRequest(req);
    if (!r) return notFound(res, "Maintenance request");
    saveAttachments(req, r.id, [req.body], true);
    res.status(201).json(detail(r, { forTenant: true, userId: req.user.id }));
  });
}

module.exports = { register, CATEGORIES, STATUS_LABELS, NEXT };
