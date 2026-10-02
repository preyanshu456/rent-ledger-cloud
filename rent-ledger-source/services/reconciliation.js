// Bank / UPI statement reconciliation.
//   1. parse the CSV a bank or UPI app exports, keep only money coming in
//   2. normalise dates, amounts, references and payer names
//   3. skip rows already imported (fingerprint) and flag possible duplicates
//   4. suggest which tenant/bills each credit belongs to, with a confidence
//      level and the evidence, for a person to confirm
const crypto = require("crypto");
const ledger = require("./ledger");
const { toPaise } = require("../lib/money");

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

const HEADERS = {
  date: [/^(txn|transaction|value|posting|tran)?\s*date$/i, /^date/i],
  credit: [/^(credit|deposit|cr)(\s*amount)?(\s*\(.*\))?$/i, /^amount\s*cr/i, /credit/i, /deposit/i],
  debit: [/^(debit|withdrawal|dr)(\s*amount)?(\s*\(.*\))?$/i, /withdraw/i, /debit/i],
  amount: [/^(txn|transaction)?\s*amount(\s*\(.*\))?$/i, /^amount/i],
  type: [/^(type|cr\/dr|dr\/cr|transaction type)$/i],
  description: [/narration|description|particulars|remarks|details/i],
  reference: [/utr|ref|reference|cheque|chq|transaction\s*id|txn\s*id/i],
  payer: [/payer|sender|from|name|paid by/i],
};

function detectColumns(header) {
  const cols = {};
  const used = new Set();
  for (const key of ["date", "credit", "debit", "amount", "type", "reference", "description", "payer"]) {
    for (const re of HEADERS[key]) {
      const idx = header.findIndex((h, i) => !used.has(i) && re.test(String(h).trim()));
      if (idx >= 0) { cols[key] = idx; used.add(idx); break; }
    }
  }
  return cols;
}

const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function normDate(value) {
  const s = String(value || "").trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return iso(y, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{1,2})[\s\-/]([A-Za-z]{3})[A-Za-z]*[\s\-/,]+(\d{2,4})/.exec(s);
  if (m && MON[m[2].toLowerCase()]) return iso(m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]), MON[m[2].toLowerCase()], Number(m[1]));
  return null;
}
function iso(y, mo, d) {
  const out = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && new Date(`${out}T00:00:00Z`).toISOString().slice(0, 10) === out ? out : null;
}
function normAmount(value) {
  const s = String(value || "").replace(/[₹,\s]|INR|Rs\.?/gi, "");
  const m = /^(-?\d+(?:\.\d{1,2})?)(CR|DR)?$/i.exec(s);
  if (!m) return null;
  return { value: Number(m[1]), side: m[2] ? m[2].toUpperCase() : null };
}

// Pulls a UPI/IMPS reference and payer name out of a bank narration such as
// "UPI/CR/412345678901/ASHA VERMA/SBIN/asha@okaxis/Rent".
function fromNarration(text) {
  const out = {};
  const ref = /\b(\d{12})\b/.exec(text) || /\b(UTR[:\s]*[A-Z0-9]{10,22})\b/i.exec(text) || /\b([A-Z]{4}[0-9A-Z]{12,18})\b/.exec(text);
  if (ref) out.reference = ref[1].replace(/^UTR[:\s]*/i, "");
  const upi = /UPI\/(?:CR\/)?\d{6,}\/([^/]+)\//i.exec(text) || /(?:FROM|BY)\s+([A-Z][A-Z .]{2,40})/i.exec(text);
  if (upi) out.payer = upi[1].trim();
  return out;
}

function parseStatement(csvText) {
  const rows = parseCsv(csvText);
  const headerIdx = rows.findIndex((r) => {
    const c = detectColumns(r);
    return c.date !== undefined && (c.credit !== undefined || c.amount !== undefined);
  });
  if (headerIdx < 0) throw Object.assign(new Error("Couldn't find the date and amount columns. Export the statement as CSV with a header row (Date, Description, Credit/Amount, Reference)."), { status: 400, expose: true });
  const cols = detectColumns(rows[headerIdx]);
  const credits = [];
  let skipped = 0;
  for (const r of rows.slice(headerIdx + 1)) {
    const date = normDate(r[cols.date]);
    let amount = null;
    if (cols.credit !== undefined) {
      const c = normAmount(r[cols.credit]);
      if (c && c.value > 0) amount = c.value;
    } else if (cols.amount !== undefined) {
      const a = normAmount(r[cols.amount]);
      const type = cols.type !== undefined ? String(r[cols.type] || "").trim().toUpperCase() : "";
      if (a && a.value > 0 && (a.side === "CR" || type.startsWith("CR") || type === "CREDIT" || (!a.side && !type))) amount = a.value;
    }
    if (!date || !amount) { skipped++; continue; }
    const description = cols.description !== undefined ? String(r[cols.description] || "").trim() : "";
    const guess = fromNarration(description);
    credits.push({
      date, amountPaise: toPaise(amount), description: description.slice(0, 500),
      reference: String(cols.reference !== undefined ? r[cols.reference] || "" : guess.reference || "").trim().slice(0, 80),
      payer: String(cols.payer !== undefined ? r[cols.payer] || "" : guess.payer || "").trim().slice(0, 120),
    });
  }
  return { credits, skipped, columns: cols };
}

function fingerprint(t) {
  return crypto.createHash("sha256").update([t.date, t.amountPaise, t.reference.toLowerCase(), t.description.toLowerCase().replace(/\s+/g, " ")].join("|")).digest("hex");
}

function nameTokens(name) {
  return String(name || "").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !["mr", "mrs", "shri", "smt", "kumar", "devi"].includes(w));
}

function daysBetween(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

// Scored suggestions for one bank credit.
function suggestMatches(db, orgId, txn, today) {
  const haystack = `${txn.payer} ${txn.description}`.toLowerCase();
  const digits = haystack.replace(/\D/g, "");
  const tenants = db.all("SELECT t.*, r.label AS room_label, r.monthly_rent_paise FROM tenants t JOIN rooms r ON r.id = t.room_id WHERE t.org_id = ? AND (t.active = 1 OR t.move_out_date >= ?)", orgId, new Date(Date.parse(`${txn.txn_date}T00:00:00Z`) - 90 * 86_400_000).toISOString().slice(0, 10));
  const out = [];
  for (const t of tenants) {
    const open = ledger.listCharges(db, orgId, { tenantId: t.id, status: "open" }, today);
    const totalDue = open.reduce((s, c) => s + c.outstanding_paise, 0);
    let score = 0;
    const evidence = [];
    const tokens = nameTokens(t.name);
    const hits = tokens.filter((w) => haystack.includes(w));
    if (hits.length >= 2) { score += 40; evidence.push(`Payer/narration contains "${hits.join(" ")}" (tenant's name)`); }
    else if (hits.length === 1) { score += 25; evidence.push(`Payer/narration contains "${hits[0]}" (part of tenant's name)`); }
    const mobile = String(t.mobile || "").replace(/\D/g, "").slice(-10);
    if (mobile.length === 10 && digits.includes(mobile)) { score += 40; evidence.push("Narration contains the tenant's mobile number"); }
    const exact = open.filter((c) => c.outstanding_paise === txn.amount_paise);
    let proposal = [];
    if (exact.length) {
      score += 35;
      const c = exact.sort((a, b) => daysBetween(a.due_date || today, txn.txn_date) - daysBetween(b.due_date || today, txn.txn_date))[0];
      evidence.push(`Amount equals the open bill "${ledger.chargeLabel(c)}"`);
      proposal = [{ chargeId: c.id, amountPaise: c.outstanding_paise, label: ledger.chargeLabel(c) }];
      if (c.due_date && daysBetween(c.due_date, txn.txn_date) <= 10) { score += 10; evidence.push(`Paid within 10 days of the due date (${c.due_date})`); }
    } else if (totalDue && totalDue === txn.amount_paise) {
      score += 30; evidence.push("Amount equals the tenant's total outstanding");
    } else if (t.monthly_rent_paise && t.monthly_rent_paise === txn.amount_paise) {
      score += 15; evidence.push("Amount equals the room's monthly rent");
    }
    if (!proposal.length && totalDue) {
      let left = txn.amount_paise;
      for (const c of open.sort((a, b) => (a.due_date || "9").localeCompare(b.due_date || "9"))) {
        if (left <= 0) break;
        const amt = Math.min(left, c.outstanding_paise);
        proposal.push({ chargeId: c.id, amountPaise: amt, label: ledger.chargeLabel(c) });
        left -= amt;
      }
    }
    if (score > 0) {
      const credit = txn.amount_paise - proposal.reduce((s, p) => s + p.amountPaise, 0);
      out.push({
        tenantId: t.id, tenantName: t.name, roomLabel: t.room_label, score: Math.min(score, 100),
        confidence: score >= 70 ? "high" : score >= 40 ? "medium" : "low", evidence, allocations: proposal, creditPaise: Math.max(credit, 0), outstandingPaise: totalDue,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}

// Signs that a credit may already be in the ledger.
function duplicateFlags(db, orgId, txn) {
  const flags = [];
  if (txn.reference && db.get("SELECT 1 FROM payments WHERE org_id = ? AND reference <> '' AND (reference = ? OR provider_payment_id = ?)", orgId, txn.reference, txn.reference)) flags.push("reference_already_recorded");
  const same = db.get("SELECT COUNT(*) AS n FROM payments p WHERE p.org_id = ? AND p.amount_paise = ? AND p.received_on = ? AND NOT EXISTS (SELECT 1 FROM payment_reversals r WHERE r.payment_id = p.id)", orgId, txn.amount_paise, txn.txn_date).n;
  if (same) flags.push("same_amount_and_date_recorded");
  return flags;
}

module.exports = { parseCsv, parseStatement, fingerprint, suggestMatches, duplicateFlags, normDate, normAmount, fromNarration };
