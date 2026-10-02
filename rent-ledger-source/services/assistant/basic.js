// Basic mode: a rule-based router used when no AI provider is configured (or
// the owner hasn't turned AI on). It recognises common questions in English
// and Hindi and maps them to the same tools the AI uses, so every answer is
// computed from the ledger. Anything it doesn't recognise gets a help message
// rather than a guess.
const finance = require("../finance");
const { findTenants } = require("./tools");

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const SHORT = MONTH_NAMES.map((m) => m.slice(0, 3));

function monthFrom(text, today) {
  const t = text.toLowerCase();
  const iso = t.match(/\b(20\d{2})-(0[1-9]|1[0-2])\b/);
  if (iso) return `${iso[1]}-${iso[2]}`;
  if (/\blast month\b|पिछले महीने/.test(t)) return finance.addMonths(today.slice(0, 7), -1);
  if (/\bthis month\b|इस महीने/.test(t)) return today.slice(0, 7);
  const named = t.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b(?:\s+(20\d{2}))?/);
  if (named) {
    const idx = SHORT.indexOf(named[1].slice(0, 3)) + 1;
    let year = named[2] ? Number(named[2]) : Number(today.slice(0, 4));
    // "March" said in January means last March.
    if (!named[2] && idx > Number(today.slice(5, 7))) year -= 1;
    return `${year}-${String(idx).padStart(2, "0")}`;
  }
  return undefined;
}

function daysFrom(text) {
  const m = text.toLowerCase().match(/\b(\d{1,3})\s*(day|days|दिन)\b/);
  if (m) return Number(m[1]);
  const w = text.toLowerCase().match(/\b(\d{1,2})\s*(month|months|महीने)\b/);
  if (w) return Number(w[1]) * 30;
  if (/\bnext month\b/.test(text.toLowerCase())) return 30;
  return undefined;
}

function amountFrom(text) {
  const m = text.replace(/,/g, "").match(/(?:₹|rs\.?|inr|rupees?)\s*(\d+(?:\.\d{1,2})?)|(\d+(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr|rupees?|रुपये)/i)
    || text.replace(/,/g, "").match(/\b(\d{2,9}(?:\.\d{1,2})?)\b/);
  if (!m) return undefined;
  return Number(m[1] || m[2]);
}

// The tenant named in the message, matched against this organisation's tenants.
function tenantIn(db, orgId, text) {
  const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ")} `;
  const tenants = db.all("SELECT name FROM tenants WHERE org_id = ? AND anonymized_at IS NULL ORDER BY active DESC", orgId);
  const full = tenants.find((x) => x.name && t.includes(` ${x.name.toLowerCase()} `));
  if (full) return full.name;
  const first = tenants.find((x) => { const f = x.name.toLowerCase().split(/\s+/)[0]; return f.length > 2 && t.includes(` ${f} `); });
  return first ? first.name.split(/\s+/)[0] : undefined;
}

function propertyIn(db, orgId, text) {
  const t = text.toLowerCase();
  const buildings = db.all("SELECT name FROM buildings WHERE org_id = ? AND status = 'active'", orgId);
  return buildings.find((b) => t.includes(b.name.toLowerCase()))?.name
    || buildings.find((b) => b.name.toLowerCase().split(/\s+/).some((w) => w.length > 3 && t.includes(w)))?.name;
}

const EXPENSE_CATEGORIES = [
  ["repairs", /repair|fix|मरम्मत/], ["utilities", /electric|water|utility|bill|बिजली|पानी/], ["property_tax", /property tax|house tax|tax/],
  ["insurance", /insurance|बीमा/], ["management_fee", /management|agent|broker/], ["maintenance", /maintenance|clean|paint|plumb|सफाई/],
];

// Returns { tool, input } or { help, reason } when the message isn't understood.
function route(db, orgId, message, today) {
  const text = String(message || "").trim();
  const t = text.toLowerCase();
  const month = monthFrom(text, today);

  // Prepare actions first: they contain words the questions below also use.
  if (/\b(draft|prepare|write|send|create)\b.*\b(remind|reminder|reminders|message|messages|notice)\b|रिमाइंडर|याद\s*दिला/.test(t)) {
    const name = tenantIn(db, orgId, text);
    return { tool: "draft_overdue_reminders", input: name && !/\ball\b|सभी|सब/.test(t) ? { tenantNames: [name] } : {} };
  }
  if (/\b(add|record|log|enter)\b.*\bexpense\b|खर्च\s*(जोड़|दर्ज)/.test(t)) {
    const property = propertyIn(db, orgId, text);
    const amount = amountFrom(text);
    if (!property || !amount) return { help: true, reason: `To prepare an expense I need the property and the amount, e.g. "Add expense ₹2,500 for plumbing repair at ${db.get("SELECT name FROM buildings WHERE org_id = ? LIMIT 1", orgId)?.name || "Green View"}".` };
    const category = EXPENSE_CATEGORIES.find(([, re]) => re.test(t))?.[0] || "other";
    const date = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
    return { tool: "prepare_expense", input: { property, amount, category, description: text.slice(0, 200), ...(date ? { date } : {}) } };
  }
  if (/\b(create|add|log|raise|make|new)\b.*\b(maintenance|repair|task|ticket|work order)\b/.test(t)) {
    const property = propertyIn(db, orgId, text);
    if (!property) return { help: true, reason: "To prepare a maintenance task, name the property, e.g. \"Create maintenance task at Green View room 101: fix the leaking tap\"." };
    const room = text.match(/\broom\s+([\w-]+)/i)?.[1];
    const title = (text.split(/[:\-–]\s+/).slice(1).join(" - ") || text.replace(/^.*?\b(?:to|for)\b\s+/i, "")).trim().slice(0, 120) || "Maintenance task";
    const priority = /\burgent|emergency|तुरंत/.test(t) ? "urgent" : /\bhigh priority|asap\b/.test(t) ? "high" : "normal";
    return { tool: "prepare_maintenance_task", input: { property, title, priority, description: text.slice(0, 500), ...(room ? { room } : {}) } };
  }

  if (/\bstatement\b|स्टेटमेंट/.test(t)) {
    const name = tenantIn(db, orgId, text);
    if (name) return { tool: "prepare_statement", input: { name } };
    return { help: true, reason: "Whose statement? Include the tenant's name, e.g. \"Statement for Ravi Kumar\"." };
  }
  const name = tenantIn(db, orgId, text);
  if (name && /\b(balance|owe|owes|due|dues|pending|paid|pay|outstanding)\b|बकाया|बाकी/.test(t)) return { tool: "tenant_balance", input: { name } };

  if (/\b(cash ?flow|forecast|predict|projection|shortfall|next month)\b|अनुमान/.test(t)) return { tool: "cashflow_insights", input: {} };
  if (/\b(anomal\w*|unusual|suspicious|duplicate|strange|odd|review alerts?|anything wrong)\b|गड़बड़/.test(t)) return { tool: "anomalies", input: {} };
  if (/\b(reconcil\w*|bank|unmatched|upi credits?)\b/.test(t)) return { tool: "reconciliation_suggestions", input: {} };
  if (/\b(lease|leases|agreement|agreements|contract|contracts)\b.*\b(expir\w*|end|ending|renew\w*)\b|\b(expir\w*|ending)\b.*\b(lease|leases|agreement)s?\b|लीज़|एग्रीमेंट/.test(t)) {
    const days = daysFrom(text);
    return { tool: "lease_expiries", input: days ? { days } : {} };
  }
  if (/\b(not paid|unpaid|haven't paid|hasn't paid|didn't pay)\b.*\bthis month\b|\bthis month\b.*\b(not paid|unpaid)\b|इस महीने.*(नहीं|बाकी)/.test(t)) return { tool: "unpaid_this_month", input: {} };
  if (/\b(overdue|late|not paid|unpaid|haven't paid|hasn't paid|defaulters?|behind)\b|बकाया|नहीं दिया|देर/.test(t)) return { tool: "overdue_tenants", input: {} };
  if (/\b(summary|summarise|summarize|overview|recap)\b|सारांश/.test(t)) return { tool: "monthly_summary", input: month ? { month } : {} };
  if (/\b(collect\w*|billed|income|revenue|earned|received)\b|वसूली|आमदनी/.test(t)) return { tool: "collection_summary", input: month ? { month } : {} };
  if (/\b(outstanding|by property|dues|receivable)\b/.test(t)) return { tool: "outstanding_by_property", input: {} };
  if (/\b(expense|expenses|spent|spend|costs?)\b|खर्च/.test(t)) return { tool: "expense_summary", input: month ? { month } : {} };
  if (/\b(maintenance|repairs?|complaints?|requests?|tickets?)\b|शिकायत/.test(t)) return { tool: "maintenance_summary", input: {} };

  return { help: true, reason: "" };
}

const HELP = [
  "Which tenants haven't paid this month?",
  "Who is overdue?",
  "Rent collection for last month",
  "Leases expiring in 60 days",
  "Outstanding by property",
  "Expenses this month",
  "Open maintenance requests",
  "Balance for <tenant name>",
  "Statement for <tenant name>",
  "Cash flow forecast",
  "Anything unusual?",
  "Draft reminders for overdue tenants",
  "Add expense ₹2,500 for plumbing repair at <property>",
  "Create maintenance task at <property> room 101: fix the tap",
];

module.exports = { route, HELP, monthFrom, daysFrom, amountFrom, tenantIn };
// findTenants is re-exported for tests that exercise name matching.
module.exports.findTenants = findTenants;
