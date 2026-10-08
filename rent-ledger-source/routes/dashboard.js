// The existing dashboard summary, now computed from the ledger.
const { toRupees } = require("../lib/money");
const { currentPeriod } = require("../lib/dates");
const ledger = require("../services/ledger");
const { razorpayConfigured } = require("./payments");
const { orgTimeZone } = require("./common");

function register(app, { db, todayFor }) {
  app.get("/api/dashboard", (req, res) => {
    const today = todayFor(req);
    const { month, year } = currentPeriod(orgTimeZone(db, req.orgId));
    const rooms = db.all("SELECT * FROM rooms WHERE org_id = ? AND status <> 'archived'", req.orgId);
    const all = ledger.listCharges(db, req.orgId, {}, today);
    const thisMonth = all.filter((c) => c.period_year === year && c.period_month === month);
    const sum = (list, field) => list.reduce((s, c) => s + c[field], 0);
    const of = (list, kind) => list.filter((c) => c.kind === kind);
    const gasBillsToEnter = rooms
      .filter((r) => r.gas_meter_id && r.gas_authority_id)
      .filter((r) => !thisMonth.some((c) => c.kind === "gas" && c.room_id === r.id))
      .map((r) => {
        const authority = db.get("SELECT * FROM authorities WHERE id = ?", r.gas_authority_id);
        const building = db.get("SELECT name FROM buildings WHERE id = ?", r.building_id);
        const tenant = db.get("SELECT id, name FROM tenants WHERE room_id = ? AND active = 1", r.id);
        return { roomId: r.id, roomLabel: r.label, buildingName: building?.name || "", meterId: r.gas_meter_id, authorityName: authority?.name || "Unknown authority", billUrl: authority?.bill_url || "", tenantId: tenant?.id || null, tenantName: tenant?.name || "" };
      });
    const occupied = rooms.filter((r) => r.status === "occupied").length;
    // Money actually received this month, whichever month's bills it paid
    // (deposit adjustments and reversed payments are not new money).
    const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-31`;
    const received = db.get(`SELECT COALESCE(SUM(p.amount_paise), 0) AS n FROM payments p
      WHERE p.org_id = ? AND p.received_on BETWEEN ? AND ? AND p.method <> 'deposit_adjustment'
        AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)`, req.orgId, monthStart, monthEnd).n;
    res.json({
      totalBuildings: db.get("SELECT COUNT(*) AS n FROM buildings WHERE org_id = ? AND status = 'active'", req.orgId).n,
      totalRooms: rooms.length,
      occupiedRooms: occupied,
      vacantRooms: rooms.length - occupied,
      month, year,
      receivedThisMonth: toRupees(received),
      rentCollected: toRupees(sum(of(thisMonth, "rent"), "paid_paise")),
      rentPending: toRupees(sum(of(thisMonth, "rent"), "outstanding_paise")),
      elecCollected: toRupees(sum(of(thisMonth, "electricity"), "paid_paise")),
      elecPending: toRupees(sum(of(thisMonth, "electricity"), "outstanding_paise")),
      gasCollected: toRupees(sum(of(thisMonth, "gas"), "paid_paise")),
      gasPending: toRupees(sum(of(thisMonth, "gas"), "outstanding_paise")),
      outstandingRentEntries: of(all, "rent").filter((c) => c.outstanding_paise > 0).length,
      outstandingElectricityEntries: of(all, "electricity").filter((c) => c.outstanding_paise > 0).length,
      outstandingGasEntries: of(all, "gas").filter((c) => c.outstanding_paise > 0).length,
      overdueTotal: toRupees(all.filter((c) => c.status === "overdue" || (c.status === "partial" && c.due_date && c.due_date < today)).reduce((s, c) => s + c.outstanding_paise, 0)),
      gasBillsToEnter,
      onlinePaymentsEnabled: razorpayConfigured(db, req.orgId),
    });
  });
}

module.exports = { register };
