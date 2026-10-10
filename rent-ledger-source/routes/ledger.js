// The ledger API used by the Finance screens: all charges, all payments,
// recording payments (cash/UPI/bank/cheque), adjustments, voids, reversals,
// tenant statements and printable receipts.
const v = require("../lib/validate");
const { toPaise, toRupees, formatInr } = require("../lib/money");
const ledger = require("../services/ledger");
const accounts = require("../services/accounts");
const { genericChargeView, chargeExtras, paymentView, VIEW_BY_KIND } = require("../services/views");
const { notify } = require("../services/notify");
const { requirePermission, ownerOnly, ctxOf, notFound, sendCsv, escapeHtml, printablePage } = require("./common");

const MONTHS = ledger.MONTHS;

function register(app, { db, todayFor }) {
  const today = (req) => todayFor(req);

  function names(p) {
    const t = p.tenant_id ? db.get("SELECT name FROM tenants WHERE id = ?", p.tenant_id) : null;
    const r = p.room_id ? db.get("SELECT label FROM rooms WHERE id = ?", p.room_id) : null;
    return { tenantName: t?.name || "", roomLabel: r?.label || "" };
  }
  function chargeOut(c, extras) {
    const view = (VIEW_BY_KIND[c.kind] || genericChargeView)(c, extras.get(c.id) || {});
    const t = c.tenant_id ? db.get("SELECT name FROM tenants WHERE id = ?", c.tenant_id) : null;
    const r = db.get("SELECT r.label, b.name AS building FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", c.room_id);
    return { ...view, amount: toRupees(c.amount_paise), label: ledger.chargeLabel(c), tenantName: t?.name || "", roomLabel: r?.label || "", buildingName: r?.building || "", description: c.description, voided: Boolean(c.voided_at) };
  }

  // ---------- charges ----------
  app.get("/api/ledger/charges", requirePermission("reports.view"), (req, res) => {
    const q = req.query;
    const filters = {
      tenantId: q.tenantId, roomId: q.roomId, buildingId: q.buildingId, kind: q.kind, status: q.status,
      periodFrom: q.from ? Number(String(q.from).replace("-", "")) : undefined, periodTo: q.to ? Number(String(q.to).replace("-", "")) : undefined,
      includeVoided: q.includeVoided === "1",
    };
    const charges = ledger.listCharges(db, req.orgId, filters, today(req)).slice(0, 1000);
    const extras = chargeExtras(db, charges.map((c) => c.id));
    res.json(charges.map((c) => chargeOut(c, extras)));
  });

  app.get("/api/ledger/charges/:id", requirePermission("reports.view"), (req, res) => {
    const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
    if (!c) return notFound(res, "Charge");
    const adjustments = db.all("SELECT a.*, u.name AS by_name FROM charge_adjustments a LEFT JOIN users u ON u.id = a.created_by WHERE a.charge_id = ? ORDER BY a.created_at", c.id);
    const allocations = db.all(`SELECT al.*, p.method, p.received_on, p.verification, p.reference FROM allocations al JOIN payments p ON p.id = al.payment_id WHERE al.charge_id = ? ORDER BY al.created_at`, c.id);
    const proofs = db.all("SELECT id, original_name, review_status, created_at FROM documents WHERE entity_type = 'charge' AND entity_id = ? AND kind = 'payment_proof' ORDER BY created_at", c.id);
    res.json({
      ...chargeOut(c, chargeExtras(db, [c.id])),
      adjustments: adjustments.map((a) => ({ id: a.id, amount: toRupees(a.amount_paise), kind: a.kind, reason: a.reason, by: a.by_name || "", at: a.created_at })),
      allocations: allocations.map((a) => ({ paymentId: a.payment_id, amount: toRupees(a.amount_paise), method: a.method, receivedOn: a.received_on, verification: a.verification, reference: a.reference, note: a.note, at: a.created_at })),
      proofs: proofs.map((d) => ({ id: d.id, name: d.original_name, reviewStatus: d.review_status, uploadedAt: d.created_at })),
      voidReason: c.void_reason || "",
    });
  });

  // Any other charge: maintenance recharge, late fee, damage, other.
  app.post("/api/ledger/charges", requirePermission("bills.manage"), (req, res) => {
    const kind = req.body?.kind;
    if (!["rent", "maintenance", "late_fee", "damage", "other"].includes(kind)) return res.status(400).json({ error: "Choose a charge type." });
    const amount = v.number({ label: "Amount", min: 0.01, max: 100_000_000, required: true })(req.body?.amount);
    const period = req.body?.month ? { month: v.month()(req.body.month), year: v.year()(req.body.year) } : null;
    const id = ledger.createCharge(db, ctxOf(req), {
      roomId: req.body?.roomId, tenantId: req.body?.tenantId || null, kind, periodYear: period?.year ?? null, periodMonth: period?.month ?? null,
      dueDate: v.date({ label: "Due date" })(req.body?.dueDate), description: v.text({ label: "Description", max: 200 })(req.body?.description),
      amountPaise: toPaise(amount), notes: v.text({ label: "Notes", max: 1000 })(req.body?.notes),
    });
    const c = ledger.getCharge(db, req.orgId, id, today(req));
    if (c.tenant_id) {
      const user = db.get("SELECT id FROM users WHERE tenant_id = ?", c.tenant_id);
      if (user) notify(db, { orgId: req.orgId, userId: user.id, kind: "charge", title: "New bill", body: `${ledger.chargeLabel(c)}: ${formatInr(c.amount_paise)}${c.due_date ? `, due ${c.due_date}` : ""}`, link: "tenant:home" });
    }
    res.status(201).json(chargeOut(c, chargeExtras(db, [id])));
  });

  // Corrections, discounts and late fees can be recorded by managers;
  // waivers and write-offs (giving up money) are owner-only.
  app.post("/api/ledger/charges/:id/adjust", requirePermission("bills.manage"), (req, res) => {
    const kind = req.body?.kind || "correction";
    if (!["correction", "waiver", "discount", "late_fee", "write_off"].includes(kind)) return res.status(400).json({ error: "Choose an adjustment type." });
    if (["waiver", "write_off"].includes(kind) && req.user.role !== "owner") return res.status(403).json({ error: "Only the owner can waive or write off money." });
    const amount = v.number({ label: "Amount", min: -100_000_000, max: 100_000_000, required: true })(req.body?.amount);
    let delta = toPaise(amount);
    if (["waiver", "discount", "write_off"].includes(kind)) delta = -Math.abs(delta);
    if (kind === "late_fee") delta = Math.abs(delta);
    const c = ledger.adjustCharge(db, ctxOf(req), req.params.id, { amountPaise: delta, kind, reason: v.text({ label: "Reason", max: 500, required: true })(req.body?.reason) }, today(req));
    res.json(chargeOut(c, chargeExtras(db, [c.id])));
  });

  app.post("/api/ledger/charges/:id/void", ownerOnly, (req, res) => {
    const c = ledger.voidCharge(db, ctxOf(req), req.params.id, v.text({ label: "Reason", max: 300, required: true })(req.body?.reason), today(req));
    res.json({ ok: true, id: c.id, status: c.status });
  });

  // ---------- payments ----------
  app.get("/api/ledger/payments", requirePermission("reports.view"), (req, res) => {
    const q = req.query;
    const rows = ledger.listPayments(db, req.orgId, { tenantId: q.tenantId, roomId: q.roomId, buildingId: q.buildingId, method: q.method, from: q.from, to: q.to, limit: q.limit });
    if (q.format === "csv") {
      return sendCsv(res, `payments-${today(req)}.csv`, ["Received on", "Tenant", "Room", "Amount (INR)", "Method", "Reference", "Verification", "Reversed", "Unallocated (INR)"],
        rows.map((p) => { const n = names(p); return [p.received_on, n.tenantName, n.roomLabel, toRupees(p.amount_paise), p.method, p.reference, p.verification, p.reversed ? `yes: ${p.reversal_reason}` : "", toRupees(p.unallocated_paise)]; }));
    }
    res.json(rows.map((p) => paymentView(p, names(p))));
  });

  app.get("/api/ledger/payments/:id", requirePermission("reports.view"), (req, res) => {
    const p = ledger.getPayment(db, req.orgId, req.params.id);
    if (!p) return notFound(res, "Payment");
    const allocations = db.all("SELECT al.*, c.kind, c.period_month, c.period_year, c.description FROM allocations al JOIN charges c ON c.id = al.charge_id WHERE al.payment_id = ? ORDER BY al.created_at", p.id);
    res.json({ ...paymentView(p, names(p)), allocations: allocations.map((a) => ({ chargeId: a.charge_id, amount: toRupees(a.amount_paise), label: ledger.chargeLabel(a), note: a.note, at: a.created_at })) });
  });

  // Record money the owner received (cash, UPI to the owner's account,
  // bank transfer, cheque). "recorded" = entered by staff without external proof.
  app.post("/api/ledger/payments", requirePermission("payments.record"), (req, res) => {
    const b = req.body || {};
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", b.tenantId || "", req.orgId);
    if (!tenant) return notFound(res, "Tenant");
    const amount = v.number({ label: "Amount", min: 0.01, max: 100_000_000, required: true })(b.amount);
    const method = ["cash", "upi", "bank_transfer", "cheque", "other"].includes(b.method) ? b.method : null;
    if (!method) return res.status(400).json({ error: "Choose how the money was paid." });
    let allocations = "auto";
    if (Array.isArray(b.allocations)) allocations = b.allocations.map((a) => ({ chargeId: String(a.chargeId), amountPaise: toPaise(v.number({ label: "Allocation", min: 0.01, max: 100_000_000, required: true })(a.amount)) }));
    else if (b.allocate === false) allocations = [];
    const result = ledger.recordPayment(db, ctxOf(req), {
      tenantId: tenant.id, roomId: tenant.room_id, amountPaise: toPaise(amount), method, reference: v.text({ label: "Reference", max: 120 })(b.reference),
      receivedOn: v.date({ label: "Received on" })(b.receivedOn) || today(req), verification: "recorded", source: "manual",
      idempotencyKey: b.idempotencyKey ? `manual:${req.orgId}:${String(b.idempotencyKey).slice(0, 80)}` : null, notes: v.text({ label: "Notes", max: 500 })(b.notes), allocations,
    }, today(req));
    const p = ledger.getPayment(db, req.orgId, result.paymentId);
    const user = db.get("SELECT id FROM users WHERE tenant_id = ?", tenant.id);
    if (user && !result.duplicate) notify(db, { orgId: req.orgId, userId: user.id, kind: "payment", title: "Payment recorded", body: `Your payment of ${formatInr(p.amount_paise)} on ${p.received_on} was recorded.`, link: "tenant:home" });
    res.status(result.duplicate ? 200 : 201).json({ ...paymentView(p, names(p)), duplicate: result.duplicate, applied: (result.applied || []).map((a) => ({ ...a, amount: toRupees(a.amountPaise) })) });
  });

  app.post("/api/ledger/payments/:id/allocate", requirePermission("payments.record"), (req, res) => {
    const items = Array.isArray(req.body?.allocations) ? req.body.allocations.map((a) => ({ chargeId: String(a.chargeId), amountPaise: toPaise(a.amount) })) : null;
    const results = db.tx(() => (items ? ledger.allocate(db, ctxOf(req), req.params.id, items, today(req)) : ledger.autoAllocate(db, ctxOf(req), req.params.id, today(req))));
    const p = ledger.getPayment(db, req.orgId, req.params.id);
    res.json({ ...paymentView(p, names(p)), applied: results.map((a) => ({ ...a, amount: toRupees(a.amountPaise) })) });
  });

  // Reversals are owner-only. Verified (online/bank) payments need the owner
  // to confirm the money was refunded.
  app.post("/api/ledger/payments/:id/reverse", ownerOnly, (req, res) => {
    const reason = v.text({ label: "Reason", max: 500, required: true })(req.body?.reason);
    const p = ledger.reversePayment(db, ctxOf(req), req.params.id, reason, { allowVerified: req.body?.refundConfirmed === true });
    res.json(paymentView(p, names(p)));
  });

  // Printable receipt (owner/manager, or the tenant it belongs to).
  app.get("/api/ledger/payments/:id/receipt", (req, res) => {
    const p = ledger.getPayment(db, req.orgId, req.params.id);
    if (!p || (req.user.role === "tenant" && p.tenant_id !== req.user.tenant_id)) return notFound(res, "Receipt");
    const org = accounts.getOrg(db, req.orgId);
    const tenant = p.tenant_id ? db.get("SELECT name FROM tenants WHERE id = ?", p.tenant_id) : null;
    const room = p.room_id ? db.get("SELECT r.label, b.name, b.address FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", p.room_id) : null;
    const allocations = db.all("SELECT al.amount_paise, c.kind, c.period_month, c.period_year, c.description FROM allocations al JOIN charges c ON c.id = al.charge_id WHERE al.payment_id = ? AND al.amount_paise > 0", p.id);
    const rows = allocations.map((a) => `<tr><td>${escapeHtml(ledger.chargeLabel(a))}</td><td class="num">${formatInr(a.amount_paise)}</td></tr>`).join("") || `<tr><td>Payment on account (credit)</td><td class="num">${formatInr(p.amount_paise)}</td></tr>`;
    const credit = p.unallocated_paise > 0 && allocations.length ? `<tr><td>Kept as credit for future bills</td><td class="num">${formatInr(p.unallocated_paise)}</td></tr>` : "";
    const methodLabel = { cash: "Cash", upi: "UPI", bank_transfer: "Bank transfer", cheque: "Cheque", razorpay: "Online (Razorpay)", deposit_adjustment: "Adjusted from deposit", other: "Other" }[p.method] || p.method;
    res.type("html").send(printablePage(`Receipt ${p.id.slice(0, 8).toUpperCase()}`, `
      <h1>Payment receipt</h1>
      <p class="muted">${escapeHtml(org.name)}${room ? ` · ${escapeHtml(room.name)}${room.address ? `, ${escapeHtml(room.address)}` : ""}` : ""}</p>
      ${p.reversed ? `<p><span class="badge">REVERSED</span> ${escapeHtml(p.reversal_reason)}</p>` : ""}
      <table><tbody>
        <tr><th>Receipt no.</th><td>${p.id.slice(0, 8).toUpperCase()}</td></tr>
        <tr><th>Received from</th><td>${escapeHtml(tenant?.name || "")}${room ? ` (${escapeHtml(room.label)})` : ""}</td></tr>
        <tr><th>Date</th><td>${escapeHtml(p.received_on)}</td></tr>
        <tr><th>Paid by</th><td>${escapeHtml(methodLabel)}${p.reference ? ` · ref ${escapeHtml(p.reference)}` : ""}</td></tr>
        <tr><th>Status</th><td>${p.verification === "verified" ? "Verified (confirmed by payment provider or bank)" : "Recorded by the owner"}</td></tr>
      </tbody></table>
      <h2>For</h2>
      <table><thead><tr><th>Bill</th><th class="num">Amount</th></tr></thead><tbody>${rows}${credit}<tr class="total"><td>Total received</td><td class="num">${formatInr(p.amount_paise)}</td></tr></tbody></table>
      ${org.settings.receipts.footer ? `<p class="muted">${escapeHtml(org.settings.receipts.footer)}</p>` : ""}
      <p class="muted">Generated by Rent Ledger on ${escapeHtml(today(req))}.</p>`));
  });

  // ---------- tenant statements ----------
  app.get("/api/ledger/tenants/:id/statement", requirePermission("reports.view"), (req, res) => {
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!tenant) return notFound(res, "Tenant");
    const st = ledger.tenantStatement(db, req.orgId, tenant.id, today(req));
    const room = db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", tenant.room_id);
    if (req.query.format === "csv") {
      return sendCsv(res, `statement-${tenant.name}-${today(req)}.csv`, ["Date", "Type", "Details", "Charged (INR)", "Paid / credit (INR)", "Balance (INR)"],
        st.entries.map((e) => [e.date, e.type, e.description, e.amountPaise > 0 ? toRupees(e.amountPaise) : "", e.amountPaise < 0 ? toRupees(-e.amountPaise) : "", toRupees(e.balancePaise)]));
    }
    if (req.query.format === "html") {
      const rows = st.entries.map((e) => `<tr><td>${escapeHtml(e.date)}</td><td>${escapeHtml(e.description)}</td><td class="num">${e.amountPaise > 0 ? formatInr(e.amountPaise) : ""}</td><td class="num">${e.amountPaise < 0 ? formatInr(-e.amountPaise) : ""}</td><td class="num">${formatInr(e.balancePaise)}</td></tr>`).join("");
      return res.type("html").send(printablePage(`Statement – ${tenant.name}`, `<h1>Statement of account</h1><p class="muted">${escapeHtml(tenant.name)} · ${escapeHtml(room?.name || "")} ${escapeHtml(room?.label || "")} · as of ${escapeHtml(today(req))}</p>
        <table><thead><tr><th>Date</th><th>Details</th><th class="num">Charged</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead><tbody>${rows}</tbody></table>
        <p>Outstanding: <strong>${formatInr(st.balance.outstandingPaise)}</strong> · Overdue: ${formatInr(st.balance.overduePaise)}${st.balance.creditPaise ? ` · Credit: ${formatInr(st.balance.creditPaise)}` : ""}</p>`));
    }
    res.json({
      tenant: { id: tenant.id, name: tenant.name, roomLabel: room?.label || "", buildingName: room?.name || "" },
      entries: st.entries.map((e) => ({ ...e, amount: toRupees(e.amountPaise), balance: toRupees(e.balancePaise) })),
      balance: Object.fromEntries(Object.entries(st.balance).map(([k, val]) => [k.replace(/Paise$/, ""), toRupees(val)])),
    });
  });

  app.get("/api/ledger/balances", requirePermission("reports.view"), (req, res) => {
    const tenants = db.all("SELECT t.*, r.label AS room_label, b.name AS building_name FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id WHERE t.org_id = ? ORDER BY t.active DESC, t.name", req.orgId);
    res.json(tenants.map((t) => {
      const bal = ledger.tenantBalance(db, req.orgId, t.id, today(req));
      return { tenantId: t.id, name: t.name, active: Boolean(t.active), roomLabel: t.room_label, buildingName: t.building_name, outstanding: toRupees(bal.outstandingPaise), overdue: toRupees(bal.overduePaise), credit: toRupees(bal.creditPaise) };
    }).filter((x) => x.active || x.outstanding || x.credit));
  });

  void MONTHS;
}

module.exports = { register };
