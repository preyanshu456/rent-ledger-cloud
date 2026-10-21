// Hostel operations: food menu and meals, attendance and leave, entry/exit
// and gate passes, staff tasks, assets and the notice board.
//
// Staff use /api/hostel/*; tenants use /api/tenant/hostel/* for their own
// meals, leave, gate passes and notices.
const crypto = require("crypto");
const v = require("../lib/validate");
const { toPaise, toRupees } = require("../lib/money");
const { audit } = require("../services/audit");
const { notify, notifyStaff } = require("../services/notify");
const { requirePermission, tenantOnly, ctxOf, notFound, orgTimeZone } = require("./common");

const MEALS = ["breakfast", "lunch", "snacks", "dinner"];
const DEFAULT_SETTINGS = {
  meals: {
    breakfast: { on: true, time: "08:00", cutoff: "07:00" },
    lunch: { on: true, time: "13:00", cutoff: "11:00" },
    snacks: { on: false, time: "17:00", cutoff: "15:00" },
    dinner: { on: true, time: "20:30", cutoff: "18:00" },
  },
  // When a tenant hasn't said anything, count them as eating ("going") or not.
  mealDefault: "going",
  curfew: "22:00",
  rollCallTime: "22:30",
  gatePassApproval: true,
};
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const STATUSES = ["present", "absent", "leave", "late"];
const CONDITIONS = ["good", "needs_repair", "broken", "in_storage", "retired"];
const REPEATS = ["none", "daily", "weekly", "monthly"];

// Local date and time in the organisation's time zone: "YYYY-MM-DDTHH:MM".
function localNow(timeZone, date = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const isDateTime = (x) => /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/.test(String(x || ""));

function mergeSettings(stored) {
  const s = (() => { try { return JSON.parse(stored || "{}"); } catch { return {}; } })();
  const meals = {};
  for (const m of MEALS) meals[m] = { ...DEFAULT_SETTINGS.meals[m], ...(s.meals?.[m] || {}) };
  return { ...DEFAULT_SETTINGS, ...s, meals };
}

function register(app, { db, todayFor }) {
  const staff = requirePermission("hostel.manage");
  const tz = (req) => orgTimeZone(db, req.orgId);
  const buildingOf = (req, id) => db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", id || "", req.orgId);
  const settingsFor = (buildingId) => mergeSettings(db.get("SELECT settings_json FROM hostel_settings WHERE building_id = ?", buildingId)?.settings_json);
  const residents = (buildingId) => db.all(`SELECT t.id, t.name, t.mobile, r.label AS room_label, r.floor_number, b2.label AS bed_label FROM tenants t
      JOIN rooms r ON r.id = t.room_id LEFT JOIN beds b2 ON b2.id = t.bed_id WHERE r.building_id = ? AND t.active = 1 ORDER BY r.floor_number, r.label, b2.label, t.name`, buildingId);
  const tenantBuilding = (tenantId) => db.get("SELECT r.building_id FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.id = ?", tenantId)?.building_id;
  const onLeave = (buildingId, date) => new Set(db.all("SELECT tenant_id FROM leave_requests WHERE building_id = ? AND status = 'approved' AND from_date <= ? AND to_date >= ?", buildingId, date, date).map((r) => r.tenant_id));
  const tenantUserId = (tenantId) => db.get("SELECT id FROM users WHERE tenant_id = ?", tenantId)?.id;
  const tellTenant = (orgId, tenantId, title, body) => { const uid = tenantUserId(tenantId); if (uid) notify(db, { orgId, userId: uid, kind: "hostel", title, body, link: "tenant:hostel" }); };
  const requireBuilding = (req, res, id) => { const b = buildingOf(req, id); if (!b) { notFound(res, "Building"); return null; } return b; };

  function mealCounts(buildingId, date) {
    const s = settingsFor(buildingId);
    const people = residents(buildingId);
    const leave = onLeave(buildingId, date);
    const marks = db.all("SELECT * FROM meal_marks WHERE building_id = ? AND meal_date = ?", buildingId, date);
    const out = {};
    for (const meal of MEALS) {
      if (!s.meals[meal].on) continue;
      const byTenant = new Map(marks.filter((m) => m.meal === meal).map((m) => [m.tenant_id, m]));
      let going = 0, notGoing = 0, unmarked = 0, served = 0, away = 0, ratingSum = 0, ratings = 0;
      const list = people.map((p) => {
        const m = byTenant.get(p.id);
        const status = leave.has(p.id) ? "leave" : m ? (m.going ? "going" : "not_going") : "unmarked";
        if (status === "leave") away++; else if (status === "going") going++; else if (status === "not_going") notGoing++; else unmarked++;
        if (m?.served) served++;
        if (m?.rating) { ratingSum += m.rating; ratings++; }
        return { tenantId: p.id, name: p.name, room: p.room_label, bed: p.bed_label || "", status, served: Boolean(m?.served), rating: m?.rating || null };
      });
      const expected = going + (s.mealDefault === "going" ? unmarked : 0);
      out[meal] = { time: s.meals[meal].time, cutoff: s.meals[meal].cutoff, going, notGoing, unmarked, onLeave: away, served, expected, wasted: Math.max(expected - served, 0), averageRating: ratings ? Math.round((ratingSum / ratings) * 10) / 10 : null, list };
    }
    return out;
  }

  function attendanceFor(buildingId, date) {
    const leave = onLeave(buildingId, date);
    const marks = new Map(db.all("SELECT * FROM attendance WHERE building_id = ? AND att_date = ?", buildingId, date).map((a) => [a.tenant_id, a]));
    return residents(buildingId).map((p) => {
      const a = marks.get(p.id);
      return { tenantId: p.id, name: p.name, mobile: p.mobile || "", room: p.room_label, bed: p.bed_label || "", status: a?.status || (leave.has(p.id) ? "leave" : ""), note: a?.note || "", onApprovedLeave: leave.has(p.id) };
    });
  }

  const leaveView = (l) => {
    const t = db.get("SELECT name FROM tenants WHERE id = ?", l.tenant_id);
    return { id: l.id, tenantId: l.tenant_id, tenantName: t?.name || "", buildingId: l.building_id, fromDate: l.from_date, toDate: l.to_date, reason: l.reason, goingTo: l.going_to, skipMeals: Boolean(l.skip_meals), status: l.status, decisionNote: l.decision_note || "", decidedAt: l.decided_at || null, createdAt: l.created_at };
  };
  const passView = (p, nowLocal) => {
    const t = db.get("SELECT name FROM tenants WHERE id = ?", p.tenant_id);
    return { id: p.id, tenantId: p.tenant_id, tenantName: t?.name || "", buildingId: p.building_id, purpose: p.purpose, outAt: p.out_at, returnBy: p.return_by, status: p.status, code: p.code,
      wentOutAt: p.went_out_at || null, cameBackAt: p.came_back_at || null, late: Boolean(p.late), overdue: p.status === "out" && nowLocal && p.return_by < nowLocal, createdAt: p.created_at };
  };
  const newCode = () => String(crypto.randomInt(100000, 1000000));

  // ---------- overview (the hostel window's home) ----------
  app.get("/api/hostel/overview", staff, (req, res) => {
    const b = requireBuilding(req, res, req.query.buildingId);
    if (!b) return;
    const date = v.date({ label: "Date" })(req.query.date) || todayFor(req);
    const now = localNow(tz(req));
    const att = attendanceFor(b.id, date);
    const passes = db.all("SELECT * FROM gate_passes WHERE building_id = ? AND status IN ('pending','approved','out')", b.id).map((p) => passView(p, now));
    res.json({
      building: { id: b.id, name: b.name }, date, now, settings: settingsFor(b.id), enabledForTenants: Boolean(db.get("SELECT 1 FROM hostel_settings WHERE building_id = ?", b.id)),
      residents: att.length,
      attendance: { marked: att.filter((a) => a.status).length, present: att.filter((a) => a.status === "present").length, absent: att.filter((a) => a.status === "absent").length, leave: att.filter((a) => a.status === "leave").length, late: att.filter((a) => a.status === "late").length },
      meals: Object.fromEntries(Object.entries(mealCounts(b.id, date)).map(([k, m]) => [k, { time: m.time, expected: m.expected, going: m.going, notGoing: m.notGoing, unmarked: m.unmarked, onLeave: m.onLeave, served: m.served }])),
      pendingLeaves: db.get("SELECT COUNT(*) AS n FROM leave_requests WHERE building_id = ? AND status = 'pending'", b.id).n,
      onLeaveToday: onLeave(b.id, date).size,
      pendingPasses: passes.filter((p) => p.status === "pending").length,
      outNow: passes.filter((p) => p.status === "out").length,
      overdueReturns: passes.filter((p) => p.overdue).map((p) => ({ id: p.id, tenantName: p.tenantName, returnBy: p.returnBy })),
      tasksDue: db.get("SELECT COUNT(*) AS n FROM hostel_tasks WHERE building_id = ? AND status = 'open' AND (due_on = '' OR due_on <= ?)", b.id, date).n,
      assetsNeedingRepair: db.get("SELECT COUNT(*) AS n FROM assets WHERE building_id = ? AND condition IN ('needs_repair','broken')", b.id).n,
      visitorsInside: db.get(`SELECT COUNT(*) AS n FROM gate_log g WHERE g.building_id = ? AND g.tenant_id IS NULL AND g.direction = 'in' AND g.at >= ?
        AND NOT EXISTS (SELECT 1 FROM gate_log o WHERE o.building_id = g.building_id AND o.tenant_id IS NULL AND o.direction = 'out' AND o.visitor_name = g.visitor_name AND o.at >= g.at)`, b.id, `${date}T00:00`).n,
    });
  });

  // ---------- settings ----------
  app.get("/api/hostel/settings/:buildingId", staff, (req, res) => {
    const b = requireBuilding(req, res, req.params.buildingId);
    if (b) res.json(settingsFor(b.id));
  });

  app.put("/api/hostel/settings/:buildingId", staff, (req, res) => {
    const b = requireBuilding(req, res, req.params.buildingId);
    if (!b) return;
    const cur = settingsFor(b.id);
    const body = req.body || {};
    const time = (x, label, fallback) => { if (x === undefined) return fallback; if (!TIME_RE.test(String(x))) throw new v.ValidationError(`${label} must be a time like 21:30.`); return String(x); };
    const meals = {};
    for (const m of MEALS) {
      const inMeal = body.meals?.[m] || {};
      meals[m] = { on: inMeal.on !== undefined ? v.bool()(inMeal.on) : cur.meals[m].on, time: time(inMeal.time, `${m} time`, cur.meals[m].time), cutoff: time(inMeal.cutoff, `${m} cut-off`, cur.meals[m].cutoff) };
    }
    const next = {
      meals, mealDefault: body.mealDefault === "not_going" ? "not_going" : body.mealDefault === "going" ? "going" : cur.mealDefault,
      curfew: time(body.curfew, "Curfew", cur.curfew), rollCallTime: time(body.rollCallTime, "Roll call", cur.rollCallTime),
      gatePassApproval: body.gatePassApproval !== undefined ? v.bool()(body.gatePassApproval) : cur.gatePassApproval,
    };
    db.run("INSERT INTO hostel_settings (building_id, org_id, settings_json, updated_at) VALUES (?,?,?,?) ON CONFLICT(building_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at",
      b.id, req.orgId, JSON.stringify(next), db.nowIso());
    res.json(next);
  });

  // ---------- food ----------
  const menuFor = (buildingId) => {
    const rows = db.all("SELECT weekday, meal, items FROM meal_menu WHERE building_id = ?", buildingId);
    const week = Array.from({ length: 7 }, (_, d) => ({ weekday: d, ...Object.fromEntries(MEALS.map((m) => [m, ""])) }));
    for (const r of rows) week[r.weekday][r.meal] = r.items;
    return week;
  };

  app.get("/api/hostel/menu/:buildingId", staff, (req, res) => {
    const b = requireBuilding(req, res, req.params.buildingId);
    if (b) res.json({ week: menuFor(b.id), settings: settingsFor(b.id) });
  });

  app.put("/api/hostel/menu/:buildingId", staff, (req, res) => {
    const b = requireBuilding(req, res, req.params.buildingId);
    if (!b) return;
    const items = Array.isArray(req.body?.items) ? req.body.items.slice(0, 28) : [];
    db.tx(() => {
      for (const it of items) {
        const day = Number(it.weekday);
        if (!Number.isInteger(day) || day < 0 || day > 6 || !MEALS.includes(it.meal)) continue;
        const text = v.text({ label: "Menu", max: 300 })(it.items);
        db.run(`INSERT INTO meal_menu (id, org_id, building_id, weekday, meal, items, updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(building_id, weekday, meal) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`, db.id(), req.orgId, b.id, day, it.meal, text, db.nowIso());
      }
    });
    res.json({ week: menuFor(b.id) });
  });

  // Copy one property's menu to another.
  app.post("/api/hostel/menu/:buildingId/copy-to/:targetId", staff, (req, res) => {
    const b = requireBuilding(req, res, req.params.buildingId);
    const target = b && requireBuilding(req, res, req.params.targetId);
    if (!target) return;
    db.tx(() => {
      for (const r of db.all("SELECT * FROM meal_menu WHERE building_id = ?", b.id)) {
        db.run(`INSERT INTO meal_menu (id, org_id, building_id, weekday, meal, items, updated_at) VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(building_id, weekday, meal) DO UPDATE SET items = excluded.items, updated_at = excluded.updated_at`, db.id(), req.orgId, target.id, r.weekday, r.meal, r.items, db.nowIso());
      }
    });
    res.json({ week: menuFor(target.id) });
  });

  app.get("/api/hostel/meals", staff, (req, res) => {
    const b = requireBuilding(req, res, req.query.buildingId);
    if (!b) return;
    const date = v.date({ label: "Date" })(req.query.date) || todayFor(req);
    res.json({ date, menu: menuFor(b.id)[weekday(date)], meals: mealCounts(b.id, date) });
  });

  // Staff tick a meal as served (or set a tenant's choice for them).
  app.post("/api/hostel/meals/mark", staff, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.body?.tenantId || "", req.orgId);
    if (!t) return notFound(res, "Tenant");
    const date = v.date({ label: "Date" })(req.body?.date) || todayFor(req);
    if (!MEALS.includes(req.body?.meal)) return res.status(400).json({ error: "Choose a meal." });
    const buildingId = tenantBuilding(t.id);
    const existing = db.get("SELECT * FROM meal_marks WHERE tenant_id = ? AND meal_date = ? AND meal = ?", t.id, date, req.body.meal);
    const going = req.body.going !== undefined ? (v.bool()(req.body.going) ? 1 : 0) : existing ? existing.going : 1;
    const served = req.body.served !== undefined ? (v.bool()(req.body.served) ? 1 : 0) : existing ? existing.served : 0;
    db.run(`INSERT INTO meal_marks (id, org_id, tenant_id, building_id, meal_date, meal, going, served, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(tenant_id, meal_date, meal) DO UPDATE SET going = excluded.going, served = excluded.served, updated_at = excluded.updated_at`,
      db.id(), req.orgId, t.id, buildingId, date, req.body.meal, served ? 1 : going, served, db.nowIso());
    res.json({ ok: true });
  });

  // ---------- attendance ----------
  app.get("/api/hostel/attendance", staff, (req, res) => {
    const b = requireBuilding(req, res, req.query.buildingId);
    if (!b) return;
    const date = v.date({ label: "Date" })(req.query.date) || todayFor(req);
    res.json({ date, list: attendanceFor(b.id, date) });
  });

  app.post("/api/hostel/attendance", staff, (req, res) => {
    const b = requireBuilding(req, res, req.body?.buildingId);
    if (!b) return;
    const date = v.date({ label: "Date" })(req.body?.date) || todayFor(req);
    if (date > todayFor(req)) return res.status(400).json({ error: "Attendance can't be marked for a future date." });
    const people = new Set(residents(b.id).map((p) => p.id));
    let marks = Array.isArray(req.body?.marks) ? req.body.marks : [];
    // "Mark everyone else present" in one tap.
    if (req.body?.allPresent) {
      const leave = onLeave(b.id, date);
      const done = new Set(db.all("SELECT tenant_id FROM attendance WHERE building_id = ? AND att_date = ?", b.id, date).map((a) => a.tenant_id));
      marks = [...marks, ...[...people].filter((id) => !done.has(id) && !marks.some((m) => m.tenantId === id)).map((id) => ({ tenantId: id, status: leave.has(id) ? "leave" : "present" }))];
    }
    let saved = 0;
    db.tx(() => {
      for (const m of marks.slice(0, 2000)) {
        if (!people.has(m.tenantId)) continue;
        if (m.status === "" || m.status === null) { db.run("DELETE FROM attendance WHERE tenant_id = ? AND att_date = ?", m.tenantId, date); continue; }
        if (!STATUSES.includes(m.status)) continue;
        db.run(`INSERT INTO attendance (id, org_id, tenant_id, building_id, att_date, status, note, marked_by, marked_at) VALUES (?,?,?,?,?,?,?,?,?)
                ON CONFLICT(tenant_id, att_date) DO UPDATE SET status = excluded.status, note = excluded.note, marked_by = excluded.marked_by, marked_at = excluded.marked_at`,
          db.id(), req.orgId, m.tenantId, b.id, date, m.status, v.text({ label: "Note", max: 200 })(m.note), req.user.id, db.nowIso());
        saved++;
      }
    });
    res.json({ saved, list: attendanceFor(b.id, date) });
  });

  // Month view for one property: days present / absent / leave per tenant.
  app.get("/api/hostel/attendance/month", staff, (req, res) => {
    const b = requireBuilding(req, res, req.query.buildingId);
    if (!b) return;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? req.query.month : todayFor(req).slice(0, 7);
    const rows = db.all("SELECT tenant_id, status, COUNT(*) AS n FROM attendance WHERE building_id = ? AND substr(att_date, 1, 7) = ? GROUP BY tenant_id, status", b.id, month);
    res.json({ month, list: residents(b.id).map((p) => {
      const mine = rows.filter((r) => r.tenant_id === p.id);
      const n = (s) => mine.find((r) => r.status === s)?.n || 0;
      return { tenantId: p.id, name: p.name, room: p.room_label, present: n("present"), late: n("late"), absent: n("absent"), leave: n("leave") };
    }) });
  });

  // ---------- leave ----------
  app.get("/api/hostel/leaves", staff, (req, res) => {
    const where = ["org_id = ?"];
    const params = [req.orgId];
    if (req.query.buildingId) { where.push("building_id = ?"); params.push(String(req.query.buildingId)); }
    if (["pending", "approved", "rejected", "cancelled"].includes(req.query.status)) { where.push("status = ?"); params.push(req.query.status); }
    res.json(db.all(`SELECT * FROM leave_requests WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, from_date DESC LIMIT 300`, ...params).map(leaveView));
  });

  function createLeave(req, tenantId, role) {
    const fromDate = v.date({ label: "From" })(req.body?.fromDate);
    const toDate = v.date({ label: "To" })(req.body?.toDate) || fromDate;
    if (!fromDate) throw new v.ValidationError("Choose the first day of leave.");
    if (toDate < fromDate) throw new v.ValidationError("The last day can't be before the first day.");
    const id = db.id();
    db.run(`INSERT INTO leave_requests (id, org_id, tenant_id, building_id, from_date, to_date, reason, going_to, skip_meals, status, created_by_role, created_at, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.orgId, tenantId, tenantBuilding(tenantId), fromDate, toDate, v.text({ label: "Reason", max: 300 })(req.body?.reason), v.text({ label: "Going to", max: 200 })(req.body?.goingTo),
      req.body?.skipMeals === false ? 0 : 1, role === "staff" ? "approved" : "pending", role, db.nowIso(), role === "staff" ? req.user.id : null, role === "staff" ? db.nowIso() : null);
    return db.get("SELECT * FROM leave_requests WHERE id = ?", id);
  }

  app.post("/api/hostel/leaves", staff, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.body?.tenantId || "", req.orgId);
    if (!t) return notFound(res, "Tenant");
    res.status(201).json(leaveView(createLeave(req, t.id, "staff")));
  });

  app.post("/api/hostel/leaves/:id/decide", staff, (req, res) => {
    const l = db.get("SELECT * FROM leave_requests WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!l) return notFound(res, "Leave request");
    if (l.status !== "pending") return res.status(409).json({ error: "This request was already decided." });
    const approve = v.bool()(req.body?.approve);
    const note = v.text({ label: "Note", max: 300 })(req.body?.note);
    db.run("UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?", approve ? "approved" : "rejected", req.user.id, db.nowIso(), note, l.id);
    tellTenant(req.orgId, l.tenant_id, approve ? "Leave approved" : "Leave not approved", `${l.from_date} to ${l.to_date}${note ? `: ${note}` : ""}`);
    res.json(leaveView(db.get("SELECT * FROM leave_requests WHERE id = ?", l.id)));
  });

  // ---------- gate passes and the entry/exit register ----------
  app.get("/api/hostel/passes", staff, (req, res) => {
    const where = ["org_id = ?"];
    const params = [req.orgId];
    if (req.query.buildingId) { where.push("building_id = ?"); params.push(String(req.query.buildingId)); }
    if (req.query.status === "active") where.push("status IN ('pending','approved','out')");
    else if (["pending", "approved", "rejected", "out", "returned", "cancelled"].includes(req.query.status)) { where.push("status = ?"); params.push(req.query.status); }
    const now = localNow(tz(req));
    res.json(db.all(`SELECT * FROM gate_passes WHERE ${where.join(" AND ")} ORDER BY CASE status WHEN 'out' THEN 0 WHEN 'pending' THEN 1 WHEN 'approved' THEN 2 ELSE 3 END, out_at DESC LIMIT 300`, ...params).map((p) => passView(p, now)));
  });

  function createPass(req, tenantId, role) {
    const outAt = String(req.body?.outAt || "");
    const returnBy = String(req.body?.returnBy || "");
    if (!isDateTime(outAt) || !isDateTime(returnBy)) throw new v.ValidationError("Enter when you go out and when you will be back.");
    if (returnBy <= outAt) throw new v.ValidationError("The return time must be after the time you go out.");
    const buildingId = tenantBuilding(tenantId);
    const needsApproval = role !== "staff" && settingsFor(buildingId).gatePassApproval;
    const id = db.id();
    db.run(`INSERT INTO gate_passes (id, org_id, tenant_id, building_id, purpose, out_at, return_by, status, code, created_at, decided_by, decided_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.orgId, tenantId, buildingId, v.text({ label: "Purpose", max: 200 })(req.body?.purpose), outAt, returnBy, needsApproval ? "pending" : "approved", newCode(), db.nowIso(),
      needsApproval ? null : req.user.id, needsApproval ? null : db.nowIso());
    return db.get("SELECT * FROM gate_passes WHERE id = ?", id);
  }

  app.post("/api/hostel/passes", staff, (req, res) => {
    const t = db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.body?.tenantId || "", req.orgId);
    if (!t) return notFound(res, "Tenant");
    res.status(201).json(passView(createPass(req, t.id, "staff"), localNow(tz(req))));
  });

  app.post("/api/hostel/passes/:id/decide", staff, (req, res) => {
    const p = db.get("SELECT * FROM gate_passes WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!p) return notFound(res, "Gate pass");
    if (p.status !== "pending") return res.status(409).json({ error: "This pass was already decided." });
    const approve = v.bool()(req.body?.approve);
    db.run("UPDATE gate_passes SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?", approve ? "approved" : "rejected", req.user.id, db.nowIso(), p.id);
    tellTenant(req.orgId, p.tenant_id, approve ? "Gate pass approved" : "Gate pass not approved", approve ? `Show code ${p.code} at the gate. Be back by ${p.return_by.replace("T", " ")}.` : p.purpose);
    res.json(passView(db.get("SELECT * FROM gate_passes WHERE id = ?", p.id), localNow(tz(req))));
  });

  // The guard records going out and coming back; both go in the register.
  app.post("/api/hostel/passes/:id/:move(out|in)", staff, (req, res) => {
    const p = db.get("SELECT * FROM gate_passes WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!p) return notFound(res, "Gate pass");
    const now = localNow(tz(req));
    if (req.params.move === "out") {
      if (p.status !== "approved") return res.status(409).json({ error: p.status === "pending" ? "This pass is not approved yet." : "This pass can't be used now." });
      db.tx(() => {
        db.run("UPDATE gate_passes SET status = 'out', went_out_at = ? WHERE id = ?", now, p.id);
        db.run("INSERT INTO gate_log (id, org_id, building_id, tenant_id, direction, at, gate_pass_id, logged_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)", db.id(), req.orgId, p.building_id, p.tenant_id, "out", now, p.id, req.user.id, db.nowIso());
      });
    } else {
      if (p.status !== "out") return res.status(409).json({ error: "This person is not marked as out." });
      const late = now > p.return_by ? 1 : 0;
      db.tx(() => {
        db.run("UPDATE gate_passes SET status = 'returned', came_back_at = ?, late = ? WHERE id = ?", now, late, p.id);
        db.run("INSERT INTO gate_log (id, org_id, building_id, tenant_id, direction, at, gate_pass_id, note, logged_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", db.id(), req.orgId, p.building_id, p.tenant_id, "in", now, p.id, late ? "Came back late" : "", req.user.id, db.nowIso());
      });
    }
    res.json(passView(db.get("SELECT * FROM gate_passes WHERE id = ?", p.id), now));
  });

  // Find a pass by the code the tenant shows at the gate.
  app.get("/api/hostel/passes/by-code/:code", staff, (req, res) => {
    const p = db.get("SELECT * FROM gate_passes WHERE org_id = ? AND code = ? AND status IN ('approved','out') ORDER BY created_at DESC LIMIT 1", req.orgId, String(req.params.code || "").trim());
    if (!p) return notFound(res, "Gate pass");
    res.json(passView(p, localNow(tz(req))));
  });

  app.get("/api/hostel/gate-log", staff, (req, res) => {
    const b = requireBuilding(req, res, req.query.buildingId);
    if (!b) return;
    const date = v.date({ label: "Date" })(req.query.date) || todayFor(req);
    res.json(db.all(`SELECT g.*, t.name AS tenant_name FROM gate_log g LEFT JOIN tenants t ON t.id = g.tenant_id WHERE g.building_id = ? AND substr(g.at, 1, 10) = ? ORDER BY g.at DESC`, b.id, date)
      .map((g) => ({ id: g.id, direction: g.direction, at: g.at, who: g.tenant_name || g.visitor_name, isVisitor: !g.tenant_id, visitorMobile: g.visitor_mobile || "", visiting: g.visiting || "", note: g.note || "", gatePassId: g.gate_pass_id || null })));
  });

  // Record a resident or a visitor coming in or going out.
  app.post("/api/hostel/gate-log", staff, (req, res) => {
    const b = requireBuilding(req, res, req.body?.buildingId);
    if (!b) return;
    const direction = req.body?.direction === "out" ? "out" : "in";
    let tenantId = null;
    if (req.body?.tenantId) {
      const t = db.get("SELECT t.id FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.id = ? AND t.org_id = ? AND r.building_id = ?", req.body.tenantId, req.orgId, b.id);
      if (!t) return notFound(res, "Tenant");
      tenantId = t.id;
    }
    const visitorName = tenantId ? "" : v.text({ label: "Visitor name", max: 120, required: true })(req.body?.visitorName);
    const now = localNow(tz(req));
    db.run("INSERT INTO gate_log (id, org_id, building_id, tenant_id, visitor_name, visitor_mobile, visiting, direction, at, note, logged_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      db.id(), req.orgId, b.id, tenantId, visitorName, tenantId ? "" : v.mobile({ label: "Visitor mobile" })(req.body?.visitorMobile), v.text({ label: "Visiting", max: 120 })(req.body?.visiting), direction, now,
      v.text({ label: "Note", max: 200 })(req.body?.note), req.user.id, db.nowIso());
    res.status(201).json({ ok: true, at: now });
  });

  // ---------- tasks ----------
  const taskView = (t) => ({ id: t.id, buildingId: t.building_id, title: t.title, details: t.details, assignee: t.assignee, dueOn: t.due_on, repeat: t.repeat, status: t.status, doneAt: t.done_at || null, doneNote: t.done_note || "", createdAt: t.created_at });
  const TASK_SCHEMA = {
    title: v.text({ label: "Task", max: 160, required: true }),
    details: v.text({ label: "Details", max: 1000 }),
    assignee: v.text({ label: "Assigned to", max: 80 }),
    dueOn: v.date({ label: "Due date" }),
    repeat: (x) => (REPEATS.includes(x) ? x : "none"),
  };

  app.get("/api/hostel/tasks", staff, (req, res) => {
    const where = ["org_id = ?"];
    const params = [req.orgId];
    if (req.query.buildingId) { where.push("building_id = ?"); params.push(String(req.query.buildingId)); }
    if (["open", "done"].includes(req.query.status)) { where.push("status = ?"); params.push(req.query.status); }
    res.json(db.all(`SELECT * FROM hostel_tasks WHERE ${where.join(" AND ")} ORDER BY status, CASE WHEN due_on = '' THEN 1 ELSE 0 END, due_on, created_at LIMIT 500`, ...params).map(taskView));
  });

  app.post("/api/hostel/tasks", staff, (req, res) => {
    const b = requireBuilding(req, res, req.body?.buildingId);
    if (!b) return;
    const d = v.clean(req.body, TASK_SCHEMA);
    if (d.repeat !== "none" && !d.dueOn) d.dueOn = todayFor(req);
    const id = db.id();
    db.run("INSERT INTO hostel_tasks (id, org_id, building_id, title, details, assignee, due_on, repeat, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", id, req.orgId, b.id, d.title, d.details, d.assignee, d.dueOn, d.repeat, req.user.id, db.nowIso());
    res.status(201).json(taskView(db.get("SELECT * FROM hostel_tasks WHERE id = ?", id)));
  });

  app.put("/api/hostel/tasks/:id", staff, (req, res) => {
    const t = db.get("SELECT * FROM hostel_tasks WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Task");
    const d = v.clean(req.body, TASK_SCHEMA, { partial: true });
    const cols = { title: "title", details: "details", assignee: "assignee", dueOn: "due_on", repeat: "repeat" };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(cols)) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    if (sets.length) db.run(`UPDATE hostel_tasks SET ${sets.join(", ")} WHERE id = ?`, ...params, t.id);
    res.json(taskView(db.get("SELECT * FROM hostel_tasks WHERE id = ?", t.id)));
  });

  // Done. A repeating task makes its next copy straight away.
  app.post("/api/hostel/tasks/:id/done", staff, (req, res) => {
    const t = db.get("SELECT * FROM hostel_tasks WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!t) return notFound(res, "Task");
    if (t.status === "done") return res.json(taskView(t));
    let next = null;
    db.tx(() => {
      db.run("UPDATE hostel_tasks SET status = 'done', done_at = ?, done_by = ?, done_note = ? WHERE id = ?", db.nowIso(), req.user.id, v.text({ label: "Note", max: 300 })(req.body?.note), t.id);
      if (t.repeat !== "none") {
        const base = t.due_on || todayFor(req);
        const due = t.repeat === "daily" ? addDays(base, 1) : t.repeat === "weekly" ? addDays(base, 7) : (() => { const [y, m, d] = base.split("-").map(Number); const idx = y * 12 + m; return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}-${String(Math.min(d, 28)).padStart(2, "0")}`; })();
        next = db.id();
        db.run("INSERT INTO hostel_tasks (id, org_id, building_id, title, details, assignee, due_on, repeat, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)", next, req.orgId, t.building_id, t.title, t.details, t.assignee, due, t.repeat, req.user.id, db.nowIso());
      }
    });
    res.json({ ...taskView(db.get("SELECT * FROM hostel_tasks WHERE id = ?", t.id)), nextTask: next ? taskView(db.get("SELECT * FROM hostel_tasks WHERE id = ?", next)) : null });
  });

  app.delete("/api/hostel/tasks/:id", staff, (req, res) => {
    db.run("DELETE FROM hostel_tasks WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    res.json({ ok: true });
  });

  // ---------- assets ----------
  const assetView = (a) => {
    const room = a.room_id ? db.get("SELECT label FROM rooms WHERE id = ?", a.room_id) : null;
    return { id: a.id, buildingId: a.building_id, roomId: a.room_id || null, roomLabel: room?.label || "", name: a.name, category: a.category, quantity: a.quantity, condition: a.condition, brand: a.brand, serialNo: a.serial_no,
      purchasedOn: a.purchased_on, cost: toRupees(a.cost_paise), warrantyUntil: a.warranty_until, notes: a.notes, createdAt: a.created_at };
  };
  const ASSET_SCHEMA = {
    name: v.text({ label: "Item", max: 120, required: true }),
    category: v.text({ label: "Category", max: 40 }),
    quantity: v.number({ label: "Quantity", min: 0, max: 100000, integer: true, fallback: 1 }),
    condition: (x) => (CONDITIONS.includes(x) ? x : "good"),
    brand: v.text({ label: "Brand", max: 80 }),
    serialNo: v.text({ label: "Serial number", max: 80 }),
    purchasedOn: v.date({ label: "Bought on" }),
    cost: v.money("Cost"),
    warrantyUntil: v.date({ label: "Warranty until" }),
    notes: v.text({ label: "Notes", max: 500 }),
  };
  const ASSET_COLS = { name: "name", category: "category", quantity: "quantity", condition: "condition", brand: "brand", serialNo: "serial_no", purchasedOn: "purchased_on", warrantyUntil: "warranty_until", notes: "notes" };

  app.get("/api/hostel/assets", staff, (req, res) => {
    const where = ["org_id = ?"];
    const params = [req.orgId];
    if (req.query.buildingId) { where.push("building_id = ?"); params.push(String(req.query.buildingId)); }
    if (CONDITIONS.includes(req.query.condition)) { where.push("condition = ?"); params.push(req.query.condition); }
    res.json(db.all(`SELECT * FROM assets WHERE ${where.join(" AND ")} ORDER BY category, name LIMIT 2000`, ...params).map(assetView));
  });

  app.post("/api/hostel/assets", staff, (req, res) => {
    const b = requireBuilding(req, res, req.body?.buildingId);
    if (!b) return;
    const roomId = req.body?.roomId || null;
    if (roomId && !db.get("SELECT 1 FROM rooms WHERE id = ? AND building_id = ?", roomId, b.id)) return notFound(res, "Room");
    const d = v.clean(req.body, ASSET_SCHEMA);
    const id = db.id();
    db.run(`INSERT INTO assets (id, org_id, building_id, room_id, name, category, quantity, condition, brand, serial_no, purchased_on, cost_paise, warranty_until, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, req.orgId, b.id, roomId, d.name, d.category || "other", d.quantity, d.condition, d.brand, d.serialNo, d.purchasedOn, toPaise(d.cost), d.warrantyUntil, d.notes, db.nowIso());
    res.status(201).json(assetView(db.get("SELECT * FROM assets WHERE id = ?", id)));
  });

  app.put("/api/hostel/assets/:id", staff, (req, res) => {
    const a = db.get("SELECT * FROM assets WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!a) return notFound(res, "Item");
    const d = v.clean(req.body, ASSET_SCHEMA, { partial: true });
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(ASSET_COLS)) if (d[k] !== undefined) { sets.push(`${col} = ?`); params.push(d[k]); }
    if (d.cost !== undefined) { sets.push("cost_paise = ?"); params.push(toPaise(d.cost)); }
    if (req.body?.roomId !== undefined) {
      const roomId = req.body.roomId || null;
      if (roomId && !db.get("SELECT 1 FROM rooms WHERE id = ? AND building_id = ?", roomId, a.building_id)) return notFound(res, "Room");
      sets.push("room_id = ?"); params.push(roomId);
    }
    if (sets.length) db.run(`UPDATE assets SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), a.id);
    res.json(assetView(db.get("SELECT * FROM assets WHERE id = ?", a.id)));
  });

  app.delete("/api/hostel/assets/:id", staff, (req, res) => {
    db.run("DELETE FROM assets WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    res.json({ ok: true });
  });

  // ---------- notices ----------
  const noticeView = (n) => ({ id: n.id, buildingId: n.building_id || null, title: n.title, body: n.body, pinned: Boolean(n.pinned), expiresOn: n.expires_on || "", createdAt: n.created_at });

  app.get("/api/hostel/notices", staff, (req, res) => {
    const params = [req.orgId];
    let where = "org_id = ?";
    if (req.query.buildingId) { where += " AND (building_id = ? OR building_id IS NULL)"; params.push(String(req.query.buildingId)); }
    res.json(db.all(`SELECT * FROM notices WHERE ${where} ORDER BY pinned DESC, created_at DESC LIMIT 200`, ...params).map(noticeView));
  });

  app.post("/api/hostel/notices", staff, (req, res) => {
    const buildingId = req.body?.buildingId || null;
    if (buildingId && !buildingOf(req, buildingId)) return notFound(res, "Building");
    const title = v.text({ label: "Title", max: 120, required: true })(req.body?.title);
    const body = v.text({ label: "Notice", max: 3000 })(req.body?.body);
    const id = db.id();
    db.tx(() => {
      db.run("INSERT INTO notices (id, org_id, building_id, title, body, pinned, expires_on, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        id, req.orgId, buildingId, title, body, v.bool()(req.body?.pinned) ? 1 : 0, v.date({ label: "Show until" })(req.body?.expiresOn), req.user.id, db.nowIso());
      // In-app alert for every tenant who can see it.
      const tenants = db.all(`SELECT t.id FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.org_id = ? AND t.active = 1 ${buildingId ? "AND r.building_id = ?" : ""}`, ...(buildingId ? [req.orgId, buildingId] : [req.orgId]));
      for (const t of tenants) tellTenant(req.orgId, t.id, `Notice: ${title}`, body.slice(0, 200));
      audit(db, ctxOf(req), "notice.posted", "notice", id, { buildingId, recipients: tenants.length });
    });
    res.status(201).json(noticeView(db.get("SELECT * FROM notices WHERE id = ?", id)));
  });

  app.delete("/api/hostel/notices/:id", staff, (req, res) => {
    db.run("DELETE FROM notices WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    res.json({ ok: true });
  });

  // ================= tenant side =================
  const meTenant = (req) => db.get("SELECT * FROM tenants WHERE id = ? AND org_id = ? AND active = 1", req.user.tenant_id, req.orgId);

  app.get("/api/tenant/hostel", tenantOnly, (req, res) => {
    const t = meTenant(req);
    if (!t) return res.status(404).json({ error: "Your tenancy is not active." });
    const buildingId = tenantBuilding(t.id);
    const today = todayFor(req);
    const now = localNow(tz(req));
    const s = settingsFor(buildingId);
    const week = menuFor(buildingId);
    const leave = db.all("SELECT * FROM leave_requests WHERE tenant_id = ? AND status = 'approved' AND to_date >= ?", t.id, today);
    const days = [0, 1, 2].map((i) => {
      const date = addDays(today, i);
      const marks = new Map(db.all("SELECT * FROM meal_marks WHERE tenant_id = ? AND meal_date = ?", t.id, date).map((m) => [m.meal, m]));
      const away = leave.some((l) => l.from_date <= date && l.to_date >= date && l.skip_meals);
      return {
        date, weekday: weekday(date), onLeave: away,
        meals: MEALS.filter((m) => s.meals[m].on).map((m) => {
          const mark = marks.get(m);
          return { meal: m, time: s.meals[m].time, cutoff: s.meals[m].cutoff, menu: week[weekday(date)][m] || "", choice: away ? "leave" : mark ? (mark.going ? "going" : "not_going") : "", defaultChoice: s.mealDefault,
            canChange: !away && `${date}T${s.meals[m].cutoff}` > now, served: Boolean(mark?.served), rating: mark?.rating || null, canRate: Boolean(mark?.served) };
        }),
      };
    });
    res.json({
      enabled: Boolean(db.get("SELECT 1 FROM hostel_settings WHERE building_id = ?", buildingId)),
      settings: { curfew: s.curfew, gatePassApproval: s.gatePassApproval }, now, menu: week, days,
      leaves: db.all("SELECT * FROM leave_requests WHERE tenant_id = ? ORDER BY from_date DESC LIMIT 20", t.id).map(leaveView),
      passes: db.all("SELECT * FROM gate_passes WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20", t.id).map((p) => passView(p, now)),
      attendance: db.all("SELECT att_date AS date, status FROM attendance WHERE tenant_id = ? AND att_date >= ? ORDER BY att_date DESC", t.id, addDays(today, -30)),
      notices: db.all("SELECT * FROM notices WHERE org_id = ? AND (building_id = ? OR building_id IS NULL) AND (expires_on = '' OR expires_on >= ?) ORDER BY pinned DESC, created_at DESC LIMIT 30", req.orgId, buildingId, today).map(noticeView),
    });
  });

  app.post("/api/tenant/hostel/meals", tenantOnly, (req, res) => {
    const t = meTenant(req);
    if (!t) return res.status(404).json({ error: "Your tenancy is not active." });
    const buildingId = tenantBuilding(t.id);
    const s = settingsFor(buildingId);
    const date = v.date({ label: "Date" })(req.body?.date);
    const meal = req.body?.meal;
    if (!date || !MEALS.includes(meal) || !s.meals[meal].on) return res.status(400).json({ error: "Choose a meal." });
    if (`${date}T${s.meals[meal].cutoff}` <= localNow(tz(req))) return res.status(409).json({ error: `It's past the ${s.meals[meal].cutoff} cut-off for this meal.` });
    if (date > addDays(todayFor(req), 7)) return res.status(400).json({ error: "You can plan meals up to a week ahead." });
    const going = v.bool()(req.body?.going) ? 1 : 0;
    db.run(`INSERT INTO meal_marks (id, org_id, tenant_id, building_id, meal_date, meal, going, updated_at) VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(tenant_id, meal_date, meal) DO UPDATE SET going = excluded.going, updated_at = excluded.updated_at`, db.id(), req.orgId, t.id, buildingId, date, meal, going, db.nowIso());
    res.json({ ok: true, going: Boolean(going) });
  });

  app.post("/api/tenant/hostel/meals/rate", tenantOnly, (req, res) => {
    const t = meTenant(req);
    if (!t) return res.status(404).json({ error: "Your tenancy is not active." });
    const rating = v.number({ label: "Rating", min: 1, max: 5, integer: true, required: true })(req.body?.rating);
    const r = db.run("UPDATE meal_marks SET rating = ?, updated_at = ? WHERE tenant_id = ? AND meal_date = ? AND meal = ? AND served = 1", rating, db.nowIso(), t.id, String(req.body?.date || ""), String(req.body?.meal || ""));
    if (!r.changes) return res.status(409).json({ error: "You can rate a meal after it is served to you." });
    res.json({ ok: true });
  });

  app.post("/api/tenant/hostel/leaves", tenantOnly, (req, res) => {
    const t = meTenant(req);
    if (!t) return res.status(404).json({ error: "Your tenancy is not active." });
    const l = createLeave(req, t.id, "tenant");
    if (l.from_date < todayFor(req)) { db.run("DELETE FROM leave_requests WHERE id = ?", l.id); return res.status(400).json({ error: "Leave can't start in the past." }); }
    notifyStaff(db, req.orgId, { kind: "hostel", title: "Leave request", body: `${t.name}: ${l.from_date} to ${l.to_date}${l.reason ? ` (${l.reason})` : ""}`, link: "hostel" });
    res.status(201).json(leaveView(l));
  });

  app.post("/api/tenant/hostel/passes", tenantOnly, (req, res) => {
    const t = meTenant(req);
    if (!t) return res.status(404).json({ error: "Your tenancy is not active." });
    const p = createPass(req, t.id, "tenant");
    if (p.status === "pending") notifyStaff(db, req.orgId, { kind: "hostel", title: "Gate pass request", body: `${t.name}: out ${p.out_at.replace("T", " ")}, back by ${p.return_by.replace("T", " ")}`, link: "hostel" });
    res.status(201).json(passView(p, localNow(tz(req))));
  });

  app.post("/api/tenant/hostel/:kind(leaves|passes)/:id/cancel", tenantOnly, (req, res) => {
    const table = req.params.kind === "leaves" ? "leave_requests" : "gate_passes";
    const row = db.get(`SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?`, req.params.id, req.user.tenant_id);
    if (!row) return notFound(res, req.params.kind === "leaves" ? "Leave request" : "Gate pass");
    if (!["pending", "approved"].includes(row.status)) return res.status(409).json({ error: "This can't be cancelled now." });
    db.run(`UPDATE ${table} SET status = 'cancelled' WHERE id = ?`, row.id);
    res.json({ ok: true });
  });
}

module.exports = { register, localNow, mergeSettings, MEALS };
