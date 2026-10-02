// Message delivery providers. Each is used only when its variables are set;
// nothing here pretends to send when a provider isn't configured.
//   Email     Resend          RESEND_API_KEY, OTP_FROM_EMAIL (or NOTIFY_FROM_EMAIL)
//   SMS       Twilio          TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   WhatsApp  Twilio WhatsApp TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886)
// WhatsApp business-initiated messages need templates approved by Meta; see README.

function isEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }

function normalizePhone(value) {
  const raw = String(value || "").replace(/[\s()\-.]/g, "");
  if (raw.startsWith("+")) return raw;
  if (/^[6-9]\d{9}$/.test(raw)) return `+${process.env.DEFAULT_PHONE_COUNTRY_CODE || "91"}${raw}`;
  return raw;
}

function configured(channel, env = process.env) {
  if (channel === "inapp") return true;
  if (channel === "email") return Boolean(env.RESEND_API_KEY && (env.NOTIFY_FROM_EMAIL || env.OTP_FROM_EMAIL));
  if (channel === "sms") return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
  if (channel === "whatsapp") return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_WHATSAPP_FROM);
  return false;
}

class DeliveryError extends Error {
  constructor(message, { retryable = true } = {}) { super(message); this.retryable = retryable; }
}

async function sendEmail({ to, subject, text }, fetchImpl = fetch) {
  if (!configured("email")) throw new DeliveryError("Email isn't set up (add RESEND_API_KEY and NOTIFY_FROM_EMAIL in Railway).", { retryable: false });
  if (!isEmail(to)) throw new DeliveryError("No valid email address for this person.", { retryable: false });
  const response = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM_EMAIL || process.env.OTP_FROM_EMAIL, to: [to], subject, text }),
  });
  if (!response.ok) throw new DeliveryError(`Email provider returned ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
  const data = await response.json().catch(() => ({}));
  return { providerMessageId: data.id || "" };
}

async function twilioMessage({ to, from, body }, fetchImpl) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const authHeader = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
  const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${authHeader}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: to, From: from, Body: body }),
  });
  if (!response.ok) throw new DeliveryError(`Messaging provider returned ${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
  const data = await response.json().catch(() => ({}));
  return { providerMessageId: data.sid || "" };
}

async function sendSms({ to, text }, fetchImpl = fetch) {
  if (!configured("sms")) throw new DeliveryError("SMS isn't set up (add the Twilio variables in Railway).", { retryable: false });
  const phone = normalizePhone(to);
  if (!/^\+\d{8,15}$/.test(phone)) throw new DeliveryError("No valid mobile number for this person.", { retryable: false });
  return twilioMessage({ to: phone, from: process.env.TWILIO_FROM_NUMBER, body: text }, fetchImpl);
}

async function sendWhatsapp({ to, text }, fetchImpl = fetch) {
  if (!configured("whatsapp")) throw new DeliveryError("WhatsApp isn't set up (add TWILIO_WHATSAPP_FROM and the Twilio variables in Railway).", { retryable: false });
  const phone = normalizePhone(to);
  if (!/^\+\d{8,15}$/.test(phone)) throw new DeliveryError("No valid mobile number for this person.", { retryable: false });
  return twilioMessage({ to: `whatsapp:${phone}`, from: process.env.TWILIO_WHATSAPP_FROM, body: text }, fetchImpl);
}

// Password-reset codes: route strictly by what the login contact is.
async function sendPasswordResetOtp(user, otp, fetchImpl = fetch) {
  const email = isEmail(user.email) ? user.email : (isEmail(user.contact) ? user.contact : "");
  const text = `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`;
  if (email) {
    if (!configured("email")) throw new Error("Email delivery is not configured. Add RESEND_API_KEY and OTP_FROM_EMAIL in Railway.");
    await sendEmail({ to: email, subject: "Your Rent Ledger password reset code", text }, fetchImpl);
    return "email";
  }
  if (/^\+\d{8,15}$/.test(normalizePhone(user.contact))) {
    if (!configured("sms")) throw new Error("SMS delivery is not configured. Add Twilio variables in Railway.");
    await sendSms({ to: user.contact, text }, fetchImpl);
    return "sms";
  }
  throw new Error("Password reset delivery is not configured for this account.");
}

module.exports = { configured, sendEmail, sendSms, sendWhatsapp, sendPasswordResetOtp, DeliveryError, isEmail, normalizePhone };
