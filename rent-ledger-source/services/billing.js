// Bills for what tenants still owe (rent, electricity, gas, other charges),
// one bill per room and tenant. Used for the preview in Finance and for the
// PDF the owner prints or sends. Amounts come straight from the ledger.
const crypto = require("node:crypto");
const ledger = require("./ledger");
const { toRupees } = require("../lib/money");
const { PdfDocument, wrap, ready: pdfReady } = require("./billpdf");

const BILL_KINDS = { rent: ["rent"], electricity: ["electricity"], gas: ["gas"], other: ["maintenance", "late_fee", "damage", "other"] };
const DEFAULT_KINDS = ["rent", "electricity"];
const KIND_ORDER = ["rent", "electricity", "gas", "maintenance", "late_fee", "damage", "other"];
const groupOf = (kind) => Object.keys(BILL_KINDS).find((g) => BILL_KINDS[g].includes(kind)) || "other";

function parseFilters(input = {}) {
  const list = (value) => (Array.isArray(value) ? value : String(value ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);
  const id = (value) => (typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "");
  let kinds = [...new Set(list(input.kinds).filter((k) => BILL_KINDS[k]))];
  if (!kinds.length) kinds = [...DEFAULT_KINDS];
  const floor = input.floor === undefined || input.floor === null || input.floor === "" ? null : Number(input.floor);
  const keys = input.keys === undefined || input.keys === null ? null : list(input.keys).filter((k) => /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{0,64}$/.test(k)).slice(0, 1000);
  return {
    buildingId: id(input.buildingId),
    roomId: id(input.roomId),
    floor: Number.isInteger(floor) ? floor : null,
    kinds,
    includeFormer: [true, "1", "true", 1].includes(input.includeFormer),
    keys,
  };
}

function collectBills(db, orgId, filters, today) {
  const f = filters;
  const charges = ledger.listCharges(db, orgId, { buildingId: f.buildingId, roomId: f.roomId, kinds: f.kinds.flatMap((k) => BILL_KINDS[k]), status: "open" }, today);
  const rooms = new Map(db.all(`SELECT r.id, r.label, r.floor_number, r.status, r.building_id, b.name AS building_name, b.address AS building_address
    FROM rooms r JOIN buildings b ON b.id = r.building_id WHERE r.org_id = ?`, orgId).map((r) => [r.id, r]));
  const tenants = new Map(db.all("SELECT id, name, mobile, active FROM tenants WHERE org_id = ?", orgId).map((t) => [t.id, t]));
  const groups = new Map();
  const former = { keys: new Set(), paise: 0 };
  for (const c of charges) {
    const room = rooms.get(c.room_id);
    if (!room || (f.floor !== null && room.floor_number !== f.floor)) continue;
    const tenant = c.tenant_id ? tenants.get(c.tenant_id) || null : null;
    const key = `${room.id}:${tenant ? tenant.id : ""}`;
    if (tenant && !tenant.active && !f.includeFormer) { former.keys.add(key); former.paise += c.outstanding_paise; continue; }
    if (!groups.has(key)) groups.set(key, { key, room, tenant, charges: [] });
    groups.get(key).charges.push(c);
  }
  let bills = [...groups.values()].map((g) => shapeBill(db, orgId, g, today));
  const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
  bills.sort((a, b) => collator.compare(a.buildingName, b.buildingName) || a.floor - b.floor || collator.compare(a.roomLabel, b.roomLabel) || (b.tenantActive - a.tenantActive) || collator.compare(a.tenantName, b.tenantName));
  if (f.keys) {
    const wanted = new Set(f.keys);
    bills = bills.filter((b) => wanted.has(b.key));
  }
  return { bills, former: { count: former.keys.size, paise: former.paise } };
}

function shapeBill(db, orgId, g, today) {
  const ym = (c) => (c.period_year || 0) * 100 + (c.period_month || 0);
  const lines = g.charges
    .sort((a, b) => ym(a) - ym(b) || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || String(a.due_date).localeCompare(String(b.due_date)))
    .map((c) => ({
      id: c.id,
      kind: c.kind,
      title: `${ledger.KIND_LABELS[c.kind] || c.kind}${c.description ? ` – ${c.description}` : ""}`,
      period: c.period_year && c.period_month ? `${ledger.MONTHS[c.period_month]} ${c.period_year}` : "",
      dueDate: c.due_date || "",
      overdue: Boolean(c.due_date && c.due_date < today),
      amountPaise: c.amount_paise,
      paidPaise: c.paid_paise,
      pendingPaise: c.outstanding_paise,
      detail: chargeDetail(c),
    }));
  const byKind = { rent: 0, electricity: 0, gas: 0, other: 0 };
  for (const l of lines) byKind[groupOf(l.kind)] += l.pendingPaise;
  const pendingPaise = lines.reduce((s, l) => s + l.pendingPaise, 0);
  // Money the tenant paid that isn't on any bill yet (an advance) lowers what they need to pay now.
  const creditPaise = g.tenant ? ledger.listPayments(db, orgId, { tenantId: g.tenant.id, limit: 1000 }).reduce((s, p) => s + p.unallocated_paise, 0) : 0;
  const dueDates = lines.map((l) => l.dueDate).filter(Boolean).sort();
  return {
    key: g.key,
    ref: `B-${today.slice(2, 4)}${today.slice(5, 7)}-${crypto.createHash("sha1").update(g.key).digest("hex").slice(0, 6).toUpperCase()}`,
    buildingId: g.room.building_id,
    buildingName: g.room.building_name,
    buildingAddress: g.room.building_address || "",
    floor: g.room.floor_number,
    roomId: g.room.id,
    roomLabel: g.room.label,
    roomStatus: g.room.status,
    tenantId: g.tenant?.id || null,
    tenantName: g.tenant?.name || "",
    tenantMobile: g.tenant?.mobile || "",
    tenantActive: g.tenant ? Boolean(g.tenant.active) : true,
    lines,
    byKind,
    pendingPaise,
    creditPaise,
    payablePaise: Math.max(pendingPaise - creditPaise, 0),
    overdue: lines.some((l) => l.overdue),
    dueBy: dueDates[0] || "",
  };
}

function chargeDetail(c) {
  const d = c.details || {};
  if (c.kind === "electricity" && (d.currReading || d.prevReading)) {
    const n = (v) => Number(v || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });
    return `Meter ${n(d.prevReading)} to ${n(d.currReading)} = ${n(d.unitsConsumed ?? Math.max((d.currReading || 0) - (d.prevReading || 0), 0))} units × ₹${Number(d.ratePerUnit || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  if (c.kind === "gas" && d.meterId) return `Gas meter ${d.meterId}${d.authorityName ? ` · ${d.authorityName}` : ""}`;
  return "";
}

const floorName = (n) => (Number(n) === 0 ? "Ground floor" : `Floor ${n}`);
// "101" reads as "Room 101" on paper; labels like "Flat 2B" or "Shop 3" stay as they are.
const roomName = (label) => (/^(room|flat|shop|unit|apt|apartment|office|house|floor|suite|studio|pg|bed)\b/i.test(String(label).trim()) ? label : `Room ${label}`);

function billView(b) {
  return {
    key: b.key, ref: b.ref, buildingId: b.buildingId, buildingName: b.buildingName, floor: b.floor, floorName: floorName(b.floor),
    roomId: b.roomId, roomLabel: b.roomLabel, roomStatus: b.roomStatus, tenantId: b.tenantId, tenantName: b.tenantName, tenantActive: b.tenantActive,
    items: b.lines.length, overdue: b.overdue, dueBy: b.dueBy,
    rent: toRupees(b.byKind.rent), electricity: toRupees(b.byKind.electricity), gas: toRupees(b.byKind.gas), other: toRupees(b.byKind.other),
    pending: toRupees(b.pendingPaise), credit: toRupees(b.creditPaise), payable: toRupees(b.payablePaise),
  };
}

// ---------- PDF ----------

const COLORS = {
  ink: [33, 33, 52], muted: [108, 112, 132], accent: [78, 88, 175], deep: [50, 50, 93],
  line: [222, 224, 234], tint: [243, 244, 251], red: [190, 50, 50], green: [36, 128, 84],
};

function rs(paise) {
  const r = toRupees(paise);
  return `₹${r.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
function niceDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
  return m ? `${Number(m[3])} ${ledger.MONTHS[Number(m[2])]} ${m[1]}` : "";
}

function billTo(b) {
  if (b.tenantName) return { name: b.tenantName + (b.tenantActive ? "" : " (moved out)"), mobile: b.tenantMobile };
  return { name: b.roomStatus === "owner" ? "Owner's floor" : `Occupant of ${roomName(b.roomLabel)}`, mobile: "" };
}

function renderBillsPdf({ orgName, bills, today, paymentDetails = "" }) {
  const title = bills.length === 1 ? `Bill ${bills[0].ref} – ${bills[0].tenantName || bills[0].roomLabel}` : `Bills – ${niceDate(today)}`;
  const doc = new PdfDocument({ title });
  const W = doc.width;
  const H = doc.height;
  const M = 44;
  const R = W - M;
  const BOTTOM = H - 74;
  const col = { desc: M + 10, period: M + 178, due: M + 240, amount: M + 372, paid: M + 432, pending: R - 10 };

  for (const b of bills) {
    const pages = [];
    const to = billTo(b);
    const newPage = (continued) => {
      const p = doc.addPage();
      pages.push(p);
      p.rect(0, 0, W, 6, { fill: COLORS.accent });
      if (continued) {
        p.text(`${orgName} · Bill ${b.ref} (continued)`, M, 40, { size: 9, color: COLORS.muted, maxWidth: R - M });
        p.text(`${to.name} · ${roomName(b.roomLabel)} · ${floorName(b.floor)}`, M, 54, { size: 10, bold: true, color: COLORS.ink, maxWidth: R - M });
      }
      return p;
    };

    // Header: who the bill is from, and the bill's reference and date.
    let p = newPage(false);
    p.text("BILL", R, 62, { size: 24, bold: true, color: COLORS.accent, align: "right" });
    p.text(`Ref. ${b.ref}`, R, 80, { size: 9, color: COLORS.muted, align: "right" });
    p.text(`Date: ${niceDate(today)}`, R, 93, { size: 9, color: COLORS.muted, align: "right" });
    p.text(orgName, M, 60, { size: 18, bold: true, color: COLORS.ink, maxWidth: 330 });
    p.text(b.buildingName, M, 78, { size: 10.5, bold: true, color: COLORS.muted, maxWidth: 330 });
    let y = b.buildingAddress ? p.paragraph(b.buildingAddress, M, 92, { size: 9, color: COLORS.muted, maxWidth: 330, maxLines: 2, lineHeight: 12 }) : 86;
    y = Math.max(y, 100) + 8;
    p.line(M, y, R, y, { color: COLORS.line });

    // Who it is for, and the amount to pay.
    const top = y + 24;
    p.text("BILLED TO", M, top, { size: 7.5, bold: true, color: COLORS.muted });
    p.text(to.name, M, top + 18, { size: 13, bold: true, color: COLORS.ink, maxWidth: 270 });
    p.text(`${roomName(b.roomLabel)} · ${floorName(b.floor)}`, M, top + 34, { size: 10, color: COLORS.ink, maxWidth: 270 });
    if (to.mobile) p.text(`Mobile: ${to.mobile}`, M, top + 48, { size: 9, color: COLORS.muted, maxWidth: 270 });
    const boxW = 210;
    const boxX = R - boxW;
    p.rect(boxX, top - 14, boxW, 74, { fill: COLORS.tint, radius: 8 });
    p.text("AMOUNT TO PAY", boxX + 14, top + 2, { size: 7.5, bold: true, color: COLORS.muted });
    p.text(rs(b.payablePaise), boxX + 14, top + 28, { size: 21, bold: true, color: COLORS.deep, maxWidth: boxW - 28 });
    if (b.payablePaise > 0) {
      if (b.overdue) p.text("Overdue – please pay now", boxX + 14, top + 47, { size: 9, bold: true, color: COLORS.red });
      else if (b.dueBy) p.text(`Please pay by ${niceDate(b.dueBy)}`, boxX + 14, top + 47, { size: 9, color: COLORS.ink });
    } else {
      p.text("Covered by your advance", boxX + 14, top + 47, { size: 9, color: COLORS.green });
    }
    y = top + 84;

    // Table of pending charges.
    const tableHead = () => {
      p.rect(M, y, R - M, 22, { fill: COLORS.tint, radius: 4 });
      const hy = y + 14.5;
      const o = { size: 7.5, bold: true, color: COLORS.muted };
      p.text("DESCRIPTION", col.desc, hy, o);
      p.text("PERIOD", col.period, hy, o);
      p.text("DUE DATE", col.due, hy, o);
      p.text("AMOUNT", col.amount, hy, { ...o, align: "right" });
      p.text("PAID", col.paid, hy, { ...o, align: "right" });
      p.text("PENDING", col.pending, hy, { ...o, align: "right" });
      y += 22;
    };
    tableHead();
    for (const l of b.lines) {
      const h = l.detail ? 34 : 24;
      if (y + h > BOTTOM) { p = newPage(true); y = 72; tableHead(); }
      const ty = y + 15.5;
      p.text(l.title, col.desc, ty, { size: 9.5, bold: true, color: COLORS.ink, maxWidth: col.period - col.desc - 8 });
      if (l.detail) p.text(l.detail, col.desc, ty + 12, { size: 7.5, color: COLORS.muted, maxWidth: col.amount - col.desc - 70 });
      p.text(l.period || "–", col.period, ty, { size: 9.5, color: COLORS.ink });
      p.text(l.dueDate ? niceDate(l.dueDate) : "–", col.due, ty, { size: 9.5, color: l.overdue ? COLORS.red : COLORS.ink, bold: l.overdue });
      p.text(rs(l.amountPaise), col.amount, ty, { size: 9.5, color: COLORS.ink, align: "right" });
      p.text(l.paidPaise ? rs(l.paidPaise) : "–", col.paid, ty, { size: 9.5, color: COLORS.muted, align: "right" });
      p.text(rs(l.pendingPaise), col.pending, ty, { size: 9.5, bold: true, color: COLORS.ink, align: "right" });
      y += h;
      p.line(M, y, R, y, { color: COLORS.line, width: 0.5 });
    }

    // Totals, then how to pay.
    const inner = R - M - 28;
    const payLines = paymentDetails ? Math.min(wrap(paymentDetails, inner, 9.5).length, 9) : 0;
    const totalsH = (b.creditPaise ? 74 : 54) + (payLines ? 40 + payLines * 13 : 0);
    if (y + 16 + totalsH > BOTTOM) { p = newPage(true); y = 72; }
    y += 22;
    const labelX = R - 230;
    p.text("Total pending", labelX, y, { size: 10, color: COLORS.ink });
    p.text(rs(b.pendingPaise), col.pending, y, { size: 10, bold: true, color: COLORS.ink, align: "right" });
    if (b.creditPaise) {
      y += 18;
      p.text("Already paid in advance", labelX, y, { size: 10, color: COLORS.ink });
      p.text(`- ${rs(b.creditPaise)}`, col.pending, y, { size: 10, bold: true, color: COLORS.green, align: "right" });
    }
    y += 10;
    p.line(labelX, y, R, y, { color: COLORS.deep, width: 1 });
    y += 18;
    p.text("Amount to pay", labelX, y, { size: 12, bold: true, color: COLORS.deep });
    p.text(rs(b.payablePaise), col.pending, y, { size: 12, bold: true, color: COLORS.deep, align: "right" });

    if (paymentDetails) {
      y += 30;
      const boxTop = y;
      const boxH = 35 + payLines * 13;
      p.rect(M, boxTop, R - M, boxH, { stroke: COLORS.line, radius: 8 });
      p.text("HOW TO PAY", M + 14, boxTop + 18, { size: 7.5, bold: true, color: COLORS.muted });
      p.paragraph(paymentDetails, M + 14, boxTop + 34, { size: 9.5, color: COLORS.ink, maxWidth: inner, maxLines: 9, lineHeight: 13 });
    }

    // Footer on each page of this bill.
    pages.forEach((pg, i) => {
      pg.line(M, H - 50, R, H - 50, { color: COLORS.line, width: 0.5 });
      pg.text(`Amounts pending on ${niceDate(today)}. Payments made after this date are not included. Made with Rent Ledger.`, M, H - 34, { size: 7.5, color: COLORS.muted, maxWidth: R - M - 70 });
      pg.text(`Page ${i + 1} of ${pages.length}`, R, H - 34, { size: 7.5, color: COLORS.muted, align: "right" });
    });
  }
  return doc.toBuffer();
}

module.exports = { pdfReady, BILL_KINDS, DEFAULT_KINDS, parseFilters, collectBills, billView, renderBillsPdf, floorName, roomName };
