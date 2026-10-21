// Leads (enquiries) and bookings (a bed held for a future move-in).
//
// A lead moves through stages: new → contacted → visit scheduled → visited →
// token paid → won (or lost). A booking holds one bed; on the joining date
// the owner taps "Move in", which creates the tenant, records the token as
// an advance payment and prepares a draft lease.
const v = require("../lib/validate");
const { toPaise, toRupees } = require("../lib/money");
const ledger = require("../services/ledger");
const accounts = require("../services/accounts");
const { audit } = require("../services/audit");
const { tenantView } = require("../services/views");
const { notifyStaff } = require("../services/notify");
const occ = require("../services/occupancy");
const { waLink } = require("../services/dues");
const { refreshRoomStatus } = require("./properties");
const { requirePermission, ctxOf, notFound } = require("./common");

const SOURCES = ["walk_in", "phone", "whatsapp", "website", "referral", "broker", "online_listing", "other"];
const STAGES = ["new", "contacted", "visit_scheduled", "visited", "token_paid", "won", "lost"];
const METHODS = ["cash", "upi", "bank_transfer", "cheque", "other"];

const LEAD_SCHEMA = {
  name: v.text({ label: "Name", max: 120, required: true }),
  mobile: v.mobile({ label: "Mobile number" }),
  email: v.email(),
  source: (x) => (SOURCES.includes(x) ? x : "walk_in"),
  stage: (x) => (STAGES.includes(x) ? x : "new"),
  visitOn: v.date({ label: "Visit date" }),
  moveInFrom: v.date({ label: "Wants to move in from" }),
  budget: v.money("Budget"),
  preference: v.text({ label: "Looking for", max: 200 }),
  notes: v.text({ label: "Notes", max: 1000 }),
  lostReason: v.text({ label: "Why lost", max: 200 }),
  nextFollowUp: v.date({ label: "Next follow-up" }),
};
const LEAD_COLUMNS = { name: "name", mobile: "mobile", email: "email", source: "source", stage: "stage", visitOn: "visit_on", moveInFrom: "move_in_from", preference: "preference", notes: "notes", lostReason: "lost_reason", nextFollowUp: "next_follow_up" };

const BOOKING_SCHEMA = {
  name: v.text({ label: "Name", max: 120, required: true }),
  mobile: v.mobile({ label: "Mobile number", required: true }),
  email: v.email(),
  joiningOn: (x) => { const d = v.date({ label: "Joining date" })(x); if (!d) throw new v.ValidationError("Joining date is required."); return d; },
  monthlyRent: v.money("Monthly rent"),
  deposit: v.money("Deposit"),
  token: v.money("Token amount"),
  tokenMethod: (x) => (x ? (METHODS.includes(x) ? x : "other") : ""),
  tokenReference: v.text({ label: "Token reference", max: 120 }),
  tokenReceivedOn: v.date({ label: "Token received on" }),
  notes: v.text({ label: "Notes", max: 1000 }),
};

function leadView(db, l, today) {
  const b = l.building_id ? db.get("SELECT name FROM buildings WHERE id = ?", l.building_id) : null;
  const booking = db.get("SELECT id, status, joining_on FROM bookings WHERE lead_id = ? ORDER BY created_at DESC LIMIT 1", l.id);
  return {
    id: l.id, buildingId: l.building_id || null, buildingName: b?.name || "", name: l.name, mobile: l.mobile || "", email: l.email || "",
    source: l.source, stage: l.stage, visitOn: l.visit_on || "", moveInFrom: l.move_in_from || "", budget: toRupees(l.budget_paise),
    preference: l.preference || "", notes: l.notes || "", lostReason: l.lost_reason || "", nextFollowUp: l.next_follow_up || "",
    followUpDue: Boolean(l.next_follow_up && l.next_follow_up <= today && !["won", "lost"].includes(l.stage)),
    createdAt: l.created_at, updatedAt: l.updated_at || l.created_at,
    booking: booking ? { id: booking.id, status: booking.status, joiningOn: booking.joining_on } : null,
    whatsapp: l.mobile ? waLink(l.mobile, `Hello ${l.name}, thank you for your interest${b ? ` in ${b.name}` : ""}.`) : "",
  };
}

function bookingView(db, b, today) {
  const bed = db.get("SELECT label FROM beds WHERE id = ?", b.bed_id);
  const room = db.get("SELECT r.label, r.floor_number, b.name, b.id AS building_id FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.id = ?", b.room_id) || {};
  const bedTenant = db.get("SELECT name, leaving_on FROM tenants WHERE bed_id = ? AND active = 1", b.bed_id);
  return {
    id: b.id, leadId: b.lead_id || null, bedId: b.bed_id, roomId: b.room_id, bedLabel: bed?.label || "", roomLabel: room.label || "", floorNumber: room.floor_number ?? null,
    buildingId: room.building_id || null, buildingName: room.name || "", name: b.name, mobile: b.mobile || "", email: b.email || "", joiningOn: b.joining_on,
    monthlyRent: toRupees(b.monthly_rent_paise), deposit: toRupees(b.deposit_paise), token: toRupees(b.token_paise), tokenMethod: b.token_method || "",
    tokenReference: b.token_reference || "", tokenReceivedOn: b.token_received_on || "", status: b.status, tenantId: b.tenant_id || null, notes: b.notes || "",
    cancelReason: b.cancel_reason || "", createdAt: b.created_at,
    bedFreeNow: !bedTenant, currentOccupant: bedTenant ? { name: bedTenant.name, leavingOn: bedTenant.leaving_on || "" } : null,
    dueToMoveIn: ["pending", "confirmed"].includes(b.status) && b.joining_on <= today,
    whatsapp: b.mobile ? waLink(b.mobile, `Hello ${b.name}, your bed ${bed?.label || ""} in ${room.name || ""} ${room.label || ""} is booked from ${b.joining_on}.`) : "",
  };
}

function addEvent(db, orgId, leadId, kind, body, userId) {
  db.run("INSERT INTO lead_events (id, org_id, lead_id, kind, body, created_by, created_at) VALUES (?,?,?,?,?,?,?)", db.id(), orgId, leadId, kind, String(body || "").slice(0, 1000), userId || null, db.nowIso());
}

// Checks a bed can be booked from `joiningOn`. A bed someone still lives in
// can be booked only if they gave notice and leave before that date.
function bookableBed(db, orgId, bedId, joiningOn, exceptBookingId) {
  const bed = db.get("SELECT * FROM beds WHERE id = ? AND org_id = ?", bedId || "", orgId);
  if (!bed) throw Object.assign(new Error("Bed not found"), { status: 404, expose: true });
  if (bed.disabled) throw Object.assign(new Error("That bed is marked as not for rent."), { status: 409, expose: true });
  const room = db.get("SELECT * FROM rooms WHERE id = ?", bed.room_id);
  if (room.status === "archived") throw Object.assign(new Error("That room is archived."), { status: 409, expose: true });
  if (db.get("SELECT 1 FROM bookings WHERE bed_id = ? AND status IN ('pending','confirmed') AND id <> ?", bed.id, exceptBookingId || "")) throw Object.assign(new Error("That bed is already booked for someone else."), { status: 409, expose: true });
  const living = db.get("SELECT name, leaving_on FROM tenants WHERE bed_id = ? AND active = 1", bed.id);
  if (living && (!living.leaving_on || living.leaving_on > joiningOn)) {
    throw Object.assign(new Error(living.leaving_on ? `${living.name} leaves on ${living.leaving_on}. Choose a joining date on or after that.` : `${living.name} lives in that bed. Record their notice first, or choose another bed.`), { status: 409, expose: true });
  }
  return { bed, room };
}

function register(app, { db, todayFor }) {
  const manage = requirePermission("tenants.manage");

  // ---------- leads ----------
  app.get("/api/leads", (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.stage === "open") where.push("stage NOT IN ('won','lost')");
    else if (STAGES.includes(req.query.stage)) { where.push("stage = :stage"); params.stage = req.query.stage; }
    if (req.query.buildingId) { where.push("building_id = :buildingId"); params.buildingId = String(req.query.buildingId); }
    if (req.query.q) { where.push("(name LIKE :q OR mobile LIKE :q)"); params.q = `%${String(req.query.q).slice(0, 60)}%`; }
    const today = todayFor(req);
    const rows = db.all(`SELECT * FROM leads WHERE ${where.join(" AND ")} ORDER BY CASE WHEN next_follow_up <> '' AND next_follow_up <= :today THEN 0 ELSE 1 END, created_at DESC LIMIT 500`, { ...params, today }).map((l) => leadView(db, l, today));
    const counts = Object.fromEntries(STAGES.map((s) => [s, 0]));
    for (const r of db.all("SELECT stage, COUNT(*) AS n FROM leads WHERE org_id = ? GROUP BY stage", req.orgId)) counts[r.stage] = r.n;
    res.json({ leads: rows, counts, stages: STAGES, sources: SOURCES });
  });

  app.get("/api/leads/:id", (req, res) => {
    const l = db.get("SELECT * FROM leads WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!l) return notFound(res, "Lead");
    const events = db.all("SELECT e.*, u.name AS author FROM lead_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.lead_id = ? ORDER BY e.created_at DESC", l.id)
      .map((e) => ({ id: e.id, kind: e.kind, body: e.body, author: e.author || "", createdAt: e.created_at }));
    res.json({ ...leadView(db, l, todayFor(req)), events });
  });

  app.post("/api/leads", manage, (req, res) => {
    const d = v.clean(req.body, LEAD_SCHEMA);
    const buildingId = req.body?.buildingId || null;
    if (buildingId && !db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", buildingId, req.orgId)) return notFound(res, "Building");
    if (!d.mobile && !d.email) return res.status(400).json({ error: "Add a mobile number or email so you can contact them." });
    const id = db.id();
    db.run(`INSERT INTO leads (id, org_id, building_id, name, mobile, email, source, stage, visit_on, move_in_from, budget_paise, preference, notes, lost_reason, next_follow_up, created_by, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, req.orgId, buildingId, d.name, d.mobile, d.email, d.source, d.stage, d.visitOn, d.moveInFrom, toPaise(d.budget), d.preference, d.notes, d.lostReason, d.nextFollowUp, req.user.id, db.nowIso());
    addEvent(db, req.orgId, id, "created", `Lead added (${d.source.replace(/_/g, " ")})`, req.user.id);
    audit(db, ctxOf(req), "lead.created", "lead", id, { source: d.source });
    res.status(201).json(leadView(db, db.get("SELECT * FROM leads WHERE id = ?", id), todayFor(req)));
  });

  app.put("/api/leads/:id", manage, (req, res) => {
    const l = db.get("SELECT * FROM leads WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!l) return notFound(res, "Lead");
    const d = v.clean(req.body, LEAD_SCHEMA, { partial: true });
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(LEAD_COLUMNS)) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    if (d.budget !== undefined) { sets.push("budget_paise = ?"); params.push(toPaise(d.budget)); }
    if (req.body?.buildingId !== undefined) {
      const buildingId = req.body.buildingId || null;
      if (buildingId && !db.get("SELECT 1 FROM buildings WHERE id = ? AND org_id = ?", buildingId, req.orgId)) return notFound(res, "Building");
      sets.push("building_id = ?"); params.push(buildingId);
    }
    if (d.stage === "lost" && !d.lostReason && !l.lost_reason && !req.body?.lostReason) { sets.push("lost_reason = ?"); params.push("Not given"); }
    if (sets.length) {
      db.run(`UPDATE leads SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), l.id);
      if (d.stage && d.stage !== l.stage) addEvent(db, req.orgId, l.id, "stage", `Stage: ${l.stage.replace(/_/g, " ")} → ${d.stage.replace(/_/g, " ")}${d.lostReason ? ` (${d.lostReason})` : ""}`, req.user.id);
    }
    res.json(leadView(db, db.get("SELECT * FROM leads WHERE id = ?", l.id), todayFor(req)));
  });

  app.post("/api/leads/:id/notes", manage, (req, res) => {
    const l = db.get("SELECT * FROM leads WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!l) return notFound(res, "Lead");
    const body = v.text({ label: "Note", max: 1000, required: true })(req.body?.body);
    addEvent(db, req.orgId, l.id, ["call", "visit", "note"].includes(req.body?.kind) ? req.body.kind : "note", body, req.user.id);
    db.run("UPDATE leads SET updated_at = ? WHERE id = ?", db.nowIso(), l.id);
    res.status(201).json({ ok: true });
  });

  app.delete("/api/leads/:id", manage, (req, res) => {
    const l = db.get("SELECT * FROM leads WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!l) return notFound(res, "Lead");
    if (db.get("SELECT 1 FROM bookings WHERE lead_id = ?", l.id)) return res.status(409).json({ error: "This lead has a booking. Mark the lead as lost instead." });
    db.run("DELETE FROM leads WHERE id = ?", l.id);
    audit(db, ctxOf(req), "lead.deleted", "lead", l.id, {});
    res.json({ ok: true });
  });

  // ---------- bookings ----------
  app.get("/api/bookings", (req, res) => {
    const where = ["org_id = :orgId"];
    const params = { orgId: req.orgId };
    if (req.query.status === "open") where.push("status IN ('pending','confirmed')");
    else if (["pending", "confirmed", "cancelled", "moved_in"].includes(req.query.status)) { where.push("status = :status"); params.status = req.query.status; }
    if (req.query.buildingId) { where.push("room_id IN (SELECT id FROM rooms WHERE building_id = :buildingId)"); params.buildingId = String(req.query.buildingId); }
    const today = todayFor(req);
    res.json(db.all(`SELECT * FROM bookings WHERE ${where.join(" AND ")} ORDER BY CASE WHEN status IN ('pending','confirmed') THEN 0 ELSE 1 END, joining_on`, params).map((b) => bookingView(db, b, today)));
  });

  app.post("/api/bookings", manage, (req, res) => {
    const d = v.clean(req.body, BOOKING_SCHEMA);
    const { bed, room } = bookableBed(db, req.orgId, req.body?.bedId, d.joiningOn);
    let lead = null;
    if (req.body?.leadId) {
      lead = db.get("SELECT * FROM leads WHERE id = ? AND org_id = ?", req.body.leadId, req.orgId);
      if (!lead) return notFound(res, "Lead");
    }
    if (d.token > 0 && !d.tokenMethod) d.tokenMethod = "cash";
    const id = db.id();
    const rent = req.body?.monthlyRent === undefined || req.body.monthlyRent === "" ? occ.bedRentPaise(bed, room) : toPaise(d.monthlyRent);
    const deposit = req.body?.deposit === undefined || req.body.deposit === "" ? room.deposit_paise : toPaise(d.deposit);
    db.tx(() => {
      db.run(`INSERT INTO bookings (id, org_id, lead_id, bed_id, room_id, name, mobile, email, joining_on, monthly_rent_paise, deposit_paise, token_paise, token_method, token_reference, token_received_on, status, notes, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, req.orgId, lead?.id || null, bed.id, bed.room_id, d.name, d.mobile, d.email, d.joiningOn, rent, deposit, toPaise(d.token), d.tokenMethod, d.tokenReference,
        d.token > 0 ? (d.tokenReceivedOn || todayFor(req)) : "", req.body?.status === "pending" ? "pending" : "confirmed", d.notes, req.user.id, db.nowIso());
      if (lead) {
        db.run("UPDATE leads SET stage = ?, updated_at = ? WHERE id = ?", d.token > 0 ? "token_paid" : lead.stage === "won" ? "won" : "visited", db.nowIso(), lead.id);
        addEvent(db, req.orgId, lead.id, "booking", `Booked ${room.label} · ${bed.label} from ${d.joiningOn}${d.token > 0 ? `, token ₹${d.token}` : ""}`, req.user.id);
      }
      audit(db, ctxOf(req), "booking.created", "booking", id, { bedId: bed.id, joiningOn: d.joiningOn, tokenPaise: toPaise(d.token) });
    });
    res.status(201).json(bookingView(db, db.get("SELECT * FROM bookings WHERE id = ?", id), todayFor(req)));
  });

  app.put("/api/bookings/:id", manage, (req, res) => {
    const b = db.get("SELECT * FROM bookings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Booking");
    if (!["pending", "confirmed"].includes(b.status)) return res.status(409).json({ error: "This booking is closed." });
    const d = v.clean(req.body, BOOKING_SCHEMA, { partial: true });
    const joiningOn = d.joiningOn || b.joining_on;
    const bedId = req.body?.bedId || b.bed_id;
    const { bed } = bookableBed(db, req.orgId, bedId, joiningOn, b.id);
    const cols = { name: "name", mobile: "mobile", email: "email", joiningOn: "joining_on", tokenMethod: "token_method", tokenReference: "token_reference", tokenReceivedOn: "token_received_on", notes: "notes" };
    const sets = ["bed_id = ?", "room_id = ?"];
    const params = [bed.id, bed.room_id];
    for (const [k, col] of Object.entries(cols)) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    for (const [k, col] of [["monthlyRent", "monthly_rent_paise"], ["deposit", "deposit_paise"], ["token", "token_paise"]]) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(toPaise(d[k])); }
    if (req.body?.status && ["pending", "confirmed"].includes(req.body.status)) { sets.push("status = ?"); params.push(req.body.status); }
    db.run(`UPDATE bookings SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), b.id);
    res.json(bookingView(db, db.get("SELECT * FROM bookings WHERE id = ?", b.id), todayFor(req)));
  });

  app.post("/api/bookings/:id/cancel", manage, (req, res) => {
    const b = db.get("SELECT * FROM bookings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Booking");
    if (!["pending", "confirmed"].includes(b.status)) return res.status(409).json({ error: "This booking is already closed." });
    const reason = v.text({ label: "Reason", max: 300 })(req.body?.reason) || "Cancelled";
    db.tx(() => {
      db.run("UPDATE bookings SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?", reason, db.nowIso(), b.id);
      if (b.lead_id) {
        db.run("UPDATE leads SET stage = 'lost', lost_reason = ?, updated_at = ? WHERE id = ? AND stage <> 'won'", `Booking cancelled: ${reason}`, db.nowIso(), b.lead_id);
        addEvent(db, req.orgId, b.lead_id, "booking", `Booking cancelled: ${reason}`, req.user.id);
      }
      audit(db, ctxOf(req), "booking.cancelled", "booking", b.id, { reason, tokenPaise: b.token_paise });
    });
    res.json({ ...bookingView(db, db.get("SELECT * FROM bookings WHERE id = ?", b.id), todayFor(req)), tokenToRefund: toRupees(b.token_paise) });
  });

  // Move in: creates the tenant on the booked bed, records the token as an
  // advance payment, and prepares a draft lease to activate.
  app.post("/api/bookings/:id/move-in", manage, (req, res) => {
    const b = db.get("SELECT * FROM bookings WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!b) return notFound(res, "Booking");
    if (!["pending", "confirmed"].includes(b.status)) return res.status(409).json({ error: "This booking is already closed." });
    const moveInDate = v.date({ label: "Move-in date" })(req.body?.moveInDate) || todayFor(req);
    const bed = db.get("SELECT * FROM beds WHERE id = ?", b.bed_id);
    const room = db.get("SELECT * FROM rooms WHERE id = ?", b.room_id);
    if (bed.disabled) return res.status(409).json({ error: "That bed is marked as not for rent." });
    const living = db.get("SELECT name FROM tenants WHERE bed_id = ? AND active = 1", bed.id);
    if (living) return res.status(409).json({ error: `${living.name} still lives in this bed. Mark them as moved out first.` });
    if (b.mobile && db.all("SELECT mobile FROM tenants WHERE org_id = ? AND active = 1", req.orgId).some((t) => accounts.sameMobile(t.mobile, b.mobile))) {
      return res.status(409).json({ error: "Another active tenant already uses this mobile number." });
    }
    const tenantId = db.id();
    let leaseId = null;
    db.tx(() => {
      db.run(`INSERT INTO tenants (id, org_id, room_id, bed_id, name, mobile, email, move_in_date, active, deposit_paise, notes, created_at) VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`,
        tenantId, req.orgId, room.id, bed.id, b.name, b.mobile, b.email, moveInDate, b.deposit_paise, b.notes, db.nowIso());
      refreshRoomStatus(db, room.id);
      if (b.token_paise > 0) {
        ledger.recordPayment(db, ctxOf(req), {
          tenantId, roomId: room.id, amountPaise: b.token_paise, method: ["cash", "upi", "bank_transfer", "cheque"].includes(b.token_method) ? b.token_method : "other",
          reference: b.token_reference, receivedOn: b.token_received_on || moveInDate, verification: "recorded", source: "manual",
          idempotencyKey: `booking-token:${b.id}`, notes: "Booking token (kept as advance for the first bills)",
        }, todayFor(req));
      }
      if (req.body?.createLease !== false && b.monthly_rent_paise > 0) {
        leaseId = db.id();
        db.run(`INSERT INTO leases (id, org_id, tenant_id, room_id, start_date, rent_paise, deposit_paise, frequency, due_day, status, auto_generate_rent, notice_days, terms, created_by, created_at)
                VALUES (?,?,?,?,?,?,?,'monthly',5,'draft',1,30,'',?,?)`, leaseId, req.orgId, tenantId, room.id, moveInDate, b.monthly_rent_paise, b.deposit_paise, req.user.id, db.nowIso());
      }
      db.run("UPDATE bookings SET status = 'moved_in', tenant_id = ?, updated_at = ? WHERE id = ?", tenantId, db.nowIso(), b.id);
      if (b.lead_id) {
        db.run("UPDATE leads SET stage = 'won', updated_at = ? WHERE id = ?", db.nowIso(), b.lead_id);
        addEvent(db, req.orgId, b.lead_id, "booking", `Moved in on ${moveInDate}`, req.user.id);
      }
      audit(db, ctxOf(req), "booking.moved_in", "booking", b.id, { tenantId, leaseId });
    });
    res.status(201).json({ tenant: tenantView(db, db.get("SELECT * FROM tenants WHERE id = ?", tenantId)), draftLeaseId: leaseId, booking: bookingView(db, db.get("SELECT * FROM bookings WHERE id = ?", b.id), todayFor(req)) });
  });

  // Website enquiries create leads; tell the staff (called from routes/site.js).
  app.locals.newWebsiteLead = (orgId, buildingName, name) => notifyStaff(db, orgId, { kind: "lead", title: "New enquiry from your property page", body: `${name} asked about ${buildingName}.`, link: "leads" });
}

module.exports = { register, leadView, bookingView, STAGES, SOURCES };
