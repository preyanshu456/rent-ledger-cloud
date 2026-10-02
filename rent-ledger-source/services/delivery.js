// Sends queued outbox messages with retries (at most 3 attempts, backing off).
//
// NOTIFY_MODE=simulate (the default outside production) never calls an
// external provider: email/SMS/WhatsApp messages are marked "simulated" so
// it's clear nothing was sent. In-app notifications are always delivered.
// In production, a channel whose provider isn't configured fails with a clear
// reason instead of pretending.
const providers = require("./providers");
const { notify } = require("./notify");

const MAX_ATTEMPTS = 3;

function mode() {
  const m = String(process.env.NOTIFY_MODE || "").toLowerCase();
  if (m === "live" || m === "simulate") return m;
  return process.env.NODE_ENV === "production" ? "live" : "simulate";
}

function channelStatus() {
  return {
    mode: mode(),
    channels: {
      inapp: { configured: true },
      email: { configured: providers.configured("email") },
      sms: { configured: providers.configured("sms") },
      whatsapp: { configured: providers.configured("whatsapp") },
    },
  };
}

async function deliverOne(db, msg, { fetchImpl = fetch } = {}) {
  if (msg.channel === "inapp") {
    if (!msg.user_id || !db.get("SELECT 1 FROM users WHERE id = ?", msg.user_id)) throw new providers.DeliveryError("This tenant doesn't have a login, so in-app messages can't reach them.", { retryable: false });
    notify(db, { orgId: msg.org_id, userId: msg.user_id, kind: msg.template_key || "message", title: msg.subject || "Message from your owner", body: msg.body, link: "tenant:notifications" });
    return { status: "sent" };
  }
  if (mode() === "simulate") return { status: "simulated" };
  if (msg.channel === "email") return { status: "sent", ...(await providers.sendEmail({ to: msg.recipient, subject: msg.subject, text: msg.body }, fetchImpl)) };
  if (msg.channel === "sms") return { status: "sent", ...(await providers.sendSms({ to: msg.recipient, text: msg.body }, fetchImpl)) };
  if (msg.channel === "whatsapp") return { status: "sent", ...(await providers.sendWhatsapp({ to: msg.recipient, text: msg.body }, fetchImpl)) };
  throw new providers.DeliveryError("Unknown channel", { retryable: false });
}

let running = false;
async function processOutbox(db, { now = Date.now(), limit = 50, fetchImpl } = {}) {
  if (running) return { skipped: true };
  running = true;
  const result = { sent: 0, simulated: 0, failed: 0, retrying: 0 };
  try {
    const due = db.all("SELECT * FROM outbox WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at LIMIT ?", new Date(now).toISOString(), limit);
    for (const msg of due) {
      // Claim the message so a second worker can't send it twice.
      const claimed = db.run("UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'", msg.id).changes;
      if (!claimed) continue;
      try {
        const out = await deliverOne(db, { ...msg, attempts: msg.attempts + 1 }, { fetchImpl });
        db.run("UPDATE outbox SET status = ?, sent_at = ?, provider_message_id = ?, last_error = NULL WHERE id = ?", out.status, new Date().toISOString(), out.providerMessageId || null, msg.id);
        result[out.status === "simulated" ? "simulated" : "sent"]++;
      } catch (err) {
        const attempts = msg.attempts + 1;
        const retry = err.retryable !== false && attempts < MAX_ATTEMPTS;
        db.run("UPDATE outbox SET status = ?, last_error = ?, next_attempt_at = ? WHERE id = ?",
          retry ? "queued" : "failed", String(err.message || err).slice(0, 300), retry ? new Date(now + 5 * 60_000 * 2 ** (attempts - 1)).toISOString() : null, msg.id);
        result[retry ? "retrying" : "failed"]++;
      }
    }
  } finally {
    running = false;
  }
  return result;
}

module.exports = { processOutbox, deliverOne, channelStatus, mode, MAX_ATTEMPTS };
