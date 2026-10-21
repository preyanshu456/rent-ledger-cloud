// Dues engine: charge packages, shared-room bill splits, late fees, discounts
// that expire, using the deposit or advance for dues, and WhatsApp links.
//
// All money still moves through services/ledger.js (charges, adjustments,
// payments, allocations), so the ledger stays the one source of truth.
const ledger = require("./ledger");
const { getOrg } = require("./accounts");
const { toPaise, toRupees, formatInr } = require("../lib/money");
const { audit } = require("./audit");
const upi = require("./upi");

class DuesError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; this.expose = true; }
}

const SYSTEM = (orgId, requestId) => ({ orgId, userId: null, role: "system", requestId });
const pad = (n) => String(n).padStart(2, "0");
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const periodDueDate = (year, month, day) => `${year}-${pad(month)}-${pad(Math.min(day, 28))}`;

// ---------- packages ----------

function packageView(p) {
  return {
    id: p.id, buildingId: p.building_id || null, name: p.name, category: p.category, billingMode: p.billing_mode,
    rate: toRupees(p.rate_paise), unitLabel: p.unit_label || "", minBill: toRupees(p.min_bill_paise), autoMonthly: Boolean(p.auto_monthly),
    dueDay: p.due_day, description: p.description || "", active: Boolean(p.active), createdAt: p.created_at,
  };
}

// The amount for `units` of a per-unit package (never below the minimum bill).
function packageAmountPaise(pkg, units) {
  if (pkg.billing_mode === "fixed") return pkg.rate_paise;
  const used = Math.round(Number(units) * pkg.rate_paise);
  return Math.max(used, pkg.min_bill_paise);
}

function activeTenantsInRoom(db, roomId) {
  return db.all("SELECT * FROM tenants WHERE room_id = ? AND active = 1 ORDER BY move_in_date, created_at", roomId);
}

// Split `total` paise into `n` parts that add up exactly (the first parts
// carry the odd paise).
function splitEvenly(total, n) {
  const base = Math.floor(total / n);
  let extra = total - base * n;
  return Array.from({ length: n }, () => base + (extra-- > 0 ? 1 : 0));
}

// Bill a package. Either to chosen tenants (each pays the full amount), or to
// a room, where the room's amount is split equally between its tenants or
// charged to each of them.
function billPackage(db, ctx, pkg, { tenantIds = [], roomId = null, units = 0, split = "each", year, month, dueDate, note = "" }, today) {
  if (!pkg.active) throw new DuesError("This package is switched off.");
  if (pkg.billing_mode === "per_unit" && !(Number(units) > 0) && !pkg.min_bill_paise) throw new DuesError(`Enter how many ${pkg.unit_label || "units"} were used.`);
  const kind = pkg.category === "maintenance" ? "maintenance" : "other";
  const amount = packageAmountPaise(pkg, units);
  const details = { packageId: pkg.id, billingMode: pkg.billing_mode, units: Number(units) || 0, rate: toRupees(pkg.rate_paise), unitLabel: pkg.unit_label || "" };
  const describe = pkg.billing_mode === "per_unit" ? `${pkg.name} (${Number(units) || 0} ${pkg.unit_label || "units"} × ₹${toRupees(pkg.rate_paise)})` : pkg.name;
  const created = [];
  return db.tx(() => {
    let targets;
    if (roomId) {
      const tenants = activeTenantsInRoom(db, roomId);
      if (!tenants.length) throw new DuesError("Nobody lives in this room right now.");
      const parts = split === "equal" ? splitEvenly(amount, tenants.length) : tenants.map(() => amount);
      targets = tenants.map((t, i) => ({ tenant: t, amount: parts[i], description: split === "equal" && tenants.length > 1 ? `${describe}, shared by ${tenants.length}` : describe }));
    } else {
      if (!tenantIds.length) throw new DuesError("Choose at least one tenant or a room.");
      targets = tenantIds.map((id) => {
        const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", id, ctx.orgId);
        if (!t) throw new DuesError("One of the tenants was not found or has moved out.", 404);
        return { tenant: t, amount, description: describe };
      });
    }
    if (pkg.building_id) {
      for (const { tenant } of targets) {
        if (!db.get("SELECT 1 FROM rooms WHERE id = ? AND building_id = ?", tenant.room_id, pkg.building_id)) throw new DuesError("This package belongs to another property.");
      }
    }
    for (const t of targets) {
      if (t.amount <= 0) continue;
      const id = ledger.createCharge(db, ctx, {
        roomId: t.tenant.room_id, tenantId: t.tenant.id, kind, periodYear: year || null, periodMonth: month || null,
        dueDate: dueDate || today, description: t.description, amountPaise: t.amount, details: { ...details, shares: targets.length, split }, source: "package", notes: note,
      });
      created.push(id);
    }
    return created;
  });
}

// Split one bill (an electricity bill for a shared room, say) between the
// room's active tenants. Equal shares, or shares by days stayed this period.
function splitRoomBill(db, ctx, { roomId, kind, amountPaise, description, year, month, dueDate, mode = "equal", periodStart, periodEnd }, today) {
  if (!["electricity", "gas", "maintenance", "other"].includes(kind)) throw new DuesError("Choose a bill type.");
  if (!(amountPaise > 0)) throw new DuesError("Enter the bill amount.");
  const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", roomId, ctx.orgId);
  if (!room) throw new DuesError("Room not found", 404);
  const tenants = activeTenantsInRoom(db, roomId);
  if (!tenants.length) throw new DuesError("Nobody lives in this room right now.");
  let parts;
  if (mode === "days" && periodStart && periodEnd) {
    const days = tenants.map((t) => {
      const from = t.move_in_date && t.move_in_date > periodStart ? t.move_in_date : periodStart;
      return Math.max(dayDiff(periodEnd, from) + 1, 0);
    });
    const totalDays = days.reduce((a, b) => a + b, 0);
    if (!totalDays) throw new DuesError("No tenant stayed in this room during that period.");
    parts = days.map((d) => Math.floor((amountPaise * d) / totalDays));
    let rest = amountPaise - parts.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % parts.length) if (days[i]) { parts[i]++; rest--; }
  } else {
    parts = splitEvenly(amountPaise, tenants.length);
  }
  return db.tx(() => tenants.map((t, i) => parts[i] > 0 ? ledger.createCharge(db, ctx, {
    roomId, tenantId: t.id, kind, periodYear: year || null, periodMonth: month || null, dueDate: dueDate || today,
    description: `${description || "Shared bill"} (share ${i + 1} of ${tenants.length})`, amountPaise: parts[i],
    details: { splitOfPaise: amountPaise, shares: tenants.length, mode }, source: "split",
  }) : null).filter(Boolean));
}

// Fixed packages marked "every month" are added to each active tenant once
// a month (from the month the package was created).
function runMonthlyPackages(db, orgId, today) {
  const [y, m] = today.split("-").map(Number);
  let created = 0;
  for (const pkg of db.all("SELECT * FROM dues_packages WHERE org_id = ? AND active = 1 AND auto_monthly = 1 AND billing_mode = 'fixed'", orgId)) {
    if (pkg.created_at.slice(0, 7) > today.slice(0, 7)) continue;
    const tenants = db.all(`SELECT t.* FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.org_id = ? AND t.active = 1 ${pkg.building_id ? "AND r.building_id = ?" : ""}`, ...(pkg.building_id ? [orgId, pkg.building_id] : [orgId]));
    for (const t of tenants) {
      if (t.move_in_date && t.move_in_date.slice(0, 7) > today.slice(0, 7)) continue;
      if (db.get("SELECT 1 FROM package_runs WHERE package_id = ? AND tenant_id = ? AND period_year = ? AND period_month = ?", pkg.id, t.id, y, m)) continue;
      db.tx(() => {
        const chargeId = ledger.createCharge(db, SYSTEM(orgId, "packages"), {
          roomId: t.room_id, tenantId: t.id, kind: pkg.category === "maintenance" ? "maintenance" : "other", periodYear: y, periodMonth: m,
          dueDate: periodDueDate(y, m, pkg.due_day), description: pkg.name, amountPaise: pkg.rate_paise, details: { packageId: pkg.id, billingMode: "fixed", auto: true }, source: "package",
        });
        db.run("INSERT INTO package_runs (package_id, tenant_id, period_year, period_month, charge_id, created_at) VALUES (?,?,?,?,?,?)", pkg.id, t.id, y, m, chargeId, db.nowIso());
      });
      created++;
    }
  }
  return created;
}

// ---------- late fees ----------

function lateFeeSettings(db, orgId) {
  const s = getOrg(db, orgId)?.settings?.lateFees || {};
  return {
    enabled: Boolean(s.enabled), graceDays: Math.max(0, Math.min(60, Number(s.graceDays) || 0)),
    mode: s.mode === "daily" ? "daily" : "flat", amountPaise: Math.max(0, toPaise(s.amount)), maxPaise: Math.max(0, toPaise(s.maxAmount)),
    kinds: (Array.isArray(s.kinds) && s.kinds.length ? s.kinds : ["rent"]).filter((k) => ["rent", "electricity", "gas", "maintenance", "other"].includes(k)),
  };
}

// Adds (or grows) late fees on overdue bills. Safe to run every hour: each
// overdue bill gets one fee charge, and a daily fee only grows for days not
// yet charged.
function applyLateFees(db, orgId, today) {
  const s = lateFeeSettings(db, orgId);
  if (!s.enabled || !s.amountPaise) return { created: 0, increased: 0 };
  const ctx = SYSTEM(orgId, "late-fees");
  let created = 0, increased = 0;
  for (const c of ledger.listCharges(db, orgId, { status: "open", kinds: s.kinds }, today)) {
    if (!c.due_date || !c.tenant_id) continue;
    const daysLate = dayDiff(today, c.due_date) - s.graceDays;
    if (daysLate < 1) continue;
    const existing = db.get("SELECT * FROM late_fees WHERE charge_id = ?", c.id);
    const label = ledger.chargeLabel(c);
    if (!existing) {
      let amount = s.mode === "daily" ? s.amountPaise * daysLate : s.amountPaise;
      if (s.maxPaise) amount = Math.min(amount, s.maxPaise);
      db.tx(() => {
        const feeId = ledger.createCharge(db, ctx, {
          roomId: c.room_id, tenantId: c.tenant_id, kind: "late_fee", periodYear: c.period_year, periodMonth: c.period_month, dueDate: today,
          description: `Late fee for ${label}`, amountPaise: amount, details: { forChargeId: c.id, mode: s.mode, graceDays: s.graceDays }, source: "late_fee",
        });
        db.run("INSERT INTO late_fees (charge_id, org_id, fee_charge_id, mode, days_charged, last_applied_on, created_at) VALUES (?,?,?,?,?,?,?)",
          c.id, orgId, feeId, s.mode, s.mode === "daily" ? daysLate : 1, today, db.nowIso());
      });
      created++;
    } else if (existing.mode === "daily" && daysLate > existing.days_charged) {
      const fee = ledger.getCharge(db, orgId, existing.fee_charge_id, today);
      if (!fee || fee.voided_at) continue;
      let add = s.amountPaise * (daysLate - existing.days_charged);
      if (s.maxPaise) add = Math.min(add, Math.max(s.maxPaise - fee.amount_paise, 0));
      db.tx(() => {
        if (add > 0) ledger.adjustCharge(db, ctx, fee.id, { amountPaise: add, kind: "late_fee", reason: `Daily late fee, ${daysLate} days late` }, today);
        db.run("UPDATE late_fees SET days_charged = ?, last_applied_on = ? WHERE charge_id = ?", daysLate, today, c.id);
      });
      if (add > 0) increased++;
    }
  }
  return { created, increased };
}

// ---------- discounts ----------

function offerView(o) {
  return { id: o.id, chargeId: o.charge_id, amount: toRupees(o.amount_paise), validUntil: o.valid_until, reason: o.reason, status: o.status, createdAt: o.created_at, closedAt: o.closed_at || null };
}

// A discount now. With `validUntil`, it is taken back if the bill is still
// unpaid after that date.
function giveDiscount(db, ctx, chargeId, { amountPaise, validUntil, reason }, today) {
  const c = ledger.getCharge(db, ctx.orgId, chargeId, today);
  if (!c) throw new DuesError("Bill not found", 404);
  if (c.voided_at) throw new DuesError("This bill was deleted.");
  if (!(amountPaise > 0)) throw new DuesError("Enter the discount amount.");
  if (amountPaise > c.outstanding_paise) throw new DuesError(`The discount can't be more than the ${formatInr(c.outstanding_paise)} still due.`);
  if (validUntil && validUntil < today) throw new DuesError("The last date can't be in the past.");
  const why = String(reason || "").trim() || (validUntil ? `Discount if paid by ${validUntil}` : "Discount");
  return db.tx(() => {
    ledger.adjustCharge(db, ctx, c.id, { amountPaise: -amountPaise, kind: "discount", reason: why }, today);
    if (!validUntil) return null;
    const id = db.id();
    db.run("INSERT INTO discount_offers (id, org_id, charge_id, amount_paise, valid_until, reason, status, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, ctx.orgId, c.id, amountPaise, validUntil, why.slice(0, 300), "active", ctx.userId || null, db.nowIso());
    audit(db, ctx, "discount.offered", "charge", c.id, { amountPaise, validUntil });
    return offerView(db.get("SELECT * FROM discount_offers WHERE id = ?", id));
  });
}

function cancelDiscount(db, ctx, offerId, today) {
  const o = db.get("SELECT * FROM discount_offers WHERE id = ? AND org_id = ?", offerId, ctx.orgId);
  if (!o) throw new DuesError("Discount not found", 404);
  if (o.status !== "active") throw new DuesError("This discount is already closed.");
  return db.tx(() => {
    ledger.adjustCharge(db, ctx, o.charge_id, { amountPaise: o.amount_paise, kind: "correction", reason: "Discount withdrawn" }, today);
    db.run("UPDATE discount_offers SET status = 'cancelled', closed_at = ? WHERE id = ?", db.nowIso(), o.id);
    audit(db, ctx, "discount.cancelled", "charge", o.charge_id, { amountPaise: o.amount_paise });
    return offerView(db.get("SELECT * FROM discount_offers WHERE id = ?", o.id));
  });
}

// Closes discounts: paid in full → used; past the date and still unpaid →
// the discount is added back to the bill.
function settleDiscounts(db, orgId, today) {
  const ctx = SYSTEM(orgId, "discounts");
  let used = 0, expired = 0;
  for (const o of db.all("SELECT * FROM discount_offers WHERE org_id = ? AND status = 'active'", orgId)) {
    const c = ledger.getCharge(db, orgId, o.charge_id, today);
    if (!c || c.voided_at) { db.run("UPDATE discount_offers SET status = 'cancelled', closed_at = ? WHERE id = ?", db.nowIso(), o.id); continue; }
    if (c.outstanding_paise === 0) { db.run("UPDATE discount_offers SET status = 'used', closed_at = ? WHERE id = ?", db.nowIso(), o.id); used++; continue; }
    if (o.valid_until < today) {
      db.tx(() => {
        ledger.adjustCharge(db, ctx, c.id, { amountPaise: o.amount_paise, kind: "correction", reason: `Discount expired: not paid by ${o.valid_until}` }, today);
        db.run("UPDATE discount_offers SET status = 'expired', closed_at = ? WHERE id = ?", db.nowIso(), o.id);
      });
      expired++;
    }
  }
  return { used, expired };
}

// ---------- deposit and advance ----------

// Uses tenant credit (advance payments not yet applied) for open bills,
// oldest first.
function applyCredit(db, ctx, tenantId, today) {
  const payments = ledger.listPayments(db, ctx.orgId, { tenantId, limit: 1000 }).filter((p) => p.unallocated_paise > 0).reverse();
  let applied = 0;
  db.tx(() => {
    for (const p of payments) for (const r of ledger.autoAllocate(db, ctx, p.id, today)) applied += r.amountPaise;
  });
  return applied;
}

// Pays open bills from the security deposit held for the tenant.
function useDeposit(db, ctx, tenantId, amountPaise, today, { depositHeld }) {
  const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", tenantId, ctx.orgId);
  if (!t) throw new DuesError("Tenant not found", 404);
  const held = depositHeld(db, t.id).heldPaise;
  const due = ledger.tenantBalance(db, ctx.orgId, t.id, today).outstandingPaise;
  if (!held) throw new DuesError("No security deposit is recorded as held for this tenant. Record the deposit received first (Tenancy → Deposit).");
  const amount = Math.min(amountPaise || due, held, due);
  if (amount <= 0) throw new DuesError("There are no unpaid bills to pay from the deposit.");
  return db.tx(() => {
    const r = ledger.recordPayment(db, ctx, { tenantId: t.id, roomId: t.room_id, amountPaise: amount, method: "deposit_adjustment", receivedOn: today, verification: "recorded", source: "manual", notes: "Paid from the security deposit", allocations: "auto" }, today);
    db.run("INSERT INTO deposit_transactions (id, org_id, tenant_id, type, amount_paise, txn_date, method, reference, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      db.id(), ctx.orgId, t.id, "applied_to_dues", amount, today, "deposit_adjustment", r.paymentId, ctx.userId || null, db.nowIso());
    audit(db, ctx, "deposit.applied_to_dues", "tenant", t.id, { amountPaise: amount, paymentId: r.paymentId });
    return { paymentId: r.paymentId, amountPaise: amount, depositLeftPaise: held - amount };
  });
}

// ---------- WhatsApp links (free: opens WhatsApp with the text filled in) ----------

function waNumber(mobile) {
  let digits = String(mobile || "").replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : "";
}
function waLink(mobile, text) {
  const n = waNumber(mobile);
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(text)}` : `https://wa.me/?text=${encodeURIComponent(text)}`;
}

function payLine(db, orgId) {
  const payee = upi.payeeFor(db, orgId);
  return payee ? `\nPay by UPI to ${payee.vpa} (${payee.name}).` : "";
}

const HI = (lang) => lang === "hi";

function reminderText(db, orgId, tenant, balance, { language = "en" } = {}) {
  const org = getOrg(db, orgId);
  const room = db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", tenant.room_id) || {};
  const owed = formatInr(balance.netDuePaise);
  if (HI(language)) {
    return `नमस्ते ${tenant.name},\n${room.name || ""} ${room.label || ""} का बकाया ${owed} है${balance.overduePaise ? ` (${formatInr(balance.overduePaise)} की तारीख निकल चुकी है)` : ""}। कृपया जल्दी भुगतान करें।${payLine(db, orgId)}\n— ${org.name}`;
  }
  return `Hello ${tenant.name},\nYour balance for ${room.name || ""} ${room.label || ""} is ${owed}${balance.overduePaise ? ` (${formatInr(balance.overduePaise)} is past its due date)` : ""}. Please pay at the earliest.${payLine(db, orgId)}\n— ${org.name}`;
}

// Tenants who owe money, each with a ready WhatsApp link.
function whatsappReminders(db, orgId, today, { buildingId, language } = {}) {
  const rows = db.all(`SELECT t.*, r.label AS room_label, b.name AS building_name, b.id AS building_id FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id
                       WHERE t.org_id = ? AND t.active = 1 ${buildingId ? "AND b.id = ?" : ""} ORDER BY b.name, r.floor_number, r.label, t.name`, ...(buildingId ? [orgId, buildingId] : [orgId]));
  const out = [];
  for (const t of rows) {
    const bal = ledger.tenantBalance(db, orgId, t.id, today);
    if (bal.netDuePaise <= 0) continue;
    const lang = language || (db.get("SELECT language FROM users WHERE tenant_id = ?", t.id)?.language) || "en";
    out.push({
      tenantId: t.id, name: t.name, mobile: t.mobile || "", buildingName: t.building_name, roomLabel: t.room_label,
      due: toRupees(bal.netDuePaise), overdue: toRupees(bal.overduePaise), hasNumber: Boolean(waNumber(t.mobile)),
      link: waLink(t.mobile, reminderText(db, orgId, t, bal, { language: lang })),
    });
  }
  return out;
}

function receiptText(db, orgId, payment, today) {
  const org = getOrg(db, orgId);
  const t = payment.tenant_id ? db.get("SELECT * FROM tenants WHERE id = ?", payment.tenant_id) : null;
  const bal = t ? ledger.tenantBalance(db, orgId, t.id, today) : null;
  const left = bal ? (bal.netDuePaise > 0 ? `Balance still due: ${formatInr(bal.netDuePaise)}.` : bal.creditPaise > 0 ? `Nothing due. Advance with us: ${formatInr(bal.creditPaise)}.` : "Nothing is due now.") : "";
  return `Payment received${t ? ` from ${t.name}` : ""}: ${formatInr(payment.amount_paise)} on ${payment.received_on} (receipt ${payment.id.slice(0, 8).toUpperCase()}).\n${left}\nThank you.\n— ${org.name}`;
}

module.exports = {
  DuesError, packageView, packageAmountPaise, billPackage, splitRoomBill, splitEvenly, runMonthlyPackages,
  lateFeeSettings, applyLateFees, giveDiscount, cancelDiscount, settleDiscounts, offerView,
  applyCredit, useDeposit, whatsappReminders, waLink, waNumber, receiptText, reminderText,
};
