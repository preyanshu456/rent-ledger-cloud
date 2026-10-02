// Property expenses. Amounts can't be edited (void and re-enter instead) so
// reports never silently change; each expense is counted once, even when it
// is linked to a maintenance request.
const v = require("../lib/validate");
const { toPaise, toRupees } = require("../lib/money");
const { audit } = require("../services/audit");
const { documentView } = require("../services/documents");
const { requirePermission, ownerOnly, ctxOf, notFound, sendCsv } = require("./common");

const CATEGORIES = ["maintenance", "repairs", "utilities", "property_tax", "insurance", "management_fee", "other"];

function register(app, { db, todayFor }) {
  const manage = requirePermission("expenses.manage");
  function view(e) {
    const b = db.get("SELECT name FROM buildings WHERE id = ?", e.building_id);
    const r = e.room_id ? db.get("SELECT label FROM rooms WHERE id = ?", e.room_id) : null;
    const m = e.maintenance_request_id ? db.get("SELECT title FROM maintenance_requests WHERE id = ?", e.maintenance_request_id) : null;
    return {
      id: e.id, buildingId: e.building_id, buildingName: b?.name || "", roomId: e.room_id, roomLabel: r?.label || "", maintenanceRequestId: e.maintenance_request_id, maintenanceTitle: m?.title || "",
      category: e.category, amount: toRupees(e.amount_paise), spentOn: e.spent_on, vendor: e.vendor, description: e.description, createdAt: e.created_at,
      voided: Boolean(e.voided_at), voidReason: e.void_reason || "",
      receipts: db.all("SELECT * FROM documents WHERE entity_type = 'expense' AND entity_id = ? AND status = 'active'", e.id).map(documentView),
    };
  }

  app.get("/api/expenses", manage, (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.includeVoided !== "1") where.push("voided_at IS NULL");
    if (req.query.buildingId) { where.push("building_id = :buildingId"); params.buildingId = String(req.query.buildingId); }
    if (CATEGORIES.includes(req.query.category)) { where.push("category = :category"); params.category = req.query.category; }
    if (req.query.from) { where.push("spent_on >= :from"); params.from = String(req.query.from); }
    if (req.query.to) { where.push("spent_on <= :to"); params.to = String(req.query.to); }
    if (req.query.maintenanceRequestId) { where.push("maintenance_request_id = :mr"); params.mr = String(req.query.maintenanceRequestId); }
    const rows = db.all(`SELECT * FROM expenses WHERE ${where.join(" AND ")} ORDER BY spent_on DESC, created_at DESC LIMIT 1000`, params).map(view);
    if (req.query.format === "csv") return sendCsv(res, `expenses-${todayFor(req)}.csv`, ["Date", "Property", "Room", "Category", "Vendor", "Description", "Maintenance request", "Amount (INR)"], rows.map((e) => [e.spentOn, e.buildingName, e.roomLabel, e.category, e.vendor, e.description, e.maintenanceTitle, e.amount]));
    res.json(rows);
  });

  app.post("/api/expenses", manage, (req, res) => {
    const b = req.body || {};
    const building = db.get("SELECT id FROM buildings WHERE id = ? AND org_id = ?", b.buildingId || "", req.orgId);
    if (!building) return notFound(res, "Building");
    if (b.roomId && !db.get("SELECT 1 FROM rooms WHERE id = ? AND building_id = ?", b.roomId, building.id)) return res.status(400).json({ error: "That room isn't in this building." });
    if (b.maintenanceRequestId && !db.get("SELECT 1 FROM maintenance_requests WHERE id = ? AND org_id = ?", b.maintenanceRequestId, req.orgId)) return notFound(res, "Maintenance request");
    if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Choose an expense category." });
    const amount = v.number({ label: "Amount", min: 0.01, max: 100_000_000, required: true })(b.amount);
    const id = db.id();
    db.run(`INSERT INTO expenses (id, org_id, building_id, room_id, maintenance_request_id, category, amount_paise, spent_on, vendor, description, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.orgId, building.id, b.roomId || null, b.maintenanceRequestId || null, b.category, toPaise(amount), v.date({ label: "Date" })(b.spentOn) || todayFor(req),
      v.text({ label: "Vendor", max: 120 })(b.vendor), v.text({ label: "Description", max: 500 })(b.description), req.user.id, db.nowIso());
    audit(db, ctxOf(req), "expense.created", "expense", id, { amountPaise: toPaise(amount), category: b.category });
    res.status(201).json(view(db.get("SELECT * FROM expenses WHERE id = ?", id)));
  });

  app.put("/api/expenses/:id", manage, (req, res) => {
    const e = db.get("SELECT * FROM expenses WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!e) return notFound(res, "Expense");
    if (e.voided_at) return res.status(409).json({ error: "This expense was voided." });
    if (req.body?.amount !== undefined && toPaise(req.body.amount) !== e.amount_paise) return res.status(409).json({ error: "Amounts can't be edited. Void this expense and enter the correct one." });
    const b = req.body || {};
    const sets = [];
    const params = [];
    if (b.vendor !== undefined) { sets.push("vendor = ?"); params.push(v.text({ label: "Vendor", max: 120 })(b.vendor)); }
    if (b.description !== undefined) { sets.push("description = ?"); params.push(v.text({ label: "Description", max: 500 })(b.description)); }
    if (b.spentOn !== undefined) { sets.push("spent_on = ?"); params.push(v.date({ label: "Date" })(b.spentOn) || e.spent_on); }
    if (b.category !== undefined) { if (!CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Choose an expense category." }); sets.push("category = ?"); params.push(b.category); }
    if (sets.length) {
      db.run(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`, ...params, e.id);
      audit(db, ctxOf(req), "expense.updated", "expense", e.id, { fields: Object.keys(b) });
    }
    res.json(view(db.get("SELECT * FROM expenses WHERE id = ?", e.id)));
  });

  app.post("/api/expenses/:id/void", ownerOnly, (req, res) => {
    const e = db.get("SELECT * FROM expenses WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!e) return notFound(res, "Expense");
    const reason = v.text({ label: "Reason", max: 300, required: true })(req.body?.reason);
    db.run("UPDATE expenses SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND voided_at IS NULL", db.nowIso(), req.user.id, reason, e.id);
    audit(db, ctxOf(req), "expense.voided", "expense", e.id, { reason, amountPaise: e.amount_paise });
    res.json(view(db.get("SELECT * FROM expenses WHERE id = ?", e.id)));
  });
}

module.exports = { register, CATEGORIES };
