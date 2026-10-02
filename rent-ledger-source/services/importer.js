// One-time import of the old db.json into SQLite.
//
// Runs on the first start of the SQLite version, inside a single transaction:
//   1. copies db.json to DATA_DIR/backups/ first
//   2. imports every record (rupees -> paise; bills -> charges + payments)
//   3. re-reads the result and checks every bill's amount and paid total
//      matches the old file exactly
// If any check fails, everything is rolled back and the server refuses to
// start, so Railway keeps the previous version running. db.json is never
// deleted or changed (an old version can still be rolled back to).
const fs = require("fs");
const path = require("path");
const { toPaise } = require("../lib/money");
const { contactKey, seedAuthorities } = require("./accounts");
const { getCharge } = require("./ledger");
const { audit } = require("./audit");

const CTX = { userId: null, role: "system", requestId: "legacy-import" };

function importLegacyJson(db, { dataDir, log, today }) {
  if (db.meta("legacy_import_done")) return { status: "already-done" };
  const jsonPath = path.join(dataDir, "db.json");
  const hasData = db.get("SELECT COUNT(*) AS n FROM organizations").n > 0;
  if (hasData || !fs.existsSync(jsonPath)) {
    db.meta("legacy_import_done", hasData ? "existing-sqlite-data" : "no-legacy-file");
    return { status: hasData ? "sqlite-already-has-data" : "no-legacy-file" };
  }
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch {
    throw new Error(`Cannot import ${jsonPath}: it is not valid JSON. Restore it from DATA_DIR/backups before starting this version.`);
  }
  const arr = (k) => (Array.isArray(legacy[k]) ? legacy[k] : []);
  if (!arr("users").length && !arr("buildings").length) {
    db.meta("legacy_import_done", "empty-legacy-file");
    return { status: "empty-legacy-file" };
  }

  // 1. keep an untouched copy of the old file
  const backupDir = path.join(dataDir, "backups");
  fs.mkdirSync(backupDir, { recursive: true });
  const backupName = `db-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-pre-sqlite.json`;
  fs.copyFileSync(jsonPath, path.join(backupDir, backupName));

  const warnings = [];
  const summary = db.tx(() => {
    const owner = arr("users").find((u) => u.role === "owner");
    const orgId = db.id();
    const ctx = { ...CTX, orgId };
    db.run("INSERT INTO organizations (id, name, time_zone, default_language, settings_json, created_at) VALUES (?,?,?,?,?,?)",
      orgId, owner ? `${owner.name}'s properties`.slice(0, 120) : "My properties", "Asia/Kolkata", "en", "{}", owner?.createdAt || db.nowIso());

    // Billing authorities keep their ids (rooms and gas bills point at them).
    const authorityIds = new Set();
    for (const a of arr("authorities")) {
      if (!a?.id || !a.name) continue;
      if (db.get("SELECT 1 FROM authorities WHERE org_id = ? AND name = ? COLLATE NOCASE", orgId, a.name)) { warnings.push(`Duplicate authority name skipped: ${a.name}`); continue; }
      db.run("INSERT INTO authorities (id, org_id, name, bill_url, created_at) VALUES (?,?,?,?,?)", a.id, orgId, a.name, a.billUrl || "", a.createdAt || db.nowIso());
      authorityIds.add(a.id);
    }
    seedAuthorities(db, orgId);

    const buildingIds = new Set();
    for (const b of arr("buildings")) {
      db.run("INSERT INTO buildings (id, org_id, name, address, total_floors, notes, created_at) VALUES (?,?,?,?,?,?,?)",
        b.id, orgId, b.name || "Building", b.address || "", Number(b.totalFloors) || 0, b.notes || "", b.createdAt || db.nowIso());
      buildingIds.add(b.id);
    }
    const roomIds = new Set();
    for (const r of arr("rooms")) {
      if (!buildingIds.has(r.buildingId)) { warnings.push(`Room ${r.id} skipped: its building is missing`); continue; }
      const electricityOnly = r.electricityOnly === true || r.electricityOnly === "true";
      db.run(`INSERT INTO rooms (id, org_id, building_id, floor_number, label, electricity_only, monthly_rent_paise, deposit_paise, status, notes, gas_meter_id, gas_authority_id, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        r.id, orgId, r.buildingId, Number(r.floorNumber) || 0, r.label || "Room", electricityOnly ? 1 : 0, electricityOnly ? 0 : toPaise(r.monthlyRent), electricityOnly ? 0 : toPaise(r.deposit),
        electricityOnly ? "owner" : (["vacant", "occupied"].includes(r.status) ? r.status : "vacant"), r.notes || "", r.gasMeterId || "",
        authorityIds.has(r.gasAuthorityId) || db.get("SELECT 1 FROM authorities WHERE id = ?", r.gasAuthorityId || "") ? r.gasAuthorityId : null, r.createdAt || db.nowIso());
      roomIds.add(r.id);
    }
    const tenantIds = new Set();
    const activeRooms = new Set();
    for (const t of arr("tenants").slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
      if (!roomIds.has(t.roomId)) { warnings.push(`Tenant ${t.id} skipped: room missing`); continue; }
      let active = t.active ? 1 : 0;
      if (active && activeRooms.has(t.roomId)) {
        active = 0;
        warnings.push(`Tenant "${t.name}" imported as moved out: their room already had an active tenant.`);
        audit(db, ctx, "import.tenant_deactivated", "tenant", t.id, { reason: "second active tenant in the same room" });
      }
      if (active) activeRooms.add(t.roomId);
      const inv = t.invite || {};
      db.run(`INSERT INTO tenants (id, org_id, room_id, name, mobile, alt_mobile, email, id_proof_type, id_proof_number, move_in_date, move_out_date, active, deposit_paise, notes,
                invite_code_hash, invite_expires_at, invite_attempts, invite_created_at, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        t.id, orgId, t.roomId, t.name || "Tenant", t.mobile || "", t.altMobile || "", t.email || "", t.idProofType || "", t.idProofNumber || "",
        t.moveInDate || "", t.moveOutDate || "", active, t.deposit === undefined || t.deposit === null ? null : toPaise(t.deposit), t.notes || "",
        inv.codeHash || null, inv.expiresAt || null, inv.attempts || 0, inv.createdAt || null, t.createdAt || db.nowIso());
      tenantIds.add(t.id);
    }

    const userIds = new Set();
    for (const u of arr("users")) {
      if (u.role === "tenant" && !tenantIds.has(u.tenantId)) { warnings.push(`Tenant login "${u.name}" skipped: tenant record missing`); continue; }
      let key = contactKey(u.contact);
      if (!key || db.get("SELECT 1 FROM users WHERE contact_key = ?", key)) {
        key = `raw:${String(u.contact || u.id).trim().toLowerCase()}`;
        if (db.get("SELECT 1 FROM users WHERE contact_key = ?", key)) { warnings.push(`Login "${u.name}" skipped: duplicate contact`); continue; }
        warnings.push(`Login "${u.name}" kept with its exact contact (another account uses the same number).`);
      }
      if (u.role === "tenant" && db.get("SELECT 1 FROM users WHERE tenant_id = ?", u.tenantId)) { warnings.push(`Second login for tenant "${u.name}" skipped`); continue; }
      db.run(`INSERT INTO users (id, org_id, name, contact, contact_key, email, password_hash, password_salt, role, tenant_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        u.id, orgId, u.name || "User", String(u.contact || ""), key, u.email || "", u.passwordHash, u.passwordSalt || null, u.role === "owner" ? "owner" : "tenant",
        u.role === "tenant" ? u.tenantId : null, u.createdAt || db.nowIso());
      userIds.add(u.id);
    }
    for (const s of arr("sessions")) {
      if (userIds.has(s.userId) && s.tokenHash && Date.parse(s.expiresAt) > Date.now()) {
        db.run("INSERT OR IGNORE INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?,?,?,?,?,?,?)",
          s.id || db.id(), s.tokenHash, s.userId, s.createdAt, s.lastSeenAt || s.createdAt, s.expiresAt, s.userAgent || "");
      }
    }

    // Bills -> charges. Money already received -> payments + allocations.
    const legacyPayments = new Map(arr("payments").filter((p) => p.razorpayPaymentId).map((p) => [p.razorpayPaymentId, p]));
    const online = new Map(); // razorpay payment id -> { allocations, entry info }
    const expected = [];
    const kinds = [["rentEntries", "rent"], ["electricityEntries", "electricity"], ["gasEntries", "gas"]];
    for (const [collection, kind] of kinds) {
      for (const e of arr(collection)) {
        if (!roomIds.has(e.roomId)) { warnings.push(`${kind} bill ${e.id} skipped: room missing`); continue; }
        const tenantId = tenantIds.has(e.tenantId) ? e.tenantId : null;
        const amount = kind === "rent" ? toPaise(e.rentAmount) : toPaise(e.amount);
        const paidTotal = kind === "rent" ? toPaise(e.amountPaid) : (e.status === "paid" || e.paidDate ? amount : 0);
        const details = kind === "electricity"
          ? { prevReading: Number(e.prevReading) || 0, currReading: Number(e.currReading) || 0, unitsConsumed: Number(e.unitsConsumed) || 0, ratePerUnit: Number(e.ratePerUnit) || 0 }
          : kind === "gas" ? { meterId: e.meterId || "", authorityId: e.authorityId || null, authorityName: e.authorityName || "" } : {};
        // Owner-only floors could still hold rent rows from very old versions.
        const room = db.get("SELECT electricity_only FROM rooms WHERE id = ?", e.roomId);
        if (kind === "rent" && room.electricity_only) { warnings.push(`Rent bill ${e.id} skipped: owner floor`); continue; }
        db.run(`INSERT INTO charges (id, org_id, room_id, tenant_id, kind, period_year, period_month, due_date, base_amount_paise, details_json, source, notes, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          e.id, orgId, e.roomId, tenantId, kind, Number(e.year) || null, Number(e.month) || null, e.dueDate || "", amount, JSON.stringify(details), "import", e.notes || "", e.createdAt || db.nowIso());
        if (e.receipt?.id && e.receipt.fileName) {
          db.run(`INSERT INTO documents (id, org_id, entity_type, entity_id, kind, file_name, original_name, mime_type, size_bytes, visible_to_tenant, review_status, uploaded_by_role, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            e.receipt.id, orgId, "charge", e.id, "payment_proof", path.basename(e.receipt.fileName), e.receipt.originalName || "payment-proof", e.receipt.mimeType || "application/octet-stream",
            Number(e.receipt.size) || 0, 1, "unverified", "tenant", e.receipt.uploadedAt || db.nowIso());
        }
        let manual = Math.max(paidTotal, 0);
        let allocatedSoFar = 0;
        if (e.onlinePayment?.paymentId) {
          const onlineAmount = Math.min(toPaise(e.onlinePayment.amount), manual || toPaise(e.onlinePayment.amount));
          const group = online.get(e.onlinePayment.paymentId) || { orderId: e.onlinePayment.orderId, paidAt: e.onlinePayment.paidAt, tenantId, roomId: e.roomId, allocations: [] };
          const onlineAlloc = Math.min(onlineAmount, amount);
          group.allocations.push({ chargeId: e.id, amountPaise: onlineAlloc });
          online.set(e.onlinePayment.paymentId, group);
          allocatedSoFar = onlineAlloc;
          manual = Math.max(manual - onlineAmount, 0);
        }
        if (manual > 0) {
          const paymentId = db.id();
          db.run(`INSERT INTO payments (id, org_id, tenant_id, room_id, amount_paise, method, reference, received_on, verification, source, idempotency_key, notes, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            paymentId, orgId, tenantId, e.roomId, manual, "other", "", e.paidDate || String(e.createdAt || db.nowIso()).slice(0, 10), "recorded", "import",
            `import:${kind}:${e.id}`, "Imported from the previous version (recorded by owner)", e.createdAt || db.nowIso());
          const alloc = Math.min(manual, amount - allocatedSoFar);
          if (alloc > 0) db.run("INSERT INTO allocations (id, org_id, payment_id, charge_id, amount_paise, note, created_at) VALUES (?,?,?,?,?,?,?)", db.id(), orgId, paymentId, e.id, alloc, "import", db.nowIso());
        }
        expected.push({ id: e.id, kind, amount, paid: Math.min(Math.max(paidTotal, 0), amount) });
      }
    }
    for (const [paymentIdRzp, group] of online) {
      const legacyPayment = legacyPayments.get(paymentIdRzp);
      const allocated = group.allocations.reduce((s, a) => s + a.amountPaise, 0);
      const amount = Math.max(legacyPayment ? toPaise(legacyPayment.amount) : allocated, allocated);
      if (amount <= 0) continue;
      const paymentId = db.id();
      db.run(`INSERT INTO payments (id, org_id, tenant_id, room_id, amount_paise, method, reference, received_on, verification, source, idempotency_key, provider, provider_payment_id, provider_order_id, notes, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        paymentId, orgId, group.tenantId, group.roomId, amount, "razorpay", paymentIdRzp, String(group.paidAt || legacyPayment?.paidAt || db.nowIso()).slice(0, 10), "verified", "razorpay",
        `razorpay:${paymentIdRzp}`, "razorpay", paymentIdRzp, group.orderId || legacyPayment?.razorpayOrderId || null, legacyPayment?.method ? `Paid by ${legacyPayment.method}` : "", group.paidAt || db.nowIso());
      for (const a of group.allocations) if (a.amountPaise > 0) db.run("INSERT INTO allocations (id, org_id, payment_id, charge_id, amount_paise, note, created_at) VALUES (?,?,?,?,?,?,?)", db.id(), orgId, paymentId, a.chargeId, a.amountPaise, "import", db.nowIso());
    }
    // Online payments that didn't land on any bill (e.g. the bill had already
    // been marked paid by hand) are still money received: import as credit.
    for (const p of arr("payments")) {
      if (p.status !== "paid" || !p.razorpayPaymentId || online.has(p.razorpayPaymentId) || toPaise(p.amount) <= 0) continue;
      db.run(`INSERT INTO payments (id, org_id, tenant_id, room_id, amount_paise, method, reference, received_on, verification, source, idempotency_key, provider, provider_payment_id, provider_order_id, notes, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        db.id(), orgId, tenantIds.has(p.tenantId) ? p.tenantId : null, roomIds.has(p.roomId) ? p.roomId : null, toPaise(p.amount), "razorpay", p.razorpayPaymentId,
        String(p.paidAt || p.createdAt || db.nowIso()).slice(0, 10), "verified", "razorpay", `razorpay:${p.razorpayPaymentId}`, "razorpay", p.razorpayPaymentId, p.razorpayOrderId || null,
        "Online payment not applied to a bill in the previous version (kept as tenant credit)", p.paidAt || db.nowIso());
      warnings.push(`Online payment ${p.razorpayPaymentId} had no bill attached; kept as tenant credit.`);
    }
    for (const p of arr("payments")) {
      if (!p.razorpayOrderId || !tenantIds.has(p.tenantId) || !roomIds.has(p.roomId)) continue;
      const linked = p.razorpayPaymentId ? db.get("SELECT id FROM payments WHERE provider_payment_id = ?", p.razorpayPaymentId) : null;
      db.run(`INSERT OR IGNORE INTO payment_orders (id, org_id, tenant_id, room_id, razorpay_order_id, amount_paise, currency, items_json, status, payment_id, method, created_at, paid_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        p.id, orgId, p.tenantId, p.roomId, p.razorpayOrderId, Math.max(toPaise(p.amount), 1), p.currency || "INR",
        JSON.stringify((p.items || []).map((i) => ({ kind: i.kind, entryId: i.entryId, month: i.month, year: i.year, amountPaise: toPaise(i.amount), result: i.result || null }))),
        p.status === "paid" ? "paid" : "created", linked?.id || null, p.method || null, p.createdAt || db.nowIso(), p.paidAt || null);
    }

    // Room status follows the (possibly corrected) active tenants.
    for (const id of roomIds) {
      const r = db.get("SELECT electricity_only FROM rooms WHERE id = ?", id);
      if (!r.electricity_only) db.run("UPDATE rooms SET status = ? WHERE id = ?", activeRooms.has(id) ? "occupied" : "vacant", id);
    }

    // 3. verify every bill against the old file
    const problems = [];
    for (const x of expected) {
      const c = getCharge(db, orgId, x.id, today);
      if (!c) { problems.push(`${x.kind} ${x.id}: missing`); continue; }
      if (c.amount_paise !== x.amount) problems.push(`${x.kind} ${x.id}: amount ${c.amount_paise} != ${x.amount}`);
      if (c.paid_paise !== x.paid) problems.push(`${x.kind} ${x.id}: paid ${c.paid_paise} != ${x.paid}`);
    }
    const count = (sql) => db.get(sql, orgId).n;
    if (count("SELECT COUNT(*) AS n FROM buildings WHERE org_id = ?") !== buildingIds.size) problems.push("building count mismatch");
    if (problems.length) {
      const err = new Error(`Import check failed (${problems.length} problem${problems.length === 1 ? "" : "s"}); nothing was changed. First: ${problems.slice(0, 5).join("; ")}`);
      err.code = "IMPORT_VERIFY_FAILED";
      throw err;
    }
    const result = {
      orgId, buildings: buildingIds.size, rooms: roomIds.size, tenants: tenantIds.size, users: userIds.size, bills: expected.length,
      onlinePayments: online.size, warnings, backup: backupName,
    };
    audit(db, ctx, "import.completed", "organization", orgId, { ...result, warnings: warnings.slice(0, 50) });
    db.meta("legacy_import_done", new Date().toISOString());
    db.meta("legacy_import_summary", JSON.stringify(result));
    return result;
  });

  fs.writeFileSync(path.join(dataDir, "db.json.MIGRATED-TO-SQLITE.txt"),
    `This folder's data moved to rent-ledger.sqlite on ${new Date().toISOString()}.\n` +
    `db.json is kept unchanged as a reference copy; changes made after this date are only in the SQLite file.\n` +
    `A copy taken just before the move is in backups/${backupName}.\n`);
  log?.info("legacy db.json imported into SQLite", { ...summary, warnings: summary.warnings.length });
  for (const w of summary.warnings) log?.warn("import warning", { warning: w });
  return { status: "imported", ...summary };
}

module.exports = { importLegacyJson };
