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
const { tenantOnly, ownerOnly, ctxOf } = require("./common");
const accounts = require("../services/paymentAccounts");

const LABELS = { rent: "Rent", electricity: "Electricity", gas: "Gas", maintenance: "Maintenance", late_fee: "Late fee", damage: "Damage", other: "Other" };

// Online payments are on for an owner once they have connected their own
// Razorpay account in Settings. There is no shared fallback account, so money
// for one owner can never land in someone else's account.
function razorpayConfigured(db, orgId) {
  return accounts.isConnected(db, orgId);
}

const razorpayRequest = (creds, method, pathname, body) => accounts.razorpayRequest(creds, method, pathname, body);

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
      const creds = accounts.getAccount(db, req.orgId);
      if (!creds) return res.status(503).json({ error: "Online payments are not set up yet. Please ask your owner to connect their Razorpay account." });
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
        order = await razorpayRequest(creds, "POST", "/orders", {
          amount: amountPaise, currency: "INR", receipt: orderRowId,
          notes: { paymentId: orderRowId, tenant: tenant.name.slice(0, 200), room: String(room?.label || "").slice(0, 200), bills: kinds },
        });
      } catch (err) {
        if (err.razorpayStatus === 401) {
          log.error("Razorpay rejected the owner's API keys.", { requestId: req.id, orgId: req.orgId });
          notifyStaff(db, req.orgId, { kind: "payment_review", title: "Razorpay keys need attention", body: "Razorpay rejected your API keys, so tenants can't pay online. Reconnect your account in Settings → Online payments.", link: "settings" });
          return res.status(502).json({ error: "Online payments are misconfigured (Razorpay rejected the API keys). Please tell your owner." });
        }
        log.error("Razorpay order creation failed", { requestId: req.id, error: err.message });
        return res.status(500).json({ error: `Could not start the payment: ${err.message}` });
      }
      db.run(`INSERT INTO payment_orders (id, org_id, tenant_id, room_id, razorpay_order_id, amount_paise, currency, items_json, status, created_at, key_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        orderRowId, req.orgId, tenant.id, tenant.room_id, order.id, amountPaise, "INR", JSON.stringify(items), "created", db.nowIso(), creds.keyId);
      res.status(201).json({
        keyId: creds.keyId, orderId: order.id, amount: amountPaise, currency: "INR", name: building?.name || "Rent Ledger",
        description: `${kinds} · ${room?.label || "your home"}`, prefill: { name: tenant.name, contact: tenant.mobile || "", email: tenant.email || "" },
      });
    } catch (err) { next(err); }
  });

  app.post("/api/tenant/payments/verify", tenantOnly, async (req, res, next) => {
    try {
      const orderId = String(req.body?.razorpay_order_id || "");
      const paymentId = String(req.body?.razorpay_payment_id || "");
      const signature = String(req.body?.razorpay_signature || "");
      if (!/^order_[A-Za-z0-9]+$/.test(orderId) || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return res.status(400).json({ error: "Invalid payment details." });
      const order = db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ? AND org_id = ?", orderId, req.orgId);
      if (!order || order.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "Payment not found." });
      const creds = accounts.credsForOrder(db, order);
      if (!creds) return res.status(503).json({ error: "Online payments are not set up." });
      const expected = crypto.createHmac("sha256", creds.keySecret).update(`${orderId}|${paymentId}`).digest("hex");
      if (!safeEqualText(expected, signature)) return res.status(400).json({ error: "Payment verification failed." });
      if (order.status === "paid") return res.json({ ok: true, amount: toRupees(order.amount_paise), alreadyRecorded: true });
      let rp;
      try {
        rp = await razorpayRequest(creds, "GET", `/payments/${paymentId}`);
        if (rp.order_id !== orderId) throw new Error("payment does not belong to this order");
        if (Number(rp.amount) !== order.amount_paise) throw new Error("amount mismatch");
        // Accounts set to manual capture leave payments "authorized" — capture them here.
        if (rp.status === "authorized") rp = await razorpayRequest(creds, "POST", `/payments/${paymentId}/capture`, { amount: rp.amount, currency: rp.currency });
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

  // Backup path when the tenant closes the page right after paying. Each owner
  // adds their own webhook in Razorpay pointing at /webhook/<their org id>,
  // signed with the webhook secret they saved in Settings.
  function handleWebhook(req, res, { secret, orgId }) {
    if (!secret) return res.status(503).json({ error: "Webhook is not configured." });
    const expected = crypto.createHmac("sha256", secret).update(req.rawBody || Buffer.alloc(0)).digest("hex");
    if (!safeEqualText(expected, req.headers["x-razorpay-signature"])) return res.status(400).json({ error: "Invalid signature." });
    const event = req.body?.event;
    const entity = req.body?.payload?.payment?.entity;
    const findOrder = (id) => {
      if (orgId) return db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ? AND org_id = ?", id, orgId);
      // The old shared webhook only covers orders made with the old shared keys.
      const order = db.get("SELECT * FROM payment_orders WHERE razorpay_order_id = ?", id);
      return order && (!order.key_id || order.key_id === process.env.RAZORPAY_KEY_ID) ? order : null;
    };
    if ((event === "payment.captured" || event === "order.paid") && entity?.order_id && entity.status === "captured") {
      const order = findOrder(entity.order_id);
      if (order && Number(entity.amount) === order.amount_paise) {
        const tz = db.get("SELECT time_zone FROM organizations WHERE id = ?", order.org_id)?.time_zone;
        applyOrderPayment(db, order, entity.id, entity.method, require("../lib/dates").localDate(tz || "Asia/Kolkata"));
      }
    }
    if (event === "payment.failed" && entity?.order_id) {
      const order = findOrder(entity.order_id);
      if (order) db.run("UPDATE payment_orders SET status = 'failed', failure_reason = ? WHERE id = ? AND status = 'created'", String(entity.error_description || "failed").slice(0, 200), order.id);
    }
    res.json({ ok: true });
  }

  app.post("/api/payments/razorpay/webhook/:orgId", (req, res) => {
    const orgId = String(req.params.orgId || "");
    const acct = /^[A-Za-z0-9-]{8,64}$/.test(orgId) ? accounts.getAccount(db, orgId) : null;
    handleWebhook(req, res, { secret: acct?.webhookSecret || "", orgId });
  });

  // Older single-account setup (server-wide RAZORPAY_WEBHOOK_SECRET).
  app.post("/api/payments/razorpay/webhook", (req, res) => handleWebhook(req, res, { secret: process.env.RAZORPAY_WEBHOOK_SECRET || "", orgId: null }));

  // ---------- owner: connect their own Razorpay account ----------
  app.get("/api/org/payment-account", ownerOnly, (req, res) => {
    res.json(accounts.publicView(db, req.orgId));
  });

  app.put("/api/org/payment-account", ownerOnly, async (req, res, next) => {
    try {
      const keyId = String(req.body?.keyId || "").trim();
      const keySecret = String(req.body?.keySecret || "").trim();
      const webhookRaw = req.body?.webhookSecret;
      const webhookSecret = webhookRaw === null ? null : String(webhookRaw || "").trim();
      if (!accounts.KEY_ID_RE.test(keyId)) return res.status(400).json({ error: "The Key ID should look like rzp_live_… or rzp_test_…" });
      if (!/^[A-Za-z0-9]{10,64}$/.test(keySecret)) return res.status(400).json({ error: "Paste the Key Secret exactly as Razorpay shows it." });
      if (webhookSecret && webhookSecret.length > 200) return res.status(400).json({ error: "The webhook secret is too long." });
      const check = await accounts.checkKeys({ keyId, keySecret });
      if (!check.ok) return res.status(400).json({ error: check.error });
      accounts.saveAccount(db, req.orgId, req.user.id, { keyId, keySecret, webhookSecret });
      audit(db, ctxOf(req), "payments.account_connected", "organization", req.orgId, { keyId, mode: accounts.modeOf(keyId), webhook: Boolean(webhookSecret) });
      res.json(accounts.publicView(db, req.orgId));
    } catch (err) { next(err); }
  });

  app.delete("/api/org/payment-account", ownerOnly, (req, res) => {
    const before = accounts.publicView(db, req.orgId);
    accounts.removeAccount(db, req.orgId);
    audit(db, ctxOf(req), "payments.account_disconnected", "organization", req.orgId, { keyId: before.keyId });
    res.json(accounts.publicView(db, req.orgId));
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

}

module.exports = { register, razorpayConfigured, applyOrderPayment };
