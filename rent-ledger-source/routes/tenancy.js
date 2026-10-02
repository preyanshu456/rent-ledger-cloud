// Move-in and move-out records, the security deposit held, and the deposit
// settlement at move-out. Settlement maths is shown line by line and only
// takes effect when the owner agrees it; nothing is deducted automatically,
// and this is not a legal determination.
const v = require("../lib/validate");
const { toPaise, toRupees, formatInr } = require("../lib/money");
const ledger = require("../services/ledger");
const accounts = require("../services/accounts");
const { audit } = require("../services/audit");
const { documentView } = require("../services/documents");
const { notify } = require("../services/notify");
const { requirePermission, ownerOnly, ctxOf, notFound, escapeHtml, printablePage } = require("./common");

const DEFAULT_CHECKLIST = {
  move_in: ["Agreement signed", "Security deposit received", "ID proof collected", "Keys handed over", "Meter readings recorded", "Photos of the property taken"],
  move_out: ["Notice received", "Keys returned", "Final meter readings recorded", "Property inspected and photos taken", "Utility bills settled", "Forwarding contact noted"],
};

function depositHeld(db, tenantId) {
  const sum = (type) => db.get("SELECT COALESCE(SUM(amount_paise),0) AS s FROM deposit_transactions WHERE tenant_id = ? AND type = ?", tenantId, type).s;
  return { receivedPaise: sum("received"), refundedPaise: sum("refunded"), appliedPaise: sum("applied_to_dues"), heldPaise: sum("received") - sum("refunded") - sum("applied_to_dues") };
}

function register(app, { db, todayFor }) {
  const manage = requirePermission("tenants.manage");
  const tenantOf = (req) => db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ?", req.params.id, req.orgId);

  function recordView(r) {
    if (!r) return null;
    return {
      id: r.id, type: r.type, recordDate: r.record_date, proposedDate: r.proposed_date, meterReadings: JSON.parse(r.meter_readings_json || "{}"),
      conditionNotes: r.condition_notes, checklist: JSON.parse(r.checklist_json || "[]"), keysCount: r.keys_count, updatedAt: r.updated_at || r.created_at,
      photos: db.all("SELECT * FROM documents WHERE entity_type = 'move_record' AND entity_id = ? AND status = 'active'", r.id).map(documentView),
    };
  }
  function settlementView(s) {
    if (!s) return null;
    const deductions = JSON.parse(s.deductions_json || "[]");
    return {
      id: s.id, status: s.status, depositHeld: toRupees(s.deposit_held_paise), outstandingDues: toRupees(s.outstanding_dues_paise),
      deductions: deductions.map((d) => ({ reason: d.reason, amount: toRupees(d.amountPaise), evidenceDocumentId: d.evidenceDocumentId || null })),
      deductionsTotal: toRupees(deductions.reduce((a, d) => a + d.amountPaise, 0)), refund: toRupees(s.refund_paise),
      tenantOwesAfterDeposit: toRupees(Math.max(s.outstanding_dues_paise + deductions.reduce((a, d) => a + d.amountPaise, 0) - s.deposit_held_paise, 0)),
      notes: s.notes, refundMethod: s.refund_method, refundReference: s.refund_reference, agreedAt: s.agreed_at, refundedAt: s.refunded_at, updatedAt: s.updated_at || s.created_at,
    };
  }

  app.get("/api/tenants/:id/tenancy", manage, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const today = todayFor(req);
    const records = Object.fromEntries(["move_in", "move_out"].map((type) => [type, recordView(db.get("SELECT * FROM move_records WHERE tenant_id = ? AND type = ?", t.id, type))]));
    const dep = depositHeld(db, t.id);
    res.json({
      tenantId: t.id, active: Boolean(t.active), agreedDeposit: toRupees(t.deposit_paise ?? db.get("SELECT deposit_paise FROM rooms WHERE id = ?", t.room_id)?.deposit_paise ?? 0),
      records, defaultChecklists: DEFAULT_CHECKLIST,
      deposit: { received: toRupees(dep.receivedPaise), refunded: toRupees(dep.refundedPaise), appliedToDues: toRupees(dep.appliedPaise), held: toRupees(dep.heldPaise),
        transactions: db.all("SELECT * FROM deposit_transactions WHERE tenant_id = ? ORDER BY txn_date, created_at", t.id).map((x) => ({ id: x.id, type: x.type, amount: toRupees(x.amount_paise), date: x.txn_date, method: x.method, reference: x.reference })) },
      balance: Object.fromEntries(Object.entries(ledger.tenantBalance(db, req.orgId, t.id, today)).map(([k, val]) => [k.replace(/Paise$/, ""), toRupees(val)])),
      settlement: settlementView(db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id)),
    });
  });

  app.put("/api/tenants/:id/move-records/:type", manage, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const type = req.params.type;
    if (!["move_in", "move_out"].includes(type)) return notFound(res, "Record type");
    const b = req.body || {};
    const readings = {};
    for (const k of ["electricity", "gas", "water"]) if (b.meterReadings?.[k] !== undefined && b.meterReadings[k] !== "") readings[k] = v.number({ label: `${k} reading`, min: 0, max: 1e9 })(b.meterReadings[k]);
    const checklist = (Array.isArray(b.checklist) ? b.checklist : DEFAULT_CHECKLIST[type].map((item) => ({ item, done: false })))
      .slice(0, 30).map((c) => ({ item: v.text({ label: "Checklist item", max: 120, required: true })(c.item), done: Boolean(c.done) }));
    const fields = {
      record_date: v.date({ label: "Date" })(b.recordDate), proposed_date: v.date({ label: "Proposed date" })(b.proposedDate),
      meter_readings_json: JSON.stringify(readings), condition_notes: v.text({ label: "Condition notes", max: 3000 })(b.conditionNotes),
      checklist_json: JSON.stringify(checklist), keys_count: v.number({ label: "Keys", min: 0, max: 50, integer: true })(b.keysCount),
    };
    const existing = db.get("SELECT id FROM move_records WHERE tenant_id = ? AND type = ?", t.id, type);
    if (existing) db.run(`UPDATE move_records SET ${Object.keys(fields).map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`, ...Object.values(fields), db.nowIso(), existing.id);
    else db.run(`INSERT INTO move_records (id, org_id, tenant_id, room_id, type, ${Object.keys(fields).join(", ")}, created_by, created_at) VALUES (?,?,?,?,?,${Object.keys(fields).map(() => "?").join(",")},?,?)`,
      db.id(), req.orgId, t.id, t.room_id, type, ...Object.values(fields), req.user.id, db.nowIso());
    audit(db, ctxOf(req), `tenancy.${type}_recorded`, "tenant", t.id, {});
    res.json(recordView(db.get("SELECT * FROM move_records WHERE tenant_id = ? AND type = ?", t.id, type)));
  });

  // Deposit received (or an early partial refund). Deposits are held money,
  // kept separate from rent income.
  app.post("/api/tenants/:id/deposit", manage, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const type = req.body?.type === "refunded" ? "refunded" : "received";
    if (type === "refunded" && req.user.role !== "owner") return res.status(403).json({ error: "Only the owner can record deposit refunds." });
    const amount = toPaise(v.number({ label: "Amount", min: 0.01, max: 100_000_000, required: true })(req.body?.amount));
    if (type === "refunded" && amount > depositHeld(db, t.id).heldPaise) return res.status(400).json({ error: "That is more than the deposit currently held." });
    const id = db.id();
    db.run("INSERT INTO deposit_transactions (id, org_id, tenant_id, type, amount_paise, txn_date, method, reference, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      id, req.orgId, t.id, type, amount, v.date({ label: "Date" })(req.body?.date) || todayFor(req), v.text({ label: "Method", max: 40 })(req.body?.method), v.text({ label: "Reference", max: 120 })(req.body?.reference), req.user.id, db.nowIso());
    audit(db, ctxOf(req), `deposit.${type}`, "tenant", t.id, { amountPaise: amount });
    res.status(201).json({ id, held: toRupees(depositHeld(db, t.id).heldPaise) });
  });

  // Draft (or update) the settlement: deposit held − dues − agreed deductions.
  app.put("/api/tenants/:id/settlement", manage, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const existing = db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id);
    if (existing && existing.status !== "draft") return res.status(409).json({ error: "This settlement has been agreed and can't be changed." });
    const deductions = (Array.isArray(req.body?.deductions) ? req.body.deductions : []).slice(0, 20).map((d) => ({
      reason: v.text({ label: "Deduction reason", max: 200, required: true })(d.reason),
      amountPaise: toPaise(v.number({ label: "Deduction amount", min: 0.01, max: 100_000_000, required: true })(d.amount)),
      evidenceDocumentId: d.evidenceDocumentId && db.get("SELECT 1 FROM documents WHERE id = ? AND org_id = ?", d.evidenceDocumentId, req.orgId) ? d.evidenceDocumentId : null,
    }));
    const held = depositHeld(db, t.id).heldPaise;
    const dues = ledger.tenantBalance(db, req.orgId, t.id, todayFor(req)).netDuePaise;
    const owed = Math.max(dues, 0) + deductions.reduce((a, d) => a + d.amountPaise, 0);
    const refund = Math.max(held - owed, 0);
    const notes = v.text({ label: "Notes", max: 2000 })(req.body?.notes);
    if (existing) db.run("UPDATE deposit_settlements SET deposit_held_paise = ?, outstanding_dues_paise = ?, deductions_json = ?, refund_paise = ?, notes = ?, updated_at = ? WHERE id = ?", held, Math.max(dues, 0), JSON.stringify(deductions), refund, notes, db.nowIso(), existing.id);
    else db.run("INSERT INTO deposit_settlements (id, org_id, tenant_id, deposit_held_paise, outstanding_dues_paise, deductions_json, refund_paise, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      db.id(), req.orgId, t.id, held, Math.max(dues, 0), JSON.stringify(deductions), refund, notes, req.user.id, db.nowIso());
    res.json(settlementView(db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id)));
  });

  // Agreeing the settlement (owner): deductions become damage charges, the
  // deposit is applied to what's owed (a "deposit adjustment" payment), and
  // the refund amount is fixed. Every step is in the ledger and audit log.
  app.post("/api/tenants/:id/settlement/agree", ownerOnly, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const s = db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id);
    if (!s) return res.status(404).json({ error: "Prepare the settlement first." });
    if (s.status !== "draft") return res.status(409).json({ error: "Already agreed." });
    const today = todayFor(req);
    const ctx = ctxOf(req);
    db.tx(() => {
      const deductions = JSON.parse(s.deductions_json || "[]");
      for (const d of deductions) {
        ledger.createCharge(db, ctx, { roomId: t.room_id, tenantId: t.id, kind: "damage", dueDate: today, description: d.reason, amountPaise: d.amountPaise, source: "settlement", notes: d.evidenceDocumentId ? `Evidence document ${d.evidenceDocumentId}` : "" });
      }
      const held = depositHeld(db, t.id).heldPaise;
      const balance = ledger.tenantBalance(db, req.orgId, t.id, today);
      const apply = Math.min(held, Math.max(balance.outstandingPaise - balance.creditPaise, 0));
      if (balance.creditPaise > 0) {
        for (const p of ledger.listPayments(db, req.orgId, { tenantId: t.id }).filter((x) => x.unallocated_paise > 0)) ledger.autoAllocate(db, ctx, p.id, today);
      }
      if (apply > 0) {
        ledger.recordPayment(db, ctx, { tenantId: t.id, roomId: t.room_id, amountPaise: apply, method: "deposit_adjustment", receivedOn: today, verification: "recorded", source: "settlement", idempotencyKey: `settlement:${s.id}`, notes: "Security deposit applied to dues at move-out", allocations: "auto" }, today);
        db.run("INSERT INTO deposit_transactions (id, org_id, tenant_id, type, amount_paise, txn_date, method, reference, settlement_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          db.id(), req.orgId, t.id, "applied_to_dues", apply, today, "deposit_adjustment", "", s.id, req.user.id, db.nowIso());
      }
      const refund = depositHeld(db, t.id).heldPaise;
      const after = ledger.tenantBalance(db, req.orgId, t.id, today);
      db.run("UPDATE deposit_settlements SET status = 'agreed', deposit_held_paise = ?, outstanding_dues_paise = ?, refund_paise = ?, agreed_at = ?, updated_at = ? WHERE id = ?",
        held, Math.max(balance.outstandingPaise - deductions.reduce((a, d) => a + d.amountPaise, 0), 0), refund, db.nowIso(), db.nowIso(), s.id);
      audit(db, ctx, "deposit.settlement_agreed", "tenant", t.id, { appliedPaise: apply, refundPaise: refund, stillOwedPaise: after.outstandingPaise });
    });
    const user = db.get("SELECT id FROM users WHERE tenant_id = ?", t.id);
    const fresh = db.get("SELECT * FROM deposit_settlements WHERE id = ?", s.id);
    if (user) notify(db, { orgId: req.orgId, userId: user.id, kind: "deposit", title: "Deposit settlement prepared", body: `Refund due to you: ${formatInr(fresh.refund_paise)}.`, link: "tenant:home" });
    res.json(settlementView(fresh));
  });

  app.post("/api/tenants/:id/settlement/refund", ownerOnly, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const s = db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id);
    if (!s || s.status !== "agreed") return res.status(409).json({ error: "Agree the settlement before recording the refund." });
    const date = v.date({ label: "Refund date" })(req.body?.date) || todayFor(req);
    const method = v.text({ label: "Method", max: 40 })(req.body?.method) || "bank_transfer";
    const reference = v.text({ label: "Reference", max: 120 })(req.body?.reference);
    db.tx(() => {
      if (s.refund_paise > 0) db.run("INSERT INTO deposit_transactions (id, org_id, tenant_id, type, amount_paise, txn_date, method, reference, settlement_id, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        db.id(), req.orgId, t.id, "refunded", s.refund_paise, date, method, reference, s.id, req.user.id, db.nowIso());
      db.run("UPDATE deposit_settlements SET status = 'refunded', refund_method = ?, refund_reference = ?, refunded_at = ?, updated_at = ? WHERE id = ?", method, reference, db.nowIso(), db.nowIso(), s.id);
      audit(db, ctxOf(req), "deposit.refunded", "tenant", t.id, { refundPaise: s.refund_paise, method });
    });
    res.json(settlementView(db.get("SELECT * FROM deposit_settlements WHERE id = ?", s.id)));
  });

  app.get("/api/tenants/:id/settlement/statement", manage, (req, res) => {
    const t = tenantOf(req);
    if (!t) return notFound(res, "Tenant");
    const s = db.get("SELECT * FROM deposit_settlements WHERE tenant_id = ?", t.id);
    if (!s) return notFound(res, "Settlement");
    const view = settlementView(s);
    const org = accounts.getOrg(db, req.orgId);
    const room = db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", t.room_id);
    const out = db.get("SELECT * FROM move_records WHERE tenant_id = ? AND type = 'move_out'", t.id);
    const rows = [
      `<tr><td>Security deposit held</td><td class="num">₹${view.depositHeld.toLocaleString("en-IN")}</td></tr>`,
      `<tr><td>Less: outstanding dues at settlement</td><td class="num">− ₹${view.outstandingDues.toLocaleString("en-IN")}</td></tr>`,
      ...view.deductions.map((d) => `<tr><td>Less: ${escapeHtml(d.reason)}${d.evidenceDocumentId ? " (evidence on file)" : ""}</td><td class="num">− ₹${d.amount.toLocaleString("en-IN")}</td></tr>`),
      `<tr class="total"><td>Refund due to tenant</td><td class="num">₹${view.refund.toLocaleString("en-IN")}</td></tr>`,
      view.tenantOwesAfterDeposit ? `<tr><td>Still owed by tenant after deposit</td><td class="num">₹${view.tenantOwesAfterDeposit.toLocaleString("en-IN")}</td></tr>` : "",
    ].join("");
    res.type("html").send(printablePage(`Deposit settlement – ${t.name}`, `<h1>Security deposit settlement</h1>
      <p class="muted">${escapeHtml(org.name)} · ${escapeHtml(room?.name || "")} ${escapeHtml(room?.label || "")} · ${escapeHtml(t.name)}</p>
      <p>Status: <span class="badge">${escapeHtml(view.status)}</span>${out?.record_date ? ` · Move-out date: ${escapeHtml(out.record_date)}` : ""}</p>
      <table><tbody>${rows}</tbody></table>
      ${view.notes ? `<h2>Notes</h2><p>${escapeHtml(view.notes)}</p>` : ""}
      ${view.refundedAt ? `<p>Refunded on ${escapeHtml(view.refundedAt.slice(0, 10))} by ${escapeHtml(view.refundMethod || "")}${view.refundReference ? `, ref ${escapeHtml(view.refundReference)}` : ""}.</p>` : ""}
      <p class="muted">Deductions are as agreed between owner and tenant; this statement is a record, not a legal determination.</p>`));
  });
}

module.exports = { register, depositHeld, DEFAULT_CHECKLIST };
