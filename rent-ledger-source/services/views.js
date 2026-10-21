// Shapes database rows into the JSON the web app has always used (rupees,
// camelCase, same field names), plus a few new fields the new screens use.
const { toRupees } = require("../lib/money");
const { listCharges } = require("./ledger");

const json = (text, fallback) => { try { return JSON.parse(text); } catch { return fallback; } };

function buildingView(b) {
  return {
    id: b.id, name: b.name, address: b.address || "", totalFloors: b.total_floors || 0, notes: b.notes || "", createdAt: b.created_at,
    propertyType: b.property_type, amenities: json(b.amenities_json, []), status: b.status,
  };
}

function roomView(r) {
  return {
    id: r.id, buildingId: r.building_id, floorNumber: r.floor_number, label: r.label, electricityOnly: Boolean(r.electricity_only),
    monthlyRent: toRupees(r.monthly_rent_paise), deposit: toRupees(r.deposit_paise), status: r.status, notes: r.notes || "",
    createdAt: r.created_at, gasMeterId: r.gas_meter_id || "", gasAuthorityId: r.gas_authority_id || null,
    paymentFrequency: r.payment_frequency, utilityNotes: r.utility_notes || "", tags: json(r.tags_json, []),
  };
}

function tenantView(db, t, now = Date.now()) {
  const inviteActive = t.invite_code_hash && t.invite_expires_at && Date.parse(t.invite_expires_at) > now && (t.invite_attempts || 0) < 5;
  return {
    id: t.id, roomId: t.room_id, name: t.name, mobile: t.mobile || "", altMobile: t.alt_mobile || "", email: t.email || "",
    idProofType: t.id_proof_type || "", idProofNumber: t.id_proof_number || "", moveInDate: t.move_in_date || "", moveOutDate: t.move_out_date || "",
    active: Boolean(t.active), notes: t.notes || "", createdAt: t.created_at,
    deposit: t.deposit_paise === null || t.deposit_paise === undefined ? null : toRupees(t.deposit_paise),
    notifyEmail: Boolean(t.notify_email), notifySms: Boolean(t.notify_sms), notifyWhatsapp: Boolean(t.notify_whatsapp),
    anonymized: Boolean(t.anonymized_at),
    bedId: t.bed_id || null, bedLabel: t.bed_id ? db.get("SELECT label FROM beds WHERE id = ?", t.bed_id)?.label || "" : "",
    noticeGivenOn: t.notice_given_on || "", leavingOn: t.leaving_on || "",
    login: { hasAccount: Boolean(db.get("SELECT 1 FROM users WHERE tenant_id = ?", t.id)), inviteExpiresAt: inviteActive ? t.invite_expires_at : null },
  };
}

function authorityView(a) {
  return { id: a.id, name: a.name, billUrl: a.bill_url || "", createdAt: a.created_at };
}

// Latest payment-proof upload and online payment for each charge, in bulk.
function chargeExtras(db, chargeIds) {
  const extras = new Map(chargeIds.map((id) => [id, {}]));
  if (!chargeIds.length) return extras;
  const placeholders = chargeIds.map(() => "?").join(",");
  for (const d of db.all(`SELECT * FROM documents WHERE entity_type = 'charge' AND kind = 'payment_proof' AND status = 'active' AND entity_id IN (${placeholders}) ORDER BY created_at`, ...chargeIds)) {
    extras.get(d.entity_id).receipt = { id: d.id, originalName: d.original_name, mimeType: d.mime_type, size: d.size_bytes, uploadedAt: d.created_at, reviewStatus: d.review_status || "unverified" };
  }
  for (const r of db.all(`SELECT al.charge_id, al.amount_paise, p.provider_payment_id, p.provider_order_id, p.created_at FROM allocations al JOIN payments p ON p.id = al.payment_id
                          WHERE p.provider = 'razorpay' AND al.amount_paise > 0 AND al.charge_id IN (${placeholders}) ORDER BY p.created_at`, ...chargeIds)) {
    extras.get(r.charge_id).onlinePayment = { provider: "razorpay", paymentId: r.provider_payment_id, orderId: r.provider_order_id, amount: toRupees(r.amount_paise), paidAt: r.created_at };
  }
  // Every amount received for each bill (newest first), for the instalments view.
  for (const r of db.all(`SELECT al.charge_id, p.id AS payment_id, p.received_on, p.method, p.reference, p.notes, p.created_at, SUM(al.amount_paise) AS net_paise
                          FROM allocations al JOIN payments p ON p.id = al.payment_id
                          WHERE al.charge_id IN (${placeholders}) AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)
                          GROUP BY al.charge_id, p.id HAVING net_paise > 0 ORDER BY p.received_on DESC, p.created_at DESC`, ...chargeIds)) {
    const e = extras.get(r.charge_id);
    (e.receipts ||= []).push({ paymentId: r.payment_id, amount: toRupees(r.net_paise), receivedOn: r.received_on, method: r.method, reference: r.reference || "", notes: r.notes || "" });
  }
  return extras;
}

function baseBill(c, extra) {
  return {
    id: c.id, roomId: c.room_id, tenantId: c.tenant_id || null, month: c.period_month, year: c.period_year,
    dueDate: c.due_date || "", paidDate: c.paid_paise > 0 ? (c.last_paid_on || "") : "",
    status: c.status, notes: c.notes || "", createdAt: c.created_at,
    outstanding: toRupees(c.outstanding_paise), paid: toRupees(c.paid_paise), kind: c.kind, source: c.source, leaseId: c.lease_id || null,
    ...(extra.receipt ? { receipt: extra.receipt } : {}),
    ...(extra.onlinePayment ? { onlinePayment: extra.onlinePayment } : {}),
    receipts: extra.receipts || [],
  };
}

function rentView(c, extra = {}) {
  return { ...baseBill(c, extra), rentAmount: toRupees(c.amount_paise), amountPaid: toRupees(c.paid_paise) };
}
function electricityView(c, extra = {}) {
  const d = c.details || {};
  return {
    ...baseBill(c, extra), paidDate: c.status === "paid" ? (c.last_paid_on || "") : "", prevReading: d.prevReading ?? 0, currReading: d.currReading ?? 0, unitsConsumed: d.unitsConsumed ?? 0,
    ratePerUnit: d.ratePerUnit ?? 0, amount: toRupees(c.amount_paise),
  };
}
function gasView(c, extra = {}) {
  const d = c.details || {};
  return { ...baseBill(c, extra), paidDate: c.status === "paid" ? (c.last_paid_on || "") : "", meterId: d.meterId || "", authorityId: d.authorityId || null, authorityName: d.authorityName || "", amount: toRupees(c.amount_paise) };
}
function genericChargeView(c, extra = {}) {
  return { ...baseBill(c, extra), amount: toRupees(c.amount_paise), description: c.description || "", details: c.details || {} };
}

const VIEW_BY_KIND = { rent: rentView, electricity: electricityView, gas: gasView };

function billsView(db, orgId, filters, today) {
  const charges = listCharges(db, orgId, filters, today);
  const extras = chargeExtras(db, charges.map((c) => c.id));
  return charges.map((c) => (VIEW_BY_KIND[c.kind] || genericChargeView)(c, extras.get(c.id)));
}

function paymentView(p, names = {}) {
  return {
    id: p.id, tenantId: p.tenant_id, roomId: p.room_id, amount: toRupees(p.amount_paise), method: p.method, reference: p.reference,
    receivedOn: p.received_on, verification: p.verification, source: p.source, notes: p.notes, createdAt: p.created_at,
    allocated: toRupees(p.allocated_paise), unallocated: toRupees(p.unallocated_paise), reversed: p.reversed, reversalReason: p.reversal_reason || "",
    reversedAt: p.reversed_at || null, providerPaymentId: p.provider_payment_id || "", evidenceDocumentId: p.evidence_document_id || null,
    tenantName: names.tenantName, roomLabel: names.roomLabel,
  };
}

module.exports = { buildingView, roomView, tenantView, authorityView, rentView, electricityView, gasView, genericChargeView, billsView, chargeExtras, paymentView, VIEW_BY_KIND };
