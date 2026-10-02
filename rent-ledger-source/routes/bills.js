// Rent, electricity and gas bills - the endpoints the existing screens use,
// now backed by the append-only ledger (amounts edit via adjustments, "mark
// paid" records a payment, "delete" voids). Plus payment proofs and receipts.
const v = require("../lib/validate");
const { toPaise } = require("../lib/money");
const ledger = require("../services/ledger");
const { billsView, rentView, electricityView, gasView, chargeExtras } = require("../services/views");
const { decodeUpload } = require("../services/documents");
const { notifyStaff } = require("../services/notify");
const { audit } = require("../services/audit");
const { requirePermission, ctxOf, notFound, tenantOnly } = require("./common");

const RENT_SCHEMA = {
  month: v.month(), year: v.year(),
  rentAmount: v.money("Rent amount"),
  amountPaid: v.money("Amount paid"),
  dueDate: v.date({ label: "Due date" }),
  paidDate: v.date({ label: "Paid date" }),
  notes: v.text({ label: "Notes", max: 1000 }),
};
const ELECTRICITY_SCHEMA = {
  month: v.month(), year: v.year(),
  prevReading: v.number({ label: "Previous reading", min: 0, max: 1e9 }),
  currReading: v.number({ label: "Current reading", min: 0, max: 1e9 }),
  ratePerUnit: v.money("Rate per unit"),
  paidDate: v.date({ label: "Paid date" }),
  dueDate: v.date({ label: "Due date" }),
  notes: v.text({ label: "Notes", max: 1000 }),
};
const GAS_SCHEMA = {
  month: v.month(), year: v.year(),
  amount: v.money("Due amount"),
  paidDate: v.date({ label: "Paid date" }),
  dueDate: v.date({ label: "Due date" }),
  notes: v.text({ label: "Notes", max: 1000 }),
};

const VIEWS = { rent: rentView, electricity: electricityView, gas: gasView };

function register(app, { db, docs, todayFor, jsonLarge }) {
  const manage = requirePermission("bills.manage");
  const today = (req) => todayFor(req);
  const view = (req, kind, id) => {
    const c = ledger.getCharge(db, req.orgId, id, today(req));
    return VIEWS[kind](c, chargeExtras(db, [id]).get(id));
  };
  const checkKind = (req, res, kind) => {
    const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
    if (!c || c.kind !== kind || c.voided_at) { notFound(res, `${kind[0].toUpperCase()}${kind.slice(1)} entry`); return null; }
    return c;
  };
  const listFor = (kind) => (req, res) => {
    res.json(billsView(db, req.orgId, { kind, roomId: req.query.roomId, tenantId: req.query.tenantId, buildingId: req.query.buildingId }, today(req)));
  };

  // ---------- rent ----------
  app.get("/api/rent", listFor("rent"));

  app.post("/api/rent", manage, (req, res) => {
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "roomId, month and year are required" });
    const data = v.clean(req.body, RENT_SCHEMA);
    const ctx = ctxOf(req);
    const id = db.tx(() => {
      const chargeId = ledger.createCharge(db, ctx, {
        roomId, tenantId: req.body?.tenantId || null, kind: "rent", periodYear: data.year, periodMonth: data.month,
        dueDate: data.dueDate, amountPaise: toPaise(data.rentAmount), notes: data.notes,
      });
      if (data.amountPaid > 0) ledger.setPaidAmount(db, ctx, chargeId, toPaise(data.amountPaid), { receivedOn: data.paidDate || today(req) }, today(req));
      return chargeId;
    });
    res.status(201).json(view(req, "rent", id));
  });

  app.put("/api/rent/:id", manage, (req, res) => {
    const c = checkKind(req, res, "rent");
    if (!c) return;
    const data = v.clean(req.body, RENT_SCHEMA, { partial: true });
    const ctx = ctxOf(req);
    db.tx(() => {
      ledger.updateChargeInfo(db, ctx, c.id, { periodYear: data.year, periodMonth: data.month, dueDate: data.dueDate, notes: data.notes });
      if (data.rentAmount !== undefined) ledger.setChargeAmount(db, ctx, c.id, toPaise(data.rentAmount), "Rent amount edited", today(req));
      if (data.amountPaid !== undefined) ledger.setPaidAmount(db, ctx, c.id, toPaise(data.amountPaid), { receivedOn: data.paidDate || today(req) }, today(req));
    });
    res.json(view(req, "rent", c.id));
  });

  app.delete("/api/rent/:id", manage, (req, res) => {
    const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
    if (!c || c.kind !== "rent") return res.json({ ok: true });
    ledger.voidCharge(db, ctxOf(req), c.id, String(req.body?.reason || "Deleted by owner"), today(req));
    res.json({ ok: true, voided: true });
  });

  // ---------- electricity ----------
  app.get("/api/electricity", listFor("electricity"));

  app.post("/api/electricity", manage, (req, res) => {
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "roomId, month and year are required" });
    const d = v.clean(req.body, ELECTRICITY_SCHEMA);
    const units = Math.max(d.currReading - d.prevReading, 0);
    const amountPaise = Math.round(units * d.ratePerUnit * 100);
    const ctx = ctxOf(req);
    const id = db.tx(() => {
      const chargeId = ledger.createCharge(db, ctx, {
        roomId, tenantId: req.body?.tenantId || null, kind: "electricity", periodYear: d.year, periodMonth: d.month, dueDate: d.dueDate,
        amountPaise, notes: d.notes, details: { prevReading: d.prevReading, currReading: d.currReading, unitsConsumed: units, ratePerUnit: d.ratePerUnit },
      });
      if (d.paidDate && amountPaise > 0) ledger.setPaidAmount(db, ctx, chargeId, amountPaise, { receivedOn: d.paidDate }, today(req));
      return chargeId;
    });
    res.status(201).json(view(req, "electricity", id));
  });

  app.put("/api/electricity/:id", manage, (req, res) => {
    const c = checkKind(req, res, "electricity");
    if (!c) return;
    const d = v.clean(req.body, ELECTRICITY_SCHEMA, { partial: true });
    const details = { ...c.details };
    for (const k of ["prevReading", "currReading", "ratePerUnit"]) if (d[k] !== undefined) details[k] = d[k];
    details.unitsConsumed = Math.max((details.currReading || 0) - (details.prevReading || 0), 0);
    const amountPaise = Math.round(details.unitsConsumed * (details.ratePerUnit || 0) * 100);
    applyUtilityEdit(req, c, d, details, amountPaise);
    res.json(view(req, "electricity", c.id));
  });

  app.delete("/api/electricity/:id", manage, (req, res) => {
    const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
    if (!c || c.kind !== "electricity") return res.json({ ok: true });
    ledger.voidCharge(db, ctxOf(req), c.id, String(req.body?.reason || "Deleted by owner"), today(req));
    res.json({ ok: true, voided: true });
  });

  // ---------- gas ----------
  // Gas is billed through a linked meter + authority; the owner enters the
  // amount the authority shows (no API access to gas companies' billing).
  app.get("/api/gas", listFor("gas"));

  app.post("/api/gas", manage, (req, res) => {
    const roomId = req.body?.roomId;
    if (!roomId) return res.status(400).json({ error: "roomId, month and year are required" });
    const room = db.get("SELECT * FROM rooms WHERE id = ? AND org_id = ?", roomId, req.orgId);
    if (!room) return notFound(res, "Room");
    if (!room.gas_meter_id || !room.gas_authority_id) return res.status(400).json({ error: "Link this room to a gas meter ID and billing authority first." });
    const d = v.clean(req.body, GAS_SCHEMA);
    const authority = db.get("SELECT * FROM authorities WHERE id = ?", room.gas_authority_id);
    const ctx = ctxOf(req);
    const id = db.tx(() => {
      const chargeId = ledger.createCharge(db, ctx, {
        roomId, tenantId: req.body?.tenantId || null, kind: "gas", periodYear: d.year, periodMonth: d.month, dueDate: d.dueDate,
        amountPaise: toPaise(d.amount), notes: d.notes, details: { meterId: room.gas_meter_id, authorityId: room.gas_authority_id, authorityName: authority?.name || "Unknown authority" },
      });
      if (d.paidDate && toPaise(d.amount) > 0) ledger.setPaidAmount(db, ctx, chargeId, toPaise(d.amount), { receivedOn: d.paidDate }, today(req));
      return chargeId;
    });
    res.status(201).json(view(req, "gas", id));
  });

  app.put("/api/gas/:id", manage, (req, res) => {
    const c = checkKind(req, res, "gas");
    if (!c) return;
    const d = v.clean(req.body, GAS_SCHEMA, { partial: true });
    if (req.body?.tenantId !== undefined) {
      const tenantId = req.body.tenantId || null;
      if (tenantId && !db.get("SELECT 1 FROM tenants WHERE id = ? AND room_id = ?", tenantId, c.room_id)) return res.status(400).json({ error: "That tenant does not belong to this room." });
      ledger.updateChargeInfo(db, ctxOf(req), c.id, { tenantId });
    }
    applyUtilityEdit(req, c, d, c.details, d.amount !== undefined ? toPaise(d.amount) : c.amount_paise);
    res.json(view(req, "gas", c.id));
  });

  app.delete("/api/gas/:id", manage, (req, res) => {
    const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
    if (!c || c.kind !== "gas") return res.json({ ok: true });
    ledger.voidCharge(db, ctxOf(req), c.id, String(req.body?.reason || "Deleted by owner"), today(req));
    res.json({ ok: true, voided: true });
  });

  // Electricity/gas edits: amount changes become adjustments; a filled-in
  // "paid date" means paid in full; clearing it undoes a recorded payment.
  function applyUtilityEdit(req, c, d, details, amountPaise) {
    const ctx = ctxOf(req);
    db.tx(() => {
      ledger.updateChargeInfo(db, ctx, c.id, { periodYear: d.year, periodMonth: d.month, notes: d.notes, dueDate: d.dueDate, details });
      if (amountPaise !== c.amount_paise) ledger.setChargeAmount(db, ctx, c.id, amountPaise, "Bill amount edited", today(req));
      const fresh = ledger.getCharge(db, req.orgId, c.id, today(req));
      if (d.paidDate !== undefined) {
        if (d.paidDate && fresh.outstanding_paise > 0) ledger.setPaidAmount(db, ctx, c.id, fresh.amount_paise, { receivedOn: d.paidDate }, today(req));
        else if (!d.paidDate && c.status === "paid" && fresh.paid_paise > 0) ledger.setPaidAmount(db, ctx, c.id, 0, {}, today(req));
      }
    });
  }

  // ---------- payment proofs (tenant uploads) ----------
  // A proof is *unverified evidence*: it never marks a bill paid by itself.
  // The owner reviews it and, if the money arrived, records the payment.
  const kindOfCollection = { rent: "rent", electricity: "electricity", gas: "gas" };
  for (const kind of Object.keys(kindOfCollection)) {
    app.post(`/api/tenant/${kind}/:id/receipt`, tenantOnly, jsonLarge, (req, res) => {
      const c = ledger.getCharge(db, req.orgId, req.params.id, today(req));
      if (!c || c.kind !== kind || c.voided_at || c.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "This bill is not available for your tenancy." });
      const upload = decodeUpload(req.body);
      if (!upload) return res.status(400).json({ error: "Upload a valid JPG, PNG, WEBP image or PDF receipt up to 10 MB." });
      const docId = db.tx(() => {
        // Earlier unreviewed proofs for this bill are replaced (kept on record as deleted).
        for (const old of db.all("SELECT id FROM documents WHERE entity_type = 'charge' AND entity_id = ? AND kind = 'payment_proof' AND status = 'active' AND review_status = 'unverified'", c.id)) docs.remove(db, req.orgId, old.id);
        const id = docs.save(db, ctxOf(req), { entityType: "charge", entityId: c.id, kind: "payment_proof", upload, visibleToTenant: true, reviewStatus: "unverified" });
        notifyStaff(db, req.orgId, { kind: "payment_proof", title: "Payment proof uploaded", body: `A tenant uploaded proof for a ${kind} bill. Review it before recording the payment.`, link: `room:${c.room_id}` });
        return id;
      });
      const d = db.get("SELECT * FROM documents WHERE id = ?", docId);
      res.status(201).json({ receipt: { id: d.id, originalName: d.original_name, mimeType: d.mime_type, size: d.size_bytes, uploadedAt: d.created_at, reviewStatus: d.review_status } });
    });
  }

  // Owner accepts a proof: records the payment (as "recorded", linked to the
  // evidence) or rejects it.
  app.post("/api/receipts/:docId/review", requirePermission("payments.record"), (req, res) => {
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ? AND kind = 'payment_proof' AND status = 'active'", req.params.docId, req.orgId);
    if (!doc) return notFound(res, "Payment proof");
    const decision = req.body?.decision;
    if (!["accept", "reject"].includes(decision)) return res.status(400).json({ error: "Choose accept or reject." });
    const ctx = ctxOf(req);
    const result = db.tx(() => {
      if (decision === "reject") {
        db.run("UPDATE documents SET review_status = 'rejected' WHERE id = ?", doc.id);
        audit(db, ctx, "payment_proof.rejected", "document", doc.id, { reason: req.body?.reason || "" });
        return { status: "rejected" };
      }
      const c = ledger.getCharge(db, req.orgId, doc.entity_id, today(req));
      if (!c || c.voided_at) throw Object.assign(new Error("The bill for this proof no longer exists."), { status: 409, expose: true });
      const amountPaise = req.body?.amount !== undefined ? toPaise(v.money("Amount")(req.body.amount)) : c.outstanding_paise;
      if (amountPaise <= 0) throw Object.assign(new Error("This bill is already paid."), { status: 409, expose: true });
      const method = ["upi", "bank_transfer", "cash", "cheque", "other"].includes(req.body?.method) ? req.body.method : "upi";
      const payment = ledger.recordPayment(db, ctx, {
        tenantId: c.tenant_id, roomId: c.room_id, amountPaise, method, reference: req.body?.reference || "", receivedOn: v.date({ label: "Received on" })(req.body?.receivedOn) || today(req),
        verification: "recorded", source: "proof", evidenceDocumentId: doc.id, idempotencyKey: `proof:${doc.id}`,
        allocations: [{ chargeId: c.id, amountPaise: Math.min(amountPaise, c.outstanding_paise) }],
      }, today(req));
      db.run("UPDATE documents SET review_status = 'accepted' WHERE id = ?", doc.id);
      return { status: "accepted", paymentId: payment.paymentId };
    });
    res.json(result);
  });

  // Payment proofs (legacy URL kept for the existing screens).
  app.get("/api/receipts/:receiptId", (req, res) => {
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ? AND status = 'active'", req.params.receiptId, req.orgId);
    if (!doc) return res.status(404).json({ error: "Receipt not found" });
    if (req.user.role === "tenant") {
      const c = doc.entity_type === "charge" ? db.get("SELECT tenant_id FROM charges WHERE id = ?", doc.entity_id) : null;
      if (!c || c.tenant_id !== req.user.tenant_id) return res.status(404).json({ error: "Receipt not found" });
    }
    const file = docs.filePath(doc);
    if (!file) return res.status(404).json({ error: "Receipt file is unavailable" });
    res.type(doc.mime_type);
    res.setHeader("Content-Disposition", `inline; filename="${doc.original_name.replace(/["\\\r\n]/g, "")}"`);
    res.sendFile(file);
  });
}

module.exports = { register };
