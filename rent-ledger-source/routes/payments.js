// Tenant payments by UPI Intent. The tenant picks bills (or "Pay all"); the
// server works out the amount from the ledger and the recipient from the
// owner's saved UPI ID, then hands back a upi://pay link (and a QR code for
// desktops). The tenant's own UPI app does the rest.
//
// No payment gateway is involved and nothing is verified automatically in this
// phase. A started payment is stored as 'pending' in payment_orders and never
// creates a ledger payment, so bills only turn "paid" once the owner records
// the money they actually received (as they already do for cash or UPI).
const { toRupees } = require("../lib/money");
const ledger = require("../services/ledger");
const upi = require("../services/upi");
const { notifyStaff } = require("../services/notify");
const { audit } = require("../services/audit");
const { tenantOnly, ctxOf } = require("./common");

const LABELS = { rent: "Rent", electricity: "Electricity", gas: "Gas", maintenance: "Maintenance", late_fee: "Late fee", damage: "Damage", other: "Other" };
const MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// Why a tenant closed a UPI request without paying.
const CANCEL_REASONS = {
  cancelled: "Cancelled by tenant",
  not_completed: "Not completed in UPI app",
  app_error: "UPI app showed an error",
  no_app: "No UPI app opened",
};
// Most banks cap a person-to-person UPI payment at ₹1,00,000.
const UPI_TYPICAL_LIMIT_PAISE = 100_000_00;
// An identical, unreported request made within this window is reused instead
// of creating a second record.
const REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

// Tenants see the Pay buttons once their owner has a UPI ID saved.
function paymentsEnabled(db, orgId) {
  return Boolean(upi.payeeFor(db, orgId));
}

function itemsKey(items) {
  return items.map((i) => `${i.entryId}:${i.amountPaise}`).sort().join("|");
}

function noteFor(items, roomLabel, reference) {
  const kinds = [...new Set(items.map((i) => LABELS[i.kind] || i.kind))];
  const periods = [...new Set(items.filter((i) => i.month && i.year).map((i) => `${MONTHS[i.month]} ${i.year}`))];
  const what = kinds.length > 2 ? "Bills" : kinds.join(", ");
  const when = periods.length === 1 ? ` ${periods[0]}` : "";
  const room = roomLabel ? ` Room ${roomLabel}` : "";
  // The reference goes last and is never cut off, so the owner can match it.
  const head = upi.cleanText(`${what}${when}${room}`, upi.NOTE_MAX - reference.length - 1);
  return head ? `${head} ${reference}` : reference;
}

function orderView(o, extra = {}) {
  const items = JSON.parse(o.items_json);
  return {
    id: o.id, provider: o.provider, status: o.status, reference: o.upi_reference || "",
    amount: toRupees(o.amount_paise), createdAt: o.created_at, reportedAt: o.tenant_reported_at || null,
    payee: o.provider === "upi" ? { upiId: o.payee_vpa, name: o.payee_name } : null,
    items: items.map((i) => ({ kind: i.kind, id: i.entryId, month: i.month, year: i.year, amount: toRupees(i.amountPaise) })),
    ...extra,
  };
}

// The link and QR for a stored initiation, rebuilt from stored server values.
function linkFor(o) {
  const items = JSON.parse(o.items_json);
  const room = o.room_label || "";
  const note = noteFor(items, room, o.upi_reference);
  const uri = upi.buildUri({ vpa: o.payee_vpa, name: o.payee_name, amountPaise: o.amount_paise, note });
  return { uri, qrSvg: upi.qrSvg(uri), note };
}

function register(app, { db, todayFor, log }) {
  // Diagnostic log line for a UPI request: what went into the link, never the
  // full UPI ID, tenant details, or anything about the tenant's bank account.
  const logUpi = (message, o, extra = {}) => log?.info(message, { paymentRef: o.upi_reference, orderId: o.id, orgId: o.org_id, ...extra });

  // tenant → room → building → organisation (the owner who bills them).
  function tenancyOf(req) {
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.user.tenant_id, req.orgId);
    if (!tenant) return null;
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", tenant.room_id, tenant.org_id);
    const building = room && db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", room.building_id, tenant.org_id);
    if (!room || !building) return null;
    return { tenant, room, building, orgId: building.org_id };
  }

  function ownOrder(req) {
    const o = db.get("SELECT o.*, r.label AS room_label FROM payment_orders o LEFT JOIN rooms r ON r.id = o.room_id WHERE o.id = ? AND o.org_id = ? AND o.provider = 'upi'", String(req.params.id || ""), req.orgId);
    return o && o.tenant_id === req.user.tenant_id ? o : null;
  }

  // Start a UPI payment. Body: { all: true } or { items: [{ id }] }. Any amount
  // or UPI ID in the body is ignored.
  app.post("/api/tenant/payments/upi", tenantOnly, (req, res, next) => {
    try {
      const t = tenancyOf(req);
      if (!t) return res.status(404).json({ error: "No active tenancy found" });
      const payee = upi.payeeFor(db, t.orgId);
      if (!payee) return res.status(409).json({ code: "no_upi_id", error: "Your owner hasn't added a UPI ID yet, so you can't pay by UPI here. Please pay them directly and add a payment proof." });
      const today = todayFor(req);
      const open = ledger.listCharges(db, t.orgId, { tenantId: t.tenant.id, status: "open" }, today).filter((c) => c.room_id === t.tenant.room_id && c.outstanding_paise > 0);
      let chosen;
      if (req.body?.all) chosen = open;
      else {
        const requested = Array.isArray(req.body?.items) ? req.body.items.slice(0, 100) : [];
        chosen = [];
        for (const r of requested) {
          const c = open.find((x) => x.id === r?.id) || null;
          if (!c) {
            const exists = ledger.getCharge(db, t.orgId, String(r?.id || ""), today);
            if (!exists || exists.tenant_id !== t.tenant.id) return res.status(404).json({ error: "This bill is not available for your tenancy." });
            continue; // already paid
          }
          if (!chosen.includes(c)) chosen.push(c);
        }
      }
      const items = chosen.map((c) => ({ kind: c.kind, entryId: c.id, month: c.period_month, year: c.period_year, amountPaise: c.outstanding_paise }));
      if (!items.length) return res.status(400).json({ error: "There is nothing pending to pay." });
      const amountPaise = items.reduce((s, i) => s + i.amountPaise, 0);
      if (!Number.isInteger(amountPaise) || amountPaise < 100) return res.status(400).json({ error: "UPI payments must be at least ₹1." });

      const key = itemsKey(items);
      const result = db.tx(() => {
        const pending = db.all("SELECT * FROM payment_orders WHERE tenant_id = ? AND org_id = ? AND provider = 'upi' AND status = 'pending' AND tenant_reported_at IS NULL ORDER BY created_at DESC", t.tenant.id, t.orgId);
        const since = new Date(Date.now() - REUSE_WINDOW_MS).toISOString();
        const same = pending.find((o) => o.created_at >= since && o.amount_paise === amountPaise && o.payee_vpa === payee.vpa && o.payee_name === payee.name && itemsKey(JSON.parse(o.items_json)) === key);
        if (same) return { order: same, reused: true };
        // Older unfinished requests for this tenant are replaced, so the owner
        // never sees several open requests for the same bills.
        const id = db.id();
        const reference = upi.newReference();
        for (const o of pending) db.run("UPDATE payment_orders SET status = 'cancelled', failure_reason = ? WHERE id = ? AND status = 'pending'", `Replaced by ${reference}`, o.id);
        db.run(`INSERT INTO payment_orders (id, org_id, tenant_id, room_id, provider, upi_reference, payee_vpa, payee_name, amount_paise, currency, items_json, status, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, t.orgId, t.tenant.id, t.tenant.room_id, "upi", reference, payee.vpa, payee.name, amountPaise, "INR", JSON.stringify(items), "pending", db.nowIso());
        return { order: db.get("SELECT * FROM payment_orders WHERE id = ?", id), reused: false };
      });
      const order = { ...result.order, room_label: t.room.label };
      const link = linkFor(order);
      logUpi(result.reused ? "upi intent reused" : "upi intent created", order, { ...upi.describeUri(link.uri), amountPaise, billCount: items.length, payeeSource: payee.source });
      res.status(result.reused ? 200 : 201).json(orderView(order, {
        ...link, reused: result.reused,
        verified: false,
        warning: amountPaise > UPI_TYPICAL_LIMIT_PAISE ? "Many banks allow at most ₹1,00,000 per UPI payment. If your app refuses, pay one bill at a time." : "",
      }));
    } catch (err) { next(err); }
  });

  // The tenant says they finished paying in their UPI app. This is only a
  // note for the owner: the status stays 'pending' and no bill is marked paid.
  app.post("/api/tenant/payments/upi/:id/reported", tenantOnly, (req, res) => {
    const o = ownOrder(req);
    if (!o) return res.status(404).json({ error: "Payment not found." });
    if (o.status !== "pending") return res.status(409).json({ error: o.status === "cancelled" ? "This payment request was cancelled. Start a new one if you still need to pay." : "This payment is already settled." });
    if (!o.tenant_reported_at) {
      db.run("UPDATE payment_orders SET tenant_reported_at = ? WHERE id = ? AND tenant_reported_at IS NULL", db.nowIso(), o.id);
      const tenant = db.get("SELECT name FROM tenants WHERE id = ?", o.tenant_id);
      logUpi("upi intent reported paid by tenant", o, { amountPaise: o.amount_paise });
      notifyStaff(db, o.org_id, {
        kind: "payment_review", title: "Tenant says they paid by UPI",
        body: `${tenant?.name || "A tenant"} says they paid ₹${toRupees(o.amount_paise).toLocaleString("en-IN")} to ${o.payee_vpa} (reference ${o.upi_reference}). Check your UPI or bank app, then record the payment. It is not marked as paid automatically.`,
        link: "finance",
      });
      audit(db, ctxOf(req), "payments.upi_reported", "payment_order", o.id, { reference: o.upi_reference, amountPaise: o.amount_paise });
    }
    res.json(orderView(db.get("SELECT * FROM payment_orders WHERE id = ?", o.id), { verified: false }));
  });

  // The tenant didn't pay (closed the app, cancelled, no UPI app…).
  // The tenant's UPI app refused the payment (e.g. Google Pay "bank limit",
  // Paytm "risk policy"). Recorded once and logged; the request stays pending
  // so the tenant can still pay the same amount by QR code or UPI ID and then
  // tap "I've paid". Nothing is retried and nothing is marked paid.
  app.post("/api/tenant/payments/upi/:id/declined", tenantOnly, (req, res) => {
    const o = ownOrder(req);
    if (!o) return res.status(404).json({ error: "Payment not found." });
    if (o.status !== "pending") return res.status(409).json({ error: "This payment request is no longer open. Tap Pay to start a new one." });
    if (o.failure_reason !== CANCEL_REASONS.app_error) {
      db.run("UPDATE payment_orders SET failure_reason = ? WHERE id = ? AND status = 'pending'", CANCEL_REASONS.app_error, o.id);
      log?.warn?.("upi intent declined by app", { paymentRef: o.upi_reference, orderId: o.id, orgId: o.org_id, amountPaise: o.amount_paise, payee: upi.maskVpa(o.payee_vpa) });
    }
    res.json(orderView(db.get("SELECT * FROM payment_orders WHERE id = ?", o.id), { verified: false }));
  });

  app.post("/api/tenant/payments/upi/:id/cancel", tenantOnly, (req, res) => {
    const o = ownOrder(req);
    if (!o) return res.status(404).json({ error: "Payment not found." });
    if (o.status === "cancelled") return res.json(orderView(o));
    if (o.status !== "pending") return res.status(409).json({ error: "This payment can't be cancelled." });
    if (o.tenant_reported_at) return res.status(409).json({ error: "You already told your owner this was paid. Ask them if anything is wrong." });
    // Only known reasons are stored and logged (no free text from the browser).
    const reason = CANCEL_REASONS[req.body?.reason] ? req.body.reason : "cancelled";
    db.run("UPDATE payment_orders SET status = 'cancelled', failure_reason = ? WHERE id = ? AND status = 'pending'", CANCEL_REASONS[reason], o.id);
    // An app error is logged as a warning so it stands out. Nothing is retried:
    // the tenant decides whether to try another app, the QR code, or pay directly.
    (reason === "app_error" ? log?.warn?.bind(log) : log?.info?.bind(log))?.("upi intent cancelled", { paymentRef: o.upi_reference, orderId: o.id, orgId: o.org_id, reason, amountPaise: o.amount_paise, payee: upi.maskVpa(o.payee_vpa) });
    res.json(orderView(db.get("SELECT * FROM payment_orders WHERE id = ?", o.id)));
  });

  // Owner dashboard: UPI payments tenants started (still unverified) and the
  // older Razorpay payments, which stay in the history unchanged.
  app.get("/api/payments", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const rows = db.all(`SELECT o.*, t.name AS tenant_name, r.label AS room_label, p.provider_payment_id FROM payment_orders o
      LEFT JOIN tenants t ON t.id = o.tenant_id LEFT JOIN rooms r ON r.id = o.room_id LEFT JOIN payments p ON p.id = o.payment_id
      WHERE o.org_id = ? AND ((o.provider = 'upi' AND o.status = 'pending') OR (o.provider = 'razorpay' AND o.status = 'paid'))
      ORDER BY COALESCE(o.paid_at, o.created_at) DESC LIMIT ${limit}`, req.orgId);
    res.json(rows.map((o) => orderView(o, {
      verified: o.provider === "razorpay" && o.status === "paid",
      paidAt: o.paid_at, method: o.method || "", providerPaymentId: o.provider_payment_id || "",
      tenantName: o.tenant_name || "Former tenant", roomLabel: o.room_label || "",
    })));
  });
}

// Recent UPI requests for the tenant portal (pending ones only).
function tenantPendingUpi(db, orgId, tenantId) {
  return db.all("SELECT * FROM payment_orders WHERE org_id = ? AND tenant_id = ? AND provider = 'upi' AND status = 'pending' ORDER BY created_at DESC LIMIT 5", orgId, tenantId)
    .map((o) => orderView(o, { verified: false }));
}

module.exports = { register, paymentsEnabled, tenantPendingUpi };
