// Organisation settings, team (property managers), audit log, data export and backups.
const v = require("../lib/validate");
const { config } = require("../lib/config");
const accounts = require("../services/accounts");
const upi = require("../services/upi");
const { audit, listAudit } = require("../services/audit");
const { inviteHash, newInviteCode } = require("./auth");
const { ownerOnly, ctxOf, notFound, sendCsv } = require("./common");

const EXPORT_TABLES = [
  "buildings", "rooms", "tenants", "authorities", "leases", "charges", "charge_adjustments", "payments", "payment_reversals", "allocations",
  "payment_orders", "documents", "bank_imports", "bank_transactions", "maintenance_requests", "maintenance_events", "expenses",
  "move_records", "deposit_transactions", "deposit_settlements", "messages", "message_templates",
];

function register(app, { db, todayFor, log }) {
  // upi = the UPI ID tenants' Pay buttons will actually use (see services/upi).
  const orgView = (org) => {
    const payee = upi.payeeFor(db, org.id);
    return { id: org.id, name: org.name, timeZone: org.time_zone, defaultLanguage: org.default_language, settings: org.settings, upi: payee ? { upiId: payee.vpa, payeeName: payee.name, source: payee.source } : null };
  };

  app.get("/api/org", (req, res) => {
    const org = accounts.getOrg(db, req.orgId);
    res.json(orgView(org));
  });

  app.put("/api/org", ownerOnly, (req, res) => {
    const org = accounts.getOrg(db, req.orgId);
    const body = req.body || {};
    const name = body.name !== undefined ? v.text({ label: "Name", max: 120, required: true })(body.name) : org.name;
    const language = body.defaultLanguage !== undefined ? (["en", "hi"].includes(body.defaultLanguage) ? body.defaultLanguage : null) : org.default_language;
    if (!language) return res.status(400).json({ error: "Language must be English or Hindi." });
    let timeZone = org.time_zone;
    if (body.timeZone !== undefined) {
      try { new Intl.DateTimeFormat("en-CA", { timeZone: body.timeZone }); timeZone = body.timeZone; } catch { return res.status(400).json({ error: "Choose a valid time zone." }); }
    }
    const settings = org.settings;
    if (body.settings?.reminders) {
      const r = body.settings.reminders;
      const n = (val, min, max, fallback) => (Number.isInteger(Number(val)) && Number(val) >= min && Number(val) <= max ? Number(val) : fallback);
      settings.reminders = {
        enabled: Boolean(r.enabled), requireApproval: r.requireApproval !== false,
        upcomingDaysBefore: n(r.upcomingDaysBefore, 0, 30, settings.reminders.upcomingDaysBefore),
        onDueDate: r.onDueDate !== false,
        overdueEveryDays: n(r.overdueEveryDays, 1, 30, settings.reminders.overdueEveryDays),
        overdueMaxCount: n(r.overdueMaxCount, 0, 10, settings.reminders.overdueMaxCount),
        leaseExpiryDays: (Array.isArray(r.leaseExpiryDays) ? r.leaseExpiryDays : settings.reminders.leaseExpiryDays).map(Number).filter((d) => Number.isInteger(d) && d > 0 && d <= 365).slice(0, 4),
        channels: (Array.isArray(r.channels) ? r.channels : ["inapp"]).filter((c) => ["inapp", "email", "sms", "whatsapp"].includes(c)),
      };
      if (!settings.reminders.channels.length) settings.reminders.channels = ["inapp"];
    }
    if (body.settings?.retention) {
      const days = Number(body.settings.retention.anonymizeFormerTenantsAfterDays);
      settings.retention = { anonymizeFormerTenantsAfterDays: Number.isInteger(days) && days >= 0 && days <= 3650 ? days : settings.retention.anonymizeFormerTenantsAfterDays };
    }
    if (body.settings?.receipts) settings.receipts = { footer: v.text({ label: "Receipt footer", max: 300 })(body.settings.receipts.footer) };
    if (body.settings?.bills) {
      const b = body.settings.bills;
      settings.bills = {
        paymentDetails: b.paymentDetails !== undefined ? v.text({ label: "Payment details", max: 600 })(b.paymentDetails) : settings.bills.paymentDetails,
        rentMode: b.rentMode !== undefined ? (["simple", "instalments"].includes(b.rentMode) ? b.rentMode : settings.bills.rentMode) : settings.bills.rentMode,
      };
    }
    // UPI ID tenants pay into (UPI Intent). Empty clears it.
    if (body.settings?.payments) {
      const p = body.settings.payments;
      const next = { ...settings.payments };
      if (p.upiId !== undefined) {
        const raw = String(p.upiId || "").trim();
        if (raw && !upi.normaliseVpa(raw)) return res.status(400).json({ error: "Enter a valid UPI ID, like yourname@okaxis or 9876543210@ybl." });
        next.upiId = raw ? upi.normaliseVpa(raw) : "";
      }
      if (p.payeeName !== undefined) next.payeeName = upi.cleanText(v.text({ label: "Name shown in UPI apps", max: 50 })(p.payeeName), 50);
      settings.payments = next;
    }
    if (body.settings?.assistant) settings.assistant = { aiEnabled: body.settings.assistant.aiEnabled === true };
    db.run("UPDATE organizations SET name = ?, default_language = ?, time_zone = ?, settings_json = ? WHERE id = ?", name, language, timeZone, JSON.stringify(settings), req.orgId);
    audit(db, ctxOf(req), "org.updated", "organization", req.orgId, { fields: Object.keys(body) });
    const fresh = accounts.getOrg(db, req.orgId);
    res.json(orgView(fresh));
  });

  // ---------- team ----------
  app.get("/api/team", ownerOnly, (req, res) => {
    const members = db.all("SELECT id, name, contact, role, created_at, disabled_at FROM users WHERE org_id = ? AND role IN ('owner','manager') ORDER BY created_at", req.orgId);
    const invites = db.all("SELECT id, name, role, expires_at, created_at, used_at FROM team_invites WHERE org_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC", req.orgId, new Date().toISOString());
    res.json({ members: members.map((m) => ({ id: m.id, name: m.name, contact: m.contact, role: m.role, createdAt: m.created_at, disabled: Boolean(m.disabled_at) })), invites });
  });

  app.post("/api/team/invites", ownerOnly, (req, res) => {
    const name = v.text({ label: "Name", max: 120, required: true })(req.body?.name);
    const contact = v.text({ label: "Mobile number or email", max: 200, required: true })(req.body?.contact);
    const key = accounts.contactKey(contact);
    if (db.get("SELECT 1 FROM users WHERE contact_key = ?", key)) return res.status(409).json({ error: "Someone already has an account with this contact." });
    const code = newInviteCode();
    const expiresAt = new Date(Date.now() + config.inviteTtlDays * 86_400_000).toISOString();
    const id = db.id();
    db.run("INSERT INTO team_invites (id, org_id, role, name, contact_key, code_hash, expires_at, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, req.orgId, "manager", name, key, inviteHash(code), expiresAt, req.user.id, db.nowIso());
    audit(db, ctxOf(req), "team.invite_created", "team_invite", id, { role: "manager" });
    res.status(201).json({ id, code, expiresAt, contact });
  });

  app.delete("/api/team/invites/:id", ownerOnly, (req, res) => {
    db.run("UPDATE team_invites SET expires_at = ? WHERE id = ? AND org_id = ?", new Date().toISOString(), req.params.id, req.orgId);
    res.json({ ok: true });
  });

  app.post("/api/team/members/:id/disable", ownerOnly, (req, res) => {
    const member = db.get("SELECT * FROM users WHERE id = ? AND org_id = ? AND role = 'manager'", req.params.id, req.orgId);
    if (!member) return notFound(res, "Team member");
    db.tx(() => {
      db.run("UPDATE users SET disabled_at = ? WHERE id = ?", db.nowIso(), member.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", member.id);
      audit(db, ctxOf(req), "team.member_disabled", "user", member.id, {});
    });
    res.json({ ok: true });
  });

  // ---------- audit log ----------
  app.get("/api/audit", ownerOnly, (req, res) => {
    const rows = listAudit(db, req.orgId, { limit: req.query.limit, entityType: req.query.entityType, entityId: req.query.entityId, before: req.query.before });
    if (req.query.format === "csv") {
      return sendCsv(res, `audit-log-${todayFor(req)}.csv`, ["Time", "Who", "Role", "Action", "Record", "Record id", "Details"],
        rows.map((r) => [r.created_at, r.actor_name || "system", r.actor_role || "", r.action, r.entity_type || "", r.entity_id || "", JSON.stringify(r.details)]));
    }
    res.json(rows.map((r) => ({ id: r.id, at: r.created_at, actor: r.actor_name || "System", role: r.actor_role, action: r.action, entityType: r.entity_type, entityId: r.entity_id, details: r.details })));
  });

  // ---------- export & backups ----------
  // All of this organisation's records as JSON. Password hashes, sessions and
  // reset codes are left out. Receipt/document files are not included.
  app.get("/api/admin/export", ownerOnly, (req, res) => {
    const data = {};
    for (const table of EXPORT_TABLES) data[table] = db.all(`SELECT * FROM ${table} WHERE org_id = ?`, req.orgId);
    data.users = db.all("SELECT id, name, contact, email, role, tenant_id, language, created_at FROM users WHERE org_id = ?", req.orgId);
    data.organization = db.get("SELECT * FROM organizations WHERE id = ?", req.orgId);
    audit(db, ctxOf(req), "data.exported", "organization", req.orgId, {});
    log.info("data export downloaded", { userId: req.user.id });
    res.setHeader("Content-Disposition", `attachment; filename="rent-ledger-backup-${todayFor(req)}.json"`);
    res.type("application/json").send(JSON.stringify({ exportedAt: new Date().toISOString(), format: "rent-ledger-export-v2", note: "Money values ending in _paise are in paise (1/100 rupee).", data }, null, 2));
  });

  app.get("/api/admin/backups", ownerOnly, (req, res) => {
    res.json(db.listBackups().slice(0, 50).map((b) => ({ name: b.name, at: new Date(b.mtimeMs).toISOString() })));
  });

  app.post("/api/admin/backups", ownerOnly, (req, res) => {
    const name = db.backup("manual");
    audit(db, ctxOf(req), "data.backup_created", "organization", req.orgId, { name });
    res.status(201).json({ name });
  });
}

module.exports = { register };
