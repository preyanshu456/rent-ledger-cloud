// Tenant self-service. Every query is scoped to the signed-in tenant's own
// tenancy on the server; hiding buttons in the browser is not relied on.
const v = require("../lib/validate");
const { toRupees } = require("../lib/money");
const ledger = require("../services/ledger");
const { billsView } = require("../services/views");
const { documentView } = require("../services/documents");
const { notifyStaff } = require("../services/notify");
const { tenantPendingUpi } = require("./payments");
const upi = require("../services/upi");
const { tenantOnly, escapeHtml, printablePage } = require("./common");

function register(app, { db, todayFor }) {
  function tenancy(req, res) {
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.user.tenant_id, req.orgId);
    if (!tenant) { res.status(404).json({ error: "No active tenancy found" }); return null; }
    const room = db.get("SELECT * FROM rooms WHERE id = ?", tenant.room_id);
    if (!room) { res.status(404).json({ error: "Your room could not be found. Please contact your owner." }); return null; }
    const building = db.get("SELECT * FROM buildings WHERE id = ?", room.building_id);
    return { tenant, room, building };
  }

  app.get("/api/tenant/portal", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    const today = todayFor(req);
    const scope = { tenantId: t.tenant.id, roomId: t.room.id };
    const byKind = (kind) => billsView(db, req.orgId, { ...scope, kind }, today);
    const other = billsView(db, req.orgId, { ...scope, kinds: ["maintenance", "late_fee", "damage", "other"] }, today);
    const balance = ledger.tenantBalance(db, req.orgId, t.tenant.id, today);
    const upcoming = ledger.listCharges(db, req.orgId, { tenantId: t.tenant.id, status: "open" }, today)
      .filter((c) => c.due_date).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5)
      .map((c) => ({ id: c.id, kind: c.kind, dueDate: c.due_date, amount: toRupees(c.outstanding_paise), label: ledger.chargeLabel(c), overdue: c.due_date < today }));
    const lease = db.get("SELECT * FROM leases WHERE tenant_id = ? AND status = 'active'", t.tenant.id);
    const owner = db.get("SELECT name, contact FROM users WHERE org_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", req.orgId);
    res.json({
      tenant: { name: t.tenant.name },
      room: { label: t.room.label, floorNumber: t.room.floor_number, monthlyRent: toRupees(t.room.monthly_rent_paise), gasMeterId: t.room.gas_meter_id || "", gasAuthorityId: t.room.gas_authority_id || null },
      building: { name: t.building?.name || "", address: t.building?.address || "" },
      rent: byKind("rent"), electricity: byKind("electricity"), gas: byKind("gas"), other,
      // UPI Intent: the Pay buttons show once the owner has a UPI ID saved.
      payments: (() => {
        const payee = upi.payeeFor(db, t.building?.org_id || req.orgId);
        return { enabled: Boolean(payee), method: "upi", payeeName: payee?.name || "", upiId: payee?.vpa || "", pending: tenantPendingUpi(db, req.orgId, t.tenant.id) };
      })(),
      balance: { outstanding: toRupees(balance.outstandingPaise), overdue: toRupees(balance.overduePaise), credit: toRupees(balance.creditPaise) },
      upcoming,
      lease: lease ? { startDate: lease.start_date, endDate: lease.end_date, rent: toRupees(lease.rent_paise), dueDay: lease.due_day, frequency: lease.frequency } : null,
      owner: owner ? { name: owner.name } : null,
    });
  });

  // Full statement with running balance, as JSON or a printable page.
  app.get("/api/tenant/statement", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    const st = ledger.tenantStatement(db, req.orgId, t.tenant.id, todayFor(req));
    if (req.query.format === "html") {
      const rows = st.entries.map((e) => `<tr><td>${escapeHtml(e.date)}</td><td>${escapeHtml(e.description)}</td><td class="num">${e.amountPaise > 0 ? "₹" + toRupees(e.amountPaise).toLocaleString("en-IN") : ""}</td><td class="num">${e.amountPaise < 0 ? "₹" + toRupees(-e.amountPaise).toLocaleString("en-IN") : ""}</td><td class="num">₹${toRupees(e.balancePaise).toLocaleString("en-IN")}</td></tr>`).join("");
      return res.type("html").send(printablePage("Statement", `<h1>Statement of account</h1><p class="muted">${escapeHtml(t.tenant.name)} · ${escapeHtml(t.building?.name || "")} ${escapeHtml(t.room.label)} · ${escapeHtml(todayFor(req))}</p>
        <table><thead><tr><th>Date</th><th>Details</th><th class="num">Charged</th><th class="num">Paid</th><th class="num">Balance</th></tr></thead><tbody>${rows}</tbody></table>
        <p>Outstanding: <strong>₹${toRupees(st.balance.outstandingPaise).toLocaleString("en-IN")}</strong>${st.balance.creditPaise ? ` · Credit: ₹${toRupees(st.balance.creditPaise).toLocaleString("en-IN")}` : ""}</p>`));
    }
    res.json({ entries: st.entries.map((e) => ({ ...e, amount: toRupees(e.amountPaise), balance: toRupees(e.balancePaise) })), balance: Object.fromEntries(Object.entries(st.balance).map(([k, val]) => [k.replace(/Paise$/, ""), toRupees(val)])) });
  });

  // Payments made by this tenant, each with a printable receipt.
  app.get("/api/tenant/receipts", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    res.json(ledger.listPayments(db, req.orgId, { tenantId: t.tenant.id }).map((p) => ({
      id: p.id, amount: toRupees(p.amount_paise), method: p.method, receivedOn: p.received_on, verification: p.verification, reversed: p.reversed, reference: p.reference,
    })));
  });

  // Lease documents and other files the owner shared with this tenant.
  app.get("/api/tenant/documents", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    const leaseIds = db.all("SELECT id FROM leases WHERE tenant_id = ?", t.tenant.id).map((l) => l.id);
    const ids = [t.tenant.id, ...leaseIds];
    const ph = ids.map(() => "?").join(",");
    const docs = db.all(`SELECT * FROM documents WHERE org_id = ? AND status = 'active' AND visible_to_tenant = 1 AND entity_type IN ('tenant','lease') AND entity_id IN (${ph}) ORDER BY created_at DESC`, req.orgId, ...ids);
    res.json(docs.map(documentView));
  });

  // Messages with the owner (approved channel inside the app).
  app.get("/api/tenant/messages", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    db.run("UPDATE messages SET read_at = ? WHERE tenant_id = ? AND direction = 'to_tenant' AND read_at IS NULL", db.nowIso(), t.tenant.id);
    res.json(db.all("SELECT id, direction, body, created_at FROM messages WHERE tenant_id = ? ORDER BY created_at", t.tenant.id).map((m) => ({ id: m.id, direction: m.direction, body: m.body, createdAt: m.created_at })));
  });

  app.post("/api/tenant/messages", tenantOnly, (req, res) => {
    const t = tenancy(req, res);
    if (!t) return;
    const body = v.text({ label: "Message", max: 2000, required: true })(req.body?.body);
    db.run("INSERT INTO messages (id, org_id, tenant_id, direction, body, created_by, created_at) VALUES (?,?,?,?,?,?,?)", db.id(), req.orgId, t.tenant.id, "to_owner", body, req.user.id, db.nowIso());
    notifyStaff(db, req.orgId, { kind: "message", title: `Message from ${t.tenant.name}`, body: body.slice(0, 200), link: `tenant:${t.tenant.id}` });
    res.status(201).json({ ok: true });
  });
}

module.exports = { register };
