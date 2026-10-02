// Default message templates (English and Hindi). Owners can edit their own
// copies; placeholders in {{double braces}} are filled from the ledger.
const DEFAULTS = {
  rent_upcoming: {
    en: { subject: "Upcoming payment: {{bill}}", body: "Hello {{tenantName}}, a reminder that {{bill}} of ₹{{amount}} for {{property}} {{unit}} is due on {{dueDate}}. Thank you. – {{ownerName}}" },
    hi: { subject: "आगामी भुगतान: {{bill}}", body: "नमस्ते {{tenantName}}, याद दिला दें कि {{property}} {{unit}} का {{bill}} ₹{{amount}} {{dueDate}} तक देय है। धन्यवाद। – {{ownerName}}" },
  },
  rent_due_today: {
    en: { subject: "Payment due today: {{bill}}", body: "Hello {{tenantName}}, {{bill}} of ₹{{amount}} is due today ({{dueDate}}). If you have already paid, please ignore this message. – {{ownerName}}" },
    hi: { subject: "आज देय भुगतान: {{bill}}", body: "नमस्ते {{tenantName}}, {{bill}} ₹{{amount}} का भुगतान आज ({{dueDate}}) देय है। अगर आप भुगतान कर चुके हैं तो कृपया इस संदेश को अनदेखा करें। – {{ownerName}}" },
  },
  rent_overdue: {
    en: { subject: "Overdue: ₹{{amount}}", body: "Hello {{tenantName}}, ₹{{amount}} is overdue for {{property}} {{unit}} ({{bills}}; oldest due {{dueDate}}, {{daysOverdue}} days ago). Please pay at the earliest. If you have already paid, please let us know. – {{ownerName}}" },
    hi: { subject: "बकाया: ₹{{amount}}", body: "नमस्ते {{tenantName}}, {{property}} {{unit}} का ₹{{amount}} बकाया है ({{bills}}; सबसे पुराना देय {{dueDate}}, {{daysOverdue}} दिन पहले)। कृपया जल्द भुगतान करें। अगर आप भुगतान कर चुके हैं तो कृपया हमें बताएं। – {{ownerName}}" },
  },
  lease_expiry: {
    en: { subject: "Your rental agreement ends on {{endDate}}", body: "Hello {{tenantName}}, your rental agreement for {{property}} {{unit}} ends on {{endDate}} ({{daysLeft}} days). Please get in touch about renewal. – {{ownerName}}" },
    hi: { subject: "आपका किराया समझौता {{endDate}} को समाप्त हो रहा है", body: "नमस्ते {{tenantName}}, {{property}} {{unit}} का आपका किराया समझौता {{endDate}} को ({{daysLeft}} दिन में) समाप्त हो रहा है। नवीनीकरण के बारे में कृपया हमसे बात करें। – {{ownerName}}" },
  },
  payment_received: {
    en: { subject: "Payment received: ₹{{amount}}", body: "Hello {{tenantName}}, we received your payment of ₹{{amount}} on {{date}}. Thank you! – {{ownerName}}" },
    hi: { subject: "भुगतान प्राप्त: ₹{{amount}}", body: "नमस्ते {{tenantName}}, ₹{{amount}} का आपका भुगतान {{date}} को प्राप्त हुआ। धन्यवाद! – {{ownerName}}" },
  },
  maintenance_update: {
    en: { subject: "Maintenance update: {{title}}", body: "Hello {{tenantName}}, your maintenance request \"{{title}}\" is now: {{status}}. {{comment}} – {{ownerName}}" },
    hi: { subject: "रखरखाव अपडेट: {{title}}", body: "नमस्ते {{tenantName}}, आपके रखरखाव अनुरोध \"{{title}}\" की स्थिति अब: {{status}}। {{comment}} – {{ownerName}}" },
  },
};
const KEYS = Object.keys(DEFAULTS);

function getTemplate(db, orgId, key, language = "en") {
  const lang = language === "hi" ? "hi" : "en";
  const custom = db.get("SELECT subject, body FROM message_templates WHERE org_id = ? AND key = ? AND language = ?", orgId, key, lang);
  return custom || DEFAULTS[key]?.[lang] || DEFAULTS[key]?.en;
}

function render(text, vars) {
  return String(text || "").replace(/\{\{\s*(\w+)\s*\}\}/g, (_, name) => (vars[name] === undefined || vars[name] === null ? "" : String(vars[name]))).replace(/\s{2,}/g, " ").trim();
}

function listTemplates(db, orgId) {
  return KEYS.flatMap((key) => ["en", "hi"].map((language) => {
    const custom = db.get("SELECT subject, body, updated_at FROM message_templates WHERE org_id = ? AND key = ? AND language = ?", orgId, key, language);
    const t = custom || DEFAULTS[key][language];
    return { key, language, subject: t.subject, body: t.body, customised: Boolean(custom), updatedAt: custom?.updated_at || null };
  }));
}

module.exports = { DEFAULTS, KEYS, getTemplate, render, listTemplates };
