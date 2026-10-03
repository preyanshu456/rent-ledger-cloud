// Finance dashboard and reports (JSON, CSV, printable HTML).
const { toRupees } = require("../lib/money");
const finance = require("../services/finance");
const accounts = require("../services/accounts");
const billing = require("../services/billing");
const { audit } = require("../services/audit");
const { requirePermission, sendCsv, escapeHtml, printablePage, ctxOf } = require("./common");

function rupeesDeep(obj) {
  if (Array.isArray(obj)) return obj.map(rupeesDeep);
  if (obj && typeof obj === "object") {
    const out = {};
    for (const [k, val] of Object.entries(obj)) {
      if (k.endsWith("Paise") && typeof val === "number") out[k.slice(0, -5)] = toRupees(val);
      else out[k] = rupeesDeep(val);
    }
    return out;
  }
  return obj;
}

function register(app, { db, todayFor }) {
  // ---------- bills for pending amounts (per room / tenant) ----------
  // Preview: who owes what, filtered by property, floor, room and type.
  app.get("/api/bills/preview", requirePermission("reports.view"), (req, res) => {
    const filters = billing.parseFilters(req.query);
    const { bills, former } = billing.collectBills(db, req.orgId, filters, todayFor(req));
    const sum = (k) => bills.reduce((s, b) => s + b[k], 0);
    res.json({
      filters: { ...filters, keys: undefined },
      bills: bills.map(billing.billView),
      totals: { bills: bills.length, pending: toRupees(sum("pendingPaise")), credit: toRupees(sum("creditPaise")), payable: toRupees(sum("payablePaise")) },
      former: { count: former.count, pending: toRupees(former.paise) },
    });
  });

  // PDF: one bill (one or more pages) per room / tenant. POST so a long list
  // of chosen bills fits; nothing is changed.
  app.post("/api/bills/pdf", requirePermission("reports.view"), (req, res) => {
    const today = todayFor(req);
    const filters = billing.parseFilters(req.body || {});
    const { bills } = billing.collectBills(db, req.orgId, filters, today);
    if (!bills.length) return res.status(404).json({ error: "Nothing is pending for this choice." });
    const org = accounts.getOrg(db, req.orgId);
    const pdf = billing.renderBillsPdf({ orgName: org.name, bills, today, paymentDetails: org.settings.bills.paymentDetails });
    audit(db, ctxOf(req), "bills.pdf_created", "organization", req.orgId, { bills: bills.length, kinds: filters.kinds, buildingId: filters.buildingId || null, floor: filters.floor, roomId: filters.roomId || null });
    const slug = (s) => String(s || "").normalize("NFKD").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const name = bills.length === 1
      ? `bill-${[slug(bills[0].buildingName), slug(bills[0].roomLabel), slug(bills[0].tenantName)].filter(Boolean).join("-")}-${today}.pdf`
      : `bills-${filters.buildingId ? `${slug(bills[0].buildingName)}-` : ""}${filters.floor !== null ? `${slug(billing.floorName(filters.floor))}-` : ""}${today}.pdf`;
    res.setHeader("Content-Disposition", `attachment; filename="${name.replace(/[^A-Za-z0-9._-]/g, "_")}"`);
    res.setHeader("Cache-Control", "no-store");
    res.type("application/pdf").send(pdf);
  });

  app.get("/api/finance/summary", requirePermission("reports.view"), (req, res) => {
    res.json(rupeesDeep(finance.summary(db, req.orgId, req.query, todayFor(req))));
  });

  app.get("/api/reports", requirePermission("reports.view"), (req, res) => {
    res.json(finance.REPORT_TYPES);
  });

  app.get("/api/reports/:type", requirePermission("reports.view"), (req, res) => {
    const today = todayFor(req);
    const r = finance.report(db, req.orgId, req.params.type, req.query, today);
    if (!r) return res.status(404).json({ error: "Unknown report" });
    const range = finance.normaliseRange(req.query, today);
    if (req.query.format === "csv") return sendCsv(res, `${req.params.type}-${range.from}-to-${range.to}.csv`, r.columns, r.rows);
    if (req.query.format === "html") {
      const org = accounts.getOrg(db, req.orgId);
      const totals = r.moneyColumns.map((i) => r.rows.reduce((s, row) => s + (Number(row[i]) || 0), 0));
      const head = r.columns.map((c, i) => `<th${r.moneyColumns.includes(i) ? ' class="num"' : ""}>${escapeHtml(c)}</th>`).join("");
      const body = r.rows.map((row) => `<tr>${row.map((cell, i) => `<td${r.moneyColumns.includes(i) ? ' class="num"' : ""}>${r.moneyColumns.includes(i) ? "₹" + Number(cell).toLocaleString("en-IN") : escapeHtml(cell)}</td>`).join("")}</tr>`).join("");
      const totalRow = r.rows.length && r.moneyColumns.length ? `<tr class="total">${r.columns.map((c, i) => `<td${r.moneyColumns.includes(i) ? ' class="num"' : ""}>${i === 0 ? "Total" : r.moneyColumns.includes(i) ? "₹" + totals[r.moneyColumns.indexOf(i)].toLocaleString("en-IN") : ""}</td>`).join("")}</tr>` : "";
      return res.type("html").send(printablePage(r.title, `<h1>${escapeHtml(r.title)}</h1><p class="muted">${escapeHtml(org.name)} · ${escapeHtml(range.from)} to ${escapeHtml(range.to)} · generated ${escapeHtml(today)}</p>
        <table><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${r.columns.length}">No records.</td></tr>`}${totalRow}</tbody></table>`));
    }
    res.json({ ...r, range });
  });
}

module.exports = { register, rupeesDeep };
