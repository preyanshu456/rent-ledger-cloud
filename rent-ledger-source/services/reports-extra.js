// Extra reports: occupancy, rent roll, defaulters, late fees and discounts,
// package charges, leads, bookings, attendance and meals. Same shape as the
// reports in finance.js: { title, columns, rows, moneyColumns }.
const ledger = require("./ledger");
const { occupancy } = require("./occupancy");
const { depositHeld } = require("../routes/tenancy");

const rupees = (p) => Math.round(p) / 100;
const label = (s) => String(s || "").replace(/_/g, " ");

const TYPES = {
  occupancy: "Occupancy (beds)", "rent-roll": "Rent roll", defaulters: "Defaulters", "late-fees-discounts": "Late fees and discounts",
  "package-charges": "Package charges", leads: "Leads", bookings: "Bookings", "hostel-attendance": "Hostel attendance", "meal-counts": "Meal counts",
};

function report(db, orgId, type, query, today, range) {
  const buildingId = query.buildingId || undefined;
  const inBuilding = (alias = "r") => (buildingId ? ` AND ${alias}.building_id = :buildingId` : "");
  const params = { orgId, buildingId, from: `${range.from}-01`, to: `${range.to}-31` };
  // node:sqlite refuses named parameters the query doesn't use.
  const all = (sql) => db.all(sql, Object.fromEntries(Object.entries(params).filter(([k]) => new RegExp(`:${k}\\b`).test(sql))));
  switch (type) {
    case "occupancy": {
      const o = occupancy(db, orgId, { buildingId });
      const rows = [];
      for (const b of o.buildings) for (const f of b.floors) for (const r of f.rooms) for (const bed of r.beds) {
        rows.push([b.name, f.floorNumber, r.label, bed.label, r.sharing, label(bed.status), bed.tenant?.name || "", bed.tenant?.leavingOn || "", bed.booking ? `${bed.booking.name} from ${bed.booking.joiningOn}` : "", bed.monthlyRent]);
      }
      rows.push(["Total", "", "", `${o.summary.beds} beds`, "", `${o.summary.occupancyRate}% occupied`, `${o.summary.occupied} occupied`, `${o.summary.notice} on notice`, `${o.summary.booked} booked`, ""]);
      return { title: "Occupancy (beds)", columns: ["Property", "Floor", "Room", "Bed", "Sharing", "Status", "Tenant", "Leaving on", "Booking", "Bed rent"], rows, moneyColumns: [] };
    }
    case "rent-roll": {
      const tenants = all(`SELECT t.*, r.label AS room, r.monthly_rent_paise AS room_rent, b.name AS building, bd.label AS bed, bd.monthly_rent_paise AS bed_rent,
          (SELECT rent_paise FROM leases l WHERE l.tenant_id = t.id AND l.status = 'active') AS lease_rent
        FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id LEFT JOIN beds bd ON bd.id = t.bed_id
        WHERE t.org_id = :orgId AND t.active = 1${inBuilding()} ORDER BY b.name, r.floor_number, r.label, bd.label`);
      const rows = tenants.map((t) => {
        const bal = ledger.tenantBalance(db, orgId, t.id, today);
        const rent = t.lease_rent ?? t.bed_rent ?? t.room_rent ?? 0;
        return [t.building, t.room, t.bed || "", t.name, t.mobile || "", t.move_in_date || "", t.leaving_on || "", rupees(rent), rupees(depositHeld(db, t.id).heldPaise), rupees(bal.outstandingPaise), rupees(bal.creditPaise)];
      });
      return { title: "Rent roll", columns: ["Property", "Room", "Bed", "Tenant", "Mobile", "Moved in", "Leaving on", "Monthly rent", "Deposit held", "Due now", "Advance"], rows, moneyColumns: [7, 8, 9, 10] };
    }
    case "defaulters": {
      const rows = [];
      for (const t of all(`SELECT t.*, r.label AS room, b.name AS building FROM tenants t JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id WHERE t.org_id = :orgId AND t.active = 1${inBuilding()}`)) {
        const open = ledger.listCharges(db, orgId, { tenantId: t.id, status: "open" }, today).filter((c) => c.due_date && c.due_date < today);
        if (!open.length) continue;
        const oldest = open.map((c) => c.due_date).sort()[0];
        const days = Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000);
        rows.push([t.name, t.mobile || "", t.building, t.room, open.length, oldest, days, rupees(open.reduce((s, c) => s + c.outstanding_paise, 0))]);
      }
      rows.sort((a, b) => b[6] - a[6]);
      return { title: "Defaulters (overdue bills)", columns: ["Tenant", "Mobile", "Property", "Room", "Overdue bills", "Oldest due date", "Days overdue", "Overdue amount"], rows, moneyColumns: [7] };
    }
    case "late-fees-discounts": {
      const rows = [];
      for (const c of all(`SELECT c.id FROM charges c JOIN rooms r ON r.id = c.room_id WHERE c.org_id = :orgId AND c.kind = 'late_fee' AND c.voided_at IS NULL AND substr(c.created_at, 1, 10) BETWEEN :from AND :to${inBuilding()}`)) {
        const fee = ledger.getCharge(db, orgId, c.id, today);
        rows.push([fee.created_at.slice(0, 10), db.get("SELECT name FROM tenants WHERE id = ?", fee.tenant_id)?.name || "", "Late fee", fee.description, fee.status, rupees(fee.amount_paise)]);
      }
      for (const a of all(`SELECT a.*, c.tenant_id, c.kind AS charge_kind, c.period_year, c.period_month, c.description FROM charge_adjustments a JOIN charges c ON c.id = a.charge_id JOIN rooms r ON r.id = c.room_id
                               WHERE a.org_id = :orgId AND a.kind = 'discount' AND substr(a.created_at, 1, 10) BETWEEN :from AND :to${inBuilding()}`)) {
        const offer = db.get("SELECT status, valid_until FROM discount_offers WHERE charge_id = ? AND amount_paise = ? ORDER BY created_at DESC LIMIT 1", a.charge_id, -a.amount_paise);
        rows.push([a.created_at.slice(0, 10), db.get("SELECT name FROM tenants WHERE id = ?", a.tenant_id)?.name || "", "Discount", `${ledger.chargeLabel({ kind: a.charge_kind, period_year: a.period_year, period_month: a.period_month, description: a.description })}: ${a.reason}`, offer ? `${offer.status}${offer.valid_until ? ` (pay by ${offer.valid_until})` : ""}` : "given", rupees(-a.amount_paise)]);
      }
      rows.sort((x, y) => String(y[0]).localeCompare(String(x[0])));
      return { title: "Late fees and discounts", columns: ["Date", "Tenant", "Type", "Bill", "Status", "Amount"], rows, moneyColumns: [5] };
    }
    case "package-charges": {
      const rows = all(`SELECT c.id FROM charges c JOIN rooms r ON r.id = c.room_id WHERE c.org_id = :orgId AND c.source IN ('package', 'split') AND c.voided_at IS NULL AND substr(c.created_at, 1, 10) BETWEEN :from AND :to${inBuilding()} ORDER BY c.created_at DESC`)
        .map((row) => {
          const c = ledger.getCharge(db, orgId, row.id, today);
          const room = db.get("SELECT r.label, b.name FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", c.room_id) || {};
          return [c.created_at.slice(0, 10), room.name, room.label, db.get("SELECT name FROM tenants WHERE id = ?", c.tenant_id)?.name || "", c.description, c.status, rupees(c.amount_paise), rupees(c.paid_paise), rupees(c.outstanding_paise)];
        });
      return { title: "Package and shared-bill charges", columns: ["Date", "Property", "Room", "Tenant", "Charge", "Status", "Amount", "Paid", "Due"], rows, moneyColumns: [6, 7, 8] };
    }
    case "leads": {
      const rows = all(`SELECT l.*, b.name AS building FROM leads l LEFT JOIN buildings b ON b.id = l.building_id WHERE l.org_id = :orgId AND substr(l.created_at, 1, 10) BETWEEN :from AND :to ${buildingId ? "AND l.building_id = :buildingId" : ""} ORDER BY l.created_at DESC`)
        .map((l) => [l.created_at.slice(0, 10), l.name, l.mobile, l.building || "", label(l.source), label(l.stage), l.visit_on, l.move_in_from, l.preference, l.lost_reason, rupees(l.budget_paise)]);
      return { title: "Leads", columns: ["Added", "Name", "Mobile", "Property", "Source", "Stage", "Visit", "Move-in from", "Looking for", "Why lost", "Budget"], rows, moneyColumns: [10] };
    }
    case "bookings": {
      const rows = all(`SELECT bk.*, r.label AS room, b.name AS building, bd.label AS bed FROM bookings bk JOIN rooms r ON r.id = bk.room_id JOIN buildings b ON b.id = r.building_id JOIN beds bd ON bd.id = bk.bed_id
                           WHERE bk.org_id = :orgId AND (bk.joining_on BETWEEN :from AND :to OR bk.status IN ('pending','confirmed'))${inBuilding()} ORDER BY bk.joining_on`)
        .map((bk) => [bk.joining_on, bk.name, bk.mobile, bk.building, bk.room, bk.bed, label(bk.status), rupees(bk.monthly_rent_paise), rupees(bk.deposit_paise), rupees(bk.token_paise)]);
      return { title: "Bookings", columns: ["Joining on", "Name", "Mobile", "Property", "Room", "Bed", "Status", "Rent", "Deposit", "Token"], rows, moneyColumns: [7, 8, 9] };
    }
    case "hostel-attendance": {
      const rows = all(`SELECT t.name, r.label AS room, b.name AS building,
          SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'leave') AS leave
        FROM attendance a JOIN tenants t ON t.id = a.tenant_id JOIN rooms r ON r.id = t.room_id JOIN buildings b ON b.id = r.building_id
        WHERE a.org_id = :orgId AND a.att_date BETWEEN :from AND :to${inBuilding()} GROUP BY t.id ORDER BY b.name, r.label, t.name`)
        .map((x) => [x.building, x.room, x.name, x.present, x.late, x.absent, x.leave]);
      return { title: "Hostel attendance", columns: ["Property", "Room", "Tenant", "Present", "Late", "Absent", "On leave"], rows, moneyColumns: [] };
    }
    case "meal-counts": {
      const rows = all(`SELECT m.meal_date, m.meal, b.name AS building, SUM(m.going) AS going, SUM(1 - m.going) AS skipping, SUM(m.served) AS served, ROUND(AVG(m.rating), 1) AS rating
        FROM meal_marks m JOIN buildings b ON b.id = m.building_id WHERE m.org_id = :orgId AND m.meal_date BETWEEN :from AND :to ${buildingId ? "AND m.building_id = :buildingId" : ""}
        GROUP BY m.meal_date, m.meal, m.building_id ORDER BY m.meal_date DESC, b.name`)
        .map((x) => [x.meal_date, x.building, x.meal, x.going, x.skipping, x.served, x.rating ?? ""]);
      return { title: "Meal counts", columns: ["Date", "Property", "Meal", "Said yes", "Said no", "Served", "Average rating"], rows, moneyColumns: [] };
    }
    default: return null;
  }
}

module.exports = { report, TYPES };
