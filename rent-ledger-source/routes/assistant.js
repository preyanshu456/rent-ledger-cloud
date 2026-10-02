// Rent Ledger AI endpoints: chat, history and approval of prepared actions.
const v = require("../lib/validate");
const { toPaise } = require("../lib/money");
const { tooMany } = require("../lib/security");
const { audit } = require("../services/audit");
const assistant = require("../services/assistant");
const { channelsFor } = require("../services/reminders");
const { processOutbox } = require("../services/delivery");
const { requirePermission, can, ctxOf, notFound } = require("./common");

const ACTION_PERMISSION = { send_reminders: "reminders.manage", create_maintenance: "maintenance.manage", create_expense: "expenses.manage" };
const PRIORITIES = ["low", "normal", "high", "urgent"];
const EXPENSE_CATEGORIES = ["maintenance", "repairs", "utilities", "property_tax", "insurance", "management_fee", "other"];

function register(app, { db, limits, todayFor, log }) {
  const use = requirePermission("assistant.use");

  app.get("/api/assistant/status", use, (req, res) => {
    res.json({
      ...assistant.status(db, req.orgId),
      dataSharing: "In AI mode your question and the tool results (tenant names, room labels, dates and amounts) are sent to the AI provider. Phone numbers, emails, ID numbers and documents are never sent.",
    });
  });

  app.get("/api/assistant/history", use, (req, res) => {
    const rows = db.all("SELECT * FROM assistant_messages WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50", req.orgId, req.user.id).reverse();
    res.json(rows.map((m) => ({ id: m.id, role: m.role, text: m.content, mode: m.mode, at: m.created_at, ...JSON.parse(m.data_json || "{}") })));
  });

  app.delete("/api/assistant/history", use, (req, res) => {
    db.run("DELETE FROM assistant_messages WHERE org_id = ? AND user_id = ?", req.orgId, req.user.id);
    res.json({ ok: true });
  });

  app.post("/api/assistant/chat", use, async (req, res, next) => {
    try {
      const limit = limits.assistantPerUser.hit(req.user.id);
      if (!limit.allowed) return tooMany(res, limit.retryAfterSeconds, "You've asked a lot of questions in the last hour. Please try again a little later.");
      const message = v.text({ label: "Message", max: 1000, required: true })(req.body?.message);
      const out = await assistant.chat(db, ctxOf(req), req.user, message, todayFor(req), { log });
      res.json(out);
    } catch (err) { next(err); }
  });

  // ---------- prepared actions ----------
  app.get("/api/assistant/actions", use, (req, res) => {
    const status = ["proposed", "executed", "rejected", "failed"].includes(req.query.status) ? req.query.status : null;
    const rows = db.all(`SELECT * FROM assistant_actions WHERE org_id = ? ${status ? "AND status = ?" : ""} ORDER BY created_at DESC LIMIT 100`, ...(status ? [req.orgId, status] : [req.orgId]));
    res.json(rows.filter((a) => can(req.user, ACTION_PERMISSION[a.type] || "assistant.use")).map(assistant.actionView));
  });

  function loadAction(req, res) {
    const a = db.get("SELECT * FROM assistant_actions WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!a) { notFound(res, "Proposal"); return null; }
    if (!can(req.user, ACTION_PERMISSION[a.type] || "owner.only")) { res.status(403).json({ error: "Your role doesn't allow this. Ask the owner." }); return null; }
    if (a.status !== "proposed") { res.status(409).json({ error: `This proposal was already ${a.status}.` }); return null; }
    return a;
  }

  // Edit a proposal before approving it (message text, which messages to keep, task or expense details).
  app.put("/api/assistant/actions/:id", use, (req, res) => {
    const a = loadAction(req, res);
    if (!a) return;
    const payload = JSON.parse(a.payload_json);
    const b = req.body || {};
    if (a.type === "send_reminders") {
      if (Array.isArray(b.messages)) {
        const edits = new Map(b.messages.map((m) => [Number(m.index), m]));
        payload.messages = payload.messages.map((m, i) => {
          const e = edits.get(i);
          if (!e) return m;
          return { ...m, body: e.body !== undefined ? v.text({ label: "Message", max: 1000, required: true })(e.body) : m.body, include: e.include !== false };
        });
      }
    } else if (a.type === "create_maintenance") {
      if (b.title !== undefined) payload.title = v.text({ label: "Title", max: 120, required: true })(b.title);
      if (b.description !== undefined) payload.description = v.text({ label: "Description", max: 2000 })(b.description);
      if (b.priority !== undefined) { if (!PRIORITIES.includes(b.priority)) return res.status(400).json({ error: "Choose a valid priority." }); payload.priority = b.priority; }
    } else if (a.type === "create_expense") {
      if (b.amount !== undefined) payload.amountPaise = toPaise(v.number({ label: "Amount", min: 0.01, max: 100_000_000, required: true })(b.amount));
      if (b.category !== undefined) { if (!EXPENSE_CATEGORIES.includes(b.category)) return res.status(400).json({ error: "Choose an expense category." }); payload.category = b.category; }
      if (b.spentOn !== undefined) payload.spentOn = v.date({ label: "Date" })(b.spentOn) || payload.spentOn;
      if (b.vendor !== undefined) payload.vendor = v.text({ label: "Vendor", max: 120 })(b.vendor);
      if (b.description !== undefined) payload.description = v.text({ label: "Description", max: 500 })(b.description);
    }
    db.run("UPDATE assistant_actions SET payload_json = ? WHERE id = ? AND status = 'proposed'", JSON.stringify(payload), a.id);
    res.json(assistant.actionView(db.get("SELECT * FROM assistant_actions WHERE id = ?", a.id)));
  });

  app.post("/api/assistant/actions/:id/reject", use, (req, res) => {
    const a = loadAction(req, res);
    if (!a) return;
    db.tx(() => {
      db.run("UPDATE assistant_actions SET status = 'rejected', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'proposed'", db.nowIso(), req.user.id, a.id);
      audit(db, ctxOf(req), "assistant.action_rejected", "assistant_action", a.id, { type: a.type });
    });
    res.json(assistant.actionView(db.get("SELECT * FROM assistant_actions WHERE id = ?", a.id)));
  });

  // Approving runs the action exactly once. Everything is re-checked now
  // (tenants still active, contact consent, property still exists).
  app.post("/api/assistant/actions/:id/approve", use, (req, res) => {
    const a = loadAction(req, res);
    if (!a) return;
    const ctx = ctxOf(req);
    const payload = JSON.parse(a.payload_json);
    let result;
    try {
      result = db.tx(() => {
        // Claim the proposal first so a double click can't run it twice.
        const claimed = db.run("UPDATE assistant_actions SET status = 'executed', decided_at = ?, decided_by = ? WHERE id = ? AND status = 'proposed'", db.nowIso(), req.user.id, a.id).changes;
        if (!claimed) { const e = new Error("This proposal was already decided."); e.status = 409; e.expose = true; throw e; }
        const out = execute(a, payload, req, ctx);
        db.run("UPDATE assistant_actions SET result_json = ? WHERE id = ?", JSON.stringify(out), a.id);
        audit(db, ctx, "assistant.action_approved", "assistant_action", a.id, { type: a.type, ...out });
        return out;
      });
    } catch (err) {
      if (err.status === 409) return res.status(409).json({ error: err.message });
      if (err instanceof v.ValidationError || err.expose) {
        db.run("UPDATE assistant_actions SET status = 'failed', result_json = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'proposed'", JSON.stringify({ error: err.message }), db.nowIso(), req.user.id, a.id);
        return res.status(400).json({ error: err.message });
      }
      throw err;
    }
    if (a.type === "send_reminders" && result.queued) processOutbox(db).catch((error) => log.error("outbox processing failed", { error }));
    res.json(assistant.actionView(db.get("SELECT * FROM assistant_actions WHERE id = ?", a.id)));
  });

  function fail(message) { const e = new Error(message); e.expose = true; return e; }

  function execute(a, payload, req, ctx) {
    if (a.type === "send_reminders") {
      let queued = 0, skipped = 0;
      const outboxIds = [];
      payload.messages.forEach((m, i) => {
        if (m.include === false) { skipped++; return; }
        const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", m.tenantId, req.orgId);
        const route = tenant ? channelsFor(db, tenant, [m.channel])[0] : null;
        if (!route) { skipped++; return; }
        const user = db.get("SELECT id FROM users WHERE tenant_id = ?", tenant.id);
        const dedupe = `assistant:${a.id}:${i}`;
        if (db.get("SELECT 1 FROM outbox WHERE dedupe_key = ?", dedupe)) { skipped++; return; }
        const id = db.id();
        db.run(`INSERT INTO outbox (id, org_id, tenant_id, user_id, channel, recipient, template_key, language, subject, body, status, dedupe_key, related_type, related_id, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?, 'queued', ?, 'tenant', ?, ?, ?)`,
          id, req.orgId, tenant.id, user?.id || null, route.channel, route.recipient, "rent_overdue", m.language || "en", String(m.subject || "").slice(0, 200), String(m.body).slice(0, 1000),
          dedupe, tenant.id, req.user.id, db.nowIso());
        outboxIds.push(id);
        queued++;
      });
      if (!queued) throw fail("None of these messages can be sent now (tenants moved out, consent withdrawn or all removed).");
      return { queued, skipped, outboxIds };
    }
    if (a.type === "create_maintenance") {
      const building = db.get("SELECT id FROM buildings WHERE id = ? AND org_id = ?", payload.buildingId, req.orgId);
      if (!building) throw fail("That property no longer exists.");
      const room = payload.roomId ? db.get("SELECT id FROM rooms WHERE id = ? AND building_id = ?", payload.roomId, building.id) : null;
      const tenant = room ? db.get("SELECT id FROM tenants WHERE room_id = ? AND active = 1", room.id) : null;
      const id = db.id();
      db.run(`INSERT INTO maintenance_requests (id, org_id, building_id, room_id, tenant_id, category, title, description, priority, status, created_by, created_by_role, created_at, updated_at)
              VALUES (?,?,?,?,?, 'other', ?, ?, ?, 'submitted', ?, ?, ?, ?)`,
        id, req.orgId, building.id, room?.id || null, tenant?.id || null, v.text({ label: "Title", max: 120, required: true })(payload.title), String(payload.description || "").slice(0, 2000),
        PRIORITIES.includes(payload.priority) ? payload.priority : "normal", req.user.id, req.user.role, db.nowIso(), db.nowIso());
      db.run("INSERT INTO maintenance_events (id, org_id, request_id, actor_user_id, actor_role, type, from_status, to_status, comment, visible_to_tenant, created_at) VALUES (?,?,?,?,?, 'created', NULL, 'submitted', ?, 0, ?)",
        db.id(), req.orgId, id, req.user.id, req.user.role, "Created from an assistant proposal", db.nowIso());
      audit(db, ctx, "maintenance.created", "maintenance", id, { via: "assistant", actionId: a.id });
      return { maintenanceRequestId: id };
    }
    if (a.type === "create_expense") {
      const building = db.get("SELECT id FROM buildings WHERE id = ? AND org_id = ?", payload.buildingId, req.orgId);
      if (!building) throw fail("That property no longer exists.");
      if (!EXPENSE_CATEGORIES.includes(payload.category)) throw fail("Choose an expense category.");
      if (!Number.isInteger(payload.amountPaise) || payload.amountPaise <= 0) throw fail("The amount must be more than zero.");
      const id = db.id();
      db.run(`INSERT INTO expenses (id, org_id, building_id, room_id, maintenance_request_id, category, amount_paise, spent_on, vendor, description, created_by, created_at) VALUES (?,?,?,NULL,NULL,?,?,?,?,?,?,?)`,
        id, req.orgId, building.id, payload.category, payload.amountPaise, v.date({ label: "Date" })(payload.spentOn) || todayFor(req), String(payload.vendor || "").slice(0, 120),
        String(payload.description || "").slice(0, 500), req.user.id, db.nowIso());
      audit(db, ctx, "expense.created", "expense", id, { amountPaise: payload.amountPaise, category: payload.category, via: "assistant", actionId: a.id });
      return { expenseId: id };
    }
    throw fail("This kind of proposal can't be approved.");
  }
}

module.exports = { register };
