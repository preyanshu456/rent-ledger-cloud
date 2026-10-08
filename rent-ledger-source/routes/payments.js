// Online payments through Razorpay. The tenant chooses which bills to pay;
// the server works out the amount from the ledger; a payment is recorded only
// after Razorpay confirms it is captured, and only once (browser callback and
// webhook can both arrive).
const crypto = require("crypto");
const { toRupees } = require("../lib/money");
const ledger = require("../services/ledger");
const { safeEqualText } = require("../services/accounts");
const { notify, notifyStaff } = require("../services/notify");
const { audit } = require("../services/audit");
const { tenantOnly } = require("./common");

const RAZORPAY_API = "https://api.razorpay.com/v1";
const LABELS = { rent: "Rent", electricity: "Electricity", gas: "Gas", maintenance: "Maintenance", late_fee: "Late fee", damage: "Damage", other: "Other" };

function razorpayConfigured() {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

async function razorpayRequest(method, pathname, body, fetchImpl = fetch) {
  const authHeader = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString("base64");
  const response = await fetchImpl(`${RAZORPAY_API}${pathname}`, {
    method, headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data?.error?.description || `Razorpay request failed (${response.status})`), { razorpayStatus: response.status });
  return data;
}

// Records a captured Razorpay payment against the order's bills. Idempotent.
function applyOrderPayment(db, order, razorpayPaymentId, method, today) {
  return db.tx(() => {
    const fresh = db.get("SELECT * FROM payment_orders WHERE id = ?", order.id);
    if (!fresh || fresh.status === "paid") return false;
    const items = JSON.parse(fresh.items_json);
    const ctx = { orgId: fresh.org_id, userId: null, role: "system", requestId: `razorpay:${razorpayPaymentId}` };
    const { paymentId, duplicate } = ledger.recordPayment(db, ctx, {
      tenantId: fresh.tenant_id, roomId: fresh.room_id, amountPaise: fresh.amount_paise, method: "razorpay", reference: razorpayPaymentId, receivedOn: today,
      verification: "verified", source: "razorpay", idempotencyKey: `razorpay:${razorpayPaymentId}`, provider: "razorpay",
      providerPaymentId: razorpayPaymentId, providerOrderId: fresh.razorpay_order_id, notes: method ? `Paid by ${method}` : "",
    }, today);
    if (duplicate) { db.run("UPDATE payment_orders SET status = 'paid', payment_id = ?, paid_at = COALESCE(paid_at, ?) WHERE id = ?", paymentId, db.nowIso(), fresh.id); return false; }
    // Bills changed since the order (paid by hand, deleted) keep the money as credit.
    const results = ledger.allocate(db, ctx, paymentId, items.map((i) => ({ chargeId: i.entryId, amountPaise: i.amountPaise })), today, { strict: false });
    for (const item of items) item.result = results.find((r) => r.chargeId === item.entryId)?.result || "applied";
    db.run("UPDATE payment_orders SET status = 'paid', payment_id = ?, method = ?, items_json = ?, paid_at = ? WHERE id = ?", paymentId, method || "", JSON.stringify(items), db.nowIso(), fresh.id);
    const tenantUser = db.get("SELECT id FROM users WHERE tenant_id = ?", fresh.tenant_id);
    if (tenantUser) notify(db, { orgId: fresh.org_id, userId: tenantUser.id, kind: "payment", title: "Payment received", body: `Your online payment of ₹${toRupees(fresh.amount_paise)} was received. Thank you!`, link: "tenant:home" });
    const tenant = db.get("SELECT name FROM tenants WHERE id = ?", fresh.tenant_id);
    notifyStaff(db, fresh.org_id, { kind: "payment", title: "Online payment received", body: `${tenant?.name || "A tenant"} paid ₹${toRupees(fresh.amount_paise)} online.`, link: "finance" });
    if (items.some((i) => i.result !== "applied")) notifyStaff(db, fresh.org_id, { kind: "payment_review", title: "Online payment needs review", body: "Part of an online payment didn't match an open bill (already paid or deleted). It is kept as the tenant's credit.", link: "finance" });
    return true;
  });
}

function register(app, { db, todayFor, log }) {
  function tenantOf(req) {
    return db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.user.tenant_id, req.orgId);
  }

  app.post("/api/tenant/payments/order", tenantOnly, async (req, res, next) => {
    try {
      if (!razorpayConfigured()) return res.status(503).json({ error: "Online payments are not set up yet. Please ask your owner to enable Razorpay." });
      const tenant = tenantOf(req);
      if (!tenant) return res.status(404).json({ error: "No active tenancy found" });
      const today = todayFor(req);
      const open = ledger.listCharges(db, req.orgId, { tenantId: tenant.id, status: "open" }, today).filter((c) => c.room_id === tenant.room_id);
      let chosen;
      if (req.body?.all) chosen = open;
      else {
        const requested = Array.isArray(req.body?.items) ? req.body.items : [];
        chosen = [];
        for (const r of requested) {
          const c = open.find((x) => x.id === r?.id) || null;
          if (!c) {
            const exists = ledger.getCharge(db, req.orgId, String(r?.id || ""), today);
            if (!exists || exists.tenant_id !== tenant.id) return res.status(404).json({ error: "This bill is not available for your tenancy." });
            continue; // already paid
          }
          if (!chosen.includes(c)) chosen.push(c);
        }
      }
      const items = chosen.map((c) => ({ kind: c.kind, entryId: c.id, month: c.period_month, year: c.period_year, amountPaise: c.outstanding_paise }));
      if (!items.length) return res.status(400).json({ error: "There is nothing pending to pay." });
      const amountPaise = items.reduce((s, i) => s + i.amountPaise, 0);
      if (amountPaise < 100) return res.status(400).json({ error: "Online payments must be at least ₹1." });
      const room = db.get("SELECT * FROM rooms WHERE id = ?", tenant.room_id);
      const building = room && db.get("SELECT * FROM buildings WHERE id = ?", room.building_id);
      const orderRowId = db.id();
      const kinds = [...new Set(items.map((i) => LABELS[i.kind] || i.kind))].join(", ");
      let order;
      try {
        order = await razorpayRequest("POST", "/orders", {
          amount: amountPaise, currency: "INR", receipt: orderRowId,
          notes: { paymentId: orderRowId, tenant: tenant.name.slice(0, 200), room: String(room?.label || "").slice(0, 200), bills: kinds },
        });
      } catch (err) {
        if (err.razorpayStatus === 401) {
          log.error("Razorpay rejected the API keys — check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.", { requestId: req.id });
          return res.status(502).json({ error: "Online payments are misconfigured (Razorpay rejected the API keys). Please tell your owner." });
        }
        log.error("Razorpay order creation failed", { requestId: req.id, error: err.message });
        return res.status(500).json({ error: `Could not start the payment: ${err.message}` });
      }
      db.run(`INSERT INTO payment_orders (id, org_id, tenant_id, room_id, razorpay_order_id, amount_paise, currency, items_json, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        orderRowId, req.orgId, tenant.id, tenant.room_id, order.id, amountPaise, "INR", JSON.stringify(items), "created", db.nowIso());
      res.status(201).json({
        keyId: process.env.RAZORPAY_KEY_ID, orderId: order.id, amount: amountPaise, currency: "INR", name: building?.name || "Rent Ledger",
        description: `${kinds} · ${room?.label || "your home"}`, prefill: { name: tenant.name, contact: tenant.mobile || "", email: tenant.email || "" },
      });
    } catch (err) { next(err); }
  });

  app.post("/api/tenant/payments/verify", tenantOnly, async (req, res, next) => {
    try {
      if (!razorpayConfigured()) return res.status(503).json({ error: "Online payments are not set up." });
      const orderId = String(req.body?.razorpay_order_id || "");
      const paymentId = String(req.body?.razorpay_payment_id || "");
      const signature = String(req.body?.razorpay_signature || "");
      if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return res.status(400).json({ error: "Invalid payment details." });
      const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${orderId}|${paymentId}`).digest("hex");
      if (!safeEqualText(expected, signature)) return res.status(400).json({ error: "Payment verification failed." });
      const order = db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ?", orderId);
      if (!order || order.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "Payment not found." });
      if (order.status === "paid") return res.json({ ok: true, amount: toRupees(order.amount_paise), alreadyRecorded: true });
      let rp;
      try {
        rp = await razorpayRequest("GET", `/payments/${paymentId}`);
        if (rp.order_id !== orderId) throw new Error("payment does not belong to this order");
        if (Number(rp.amount) !== order.amount_paise) throw new Error("amount mismatch");
        // Accounts set to manual capture leave payments "authorized" — capture them here.
        if (rp.status === "authorized") rp = await razorpayRequest("POST", `/payments/${paymentId}/capture`, { amount: rp.amount, currency: rp.currency });
        if (rp.status !== "captured") throw new Error(`payment status is "${rp.status}"`);
      } catch (err) {
        return res.status(502).json({ error: `We could not confirm this payment yet (${err.message}). If money was deducted, share payment ID ${paymentId} with your owner.` });
      }
      applyOrderPayment(db, order, paymentId, rp.method, todayFor(req));
      const fresh = db.get("SELECT * FROM payment_orders WHERE id = ?", order.id);
      res.json({ ok: true, amount: toRupees(fresh.amount_paise), items: JSON.parse(fresh.items_json).map((i) => ({ ...i, amount: toRupees(i.amountPaise) })) });
    } catch (err) { next(err); }
  });

  // Tells the server a checkout failed (for the repeated-failure alert).
  app.post("/api/tenant/payments/failed", tenantOnly, (req, res) => {
    const orderId = String(req.body?.razorpay_order_id || "");
    const order = db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ? AND tenant_id = ?", orderId, req.user.tenant_id);
    if (order && order.status === "created") db.run("UPDATE payment_orders SET status = 'failed', failure_reason = ? WHERE id = ?", String(req.body?.reason || "").slice(0, 200), order.id);
    res.json({ ok: true });
  });

  // Backup path when the tenant closes the page right after paying.
  app.post("/api/payments/razorpay/webhook", (req, res) => {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "Webhook is not configured." });
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
    if (!safeEqualText(expected, req.headers["x-razorpay-signature"])) return res.status(400).json({ error: "Invalid signature." });
    const event = req.body?.event;
    const entity = req.body?.payload?.payment?.entity;
    if ((event === "payment.captured" || event === "order.paid") && entity?.order_id && entity.status === "captured") {
      const order = db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ?", entity.order_id);
      if (order && Number(entity.amount) === order.amount_paise) {
        const tz = db.get("SELECT time_zone FROM organizations WHERE id = ?", order.org_id)?.time_zone;
        applyOrderPayment(db, order, entity.id, entity.method, require("../lib/dates").localDate(tz || "Asia/Kolkata"));
      }
    }
    if (event === "payment.failed" && entity?.order_id) {
      db.run("UPDATE payment_orders SET status = 'failed', failure_reason = ? WHERE razorpay_order_id = ? AND status = 'created'", String(entity.error_description || "failed").slice(0, 200), entity.order_id);
    }
    res.json({ ok: true });
  });

  // Owner view of online payments (dashboard card).
  app.get("/api/payments", (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const rows = db.all(`SELECT o.*, t.name AS tenant_name, r.label AS room_label, p.provider_payment_id FROM payment_orders o
      LEFT JOIN tenants t ON t.id = o.tenant_id LEFT JOIN rooms r ON r.id = o.room_id LEFT JOIN payments p ON p.id = o.payment_id
      WHERE o.org_id = ? AND o.status = 'paid' ORDER BY o.paid_at DESC LIMIT ${limit}`, req.orgId);
    res.json(rows.map((o) => ({
      id: o.id, amount: toRupees(o.amount_paise), paidAt: o.paid_at, method: o.method || "", razorpayPaymentId: o.provider_payment_id || "",
      tenantName: o.tenant_name || "Former tenant", roomLabel: o.room_label || "",
      items: JSON.parse(o.items_json).map((i) => ({ kind: i.kind, month: i.month, year: i.year, amount: toRupees(i.amountPaise), result: i.result })),
    })));
  });

  void audit;
}

module.exports = { register, razorpayConfigured, applyOrderPayment };
