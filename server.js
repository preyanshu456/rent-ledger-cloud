async function sendPasswordResetOtp(user, otp) {
  // Route strictly by what the account's contact actually is, rather than by
  // which provider happens to have variables set. Previously an email-contact
  // account could fall through to the Twilio branch and try to "text" the
  // email address, which always failed.
  const email = isEmail(user.email) ? user.email : (isEmail(user.contact) ? user.contact : '');
  if (email) {
    if (!process.env.RESEND_API_KEY || !process.env.OTP_FROM_EMAIL) {
      throw new Error('Email delivery is not configured. Add RESEND_API_KEY and OTP_FROM_EMAIL in Railway.');
    }
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.OTP_FROM_EMAIL,
        to: [email],
        subject: 'Your Rent Ledger password reset code',
        text: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code with anyone.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset email');
    return 'email';
  }
  const phone = normalizeSmsNumber(user.contact);
  if (/^\+\d{8,15}$/.test(phone)) {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_FROM_NUMBER) {
      throw new Error('SMS delivery is not configured. Add Twilio variables in Railway.');
    }
    const authHeader = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${authHeader}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        To: phone,
        From: process.env.TWILIO_FROM_NUMBER,
        Body: `Your Rent Ledger verification code is ${otp}. It expires in 10 minutes. Do not share this code.`,
      }),
    });
    if (!response.ok) throw new Error('Unable to send the reset SMS');
    return 'sms';
  }
  throw new Error('Password reset delivery is not configured for this account.');
}
