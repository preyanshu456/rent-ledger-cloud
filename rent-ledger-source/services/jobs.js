// Background jobs (single server instance):
//   hourly   - create due rent charges from active leases, end expired leases,
//              automatic reminders (only for organisations that turned them on),
//              anonymise former tenants past the retention period, daily backup
//   every 2m - send queued outbox messages (with retries)
const { localDate } = require("../lib/dates");
const schedules = require("./schedules");
const reminders = require("./reminders");
const delivery = require("./delivery");
const { getOrg } = require("./accounts");
const { notifyStaff } = require("./notify");
const { audit } = require("./audit");
const dues = require("./dues");

function todayForOrg(db) {
  return (orgId) => localDate(db.get("SELECT time_zone FROM organizations WHERE id = ?", orgId)?.time_zone || "Asia/Kolkata");
}

function runHourly(db, { log } = {}) {
  const today = todayForOrg(db);
  const out = { charges: 0, leasesEnded: 0, reminders: 0, anonymized: 0, lateFees: 0, packages: 0, discountsExpired: 0, backup: null };
  out.leasesEnded = 0;
  out.charges = schedules.generateDueCharges(db, today);
  out.leasesEnded = schedules.expireLeases(db, today);
  for (const org of db.all("SELECT id FROM organizations")) {
    // Dues engine: monthly packages, late fees, discounts past their date.
    // One organisation's problem never stops the others.
    try {
      out.packages += dues.runMonthlyPackages(db, org.id, today(org.id));
      const lf = dues.applyLateFees(db, org.id, today(org.id));
      out.lateFees += lf.created + lf.increased;
      out.discountsExpired += dues.settleDiscounts(db, org.id, today(org.id)).expired;
    } catch (error) { log?.error("dues job failed", { orgId: org.id, error }); }
    const o = getOrg(db, org.id);
    const s = o.settings.reminders;
    if (s.enabled) {
      const res = reminders.draftReminders(db, org.id, today(org.id), { status: s.requireApproval ? "draft" : "queued" });
      out.reminders += res.created;
      if (res.created && s.requireApproval) notifyStaff(db, org.id, { kind: "reminders", title: `${res.created} reminder${res.created === 1 ? "" : "s"} waiting for approval`, body: "Review and approve them in Reminders → Outbox.", link: "reminders" });
    }
    const days = o.settings.retention.anonymizeFormerTenantsAfterDays;
    if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
      for (const t of db.all("SELECT id FROM tenants WHERE org_id = ? AND active = 0 AND anonymized_at IS NULL AND move_out_date <> '' AND move_out_date < ?", org.id, cutoff)) {
        db.tx(() => {
          db.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE tenant_id = ?)", t.id);
          db.run("DELETE FROM users WHERE tenant_id = ?", t.id);
          db.run("UPDATE tenants SET name = ?, mobile = '', alt_mobile = '', email = '', id_proof_type = '', id_proof_number = '', notes = '', anonymized_at = ? WHERE id = ?", `Former tenant ${t.id.slice(0, 4).toUpperCase()}`, db.nowIso(), t.id);
          audit(db, { orgId: org.id, role: "system", requestId: "retention" }, "tenant.anonymized", "tenant", t.id, { reason: `retention ${days} days` });
        });
        out.anonymized++;
      }
    }
  }
  out.backup = db.maybeBackup();
  if (out.charges || out.reminders || out.anonymized || out.leasesEnded || out.lateFees || out.packages || out.discountsExpired) log?.info("hourly jobs", out);
  return out;
}

function startJobs({ db }, { log } = {}) {
  const safe = (name, fn) => async () => {
    try { await fn(); } catch (error) { log?.error(`job failed: ${name}`, { error }); }
  };
  const hourly = safe("hourly", () => runHourly(db, { log }));
  const outbox = safe("outbox", async () => { const r = await delivery.processOutbox(db); if (r.sent || r.failed || r.simulated) log?.info("outbox processed", r); });
  const first = setTimeout(hourly, 10_000);
  const h = setInterval(hourly, 60 * 60_000);
  const o = setInterval(outbox, 2 * 60_000);
  for (const t of [first, h, o]) t.unref();
  return { stop() { clearTimeout(first); clearInterval(h); clearInterval(o); }, runHourly: () => runHourly(db, { log }) };
}

module.exports = { startJobs, runHourly };
