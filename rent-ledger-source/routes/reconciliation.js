// Reconciliation screens' API: import a statement, review suggestions,
// confirm (records a verified payment) or ignore each credit.
const v = require("../lib/validate");
const { toRupees, toPaise } = require("../lib/money");
const ledger = require("../services/ledger");
const recon = require("../services/reconciliation");
const { audit } = require("../services/audit");
const { notify } = require("../services/notify");
const { requirePermission, ctxOf, notFound } = require("./common");

function txnView(t) {
  return {
    id: t.id, date: t.txn_date, amount: toRupees(t.amount_paise), reference: t.reference, description: t.description, payer: t.payer,
    status: t.status, flags: JSON.parse(t.flags_json || "[]"), matchedPaymentId: t.matched_payment_id, decidedAt: t.decided_at, importId: t.import_id,
  };
}

function register(app, { db, todayFor }) {
  const manage = requirePermission("reconciliation.manage");

  app.post("/api/reconciliation/imports", manage, (req, res) => {
    const csv = String(req.body?.csv || "");
    if (!csv.trim()) return res.status(400).json({ error: "Paste or upload the statement CSV." });
    if (csv.length > 2_000_000) return res.status(413).json({ error: "This statement is too large (2 MB limit). Export a shorter date range." });
    const parsed = recon.parseStatement(csv);
    const importId = db.id();
    let imported = 0, duplicates = 0;
    db.tx(() => {
      db.run("INSERT INTO bank_imports (id, org_id, file_name, row_count, created_by, created_at) VALUES (?,?,?,?,?,?)", importId, req.orgId, v.text({ label: "File name", max: 120 })(req.body?.fileName), parsed.credits.length + parsed.skipped, req.user.id, db.nowIso());
      for (const c of parsed.credits) {
        const fp = recon.fingerprint(c);
        if (db.get("SELECT 1 FROM bank_transactions WHERE org_id = ? AND fingerprint = ?", req.orgId, fp)) { duplicates++; continue; }
        const txn = { txn_date: c.date, amount_paise: c.amountPaise, reference: c.reference, description: c.description, payer: c.payer };
        const flags = recon.duplicateFlags(db, req.orgId, txn);
        db.run(`INSERT INTO bank_transactions (id, org_id, import_id, txn_date, amount_paise, reference, description, payer, fingerprint, status, flags_json, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,'unmatched',?,?)`, db.id(), req.orgId, importId, c.date, c.amountPaise, c.reference, c.description, c.payer, fp, JSON.stringify(flags), db.nowIso());
        imported++;
      }
      db.run("UPDATE bank_imports SET imported_count = ?, duplicate_count = ?, skipped_count = ? WHERE id = ?", imported, duplicates, parsed.skipped, importId);
      audit(db, ctxOf(req), "reconciliation.imported", "bank_import", importId, { imported, duplicates, skipped: parsed.skipped });
    });
    res.status(201).json({ importId, imported, duplicates, skipped: parsed.skipped, note: parsed.skipped ? `${parsed.skipped} row(s) were not money coming in, or had no readable date/amount, and were skipped.` : "" });
  });

  app.get("/api/reconciliation/transactions", manage, (req, res) => {
    const status = ["unmatched", "matched", "ignored"].includes(req.query.status) ? req.query.status : null;
    const rows = db.all(`SELECT * FROM bank_transactions WHERE org_id = ? ${status ? "AND status = ?" : ""} ORDER BY txn_date DESC, created_at DESC LIMIT 500`, ...(status ? [req.orgId, status] : [req.orgId]));
    res.json(rows.map(txnView));
  });

  app.get("/api/reconciliation/transactions/:id/suggestions", manage, (req, res) => {
    const t = db.get("SELECT * FROM bank_transactions WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Transaction");
    const suggestions = recon.suggestMatches(db, req.orgId, t, todayFor(req));
    res.json({
      transaction: txnView(t),
      suggestions: suggestions.map((s) => ({ ...s, credit: toRupees(s.creditPaise), outstanding: toRupees(s.outstandingPaise), allocations: s.allocations.map((a) => ({ chargeId: a.chargeId, label: a.label, amount: toRupees(a.amountPaise) })) })),
      note: t.status === "unmatched" && !suggestions.length ? "No likely tenant found. Choose the tenant yourself, or ignore it if this credit isn't rent." : "",
    });
  });

  // Confirm a match: records a *verified* payment (the bank statement is the
  // evidence), applies it to the chosen bills, and is safe to retry.
  app.post("/api/reconciliation/transactions/:id/confirm", manage, (req, res) => {
    const t = db.get("SELECT * FROM bank_transactions WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Transaction");
    if (t.status === "matched") return res.json({ ok: true, paymentId: t.matched_payment_id, alreadyMatched: true });
    if (t.status === "ignored") return res.status(409).json({ error: "This credit was ignored. Reopen it first." });
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.body?.tenantId || "", req.orgId);
    if (!tenant) return res.status(400).json({ error: "Choose the tenant this payment came from." });
    const allocations = Array.isArray(req.body?.allocations)
      ? req.body.allocations.map((a) => ({ chargeId: String(a.chargeId), amountPaise: toPaise(v.number({ label: "Allocation", min: 0.01, max: 100_000_000, required: true })(a.amount)) }))
      : "auto";
    const result = db.tx(() => {
      const r = ledger.recordPayment(db, ctxOf(req), {
        tenantId: tenant.id, roomId: tenant.room_id, amountPaise: t.amount_paise, method: /upi/i.test(`${t.description} ${t.reference}`) ? "upi" : "bank_transfer",
        reference: t.reference, receivedOn: t.txn_date, verification: "verified", source: "reconciliation", idempotencyKey: `bank:${t.id}`,
        notes: `Matched from bank statement: ${t.description}`.slice(0, 500), allocations,
      }, todayFor(req));
      db.run("UPDATE bank_transactions SET status = 'matched', matched_payment_id = ?, decided_by = ?, decided_at = ? WHERE id = ?", r.paymentId, req.user.id, db.nowIso(), t.id);
      audit(db, ctxOf(req), "reconciliation.matched", "bank_transaction", t.id, { paymentId: r.paymentId, tenantId: tenant.id, amountPaise: t.amount_paise, suggestedScore: req.body?.score ?? null });
      return r;
    });
    const user = db.get("SELECT id FROM users WHERE tenant_id = ?", tenant.id);
    if (user) notify(db, { orgId: req.orgId, userId: user.id, kind: "payment", title: "Payment received", body: `Your payment of ₹${toRupees(t.amount_paise)} on ${t.txn_date} was received.`, link: "tenant:home" });
    res.json({ ok: true, paymentId: result.paymentId, applied: (result.applied || []).map((a) => ({ ...a, amount: toRupees(a.amountPaise) })) });
  });

  app.post("/api/reconciliation/transactions/:id/ignore", manage, (req, res) => {
    const t = db.get("SELECT * FROM bank_transactions WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Transaction");
    if (t.status === "matched") return res.status(409).json({ error: "This credit is already matched to a payment." });
    db.run("UPDATE bank_transactions SET status = 'ignored', decided_by = ?, decided_at = ? WHERE id = ?", req.user.id, db.nowIso(), t.id);
    audit(db, ctxOf(req), "reconciliation.ignored", "bank_transaction", t.id, { reason: v.text({ label: "Reason", max: 200 })(req.body?.reason) });
    res.json({ ok: true });
  });

  app.post("/api/reconciliation/transactions/:id/reopen", manage, (req, res) => {
    const t = db.get("SELECT * FROM bank_transactions WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Transaction");
    if (t.status !== "ignored") return res.status(409).json({ error: "Only ignored credits can be reopened." });
    db.run("UPDATE bank_transactions SET status = 'unmatched', decided_by = NULL, decided_at = NULL WHERE id = ?", t.id);
    res.json({ ok: true });
  });
}

module.exports = { register };
