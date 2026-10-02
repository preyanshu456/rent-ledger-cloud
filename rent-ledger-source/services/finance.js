// Financial summaries and reports. Every number is derived from ledger rows
// (charges, adjustments, payments, allocations) and expenses - nothing is
// stored or hard-coded - so the dashboard, reports and assistant always agree.
const ledger = require("./ledger");

function monthKey(y, m) { return `${y}-${String(m).padStart(2, "0")}`; }
function addMonths(ym, n) {
  const [y, m] = ym.split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return monthKey(Math.floor(t / 12), (t % 12) + 1);
}
function monthsBetween(from, to) {
  const out = [];
  for (let k = from; k <= to && out.length < 60; k = addMonths(k, 1)) out.push(k);
  return out;
}

// Period filter: charges by billing period (YYYY-MM), payments/expenses by date.
function normaliseRange(q, today) {
  const to = /^\d{4}-\d{2}$/.test(q.to || "") ? q.to : today.slice(0, 7);
  const from = /^\d{4}-\d{2}$/.test(q.from || "") ? q.from : addMonths(to, -5);
  return { from: from <= to ? from : to, to };
}

function chargesInRange(db, orgId, { from, to, buildingId }, today) {
  return ledger.listCharges(db, orgId, { buildingId, periodFrom: Number(from.replace("-", "")), periodTo: Number(to.replace("-", "")) }, today);
}

function paymentsInRange(db, orgId, { from, to, buildingId }) {
  const end = `${addMonths(to, 1)}-01`;
  return ledger.listPayments(db, orgId, { buildingId, from: `${from}-01`, to: end, limit: 1000 }).filter((p) => p.received_on < end && !p.reversed && p.method !== "deposit_adjustment");
}

function expensesInRange(db, orgId, { from, to, buildingId }) {
  const end = `${addMonths(to, 1)}-01`;
  return db.all(`SELECT e.*, b.name AS building_name FROM expenses e JOIN buildings b ON b.id = e.building_id
                 WHERE e.org_id = ? AND e.voided_at IS NULL AND e.spent_on >= ? AND e.spent_on < ? ${buildingId ? "AND e.building_id = ?" : ""} ORDER BY e.spent_on`,
    ...[orgId, `${from}-01`, end, ...(buildingId ? [buildingId] : [])]);
}

function summary(db, orgId, query, today) {
  const range = normaliseRange(query, today);
  const buildingId = query.buildingId || undefined;
  const charges = chargesInRange(db, orgId, { ...range, buildingId }, today);
  const payments = paymentsInRange(db, orgId, { ...range, buildingId });
  const expenses = expensesInRange(db, orgId, { ...range, buildingId });
  const allOpen = ledger.listCharges(db, orgId, { buildingId, status: "open" }, today);
  const sum = (list, f) => list.reduce((s, x) => s + x[f], 0);
  const billed = sum(charges, "amount_paise");
  const collectedOnBills = sum(charges, "paid_paise");
  const overdue = allOpen.filter((c) => c.due_date && c.due_date < today).reduce((s, c) => s + c.outstanding_paise, 0);
  const received = sum(payments, "amount_paise");
  const spent = sum(expenses, "amount_paise");

  const months = monthsBetween(range.from, range.to);
  const trend = months.map((k) => {
    const [y, m] = k.split("-").map(Number);
    const cs = charges.filter((c) => c.period_year === y && c.period_month === m);
    const ps = payments.filter((p) => p.received_on.startsWith(k));
    const es = expenses.filter((e) => e.spent_on.startsWith(k));
    return { month: k, billedPaise: sum(cs, "amount_paise"), collectedPaise: sum(cs, "paid_paise"), receivedPaise: sum(ps, "amount_paise"), expensesPaise: sum(es, "amount_paise") };
  });

  const buildings = db.all(`SELECT id, name FROM buildings WHERE org_id = ? ${buildingId ? "AND id = ?" : ""} ORDER BY name`, ...(buildingId ? [orgId, buildingId] : [orgId]));
  const roomBuilding = new Map(db.all("SELECT id, building_id FROM rooms WHERE org_id = ?", orgId).map((r) => [r.id, r.building_id]));
  const byProperty = buildings.map((b) => {
    const cs = charges.filter((c) => roomBuilding.get(c.room_id) === b.id);
    const ps = payments.filter((p) => roomBuilding.get(p.room_id) === b.id);
    const es = expenses.filter((e) => e.building_id === b.id);
    const open = allOpen.filter((c) => roomBuilding.get(c.room_id) === b.id);
    const inc = sum(ps, "amount_paise");
    const exp = sum(es, "amount_paise");
    return { buildingId: b.id, name: b.name, billedPaise: sum(cs, "amount_paise"), receivedPaise: inc, expensesPaise: exp, netPaise: inc - exp, outstandingPaise: sum(open, "outstanding_paise") };
  });

  const leases = db.all(`SELECT l.*, t.name AS tenant_name, r.label AS room_label FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN rooms r ON r.id = l.room_id
                         WHERE l.org_id = ? AND l.status = 'active' AND l.end_date <> '' ORDER BY l.end_date LIMIT 50`, orgId)
    .map((l) => ({ leaseId: l.id, tenantName: l.tenant_name, roomLabel: l.room_label, endDate: l.end_date, daysLeft: Math.round((Date.parse(`${l.end_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) }))
    .filter((l) => l.daysLeft <= 90);

  // Rent due in the current month (whatever the selected range).
  const [cy, cm] = today.slice(0, 7).split("-").map(Number);
  const thisMonth = ledger.listCharges(db, orgId, { buildingId, year: cy, month: cm }, today);

  return {
    range, generatedFor: today,
    totals: {
      billedPaise: billed, collectedOnBillsPaise: collectedOnBills, collectionRate: billed ? Math.round((collectedOnBills / billed) * 1000) / 10 : null,
      receivedPaise: received, expensesPaise: spent, netCashFlowPaise: received - spent,
      outstandingPaise: sum(allOpen, "outstanding_paise"), overduePaise: overdue,
      dueThisMonthPaise: sum(thisMonth, "amount_paise"), collectedThisMonthPaise: sum(thisMonth, "paid_paise"),
    },
    trend, byProperty, leaseExpiries: leases,
    basis: "Billed and collected use bills dated in the selected months; received and expenses use payment and expense dates; outstanding and overdue are all open bills as of today.",
  };
}

// Tabular reports (rows of plain values) for the Reports screen / CSV.
function report(db, orgId, type, query, today) {
  const range = normaliseRange(query, today);
  const buildingId = query.buildingId || undefined;
  const tenantName = (id) => (id ? db.get("SELECT name FROM tenants WHERE id = ?", id)?.name || "" : "");
  const roomInfo = (id) => db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", id) || {};
  const rupees = (p) => Math.round(p) / 100;
  switch (type) {
    case "rent-collection": {
      const rows = chargesInRange(db, orgId, { ...range, buildingId }, today).filter((c) => c.kind === "rent")
        .map((c) => { const r = roomInfo(c.room_id); return [monthKey(c.period_year, c.period_month), r.name, r.label, tenantName(c.tenant_id), rupees(c.amount_paise), rupees(c.paid_paise), rupees(c.outstanding_paise), c.status]; });
      return { title: "Rent collection", columns: ["Month", "Property", "Room", "Tenant", "Rent", "Collected", "Outstanding", "Status"], rows, moneyColumns: [4, 5, 6] };
    }
    case "outstanding": {
      const rows = ledger.listCharges(db, orgId, { buildingId, status: "open" }, today)
        .sort((a, b) => (a.due_date || "9").localeCompare(b.due_date || "9"))
        .map((c) => { const r = roomInfo(c.room_id); const days = c.due_date && c.due_date < today ? Math.round((Date.parse(today) - Date.parse(c.due_date)) / 86_400_000) : 0; return [r.name, r.label, tenantName(c.tenant_id), ledger.chargeLabel(c), c.due_date, days, rupees(c.outstanding_paise)]; });
      return { title: "Outstanding dues", columns: ["Property", "Room", "Tenant", "Bill", "Due date", "Days overdue", "Outstanding"], rows, moneyColumns: [6] };
    }
    case "property-income": {
      const s = summary(db, orgId, query, today);
      return { title: "Property income and expenses", columns: ["Property", "Billed", "Received", "Expenses", "Net", "Outstanding now"], rows: s.byProperty.map((p) => [p.name, rupees(p.billedPaise), rupees(p.receivedPaise), rupees(p.expensesPaise), rupees(p.netPaise), rupees(p.outstandingPaise)]), moneyColumns: [1, 2, 3, 4, 5] };
    }
    case "cash-flow": {
      const s = summary(db, orgId, query, today);
      return { title: "Monthly cash flow", columns: ["Month", "Billed", "Received", "Expenses", "Net cash flow"], rows: s.trend.map((t) => [t.month, rupees(t.billedPaise), rupees(t.receivedPaise), rupees(t.expensesPaise), rupees(t.receivedPaise - t.expensesPaise)]), moneyColumns: [1, 2, 3, 4] };
    }
    case "lease-expiry": {
      const rows = db.all(`SELECT l.*, t.name AS tenant, r.label, b.name AS building FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN rooms r ON r.id = l.room_id JOIN buildings b ON b.id = r.building_id
                           WHERE l.org_id = ? AND l.status = 'active' ${buildingId ? "AND b.id = ?" : ""} ORDER BY CASE WHEN l.end_date = '' THEN 1 ELSE 0 END, l.end_date`, ...(buildingId ? [orgId, buildingId] : [orgId]))
        .map((l) => [l.building, l.label, l.tenant, l.start_date, l.end_date || "Open-ended", l.end_date ? Math.round((Date.parse(l.end_date) - Date.parse(today)) / 86_400_000) : "", rupees(l.rent_paise)]);
      return { title: "Lease expiries", columns: ["Property", "Room", "Tenant", "Start", "End", "Days left", "Rent"], rows, moneyColumns: [6] };
    }
    case "maintenance-expenses": {
      const rows = expensesInRange(db, orgId, { ...range, buildingId }).map((e) => {
        const req = e.maintenance_request_id ? db.get("SELECT title FROM maintenance_requests WHERE id = ?", e.maintenance_request_id) : null;
        return [e.spent_on, e.building_name, e.category.replace("_", " "), e.vendor, e.description, req?.title || "", rupees(e.amount_paise)];
      });
      return { title: "Expenses (incl. maintenance)", columns: ["Date", "Property", "Category", "Vendor", "Description", "Maintenance request", "Amount"], rows, moneyColumns: [6] };
    }
    case "deposit-settlements": {
      const rows = db.all("SELECT s.*, t.name FROM deposit_settlements s JOIN tenants t ON t.id = s.tenant_id WHERE s.org_id = ? ORDER BY s.created_at DESC", orgId)
        .map((s) => { const ded = JSON.parse(s.deductions_json || "[]").reduce((a, d) => a + d.amountPaise, 0); return [s.name, s.status, rupees(s.deposit_held_paise), rupees(s.outstanding_dues_paise), rupees(ded), rupees(s.refund_paise), s.refunded_at ? s.refunded_at.slice(0, 10) : ""]; });
      return { title: "Deposit settlements", columns: ["Tenant", "Status", "Deposit held", "Dues applied", "Deductions", "Refund", "Refunded on"], rows, moneyColumns: [2, 3, 4, 5] };
    }
    case "payments": {
      const rows = paymentsInRange(db, orgId, { ...range, buildingId }).map((p) => { const r = roomInfo(p.room_id); return [p.received_on, r.name, r.label, tenantName(p.tenant_id), p.method, p.reference, p.verification, rupees(p.amount_paise)]; });
      return { title: "Payments received", columns: ["Date", "Property", "Room", "Tenant", "Method", "Reference", "Verification", "Amount"], rows, moneyColumns: [7] };
    }
    default: return null;
  }
}

const REPORT_TYPES = ["rent-collection", "outstanding", "payments", "property-income", "cash-flow", "lease-expiry", "maintenance-expenses", "deposit-settlements"];

module.exports = { summary, report, REPORT_TYPES, normaliseRange, addMonths, monthsBetween };
