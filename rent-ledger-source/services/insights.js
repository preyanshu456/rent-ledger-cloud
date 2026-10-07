// Cash-flow insights and review alerts. Facts come straight from the ledger;
// forecasts are labelled as forecasts and list their assumptions. Alerts are
// prompts to take a look, never accusations.
const ledger = require("./ledger");
const finance = require("./finance");

function cashflow(db, orgId, today) {
  const thisMonth = today.slice(0, 7);
  const nextMonth = finance.addMonths(thisMonth, 1);
  const [ny, nm] = nextMonth.split("-").map(Number);
  // Expected rent next month: active leases billing that month, plus occupied
  // rooms without a lease at their monthly rent.
  const STEP = { monthly: 1, quarterly: 3, half_yearly: 6, yearly: 12 };
  let expectedRentPaise = 0;
  const leased = new Set();
  for (const l of db.all("SELECT * FROM leases WHERE org_id = ? AND status = 'active'", orgId)) {
    leased.add(l.tenant_id);
    if (l.end_date && l.end_date < `${nextMonth}-01`) continue;
    const startIdx = Number(l.start_date.slice(0, 4)) * 12 + Number(l.start_date.slice(5, 7)) - 1;
    const idx = ny * 12 + nm - 1;
    if (idx >= startIdx && (idx - startIdx) % (STEP[l.frequency] || 1) === 0) expectedRentPaise += l.rent_paise;
  }
  for (const t of db.all("SELECT t.id, r.monthly_rent_paise FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.org_id = ? AND t.active = 1", orgId)) {
    if (!leased.has(t.id)) expectedRentPaise += t.monthly_rent_paise;
  }
  const s = finance.summary(db, orgId, { from: finance.addMonths(thisMonth, -6), to: finance.addMonths(thisMonth, -1) }, today);
  const months = s.trend.filter((t) => t.billedPaise > 0);
  const rates = months.map((t) => t.collectedPaise / t.billedPaise);
  const avgRate = rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null;
  const last3 = s.trend.slice(-3);
  const avgExpensesPaise = last3.length ? Math.round(last3.reduce((a, t) => a + t.expensesPaise, 0) / last3.length) : 0;
  const outstanding = ledger.listCharges(db, orgId, { status: "open" }, today);
  const outstandingPaise = outstanding.reduce((a, c) => a + c.outstanding_paise, 0);
  const overduePaise = outstanding.filter((c) => c.due_date && c.due_date < today).reduce((a, c) => a + c.outstanding_paise, 0);
  const projectedCollectionPaise = avgRate === null ? expectedRentPaise : Math.round(expectedRentPaise * avgRate);
  const projectedNetPaise = projectedCollectionPaise - avgExpensesPaise;
  // Compare the recent half of the months with the earlier half, so one slow
  // month (often just a late payer) doesn't flip the trend on its own.
  const avg = (list) => list.reduce((a, b) => a + b, 0) / list.length;
  const half = Math.floor(rates.length / 2);
  const earlier = rates.length >= 3 ? avg(rates.slice(0, half)) : null;
  const recent = rates.length >= 3 ? avg(rates.slice(-half)) : null;
  const trendDirection = rates.length >= 3 ? (recent < earlier - 0.1 ? "falling" : recent > earlier + 0.1 ? "rising" : "steady") : "not enough history";
  const expiries = finance.summary(db, orgId, {}, today).leaseExpiries.filter((l) => l.daysLeft <= 60);
  return {
    facts: {
      outstandingPaise, overduePaise,
      collectionHistory: s.trend.map((t) => ({ month: t.month, billedPaise: t.billedPaise, collectedPaise: t.collectedPaise, rate: t.billedPaise ? Math.round((t.collectedPaise / t.billedPaise) * 1000) / 10 : null })),
      averageMonthlyExpensesPaise: avgExpensesPaise, leasesEndingWithin60Days: expiries,
    },
    forecast: {
      month: nextMonth, expectedRentPaise, projectedCollectionPaise, projectedNetPaise,
      collectionTrend: trendDirection,
      possibleShortfall: projectedNetPaise < 0 || (avgRate !== null && avgRate < 0.8),
      assumptions: [
        "Expected rent = active leases billing next month + occupied rooms without a lease at their monthly rent.",
        avgRate === null ? "No collection history yet, so 100% collection is assumed." : `Collection follows the last ${rates.length} month(s) average of ${Math.round(avgRate * 100)}%.`,
        `Expenses follow the last 3 months' average (₹${Math.round(avgExpensesPaise / 100).toLocaleString("en-IN")}).`,
        "Vacancies, new tenants and one-off costs are not predicted.",
      ],
    },
  };
}

function anomalies(db, orgId, today) {
  const alerts = [];
  const inr = (p) => `₹${(Math.round(p) / 100).toLocaleString("en-IN")}`;
  const tenantName = (id) => (id ? db.get("SELECT name FROM tenants WHERE id = ?", id)?.name || "a tenant" : "unknown tenant");

  // 1. The same reference used by more than one live payment.
  for (const r of db.all(`SELECT reference, COUNT(*) AS n, GROUP_CONCAT(id) AS ids, SUM(amount_paise) AS total FROM payments p
                          WHERE org_id = ? AND reference <> '' AND NOT EXISTS (SELECT 1 FROM payment_reversals x WHERE x.payment_id = p.id)
                          GROUP BY lower(reference) HAVING n > 1`, orgId)) {
    alerts.push({ type: "duplicate_reference", severity: "review", title: `Reference ${r.reference} used ${r.n} times`, detail: `${r.n} payments (${inr(r.total)} in total) share this reference. Check it wasn't recorded twice.`, refs: r.ids.split(",") });
  }
  // 2. Same tenant, same amount, same day, recorded more than once.
  for (const r of db.all(`SELECT tenant_id, amount_paise, received_on, COUNT(*) AS n, GROUP_CONCAT(id) AS ids FROM payments p
                          WHERE org_id = ? AND tenant_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM payment_reversals x WHERE x.payment_id = p.id)
                          GROUP BY tenant_id, amount_paise, received_on HAVING n > 1`, orgId)) {
    alerts.push({ type: "possible_duplicate_payment", severity: "review", title: `${tenantName(r.tenant_id)}: ${r.n} payments of ${inr(r.amount_paise)} on ${r.received_on}`, detail: "Could be genuine (e.g. two bills) or a double entry.", refs: r.ids.split(",") });
  }
  // 3. Rent bills that differ from the active lease or room rent.
  for (const c of db.all(`SELECT c.*, l.rent_paise AS lease_rent, r.monthly_rent_paise AS room_rent FROM charges c JOIN rooms r ON r.id = c.room_id
                          LEFT JOIN leases l ON l.tenant_id = c.tenant_id AND l.status = 'active'
                          WHERE c.org_id = ? AND c.kind = 'rent' AND c.voided_at IS NULL AND c.period_year * 100 + c.period_month >= ?`, orgId, Number(finance.addMonths(today.slice(0, 7), -3).replace("-", "")))) {
    const expected = c.lease_rent ?? c.room_rent;
    const current = ledger.getCharge(db, orgId, c.id, today);
    if (expected && current.amount_paise !== expected) {
      alerts.push({ type: "rent_amount_change", severity: "info", title: `${tenantName(c.tenant_id)}: rent for ${c.period_month}/${c.period_year} is ${inr(current.amount_paise)}`, detail: `The ${c.lease_rent ? "lease" : "room"} rent is ${inr(expected)}.`, refs: [c.id] });
    }
  }
  // 4. Large adjustments.
  for (const a of db.all(`SELECT a.*, c.base_amount_paise, c.tenant_id FROM charge_adjustments a JOIN charges c ON c.id = a.charge_id WHERE a.org_id = ? AND a.created_at >= ?`, orgId, new Date(Date.now() - 90 * 86_400_000).toISOString())) {
    if (Math.abs(a.amount_paise) >= Math.max(500_000, Math.abs(a.base_amount_paise) * 0.25)) {
      alerts.push({ type: "large_adjustment", severity: "review", title: `${a.kind.replace("_", " ")} of ${inr(Math.abs(a.amount_paise))} for ${tenantName(a.tenant_id)}`, detail: `Reason given: "${a.reason}".`, refs: [a.charge_id] });
    }
  }
  // 5. Money that arrived but isn't matched or applied.
  const week = new Date(Date.parse(`${today}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
  const unmatched = db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount_paise),0) AS total FROM bank_transactions WHERE org_id = ? AND status = 'unmatched' AND txn_date <= ?", orgId, week);
  if (unmatched.n) alerts.push({ type: "unmatched_bank_credits", severity: "review", title: `${unmatched.n} bank credit(s) unmatched for over a week`, detail: `${inr(unmatched.total)} received but not yet linked to a tenant.`, refs: [] });
  const credits = ledger.listPayments(db, orgId, { limit: 1000 }).filter((p) => p.unallocated_paise > 0 && p.received_on <= week);
  if (credits.length) alerts.push({ type: "unapplied_credit", severity: "info", title: `${credits.length} payment(s) with unapplied credit`, detail: `${inr(credits.reduce((s, p) => s + p.unallocated_paise, 0))} is sitting as tenant credit. Apply it to bills or refund it.`, refs: credits.map((p) => p.id) });
  // 6. Repeated failed online payment attempts.
  for (const r of db.all(`SELECT tenant_id, COUNT(*) AS n FROM payment_orders WHERE org_id = ? AND status = 'failed' AND created_at >= ? GROUP BY tenant_id HAVING n >= 3`, orgId, new Date(Date.now() - 30 * 86_400_000).toISOString())) {
    alerts.push({ type: "repeated_payment_failures", severity: "info", title: `${tenantName(r.tenant_id)}: ${r.n} failed online payment attempts this month`, detail: "They may need help paying, or another payment method.", refs: [] });
  }
  return { alerts, note: "These are prompts to review, not conclusions. Many have ordinary explanations." };
}

module.exports = { cashflow, anomalies };
