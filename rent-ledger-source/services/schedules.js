// Rent schedules: active leases create their rent charges automatically, one
// per period, never twice (a unique index guarantees it). Periods before the
// schedule start are never billed, and a period that already has a rent bill
// for the same tenant (entered by hand) is skipped.
const ledger = require("./ledger");

const STEP = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };

function ym(dateStr) {
  const [y, m] = String(dateStr).split("-").map(Number);
  return y * 12 + (m - 1);
}
function fromYm(n) { return { year: Math.floor(n / 12), month: (n % 12) + 1 }; }
function pad(n) { return String(n).padStart(2, "0"); }

// Billing periods of a lease that have started on or before `today`.
function duePeriods(lease, today) {
  const step = STEP[lease.frequency] || 1;
  const start = ym(lease.start_date);
  const first = Math.max(start, lease.schedule_start ? ym(`${lease.schedule_start}-01`) : start);
  const last = Math.min(ym(today), lease.end_date ? ym(lease.end_date) : Infinity);
  const periods = [];
  for (let n = start; n <= last; n += step) if (n >= first) periods.push(fromYm(n));
  return periods;
}

function generateForLease(db, lease, today, { userId = null } = {}) {
  if (lease.status !== "active" || !lease.auto_generate_rent) return [];
  const created = [];
  const ctx = { orgId: lease.org_id, userId, role: "system", requestId: "rent-schedule" };
  for (const p of duePeriods(lease, today)) {
    const exists = db.get(`SELECT 1 FROM charges WHERE org_id = ? AND kind = 'rent' AND voided_at IS NULL AND period_year = ? AND period_month = ?
                           AND (lease_id = ? OR (tenant_id = ? AND room_id = ?))`, lease.org_id, p.year, p.month, lease.id, lease.tenant_id, lease.room_id);
    if (exists) continue;
    const dueDate = `${p.year}-${pad(p.month)}-${pad(Math.min(lease.due_day, 28))}`;
    try {
      const id = ledger.createCharge(db, ctx, {
        roomId: lease.room_id, tenantId: lease.tenant_id, leaseId: lease.id, kind: "rent", periodYear: p.year, periodMonth: p.month,
        dueDate, amountPaise: lease.rent_paise, source: "schedule", description: lease.frequency === "monthly" ? "" : `${lease.frequency.replace("_", "-")} rent`,
      });
      created.push(id);
    } catch (err) {
      if (!/UNIQUE constraint failed/.test(err.message)) throw err; // created concurrently: fine
    }
  }
  return created;
}

function generateDueCharges(db, todayForOrg) {
  let count = 0;
  for (const lease of db.all("SELECT * FROM leases WHERE status = 'active' AND auto_generate_rent = 1")) {
    count += db.tx(() => generateForLease(db, lease, todayForOrg(lease.org_id))).length;
  }
  return count;
}

// Leases past their end date become "ended" (the schedule stops billing).
function expireLeases(db, todayForOrg) {
  let n = 0;
  for (const lease of db.all("SELECT id, org_id, end_date FROM leases WHERE status = 'active' AND end_date <> ''")) {
    if (lease.end_date < todayForOrg(lease.org_id)) {
      db.run("UPDATE leases SET status = 'ended', ended_at = ?, end_reason = 'Reached end date' WHERE id = ?", db.nowIso(), lease.id);
      n++;
    }
  }
  return n;
}

module.exports = { duePeriods, generateForLease, generateDueCharges, expireLeases };
