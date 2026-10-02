// Tools the assistant can use. Read tools return data computed by the same
// deterministic services as the dashboard and reports. "Prepare" tools never
// change anything: they create a *proposal* the owner reviews and approves.
//
// Privacy: tool results contain tenant names, room labels, dates and amounts
// only - never phone numbers, emails or ID numbers.
const ledger = require("../ledger");
const finance = require("../finance");
const insights = require("../insights");
const reminders = require("../reminders");
const recon = require("../reconciliation");
const { toRupees, toPaise } = require("../../lib/money");

const inr = (p) => `₹${toRupees(p).toLocaleString("en-IN")}`;
const MONTHS = ["", "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function findTenants(db, orgId, name) {
  const q = String(name || "").trim().toLowerCase();
  if (!q) return [];
  return db.all("SELECT t.*, r.label AS room_label, b.name AS building_name FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id WHERE t.org_id = ? AND t.anonymized_at IS NULL ORDER BY t.active DESC", orgId)
    .filter((t) => t.name.toLowerCase().includes(q) || q.split(/\s+/).every((w) => t.name.toLowerCase().includes(w)));
}

function proposal(db, ctx, type, summary, payload) {
  const id = db.id();
  db.run("INSERT INTO assistant_actions (id, org_id, user_id, type, summary, payload_json, status, created_at) VALUES (?,?,?,?,?,?, 'proposed', ?)", id, ctx.orgId, ctx.userId, type, summary, JSON.stringify(payload), db.nowIso());
  return { id, type, summary, payload, status: "proposed" };
}

// Each tool: description + JSON schema (for AI models) + run(db, ctx, input, today).
const TOOLS = {
  overdue_tenants: {
    description: "Tenants with overdue (unpaid past due date) bills, with amounts and the oldest due date.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const rows = [];
      for (const t of db.all("SELECT t.id, t.name, r.label, b.name AS building FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id WHERE t.org_id = ? AND t.active = 1 ORDER BY t.name", ctx.orgId)) {
        const overdue = ledger.listCharges(db, ctx.orgId, { tenantId: t.id, status: "open" }, today).filter((c) => c.due_date && c.due_date < today);
        if (!overdue.length) continue;
        const oldest = overdue.map((c) => c.due_date).sort()[0];
        rows.push({ tenantId: t.id, name: t.name, property: t.building, room: t.label, overduePaise: overdue.reduce((s, c) => s + c.outstanding_paise, 0), bills: overdue.length, oldestDue: oldest, daysOverdue: Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) });
      }
      rows.sort((a, b) => b.overduePaise - a.overduePaise);
      return {
        summary: rows.length ? `${rows.length} tenant(s) have overdue bills totalling ${inr(rows.reduce((s, r) => s + r.overduePaise, 0))} as of ${today}.` : `No overdue bills as of ${today}.`,
        table: { title: "Overdue tenants", columns: ["Tenant", "Property", "Room", "Overdue", "Bills", "Oldest due", "Days overdue"], rows: rows.map((r) => [r.name, r.property, r.room, inr(r.overduePaise), r.bills, r.oldestDue, r.daysOverdue]) },
        basis: "Bills with a due date before today and an unpaid balance, from the ledger.",
        data: rows.map((r) => ({ ...r, overdue: toRupees(r.overduePaise) })),
      };
    },
  },

  unpaid_this_month: {
    description: "Tenants who have not fully paid this month's rent.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const [y, m] = today.slice(0, 7).split("-").map(Number);
      const rows = ledger.listCharges(db, ctx.orgId, { kind: "rent", year: y, month: m }, today).filter((c) => c.outstanding_paise > 0).map((c) => {
        const t = c.tenant_id ? db.get("SELECT name FROM tenants WHERE id = ?", c.tenant_id) : null;
        const r = db.get("SELECT label FROM rooms WHERE id = ?", c.room_id);
        return [t?.name || "(no tenant)", r?.label || "", inr(c.amount_paise), inr(c.paid_paise), inr(c.outstanding_paise), c.due_date || "", c.status];
      });
      return {
        summary: rows.length ? `${rows.length} rent bill(s) for ${MONTHS[m]} ${y} are not fully paid.` : `All rent bills for ${MONTHS[m]} ${y} are paid (or none exist yet).`,
        table: { title: `Unpaid rent – ${MONTHS[m]} ${y}`, columns: ["Tenant", "Room", "Rent", "Paid", "Due", "Due date", "Status"], rows },
        basis: `Rent bills for the period ${MONTHS[m]} ${y} with an unpaid balance.`,
      };
    },
  },

  collection_summary: {
    description: "Rent billed, collected and outstanding for a month (default: current month). month is YYYY-MM.",
    schema: { type: "object", properties: { month: { type: "string", description: "YYYY-MM" } }, additionalProperties: false },
    run(db, ctx, input, today) {
      const month = /^\d{4}-\d{2}$/.test(input?.month || "") ? input.month : today.slice(0, 7);
      const s = finance.summary(db, ctx.orgId, { from: month, to: month }, today);
      const t = s.totals;
      const [y, m] = month.split("-").map(Number);
      return {
        summary: `${MONTHS[m]} ${y}: billed ${inr(t.billedPaise)}, collected ${inr(t.collectedOnBillsPaise)}${t.collectionRate !== null ? ` (${t.collectionRate}%)` : ""}; payments received in the month ${inr(t.receivedPaise)}; expenses ${inr(t.expensesPaise)}.`,
        table: { title: `Collection – ${MONTHS[m]} ${y}`, columns: ["Property", "Billed", "Received", "Expenses", "Outstanding now"], rows: s.byProperty.map((p) => [p.name, inr(p.billedPaise), inr(p.receivedPaise), inr(p.expensesPaise), inr(p.outstandingPaise)]) },
        basis: s.basis,
      };
    },
  },

  lease_expiries: {
    description: "Active leases ending within a number of days (default 60).",
    schema: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365 } }, additionalProperties: false },
    run(db, ctx, input, today) {
      const days = Math.min(Math.max(Number(input?.days) || 60, 1), 365);
      const rows = db.all(`SELECT l.end_date, l.rent_paise, t.name, r.label, b.name AS building FROM leases l JOIN tenants t ON t.id = l.tenant_id JOIN rooms r ON r.id = l.room_id JOIN buildings b ON b.id = r.building_id
                           WHERE l.org_id = ? AND l.status = 'active' AND l.end_date <> '' ORDER BY l.end_date`, ctx.orgId)
        .map((l) => ({ ...l, left: Math.round((Date.parse(l.end_date) - Date.parse(today)) / 86_400_000) })).filter((l) => l.left <= days);
      return {
        summary: rows.length ? `${rows.length} lease(s) end within ${days} days.` : `No active leases end within ${days} days.`,
        table: { title: `Leases ending within ${days} days`, columns: ["Tenant", "Property", "Room", "Ends", "Days left", "Rent"], rows: rows.map((l) => [l.name, l.building, l.label, l.end_date, l.left, inr(l.rent_paise)]) },
        basis: "Active leases with an end date, from the Leases records.",
      };
    },
  },

  outstanding_by_property: {
    description: "Outstanding (unpaid) amounts per property, as of today.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const s = finance.summary(db, ctx.orgId, {}, today);
      return {
        summary: `Total outstanding: ${inr(s.totals.outstandingPaise)} (overdue: ${inr(s.totals.overduePaise)}).`,
        table: { title: "Outstanding by property", columns: ["Property", "Outstanding"], rows: s.byProperty.map((p) => [p.name, inr(p.outstandingPaise)]) },
        basis: "All open bills as of today, grouped by property.",
      };
    },
  },

  expense_summary: {
    description: "Expenses by category and property for a month (YYYY-MM, default current month).",
    schema: { type: "object", properties: { month: { type: "string" } }, additionalProperties: false },
    run(db, ctx, input, today) {
      const month = /^\d{4}-\d{2}$/.test(input?.month || "") ? input.month : today.slice(0, 7);
      const rows = db.all(`SELECT e.category, b.name AS building, SUM(e.amount_paise) AS total, COUNT(*) AS n FROM expenses e JOIN buildings b ON b.id = e.building_id
                           WHERE e.org_id = ? AND e.voided_at IS NULL AND substr(e.spent_on, 1, 7) = ? GROUP BY e.category, b.name ORDER BY total DESC`, ctx.orgId, month);
      const total = rows.reduce((s, r) => s + r.total, 0);
      const [y, m] = month.split("-").map(Number);
      return {
        summary: rows.length ? `${MONTHS[m]} ${y} expenses: ${inr(total)} across ${rows.reduce((s, r) => s + r.n, 0)} entries.` : `No expenses recorded for ${MONTHS[m]} ${y}.`,
        table: { title: `Expenses – ${MONTHS[m]} ${y}`, columns: ["Category", "Property", "Entries", "Total"], rows: rows.map((r) => [r.category.replace("_", " "), r.building, r.n, inr(r.total)]) },
        basis: "Expenses dated in the month (voided entries excluded).",
      };
    },
  },

  maintenance_summary: {
    description: "Open maintenance requests by status and priority, oldest first.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx) {
      const open = db.all(`SELECT m.*, b.name AS building, r.label FROM maintenance_requests m JOIN buildings b ON b.id = m.building_id LEFT JOIN rooms r ON r.id = m.room_id
                           WHERE m.org_id = ? AND m.status NOT IN ('resolved','closed') ORDER BY m.created_at`, ctx.orgId);
      const urgent = open.filter((m) => ["urgent", "high"].includes(m.priority)).length;
      return {
        summary: open.length ? `${open.length} open maintenance request(s), ${urgent} high/urgent. Oldest opened ${open[0].created_at.slice(0, 10)}.` : "No open maintenance requests.",
        table: { title: "Open maintenance", columns: ["Title", "Property", "Room", "Priority", "Status", "Opened"], rows: open.map((m) => [m.title, m.building, m.label || "", m.priority, m.status.replace("_", " "), m.created_at.slice(0, 10)]) },
        basis: "Maintenance requests not resolved or closed.",
      };
    },
  },

  tenant_balance: {
    description: "One tenant's balance and open bills, by (part of) their name.",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run(db, ctx, input, today) {
      const matches = findTenants(db, ctx.orgId, input?.name);
      if (!matches.length) return { summary: `No tenant found matching "${input?.name || ""}".`, basis: "Tenant records." };
      if (matches.length > 1 && !matches.some((m) => m.name.toLowerCase() === String(input.name).toLowerCase())) {
        return { summary: `Several tenants match "${input.name}": ${matches.slice(0, 5).map((m) => m.name).join(", ")}. Which one?`, basis: "Tenant records." };
      }
      const t = matches.find((m) => m.name.toLowerCase() === String(input.name).toLowerCase()) || matches[0];
      const bal = ledger.tenantBalance(db, ctx.orgId, t.id, today);
      const open = ledger.listCharges(db, ctx.orgId, { tenantId: t.id, status: "open" }, today);
      return {
        summary: `${t.name} (${t.building_name} ${t.room_label}): outstanding ${inr(bal.outstandingPaise)}, overdue ${inr(bal.overduePaise)}${bal.creditPaise ? `, credit ${inr(bal.creditPaise)}` : ""}.`,
        table: { title: `Open bills – ${t.name}`, columns: ["Bill", "Due date", "Amount", "Paid", "Outstanding", "Status"], rows: open.map((c) => [ledger.chargeLabel(c), c.due_date, inr(c.amount_paise), inr(c.paid_paise), inr(c.outstanding_paise), c.status]) },
        basis: "The tenant's charges and payments in the ledger.",
        links: [{ label: "Statement", href: `/api/ledger/tenants/${t.id}/statement?format=html` }],
      };
    },
  },

  cashflow_insights: {
    description: "Cash-flow facts and a labelled forecast for next month.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const c = insights.cashflow(db, ctx.orgId, today);
      return {
        summary: `Facts: outstanding ${inr(c.facts.outstandingPaise)} (overdue ${inr(c.facts.overduePaise)}). Forecast for ${c.forecast.month} (an estimate): expected rent ${inr(c.forecast.expectedRentPaise)}, likely collection ${inr(c.forecast.projectedCollectionPaise)}, net after typical expenses ${inr(c.forecast.projectedNetPaise)}${c.forecast.possibleShortfall ? " – possible shortfall" : ""}.`,
        basis: `Assumptions: ${c.forecast.assumptions.join(" ")}`,
      };
    },
  },

  anomalies: {
    description: "Review alerts: possible duplicate payments, unusual adjustments or rent changes, unmatched or unapplied money, repeated failed payments.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const a = insights.anomalies(db, ctx.orgId, today);
      return {
        summary: a.alerts.length ? `${a.alerts.length} item(s) worth reviewing. ${a.note}` : "Nothing unusual found.",
        table: { title: "Review alerts", columns: ["Alert", "Details"], rows: a.alerts.map((x) => [x.title, x.detail]) },
        basis: "Rule-based checks over payments, adjustments, bank imports and online payment attempts.",
      };
    },
  },

  reconciliation_suggestions: {
    description: "Unmatched bank credits with the most likely tenant for each.",
    schema: { type: "object", properties: {}, additionalProperties: false },
    run(db, ctx, input, today) {
      const txns = db.all("SELECT * FROM bank_transactions WHERE org_id = ? AND status = 'unmatched' ORDER BY txn_date DESC LIMIT 20", ctx.orgId);
      const rows = txns.map((t) => { const s = recon.suggestMatches(db, ctx.orgId, t, today)[0]; return [t.txn_date, inr(t.amount_paise), t.payer || t.description.slice(0, 40), s ? `${s.tenantName} (${s.confidence})` : "No likely match"]; });
      return {
        summary: txns.length ? `${txns.length} unmatched bank credit(s). Confirm matches in Finance → Reconciliation.` : "No unmatched bank credits.",
        table: { title: "Unmatched bank credits", columns: ["Date", "Amount", "From", "Suggested tenant"], rows },
        basis: "Imported bank statement lines scored on name, amount, mobile number and due dates. Confirming is always done by you.",
      };
    },
  },

  // ---------- prepare actions (proposals; nothing changes until approved) ----------
  draft_overdue_reminders: {
    description: "Prepare reminder messages for tenants with overdue bills (optionally only some tenants by name). Creates a proposal for the owner to review, edit and approve; nothing is sent by this tool.",
    schema: { type: "object", properties: { tenantNames: { type: "array", items: { type: "string" } } }, additionalProperties: false },
    prepare: true,
    run(db, ctx, input, today) {
      let tenantIds = null;
      if (Array.isArray(input?.tenantNames) && input.tenantNames.length) tenantIds = input.tenantNames.flatMap((n) => findTenants(db, ctx.orgId, n).map((t) => t.id));
      const items = reminders.preview(db, ctx.orgId, today, { kinds: ["overdue"], tenantIds, force: true }).filter((p) => p.reachable);
      const unreachable = reminders.preview(db, ctx.orgId, today, { kinds: ["overdue"], tenantIds, force: true }).filter((p) => !p.reachable);
      if (!items.length) return { summary: unreachable.length ? `Overdue tenants found, but none can be reached (they need an app login or consent for email/SMS/WhatsApp): ${unreachable.map((u) => u.tenantName).join(", ")}.` : "No overdue tenants to remind.", basis: "Overdue bills from the ledger." };
      const messages = items.flatMap((p) => p.channels.map((channel) => ({ tenantId: p.tenantId, tenantName: p.tenantName, channel, language: p.language, subject: p.subject, body: p.body, amount: p.amount })));
      const action = proposal(db, ctx, "send_reminders", `Send ${messages.length} overdue reminder message(s) to ${items.length} tenant(s)`, { messages });
      return {
        summary: `I've drafted ${messages.length} reminder message(s) for ${items.length} tenant(s). Review and edit them below, then approve to send.${unreachable.length ? ` Not reachable: ${unreachable.map((u) => u.tenantName).join(", ")}.` : ""}`,
        table: { title: "Draft reminders", columns: ["Tenant", "Channel", "Amount", "Message"], rows: messages.map((m) => [m.tenantName, m.channel, `₹${m.amount.toLocaleString("en-IN")}`, m.body]) },
        basis: "Overdue bills from the ledger; message text from your reminder templates.",
        action,
      };
    },
  },

  prepare_maintenance_task: {
    description: "Prepare a maintenance task for a property (and optionally a room). Creates a proposal to approve.",
    schema: { type: "object", properties: { property: { type: "string" }, room: { type: "string" }, title: { type: "string" }, description: { type: "string" }, priority: { type: "string", enum: ["low", "normal", "high", "urgent"] } }, required: ["property", "title"], additionalProperties: false },
    prepare: true,
    run(db, ctx, input) {
      const b = db.all("SELECT id, name FROM buildings WHERE org_id = ? AND status = 'active'", ctx.orgId).find((x) => x.name.toLowerCase().includes(String(input?.property || "").toLowerCase()));
      if (!b) return { summary: `I couldn't find a property matching "${input?.property || ""}".`, basis: "Property records." };
      const room = input?.room ? db.get("SELECT id, label FROM rooms WHERE building_id = ? AND lower(label) = lower(?)", b.id, input.room) : null;
      const payload = { buildingId: b.id, buildingName: b.name, roomId: room?.id || null, roomLabel: room?.label || "", title: String(input.title).slice(0, 120), description: String(input.description || "").slice(0, 2000), priority: ["low", "normal", "high", "urgent"].includes(input.priority) ? input.priority : "normal" };
      const action = proposal(db, ctx, "create_maintenance", `Create maintenance task "${payload.title}" at ${b.name}${room ? ` ${room.label}` : ""}`, payload);
      return { summary: `Prepared a maintenance task for ${b.name}${room ? ` ${room.label}` : ""}. Approve it to create it.`, basis: "Property records.", action };
    },
  },

  prepare_expense: {
    description: "Prepare an expense entry (property, category, amount in rupees, date YYYY-MM-DD, vendor, description). Creates a proposal to approve.",
    schema: { type: "object", properties: { property: { type: "string" }, category: { type: "string", enum: ["maintenance", "repairs", "utilities", "property_tax", "insurance", "management_fee", "other"] }, amount: { type: "number" }, date: { type: "string" }, vendor: { type: "string" }, description: { type: "string" } }, required: ["property", "category", "amount"], additionalProperties: false },
    prepare: true,
    run(db, ctx, input, today) {
      const b = db.all("SELECT id, name FROM buildings WHERE org_id = ?", ctx.orgId).find((x) => x.name.toLowerCase().includes(String(input?.property || "").toLowerCase()));
      if (!b) return { summary: `I couldn't find a property matching "${input?.property || ""}".`, basis: "Property records." };
      const amount = Number(input.amount);
      if (!Number.isFinite(amount) || amount <= 0) return { summary: "The amount must be more than zero.", basis: "" };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(input.date || "") ? input.date : today;
      const payload = { buildingId: b.id, buildingName: b.name, category: input.category, amountPaise: toPaise(amount), spentOn: date, vendor: String(input.vendor || "").slice(0, 120), description: String(input.description || "").slice(0, 500) };
      const action = proposal(db, ctx, "create_expense", `Record ${input.category.replace("_", " ")} expense of ${inr(payload.amountPaise)} for ${b.name} on ${date}`, payload);
      return { summary: `Prepared an expense of ${inr(payload.amountPaise)} for ${b.name}. Approve it to record it.`, basis: "Property records.", action };
    },
  },

  prepare_statement: {
    description: "Get a printable statement for a tenant by name (read-only).",
    schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
    run(db, ctx, input, today) {
      const r = TOOLS.tenant_balance.run(db, ctx, input, today);
      return { ...r, summary: r.links ? `${r.summary} Open the statement to print or save it as PDF.` : r.summary };
    },
  },

  monthly_summary: {
    description: "A short financial summary of a month (YYYY-MM, default last month): billed, collected, expenses, net, overdue, maintenance.",
    schema: { type: "object", properties: { month: { type: "string" } }, additionalProperties: false },
    run(db, ctx, input, today) {
      const month = /^\d{4}-\d{2}$/.test(input?.month || "") ? input.month : finance.addMonths(today.slice(0, 7), -1);
      const s = finance.summary(db, ctx.orgId, { from: month, to: month }, today).totals;
      const m = TOOLS.maintenance_summary.run(db, ctx, {}, today);
      const [y, mm] = month.split("-").map(Number);
      return {
        summary: `${MONTHS[mm]} ${y}: billed ${inr(s.billedPaise)}, collected ${inr(s.collectedOnBillsPaise)}${s.collectionRate !== null ? ` (${s.collectionRate}%)` : ""}, received ${inr(s.receivedPaise)}, expenses ${inr(s.expensesPaise)}, net cash flow ${inr(s.netCashFlowPaise)}. Outstanding today: ${inr(s.outstandingPaise)} (overdue ${inr(s.overduePaise)}). ${m.summary}`,
        basis: "Ledger bills and payments, and expenses, for the month; outstanding as of today.",
      };
    },
  },
};

module.exports = { TOOLS, findTenants };
