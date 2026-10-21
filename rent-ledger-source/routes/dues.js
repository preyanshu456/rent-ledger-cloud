// Dues engine routes: packages, shared bills, late fees, discounts, deposit
// and advance, and free WhatsApp links for reminders and receipts.
const v = require("../lib/validate");
const { toPaise, toRupees } = require("../lib/money");
const ledger = require("../services/ledger");
const dues = require("../services/dues");
const accounts = require("../services/accounts");
const { audit } = require("../services/audit");
const { depositHeld } = require("./tenancy");
const { requirePermission, ownerOnly, ctxOf, notFound } = require("./common");

const PACKAGE_SCHEMA = {
  name: v.text({ label: "Package name", max: 80, required: true }),
  category: (x) => (x === "maintenance" ? "maintenance" : "other"),
  billingMode: (x) => {
    if (!["fixed", "per_unit"].includes(x)) throw new v.ValidationError("Choose fixed amount or per unit.");
    return x;
  },
  rate: v.money("Amount or rate"),
  unitLabel: v.text({ label: "Unit", max: 30 }),
  minBill: v.money("Minimum bill"),
  autoMonthly: v.bool(),
  dueDay: v.number({ label: "Due day", min: 1, max: 28, integer: true, fallback: 5 }),
  description: v.text({ label: "Description", max: 300 }),
};

function register(app, { db, todayFor }) {
  const bills = requirePermission("bills.manage");
  const record = requirePermission("payments.record");
  const remind = requirePermission("reminders.manage");
  const pkgOf = (req, id) => db.get("SELECT * FROM dues_packages WHERE id = ? AND org_id = ?", id, req.orgId);
  const period = (body) => ({
    year: body?.year ? v.number({ label: "Year", min: 2000, max: 2100, integer: true })(body.year) : null,
    month: body?.month ? v.number({ label: "Month", min: 1, max: 12, integer: true })(body.month) : null,
    dueDate: v.date({ label: "Due date" })(body?.dueDate),
  });

  // ---------- packages ----------
  app.get("/api/dues/packages", (req, res) => {
    res.json(db.all("SELECT * FROM dues_packages WHERE org_id = ? ORDER BY active DESC, name COLLATE NOCASE", req.orgId).map(dues.packageView));
  });

  app.post("/api/dues/packages", bills, (req, res) => {
    const d = v.clean(req.body, PACKAGE_SCHEMA);
    const buildingId = req.body?.buildingId || null;
    if (buildingId && !db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", buildingId, req.orgId)) return notFound(res, "Building");
    if (d.billingMode === "per_unit" && !d.unitLabel) return res.status(400).json({ error: "Enter the unit, for example load, plate or kg." });
    if (d.autoMonthly && d.billingMode !== "fixed") return res.status(400).json({ error: "Only fixed-amount packages can be added every month automatically." });
    const id = db.id();
    db.run(`INSERT INTO dues_packages (id, org_id, building_id, name, category, billing_mode, rate_paise, unit_label, min_bill_paise, auto_monthly, due_day, description, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, req.orgId, buildingId, d.name, d.category, d.billingMode, toPaise(d.rate), d.unitLabel, toPaise(d.minBill), d.autoMonthly ? 1 : 0, d.dueDay, d.description, db.nowIso());
    audit(db, ctxOf(req), "package.created", "dues_package", id, { name: d.name });
    res.status(201).json(dues.packageView(pkgOf(req, id)));
  });

  app.put("/api/dues/packages/:id", bills, (req, res) => {
    const p = pkgOf(req, req.params.id);
    if (!p) return notFound(res, "Package");
    const d = v.clean(req.body, PACKAGE_SCHEMA, { partial: true });
    const map = { name: "name", category: "category", billingMode: "billing_mode", unitLabel: "unit_label", dueDay: "due_day", description: "description" };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) if (req.body?.[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    if (req.body?.rate !== undefined) { sets.push("rate_paise = ?"); params.push(toPaise(d.rate)); }
    if (req.body?.minBill !== undefined) { sets.push("min_bill_paise = ?"); params.push(toPaise(d.minBill)); }
    if (req.body?.autoMonthly !== undefined) { sets.push("auto_monthly = ?"); params.push(d.autoMonthly ? 1 : 0); }
    if (req.body?.active !== undefined) { sets.push("active = ?"); params.push(v.bool()(req.body.active) ? 1 : 0); }
    if (sets.length) db.run(`UPDATE dues_packages SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), p.id);
    const fresh = pkgOf(req, p.id);
    if (fresh.auto_monthly && fresh.billing_mode !== "fixed") db.run("UPDATE dues_packages SET auto_monthly = 0 WHERE id = ?", p.id);
    res.json(dues.packageView(pkgOf(req, p.id)));
  });

  // Packages are switched off rather than deleted once they have billed anyone.
  app.delete("/api/dues/packages/:id", bills, (req, res) => {
    const p = pkgOf(req, req.params.id);
    if (!p) return notFound(res, "Package");
    const used = db.all("SELECT details_json FROM charges WHERE org_id = ? AND source = 'package'", req.orgId).some((c) => { try { return JSON.parse(c.details_json).packageId === p.id; } catch { return false; } });
    if (used) { db.run("UPDATE dues_packages SET active = 0, auto_monthly = 0, updated_at = ? WHERE id = ?", db.nowIso(), p.id); return res.json({ ok: true, switchedOff: true }); }
    db.run("DELETE FROM dues_packages WHERE id = ?", p.id);
    res.json({ ok: true });
  });

  app.post("/api/dues/packages/:id/bill", bills, (req, res) => {
    const p = pkgOf(req, req.params.id);
    if (!p) return notFound(res, "Package");
    const roomId = req.body?.roomId || null;
    if (roomId && !db.get("SELECT 1 FROM rooms WHERE id = ? AND org_id = ?", roomId, req.orgId)) return notFound(res, "Room");
    const units = req.body?.units === undefined || req.body.units === "" ? 0 : v.number({ label: "Units", min: 0, max: 1e6 })(req.body.units);
    const ids = dues.billPackage(db, ctxOf(req), p, {
      tenantIds: Array.isArray(req.body?.tenantIds) ? req.body.tenantIds.map(String).slice(0, 500) : [], roomId, units,
      split: req.body?.split === "equal" ? "equal" : "each", ...period(req.body), note: v.text({ label: "Note", max: 300 })(req.body?.note),
    }, todayFor(req));
    res.status(201).json({ created: ids.length, chargeIds: ids, amountEach: toRupees(dues.packageAmountPaise(p, units)) });
  });

  // ---------- one bill split between the tenants of a shared room ----------
  app.post("/api/dues/split", bills, (req, res) => {
    const ids = dues.splitRoomBill(db, ctxOf(req), {
      roomId: req.body?.roomId || "", kind: req.body?.kind, amountPaise: toPaise(v.money("Amount")(req.body?.amount)),
      description: v.text({ label: "Description", max: 120 })(req.body?.description), ...period(req.body),
      mode: req.body?.mode === "days" ? "days" : "equal",
      periodStart: v.date({ label: "From" })(req.body?.periodStart), periodEnd: v.date({ label: "To" })(req.body?.periodEnd),
    }, todayFor(req));
    res.status(201).json({ created: ids.length, chargeIds: ids });
  });

  // ---------- late fees ----------
  app.get("/api/dues/late-fees", (req, res) => {
    const s = accounts.getOrg(db, req.orgId).settings.lateFees;
    const recent = db.all(`SELECT lf.*, c.tenant_id FROM late_fees lf JOIN charges c ON c.id = lf.fee_charge_id WHERE lf.org_id = ? ORDER BY lf.created_at DESC LIMIT 50`, req.orgId)
      .map((lf) => { const fee = ledger.getCharge(db, req.orgId, lf.fee_charge_id, todayFor(req)); return { forChargeId: lf.charge_id, feeChargeId: lf.fee_charge_id, mode: lf.mode, days: lf.days_charged, amount: toRupees(fee?.amount_paise || 0), status: fee?.status || "", tenantName: db.get("SELECT name FROM tenants WHERE id = ?", lf.tenant_id)?.name || "", createdAt: lf.created_at }; });
    res.json({ settings: s, recent });
  });

  app.put("/api/dues/late-fees", ownerOnly, (req, res) => {
    const org = accounts.getOrg(db, req.orgId);
    const b = req.body || {};
    const next = {
      enabled: v.bool()(b.enabled),
      graceDays: v.number({ label: "Grace days", min: 0, max: 60, integer: true, fallback: 5 })(b.graceDays),
      mode: b.mode === "daily" ? "daily" : "flat",
      amount: v.money("Late fee amount")(b.amount),
      maxAmount: v.money("Maximum late fee")(b.maxAmount),
      kinds: (Array.isArray(b.kinds) ? b.kinds : ["rent"]).filter((k) => ["rent", "electricity", "gas", "maintenance", "other"].includes(k)),
    };
    if (!next.kinds.length) next.kinds = ["rent"];
    if (next.enabled && !(next.amount > 0)) return res.status(400).json({ error: "Enter the late fee amount." });
    const settings = { ...org.settings, lateFees: next };
    db.run("UPDATE organizations SET settings_json = ? WHERE id = ?", JSON.stringify(settings), req.orgId);
    audit(db, ctxOf(req), "late_fees.updated", "organization", req.orgId, next);
    res.json({ settings: next });
  });

  // Run late fees, monthly packages and discount checks now (they also run every hour).
  app.post("/api/dues/run", ownerOnly, (req, res) => {
    const today = todayFor(req);
    res.json({ lateFees: dues.applyLateFees(db, req.orgId, today), packages: dues.runMonthlyPackages(db, req.orgId, today), discounts: dues.settleDiscounts(db, req.orgId, today) });
  });

  // ---------- discounts ----------
  app.post("/api/dues/charges/:id/discount", bills, (req, res) => {
    const amountPaise = toPaise(v.money("Discount")(req.body?.amount));
    let validUntil = v.date({ label: "Pay by" })(req.body?.validUntil);
    if (!validUntil && req.body?.validDays) {
      const days = v.number({ label: "Valid for days", min: 1, max: 365, integer: true })(req.body.validDays);
      validUntil = new Date(Date.parse(`${todayFor(req)}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    }
    const offer = dues.giveDiscount(db, ctxOf(req), req.params.id, { amountPaise, validUntil, reason: v.text({ label: "Reason", max: 300 })(req.body?.reason) }, todayFor(req));
    res.status(201).json({ offer, charge: chargeJson(req, req.params.id) });
  });

  app.get("/api/dues/discounts", (req, res) => {
    const where = req.query.status ? "AND o.status = ?" : "";
    res.json(db.all(`SELECT o.*, c.tenant_id FROM discount_offers o JOIN charges c ON c.id = o.charge_id WHERE o.org_id = ? ${where} ORDER BY o.created_at DESC LIMIT 200`, ...(req.query.status ? [req.orgId, String(req.query.status)] : [req.orgId]))
      .map((o) => ({ ...dues.offerView(o), tenantName: db.get("SELECT name FROM tenants WHERE id = ?", o.tenant_id)?.name || "" })));
  });

  app.post("/api/dues/discounts/:id/cancel", bills, (req, res) => {
    res.json(dues.cancelDiscount(db, ctxOf(req), req.params.id, todayFor(req)));
  });

  // ---------- deposit and advance ----------
  app.get("/api/dues/tenants/:id/money", (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    const bal = ledger.tenantBalance(db, req.orgId, t.id, todayFor(req));
    const dep = depositHeld(db, t.id);
    res.json({ outstanding: toRupees(bal.outstandingPaise), overdue: toRupees(bal.overduePaise), advance: toRupees(bal.creditPaise), netDue: toRupees(bal.netDuePaise), depositHeld: toRupees(dep.heldPaise) });
  });

  app.post("/api/dues/tenants/:id/apply-advance", record, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Tenant");
    const applied = dues.applyCredit(db, ctxOf(req), t.id, todayFor(req));
    res.json({ applied: toRupees(applied) });
  });

  app.post("/api/dues/tenants/:id/use-deposit", ownerOnly, (req, res) => {
    const amount = req.body?.amount === undefined || req.body.amount === "" ? 0 : toPaise(v.money("Amount")(req.body.amount));
    const r = dues.useDeposit(db, ctxOf(req), req.params.id, amount, todayFor(req), { depositHeld });
    res.status(201).json({ paymentId: r.paymentId, amount: toRupees(r.amountPaise), depositLeft: toRupees(r.depositLeftPaise) });
  });

  // ---------- WhatsApp links ----------
  app.get("/api/dues/whatsapp", remind, (req, res) => {
    res.json(dues.whatsappReminders(db, req.orgId, todayFor(req), { buildingId: req.query.buildingId || undefined, language: ["en", "hi"].includes(req.query.language) ? req.query.language : undefined }));
  });

  app.get("/api/ledger/payments/:id/whatsapp", (req, res) => {
    const p = ledger.getPayment(db, req.orgId, req.params.id);
    if (!p || (req.user.role === "tenant" && p.tenant_id !== req.user.tenant_id)) return notFound(res, "Payment");
    const t = p.tenant_id ? db.get("SELECT mobile FROM tenants WHERE id = ?", p.tenant_id) : null;
    const text = dues.receiptText(db, req.orgId, p, todayFor(req));
    res.json({ text, link: dues.waLink(req.user.role === "tenant" ? "" : t?.mobile, text) });
  });

  function chargeJson(req, id) {
    const c = ledger.getCharge(db, req.orgId, id, todayFor(req));
    return c ? { id: c.id, amount: toRupees(c.amount_paise), outstanding: toRupees(c.outstanding_paise), status: c.status } : null;
  }
}

module.exports = { register };
