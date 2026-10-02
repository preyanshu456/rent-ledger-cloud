// The financial ledger. All accounting is deterministic code here; nothing
// else (UI, AI assistant, imports) changes balances except through these
// functions. Rows are append-only: corrections are adjustments, reversals and
// negative allocations, so the full history is always visible.
const { toRupees } = require("../lib/money");
const { audit } = require("./audit");

class LedgerError extends Error {
  constructor(message, status = 409) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const CHARGE_SELECT = `
SELECT c.*,
  c.base_amount_paise + COALESCE((SELECT SUM(a.amount_paise) FROM charge_adjustments a WHERE a.charge_id = c.id), 0) AS amount_paise,
  COALESCE((SELECT SUM(al.amount_paise) FROM allocations al WHERE al.charge_id = c.id), 0) AS paid_paise,
  COALESCE((SELECT SUM(al.amount_paise) FROM allocations al JOIN payments p ON p.id = al.payment_id WHERE al.charge_id = c.id AND p.verification = 'verified'), 0) AS verified_paid_paise,
  (SELECT MAX(p.received_on) FROM allocations al JOIN payments p ON p.id = al.payment_id
     WHERE al.charge_id = c.id AND al.amount_paise > 0 AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)) AS last_paid_on,
  (SELECT COUNT(*) FROM charge_adjustments a WHERE a.charge_id = c.id) AS adjustment_count
FROM charges c`;

const PAYMENT_SELECT = `
SELECT p.*,
  COALESCE((SELECT SUM(al.amount_paise) FROM allocations al WHERE al.payment_id = p.id), 0) AS allocated_paise,
  r.reason AS reversal_reason, r.created_at AS reversed_at
FROM payments p LEFT JOIN payment_reversals r ON r.payment_id = p.id`;

function chargeStatus(c, today) {
  if (c.voided_at) return "void";
  const outstanding = c.amount_paise - c.paid_paise;
  if (c.amount_paise === 0) return c.adjustment_count > 0 ? "waived" : "paid";
  if (outstanding <= 0) return "paid";
  if (c.due_date && today && c.due_date < today) return c.paid_paise > 0 ? "partial" : "overdue";
  return c.paid_paise > 0 ? "partial" : "due";
}

function decorateCharge(c, today) {
  if (!c) return c;
  c.outstanding_paise = Math.max(c.amount_paise - c.paid_paise, 0);
  c.status = chargeStatus(c, today);
  c.details = safeJson(c.details_json, {});
  return c;
}

function decoratePayment(p) {
  if (!p) return p;
  p.reversed = Boolean(p.reversed_at);
  p.unallocated_paise = p.reversed ? 0 : Math.max(p.amount_paise - p.allocated_paise, 0);
  return p;
}

function safeJson(text, fallback) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function getCharge(db, orgId, id, today) {
  return decorateCharge(db.get(`${CHARGE_SELECT} WHERE c.org_id = ? AND c.id = ?`, orgId, id), today);
}

function listCharges(db, orgId, filters = {}, today) {
  const where = ["c.org_id = :orgId"];
  const params = { orgId };
  if (!filters.includeVoided) where.push("c.voided_at IS NULL");
  for (const [key, column] of [["roomId", "room_id"], ["tenantId", "tenant_id"], ["kind", "kind"], ["leaseId", "lease_id"]]) {
    if (filters[key]) { where.push(`c.${column} = :${key}`); params[key] = filters[key]; }
  }
  if (filters.buildingId) { where.push("c.room_id IN (SELECT id FROM rooms WHERE building_id = :buildingId)"); params.buildingId = filters.buildingId; }
  if (filters.kinds) { where.push(`c.kind IN (${filters.kinds.map((_, i) => `:k${i}`).join(",")})`); filters.kinds.forEach((k, i) => { params[`k${i}`] = k; }); }
  if (filters.periodFrom) { where.push("(c.period_year * 100 + c.period_month) >= :periodFrom"); params.periodFrom = filters.periodFrom; }
  if (filters.periodTo) { where.push("(c.period_year * 100 + c.period_month) <= :periodTo"); params.periodTo = filters.periodTo; }
  if (filters.year && filters.month) { where.push("c.period_year = :year AND c.period_month = :month"); params.year = filters.year; params.month = filters.month; }
  const rows = db.all(`${CHARGE_SELECT} WHERE ${where.join(" AND ")} ORDER BY c.period_year DESC, c.period_month DESC, c.created_at DESC`, params);
  let out = rows.map((c) => decorateCharge(c, today));
  if (filters.status === "open") out = out.filter((c) => c.outstanding_paise > 0);
  else if (filters.status) out = out.filter((c) => c.status === filters.status);
  return out;
}

function getPayment(db, orgId, id) {
  return decoratePayment(db.get(`${PAYMENT_SELECT} WHERE p.org_id = ? AND p.id = ?`, orgId, id));
}

function listPayments(db, orgId, filters = {}) {
  const where = ["p.org_id = :orgId"];
  const params = { orgId };
  if (filters.tenantId) { where.push("p.tenant_id = :tenantId"); params.tenantId = filters.tenantId; }
  if (filters.roomId) { where.push("p.room_id = :roomId"); params.roomId = filters.roomId; }
  if (filters.method) { where.push("p.method = :method"); params.method = filters.method; }
  if (filters.from) { where.push("p.received_on >= :from"); params.from = filters.from; }
  if (filters.to) { where.push("p.received_on <= :to"); params.to = filters.to; }
  if (filters.buildingId) { where.push("p.room_id IN (SELECT id FROM rooms WHERE building_id = :buildingId)"); params.buildingId = filters.buildingId; }
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 1000);
  return db.all(`${PAYMENT_SELECT} WHERE ${where.join(" AND ")} ORDER BY p.received_on DESC, p.created_at DESC LIMIT ${limit}`, params).map(decoratePayment);
}

function allocationsForPayment(db, paymentId) {
  return db.all(`SELECT al.charge_id, SUM(al.amount_paise) AS net_paise FROM allocations al WHERE al.payment_id = ? GROUP BY al.charge_id HAVING net_paise <> 0`, paymentId);
}

function contributionsToCharge(db, chargeId) {
  return db.all(`
    SELECT p.*, SUM(al.amount_paise) AS net_paise,
      EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id) AS is_reversed
    FROM allocations al JOIN payments p ON p.id = al.payment_id
    WHERE al.charge_id = ?
    GROUP BY p.id HAVING net_paise > 0
    ORDER BY p.received_on DESC, p.created_at DESC`, chargeId);
}

// ---------- charges ----------

function createCharge(db, ctx, input) {
  const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", input.roomId, ctx.orgId);
  if (!room) throw new LedgerError("Room not found", 404);
  if (room.electricity_only && input.kind === "rent") throw new LedgerError("Owner electricity-only floors cannot have rent entries.", 400);
  if (input.tenantId) {
    const tenant = db.get("SELECT id, room_id FROM tenants WHERE id = ? AND org_id = ?", input.tenantId, ctx.orgId);
    if (!tenant || tenant.room_id !== room.id) throw new LedgerError("That tenant does not belong to this room.", 400);
  }
  const amount = Math.round(input.amountPaise);
  if (!Number.isInteger(amount) || amount < 0) throw new LedgerError("Amount must be zero or more.", 400);
  const id = input.id || db.id();
  db.run(`INSERT INTO charges (id, org_id, room_id, tenant_id, lease_id, kind, period_year, period_month, due_date, description, base_amount_paise, details_json, source, notes, created_by, created_at)
          VALUES (:id, :orgId, :roomId, :tenantId, :leaseId, :kind, :year, :month, :dueDate, :description, :amount, :details, :source, :notes, :createdBy, :createdAt)`, {
    id, orgId: ctx.orgId, roomId: room.id, tenantId: input.tenantId || null, leaseId: input.leaseId || null, kind: input.kind,
    year: input.periodYear ?? null, month: input.periodMonth ?? null, dueDate: input.dueDate || "", description: input.description || "",
    amount, details: JSON.stringify(input.details || {}), source: input.source || "manual", notes: input.notes || "",
    createdBy: ctx.userId || null, createdAt: input.createdAt || db.nowIso(),
  });
  audit(db, ctx, "charge.created", "charge", id, { kind: input.kind, amountPaise: amount, roomId: room.id, tenantId: input.tenantId || null, source: input.source || "manual" });
  return id;
}

// Non-financial fields (period, due date, notes, details other than amount).
function updateChargeInfo(db, ctx, chargeId, fields) {
  const sets = [];
  const params = { id: chargeId, orgId: ctx.orgId, updatedAt: db.nowIso() };
  for (const [key, column] of [["periodYear", "period_year"], ["periodMonth", "period_month"], ["dueDate", "due_date"], ["notes", "notes"], ["description", "description"]]) {
    if (fields[key] !== undefined) { sets.push(`${column} = :${key}`); params[key] = fields[key]; }
  }
  if (fields.details !== undefined) { sets.push("details_json = :details"); params.details = JSON.stringify(fields.details); }
  if (fields.tenantId !== undefined) { sets.push("tenant_id = :tenantId"); params.tenantId = fields.tenantId; }
  if (!sets.length) return;
  db.run(`UPDATE charges SET ${sets.join(", ")}, updated_at = :updatedAt WHERE id = :id AND org_id = :orgId`, params);
  audit(db, ctx, "charge.updated", "charge", chargeId, { fields: Object.keys(fields) });
}

function adjustCharge(db, ctx, chargeId, { amountPaise, kind = "correction", reason }, today) {
  return db.tx(() => {
    const c = getCharge(db, ctx.orgId, chargeId, today);
    if (!c) throw new LedgerError("Charge not found", 404);
    if (c.voided_at) throw new LedgerError("This charge was voided.");
    const delta = Math.round(amountPaise);
    if (!delta) return c;
    if (!reason || !String(reason).trim()) throw new LedgerError("A reason is required for adjustments.", 400);
    const newAmount = c.amount_paise + delta;
    if (newAmount < 0) throw new LedgerError("An adjustment can't make the amount negative.", 400);
    db.run("INSERT INTO charge_adjustments (id, org_id, charge_id, amount_paise, kind, reason, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
      db.id(), ctx.orgId, c.id, delta, kind, String(reason).slice(0, 500), ctx.userId || null, db.nowIso());
    // If the charge is now smaller than what was already paid towards it, the
    // excess goes back to the tenant as credit (the money was still received).
    if (c.paid_paise > newAmount) unallocateFromCharge(db, ctx, c.id, c.paid_paise - newAmount, `Charge reduced: ${reason}`);
    audit(db, ctx, "charge.adjusted", "charge", c.id, { deltaPaise: delta, kind, reason });
    return getCharge(db, ctx.orgId, c.id, today);
  });
}

function setChargeAmount(db, ctx, chargeId, newAmountPaise, reason, today) {
  const c = getCharge(db, ctx.orgId, chargeId, today);
  if (!c) throw new LedgerError("Charge not found", 404);
  const delta = Math.round(newAmountPaise) - c.amount_paise;
  if (!delta) return c;
  return adjustCharge(db, ctx, chargeId, { amountPaise: delta, kind: "correction", reason: reason || "Amount corrected" }, today);
}

// Takes `amount` of allocations off a charge (newest payments first). The
// payments keep their money as unallocated tenant credit.
function unallocateFromCharge(db, ctx, chargeId, amount, note) {
  let remaining = amount;
  for (const p of contributionsToCharge(db, chargeId)) {
    if (remaining <= 0) break;
    const take = Math.min(p.net_paise, remaining);
    db.run("INSERT INTO allocations (id, org_id, payment_id, charge_id, amount_paise, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
      db.id(), ctx.orgId, p.id, chargeId, -take, String(note || "").slice(0, 300), ctx.userId || null, db.nowIso());
    remaining -= take;
  }
}

function voidCharge(db, ctx, chargeId, reason, today) {
  return db.tx(() => {
    const c = getCharge(db, ctx.orgId, chargeId, today);
    if (!c) throw new LedgerError("Charge not found", 404);
    if (c.voided_at) return c;
    if (c.verified_paid_paise > 0) {
      throw new LedgerError(`This bill has a verified payment of ₹${toRupees(c.verified_paid_paise)}. Refund it with the payment provider or bank first; then reverse the payment.`);
    }
    if (c.paid_paise > 0) reducePaid(db, ctx, c, c.paid_paise, `Bill deleted: ${reason || "removed by owner"}`, today);
    db.run("UPDATE charges SET voided_at = ?, voided_by = ?, void_reason = ? WHERE id = ? AND org_id = ?", db.nowIso(), ctx.userId || null, String(reason || "Removed").slice(0, 300), c.id, ctx.orgId);
    audit(db, ctx, "charge.voided", "charge", c.id, { reason: reason || "Removed", amountPaise: c.amount_paise });
    return getCharge(db, ctx.orgId, c.id, today);
  });
}

// ---------- payments ----------

const METHODS = ["cash", "upi", "bank_transfer", "cheque", "razorpay", "deposit_adjustment", "other"];

function recordPayment(db, ctx, input, today) {
  return db.tx(() => {
    if (input.idempotencyKey) {
      const existing = db.get("SELECT id FROM payments WHERE idempotency_key = ?", input.idempotencyKey);
      if (existing) return { paymentId: existing.id, duplicate: true };
    }
    if (input.providerPaymentId) {
      const existing = db.get("SELECT id FROM payments WHERE provider_payment_id = ?", input.providerPaymentId);
      if (existing) return { paymentId: existing.id, duplicate: true };
    }
    const amount = Math.round(input.amountPaise);
    if (!Number.isInteger(amount) || amount <= 0) throw new LedgerError("Payment amount must be more than zero.", 400);
    if (!METHODS.includes(input.method)) throw new LedgerError("Unknown payment method.", 400);
    let tenant = null;
    if (input.tenantId) {
      tenant = db.get("SELECT id, room_id FROM tenants WHERE id = ? AND org_id = ?", input.tenantId, ctx.orgId);
      if (!tenant) throw new LedgerError("Tenant not found", 404);
    }
    const roomId = input.roomId || tenant?.room_id || null;
    if (roomId && !db.get("SELECT 1 FROM rooms WHERE id = ? AND org_id = ?", roomId, ctx.orgId)) throw new LedgerError("Room not found", 404);
    const id = db.id();
    db.run(`INSERT INTO payments (id, org_id, tenant_id, room_id, amount_paise, method, reference, received_on, verification, source, idempotency_key, provider, provider_payment_id, provider_order_id, evidence_document_id, notes, created_by, created_at)
            VALUES (:id, :orgId, :tenantId, :roomId, :amount, :method, :reference, :receivedOn, :verification, :source, :idem, :provider, :providerPaymentId, :providerOrderId, :evidence, :notes, :createdBy, :createdAt)`, {
      id, orgId: ctx.orgId, tenantId: tenant?.id || null, roomId, amount, method: input.method, reference: String(input.reference || "").slice(0, 120),
      receivedOn: input.receivedOn || today, verification: input.verification || "recorded", source: input.source || "manual",
      idem: input.idempotencyKey || null, provider: input.provider || null, providerPaymentId: input.providerPaymentId || null,
      providerOrderId: input.providerOrderId || null, evidence: input.evidenceDocumentId || null, notes: String(input.notes || "").slice(0, 500),
      createdBy: ctx.userId || null, createdAt: input.createdAt || db.nowIso(),
    });
    audit(db, ctx, "payment.recorded", "payment", id, { amountPaise: amount, method: input.method, verification: input.verification || "recorded", source: input.source || "manual", tenantId: tenant?.id || null });
    let applied = [];
    if (Array.isArray(input.allocations)) applied = allocate(db, ctx, id, input.allocations, today);
    else if (input.allocations === "auto") applied = autoAllocate(db, ctx, id, today);
    return { paymentId: id, duplicate: false, applied };
  });
}

// Allocate part of a payment to specific charges. Never more than the charge's
// outstanding amount or the payment's unallocated amount.
function allocate(db, ctx, paymentId, items, today, { strict = true } = {}) {
  const p = getPayment(db, ctx.orgId, paymentId);
  if (!p) throw new LedgerError("Payment not found", 404);
  if (p.reversed) throw new LedgerError("This payment was reversed.");
  let available = p.unallocated_paise;
  const results = [];
  for (const item of items) {
    const c = getCharge(db, ctx.orgId, item.chargeId, today);
    if (!c) { if (strict) throw new LedgerError("Charge not found", 404); results.push({ chargeId: item.chargeId, result: "bill-deleted", amountPaise: 0 }); continue; }
    if (c.voided_at) { if (strict) throw new LedgerError("That bill was deleted."); results.push({ chargeId: c.id, result: "bill-deleted", amountPaise: 0 }); continue; }
    if (p.tenant_id && c.tenant_id && c.tenant_id !== p.tenant_id) throw new LedgerError("That bill belongs to a different tenant.", 400);
    const want = Math.round(item.amountPaise ?? c.outstanding_paise);
    const amount = Math.min(want, c.outstanding_paise, available);
    if (amount <= 0) {
      if (strict && want > 0 && c.outstanding_paise <= 0) throw new LedgerError("That bill is already paid.");
      if (strict && want > 0 && available <= 0) throw new LedgerError("Nothing left on this payment to allocate.");
      results.push({ chargeId: c.id, result: c.outstanding_paise <= 0 ? "already-paid" : "no-funds", amountPaise: 0 });
      continue;
    }
    if (strict && want > c.outstanding_paise) throw new LedgerError(`That is more than the ₹${toRupees(c.outstanding_paise)} still due on this bill.`, 400);
    db.run("INSERT INTO allocations (id, org_id, payment_id, charge_id, amount_paise, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
      db.id(), ctx.orgId, p.id, c.id, amount, String(item.note || "").slice(0, 300), ctx.userId || null, db.nowIso());
    available -= amount;
    results.push({ chargeId: c.id, result: "applied", amountPaise: amount });
  }
  return results;
}

// Oldest open bills first (by due date, then period).
function autoAllocate(db, ctx, paymentId, today) {
  const p = getPayment(db, ctx.orgId, paymentId);
  if (!p?.tenant_id) return [];
  const open = listCharges(db, ctx.orgId, { tenantId: p.tenant_id, status: "open" }, today)
    .sort((a, b) => (a.due_date || "9999").localeCompare(b.due_date || "9999") || (a.period_year * 100 + a.period_month) - (b.period_year * 100 + b.period_month) || a.created_at.localeCompare(b.created_at));
  const items = [];
  let left = p.unallocated_paise;
  for (const c of open) {
    if (left <= 0) break;
    const amount = Math.min(left, c.outstanding_paise);
    items.push({ chargeId: c.id, amountPaise: amount });
    left -= amount;
  }
  return allocate(db, ctx, paymentId, items, today, { strict: false });
}

function reversePayment(db, ctx, paymentId, reason, { allowVerified = false } = {}) {
  return db.tx(() => {
    const p = getPayment(db, ctx.orgId, paymentId);
    if (!p) throw new LedgerError("Payment not found", 404);
    if (p.reversed) return p;
    if (!reason || !String(reason).trim()) throw new LedgerError("A reason is required to reverse a payment.", 400);
    if (p.verification === "verified" && !allowVerified) throw new LedgerError("Verified payments (online or bank-matched) can only be reversed after a refund. Confirm the refund to continue.");
    db.run("INSERT INTO payment_reversals (id, org_id, payment_id, reason, created_by, created_at) VALUES (?,?,?,?,?,?)", db.id(), ctx.orgId, p.id, String(reason).slice(0, 500), ctx.userId || null, db.nowIso());
    for (const a of allocationsForPayment(db, p.id)) {
      if (a.net_paise > 0) db.run("INSERT INTO allocations (id, org_id, payment_id, charge_id, amount_paise, note, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)",
        db.id(), ctx.orgId, p.id, a.charge_id, -a.net_paise, "Payment reversed", ctx.userId || null, db.nowIso());
    }
    audit(db, ctx, "payment.reversed", "payment", p.id, { reason, amountPaise: p.amount_paise, method: p.method });
    return getPayment(db, ctx.orgId, p.id);
  });
}

// Removes `reduction` of *recorded* (owner-entered) money from a charge by
// reversing those payments and re-recording what remains, so the history
// shows exactly what was corrected. Verified money is never touched.
function reducePaid(db, ctx, charge, reduction, reason, today) {
  const contributions = contributionsToCharge(db, charge.id).filter((p) => !p.is_reversed);
  const reducible = contributions.filter((p) => p.verification !== "verified").reduce((s, p) => s + p.net_paise, 0);
  if (reducible < reduction) {
    throw new LedgerError(`₹${toRupees(reduction - reducible)} of this was paid online or matched to a bank statement and can't be removed here. Refund it first, then reverse that payment.`);
  }
  let remaining = reduction;
  for (const p of contributions) {
    if (remaining <= 0) break;
    if (p.verification === "verified") continue;
    const take = Math.min(p.net_paise, remaining);
    const others = allocationsForPayment(db, p.id);
    const unallocatedBefore = p.amount_paise - others.reduce((s, a) => s + a.net_paise, 0);
    reversePayment(db, ctx, p.id, reason);
    const keep = p.amount_paise - take;
    if (keep > 0) {
      const replacement = recordPayment(db, ctx, {
        tenantId: p.tenant_id, roomId: p.room_id, amountPaise: keep, method: p.method, reference: p.reference, receivedOn: p.received_on,
        verification: p.verification, source: p.source === "import" ? "import" : "manual", evidenceDocumentId: p.evidence_document_id,
        notes: `Replaces payment ${p.id.slice(0, 8)} after correction`,
      }, today);
      const items = others
        .map((a) => ({ chargeId: a.charge_id, amountPaise: a.charge_id === charge.id ? a.net_paise - take : a.net_paise }))
        .filter((i) => i.amountPaise > 0);
      allocate(db, ctx, replacement.paymentId, items, today, { strict: false });
      void unallocatedBefore; // stays as credit on the replacement automatically
    }
    remaining -= take;
  }
}

// Legacy "amount paid" field: move what's paid on a charge to `target`.
// Increases record a payment; decreases correct recorded payments.
function setPaidAmount(db, ctx, chargeId, targetPaise, { receivedOn, method = "cash", tenantId, notes } = {}, today) {
  return db.tx(() => {
    const c = getCharge(db, ctx.orgId, chargeId, today);
    if (!c) throw new LedgerError("Charge not found", 404);
    if (c.voided_at) throw new LedgerError("This bill was deleted.");
    const target = Math.max(0, Math.round(targetPaise));
    if (target === c.paid_paise) return c;
    if (target > c.paid_paise) {
      const delta = target - c.paid_paise;
      const toBill = Math.min(delta, c.outstanding_paise);
      recordPayment(db, ctx, {
        tenantId: c.tenant_id || tenantId || null, roomId: c.room_id, amountPaise: delta, method, receivedOn: receivedOn || today,
        verification: "recorded", source: "manual", notes: notes || (delta > toBill ? "Includes advance (kept as credit)" : ""),
        allocations: toBill > 0 ? [{ chargeId: c.id, amountPaise: toBill }] : [],
      }, today);
    } else {
      reducePaid(db, ctx, c, c.paid_paise - target, "Amount paid corrected by owner", today);
    }
    return getCharge(db, ctx.orgId, c.id, today);
  });
}

// ---------- balances & statements ----------

function tenantBalance(db, orgId, tenantId, today) {
  const charges = listCharges(db, orgId, { tenantId }, today);
  const payments = listPayments(db, orgId, { tenantId, limit: 1000 });
  const charged = charges.reduce((s, c) => s + c.amount_paise, 0);
  const outstanding = charges.reduce((s, c) => s + c.outstanding_paise, 0);
  const overdue = charges.filter((c) => c.status === "overdue" || (c.status === "partial" && c.due_date && c.due_date < today)).reduce((s, c) => s + c.outstanding_paise, 0);
  const credit = payments.reduce((s, p) => s + p.unallocated_paise, 0);
  const received = payments.filter((p) => !p.reversed).reduce((s, p) => s + p.amount_paise, 0);
  return { chargedPaise: charged, receivedPaise: received, outstandingPaise: outstanding, overduePaise: overdue, creditPaise: credit, netDuePaise: outstanding - credit };
}

// Chronological statement with a running balance (positive = tenant owes).
function tenantStatement(db, orgId, tenantId, today) {
  const rows = [];
  for (const c of db.all("SELECT * FROM charges WHERE org_id = ? AND tenant_id = ?", orgId, tenantId)) {
    const date = c.due_date || c.created_at.slice(0, 10);
    rows.push({ date, at: c.created_at, type: "charge", ref: c.id, kind: c.kind, description: chargeLabel(c), amountPaise: c.base_amount_paise });
    if (c.voided_at) rows.push({ date: c.voided_at.slice(0, 10), at: c.voided_at, type: "void", ref: c.id, kind: c.kind, description: `Deleted: ${chargeLabel(c)} (${c.void_reason || ""})`, amountPaise: -(c.base_amount_paise + (db.get("SELECT COALESCE(SUM(amount_paise),0) AS s FROM charge_adjustments WHERE charge_id = ?", c.id).s)) });
  }
  for (const a of db.all("SELECT a.*, c.kind, c.period_year, c.period_month, c.description AS cdesc FROM charge_adjustments a JOIN charges c ON c.id = a.charge_id WHERE a.org_id = ? AND c.tenant_id = ?", orgId, tenantId)) {
    rows.push({ date: a.created_at.slice(0, 10), at: a.created_at, type: "adjustment", ref: a.charge_id, kind: a.kind, description: `${labelAdjustment(a.kind)}: ${a.reason}`, amountPaise: a.amount_paise });
  }
  for (const p of db.all(`${PAYMENT_SELECT} WHERE p.org_id = ? AND p.tenant_id = ?`, orgId, tenantId)) {
    rows.push({ date: p.received_on, at: p.created_at, type: "payment", ref: p.id, kind: p.method, description: `Payment (${p.method.replace("_", " ")}${p.reference ? `, ref ${p.reference}` : ""})${p.verification === "verified" ? " · verified" : " · recorded"}`, amountPaise: -p.amount_paise });
    if (p.reversed_at) rows.push({ date: p.reversed_at.slice(0, 10), at: p.reversed_at, type: "reversal", ref: p.id, kind: p.method, description: `Payment reversed: ${p.reversal_reason}`, amountPaise: p.amount_paise });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.at.localeCompare(b.at));
  let balance = 0;
  for (const r of rows) { balance += r.amountPaise; r.balancePaise = balance; }
  return { entries: rows, balance: tenantBalance(db, orgId, tenantId, today) };
}

const KIND_LABELS = { rent: "Rent", electricity: "Electricity", gas: "Gas", maintenance: "Maintenance", late_fee: "Late fee", damage: "Damage", other: "Other charge" };
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function chargeLabel(c) {
  const period = c.period_year && c.period_month ? ` ${MONTHS[c.period_month]} ${c.period_year}` : "";
  return `${KIND_LABELS[c.kind] || c.kind}${period}${c.description ? ` – ${c.description}` : ""}`;
}
function labelAdjustment(kind) {
  return { correction: "Correction", waiver: "Waiver", discount: "Discount", late_fee: "Late fee", write_off: "Write-off" }[kind] || kind;
}

module.exports = {
  LedgerError, METHODS, KIND_LABELS, MONTHS,
  getCharge, listCharges, createCharge, updateChargeInfo, adjustCharge, setChargeAmount, voidCharge,
  getPayment, listPayments, recordPayment, allocate, autoAllocate, reversePayment, setPaidAmount,
  tenantBalance, tenantStatement, chargeLabel, contributionsToCharge, allocationsForPayment,
};
