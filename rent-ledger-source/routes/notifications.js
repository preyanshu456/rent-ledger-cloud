// In-app notifications, reminder settings and templates, reminder previews,
// drafts and the outbox (review → approve → send).
const v = require("../lib/validate");
const accounts = require("../services/accounts");
const templates = require("../services/templates");
const reminders = require("../services/reminders");
const delivery = require("../services/delivery");
const { audit } = require("../services/audit");
const { requirePermission, ctxOf, notFound } = require("./common");

const KIND_MAP = { overdue: ["overdue"], upcoming: ["upcoming", "due_today"], lease_expiry: ["lease_expiry"], all: ["upcoming", "due_today", "overdue", "lease_expiry"] };

function outboxView(m, tenantName) {
  return {
    id: m.id, tenantId: m.tenant_id, tenantName: tenantName || "", channel: m.channel, recipient: m.channel === "inapp" ? "In-app" : m.recipient,
    templateKey: m.template_key, language: m.language, subject: m.subject, body: m.body, status: m.status, attempts: m.attempts, lastError: m.last_error,
    createdAt: m.created_at, approvedAt: m.approved_at, sentAt: m.sent_at,
  };
}

function register(app, { db, todayFor, log }) {
  const manage = requirePermission("reminders.manage");

  // ---------- notifications (every signed-in user) ----------
  app.get("/api/notifications", (req, res) => {
    const rows = db.all("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50", req.user.id);
    const unread = db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL", req.user.id).n;
    res.json({ unread, items: rows.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, link: n.link, createdAt: n.created_at, read: Boolean(n.read_at) })) });
  });
  app.post("/api/notifications/read-all", (req, res) => {
    db.run("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL", db.nowIso(), req.user.id);
    res.json({ ok: true });
  });
  app.post("/api/notifications/:id/read", (req, res) => {
    db.run("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?", db.nowIso(), req.params.id, req.user.id);
    res.json({ ok: true });
  });

  // ---------- settings & templates ----------
  app.get("/api/reminders/settings", manage, (req, res) => {
    const org = accounts.getOrg(db, req.orgId);
    res.json({ settings: org.settings.reminders, ...delivery.channelStatus() });
  });

  app.get("/api/reminders/templates", manage, (req, res) => res.json(templates.listTemplates(db, req.orgId)));

  app.put("/api/reminders/templates/:key/:language", manage, (req, res) => {
    const { key, language } = req.params;
    if (!templates.KEYS.includes(key) || !["en", "hi"].includes(language)) return notFound(res, "Template");
    if (req.body?.reset) {
      db.run("DELETE FROM message_templates WHERE org_id = ? AND key = ? AND language = ?", req.orgId, key, language);
      return res.json({ ok: true, reset: true });
    }
    const subject = v.text({ label: "Subject", max: 200 })(req.body?.subject);
    const body = v.text({ label: "Message", max: 1000, required: true })(req.body?.body);
    db.run(`INSERT INTO message_templates (id, org_id, key, language, subject, body, updated_by, updated_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(org_id, key, language) DO UPDATE SET subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      db.id(), req.orgId, key, language, subject, body, req.user.id, db.nowIso());
    audit(db, ctxOf(req), "template.updated", "message_template", `${key}:${language}`, {});
    res.json({ ok: true });
  });

  // ---------- previews & drafts ----------
  app.get("/api/reminders/preview", manage, (req, res) => {
    const kinds = KIND_MAP[req.query.kind] || KIND_MAP.all;
    const force = req.query.mode !== "scheduled"; // "what can I send now" vs "what the schedule would send today"
    res.json(reminders.preview(db, req.orgId, todayFor(req), { kinds, force }));
  });

  app.post("/api/reminders/drafts", manage, (req, res) => {
    const kinds = KIND_MAP[req.body?.kind] || KIND_MAP.overdue;
    const tenantIds = Array.isArray(req.body?.tenantIds) ? req.body.tenantIds.map(String) : null;
    const result = reminders.draftReminders(db, req.orgId, todayFor(req), { kinds, tenantIds, force: true, createdBy: req.user.id, status: "draft" });
    audit(db, ctxOf(req), "reminders.drafted", "outbox", null, { created: result.created, kind: req.body?.kind || "overdue" });
    res.status(201).json(result);
  });

  // ---------- outbox ----------
  app.get("/api/outbox", manage, (req, res) => {
    const status = ["draft", "queued", "sending", "sent", "failed", "cancelled", "simulated"].includes(req.query.status) ? req.query.status : null;
    const rows = db.all(`SELECT o.*, t.name AS tenant_name FROM outbox o LEFT JOIN tenants t ON t.id = o.tenant_id WHERE o.org_id = ? ${status ? "AND o.status = ?" : ""} ORDER BY o.created_at DESC LIMIT 300`, ...(status ? [req.orgId, status] : [req.orgId]));
    res.json(rows.map((m) => outboxView(m, m.tenant_name)));
  });

  app.put("/api/outbox/:id", manage, (req, res) => {
    const m = db.get("SELECT * FROM outbox WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!m) return notFound(res, "Message");
    if (m.status !== "draft") return res.status(409).json({ error: "Only drafts can be edited." });
    const subject = req.body?.subject !== undefined ? v.text({ label: "Subject", max: 200 })(req.body.subject) : m.subject;
    const body = req.body?.body !== undefined ? v.text({ label: "Message", max: 1000, required: true })(req.body.body) : m.body;
    db.run("UPDATE outbox SET subject = ?, body = ? WHERE id = ?", subject, body, m.id);
    res.json(outboxView(db.get("SELECT * FROM outbox WHERE id = ?", m.id)));
  });

  // Explicit approval; only then is anything sent.
  app.post("/api/outbox/approve", manage, async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String).slice(0, 500) : [];
      if (!ids.length) return res.status(400).json({ error: "Choose the messages to send." });
      let approved = 0;
      db.tx(() => {
        for (const id of ids) approved += db.run("UPDATE outbox SET status = 'queued', approved_by = ?, approved_at = ? WHERE id = ? AND org_id = ? AND status = 'draft'", req.user.id, db.nowIso(), id, req.orgId).changes;
        audit(db, ctxOf(req), "outbox.approved", "outbox", null, { count: approved });
      });
      const result = await delivery.processOutbox(db);
      res.json({ approved, delivery: result, mode: delivery.mode() });
    } catch (err) { next(err); }
  });

  app.post("/api/outbox/:id/cancel", manage, (req, res) => {
    const changed = db.run("UPDATE outbox SET status = 'cancelled', dedupe_key = NULL WHERE id = ? AND org_id = ? AND status IN ('draft','queued')", req.params.id, req.orgId).changes;
    if (!changed) return res.status(409).json({ error: "This message can't be cancelled (already sent or not found)." });
    res.json({ ok: true });
  });

  app.post("/api/outbox/:id/retry", manage, async (req, res, next) => {
    try {
      const changed = db.run("UPDATE outbox SET status = 'queued', attempts = 0, next_attempt_at = NULL WHERE id = ? AND org_id = ? AND status = 'failed'", req.params.id, req.orgId).changes;
      if (!changed) return res.status(409).json({ error: "Only failed messages can be retried." });
      res.json({ ok: true, delivery: await delivery.processOutbox(db) });
    } catch (err) { next(err); }
  });

  void log;
}

module.exports = { register };
