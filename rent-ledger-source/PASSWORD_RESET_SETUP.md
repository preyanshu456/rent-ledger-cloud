# Password reset delivery

The app stores only a hash of every 6-digit reset code. A code expires in 10 minutes, accepts at most five attempts, and is invalidated once the password changes.

Configure one delivery provider in Railway **Variables**. Never put these values in GitHub or the front-end code.

## Email with Resend

Set both variables:

- `RESEND_API_KEY` — your Resend API key
- `OTP_FROM_EMAIL` — a verified sender, for example `Rent Ledger <security@yourdomain.com>`

Users whose login contact is an email will receive their code by email.

## SMS with Twilio

Set all three variables:

- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_FROM_NUMBER` — a Twilio number in international format, for example `+14155550123`

Users whose login contact is a mobile number will receive their code by SMS. Indian 10-digit mobile numbers are automatically sent to Twilio as `+91` numbers. For another country, add `DEFAULT_PHONE_COUNTRY_CODE` in Railway (without the `+` sign).

After adding variables, Railway restarts the service automatically. Open the login page and select **Forgot password?** to test the flow.
