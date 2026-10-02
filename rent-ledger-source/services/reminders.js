// Reminder engine. Works out who should be reminded today (upcoming, due
// today, overdue, lease expiry), renders the message from templates, and puts
// it in the outbox - as a draft when approval is required (the default), or
// queued for sending when the owner has turned automatic sending on.
// A unique dedupe key per reminder/channel/day makes duplicates impossible.
const ledger = require("./ledger");
const templates = require("./templates");
const { getOrg } = require("./accounts");
const providers = require("./providers");
const { toRupees } = require("../lib/money");

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
const inr = (paise) => toRupees(paise).toLocaleString("en-IN");

// Which channels can reach this tenant (owner settings ∩ tenant consent ∩ contact details).
function channelsFor(db, tenant, wanted) {
  const out = [];
  const hasLogin = Boolean(db.get("SELECT 1 FROM users WHERE tenant_id = ?", tenant.id));
  for (const ch of wanted) {
    if (ch === "inapp" && hasLogin) out.push({ channel: "inapp", recipient: "app" });
    if (ch === "email" && tenant.notify_email && providers.isEmail(tenant.email)) out.push({ channel: "email", recipient: tenant.email });
    if (ch === "sms" && tenant.notify_sms && tenant.mobile) out.push({ channel: "sms", recipient: tenant.mobile });
    if (ch === "whatsapp" && tenant.notify_whatsapp && tenant.mobile) out.push({ channel: "whatsapp", recipient: tenant.mobile });
  }
  return out;
}

function baseVars(db, org, tenant) {
  const room = db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", tenant.room_id) || {};
  const owner = db.get("SELECT name FROM users WHERE org_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", org.id);
  return { tenantName: tenant.name, property: room.name || "", unit: room.label || "", ownerName: owner?.name || org.name };
}

// Everything that *would* be sent today, without side effects.
function computeReminders(db, orgId, today, { kinds = ["upcoming", "due_today", "overdue", "lease_expiry"], tenantIds = null, force = false } = {}) {
  const org = getOrg(db, orgId);
  const s = org.settings.reminders;
  const tenants = db.all("SELECT * FROM tenants WHERE org_id = ? AND active = 1", orgId).filter((t) => !tenantIds || tenantIds.includes(t.id));
  const out = [];
  for (const t of tenants) {
    const vars = baseVars(db, org, t);
    const open = ledger.listCharges(db, orgId, { tenantId: t.id, status: "open" }, today).filter((c) => c.due_date);
    for (const c of open) {
      const days = daysBetween(today, c.due_date);
      if (kinds.includes("upcoming") && (force ? days > 0 && days <= Math.max(s.upcomingDaysBefore, 7) : s.upcomingDaysBefore > 0 && days === s.upcomingDaysBefore)) {
        out.push({ tenant: t, key: "rent_upcoming", relatedType: "charge", relatedId: c.id, dedupe: `rem:${c.id}:upcoming`, amountPaise: c.outstanding_paise,
          vars: { ...vars, bill: ledger.chargeLabel(c), amount: inr(c.outstanding_paise), dueDate: c.due_date } });
      }
      if (kinds.includes("due_today") && days === 0 && (s.onDueDate || force)) {
        out.push({ tenant: t, key: "rent_due_today", relatedType: "charge", relatedId: c.id, dedupe: `rem:${c.id}:due`, amountPaise: c.outstanding_paise,
          vars: { ...vars, bill: ledger.chargeLabel(c), amount: inr(c.outstanding_paise), dueDate: c.due_date } });
      }
    }
    if (kinds.includes("overdue")) {
      const overdue = open.filter((c) => c.due_date < today).sort((a, b) => a.due_date.localeCompare(b.due_date));
      if (overdue.length) {
        const oldest = overdue[0];
        const daysOver = daysBetween(oldest.due_date, today);
        const nth = s.overdueEveryDays > 0 ? daysOver / s.overdueEveryDays : 0;
        const qualifies = force || (Number.isInteger(nth) && nth >= 1 && nth <= s.overdueMaxCount);
        if (qualifies) {
          const total = overdue.reduce((sum, c) => sum + c.outstanding_paise, 0);
          out.push({ tenant: t, key: "rent_overdue", relatedType: "tenant", relatedId: t.id, dedupe: `rem:overdue:${t.id}:${today}`, amountPaise: total,
            vars: { ...vars, amount: inr(total), bills: overdue.map((c) => ledger.chargeLabel(c)).join(", "), dueDate: oldest.due_date, daysOverdue: daysOver } });
        }
      }
    }
    if (kinds.includes("lease_expiry")) {
      const lease = db.get("SELECT * FROM leases WHERE tenant_id = ? AND status = 'active' AND end_date <> ''", t.id);
      if (lease) {
        const left = daysBetween(today, lease.end_date);
        if ((force && left >= 0 && left <= 90) || s.leaseExpiryDays.includes(left)) {
          out.push({ tenant: t, key: "lease_expiry", relatedType: "lease", relatedId: lease.id, dedupe: `rem:lease:${lease.id}:${force ? today : left}`, amountPaise: 0,
            vars: { ...vars, endDate: lease.end_date, daysLeft: left } });
        }
      }
    }
  }
  return out.map((r) => ({ ...r, channels: channelsFor(db, r.tenant, s.channels) }));
}

function preview(db, orgId, today, opts) {
  const org = getOrg(db, orgId);
  return computeReminders(db, orgId, today, opts).map((r) => {
    const lang = db.get("SELECT language FROM users WHERE tenant_id = ?", r.tenant.id)?.language || org.default_language;
    const tpl = templates.getTemplate(db, orgId, r.key, lang);
    return {
      tenantId: r.tenant.id, tenantName: r.tenant.name, key: r.key, relatedType: r.relatedType, relatedId: r.relatedId, amount: toRupees(r.amountPaise),
      channels: r.channels.map((c) => c.channel), language: lang, subject: templates.render(tpl.subject, r.vars), body: templates.render(tpl.body, r.vars),
      reachable: r.channels.length > 0,
    };
  });
}

// Put reminders into the outbox. Returns { created, skippedDuplicates, unreachable }.
function draftReminders(db, orgId, today, { createdBy = null, status = "draft", ...opts } = {}) {
  const org = getOrg(db, orgId);
  let created = 0, skippedDuplicates = 0, unreachable = 0;
  const ids = [];
  db.tx(() => {
    for (const r of computeReminders(db, orgId, today, opts)) {
      if (!r.channels.length) { unreachable++; continue; }
      const user = db.get("SELECT id, language FROM users WHERE tenant_id = ?", r.tenant.id);
      const lang = user?.language || org.default_language;
      const tpl = templates.getTemplate(db, orgId, r.key, lang);
      for (const ch of r.channels) {
        const dedupe = `${r.dedupe}:${ch.channel}`;
        if (db.get("SELECT 1 FROM outbox WHERE dedupe_key = ?", dedupe)) { skippedDuplicates++; continue; }
        const id = db.id();
        db.run(`INSERT INTO outbox (id, org_id, tenant_id, user_id, channel, recipient, template_key, language, subject, body, status, dedupe_key, related_type, related_id, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          id, orgId, r.tenant.id, user?.id || null, ch.channel, ch.recipient, r.key, lang, templates.render(tpl.subject, r.vars), templates.render(tpl.body, r.vars),
          status, dedupe, r.relatedType, r.relatedId, createdBy, db.nowIso());
        ids.push(id);
        created++;
      }
    }
  });
  return { created, skippedDuplicates, unreachable, ids };
}

module.exports = { computeReminders, preview, draftReminders, channelsFor, daysBetween };
