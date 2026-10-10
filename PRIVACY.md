# Privacy and data handling

This describes what Rent Ledger stores, who can see it, and what is sent to outside services. It is a technical description for the people running the app, not legal advice. If you rely on it for compliance (for example India's Digital Personal Data Protection Act, 2023), have it reviewed.

## What is stored

| Data | Where | Notes |
|---|---|---|
| Accounts: name, mobile or email, password hash, language | SQLite (`users`) | Passwords use scrypt with a per-user salt. Sign-in tokens are stored only as SHA-256 hashes. |
| Tenants: name, mobile, alternate mobile, email, ID-proof type and number, move-in/out dates, deposit, reminder consent | SQLite (`tenants`) | Visible to the owner and managers of the same organisation only. |
| Leases, bills, payments, adjustments, deposits, settlements | SQLite | Append-only: payments, allocations, adjustments, reversals and deposit transactions can't be edited or deleted (database triggers). |
| Documents: payment proofs, lease files, maintenance photos, move-in/out photos, expense receipts | `DATA_DIR/documents` (older proofs in `DATA_DIR/receipts`) | File type is checked by its content, with a 10 MB limit. Every download checks permission. Tenants can only open their own files, and only those the owner shared. |
| Bank statement lines you import | SQLite (`bank_transactions`) | Only money coming in is imported. |
| Messages, notifications, reminder outbox, assistant chats | SQLite | Assistant chats are visible only to the person who wrote them, and they can clear them. |
| Audit log | SQLite (`audit_log`) | Who did what and when, for money, tenancy, team and settings changes. Append-only. |
| Backups | `DATA_DIR/backups` | Full database copies. Treat them like the live data. |

Structured logs never contain passwords, tokens, OTPs or API keys (they are redacted). Request logs hold user ids, not names or contact details.

## Who can see what

- **Organisations are isolated.** Every record carries an organisation id, and every query is limited to the signed-in user's organisation.
- **Owners** see everything in their organisation.
- **Managers** run day-to-day work. They can't reverse payments, void or waive bills, settle deposits, manage the team, export data or read the audit log.
- **Tenants** see only their own tenancy: bills, payments, receipts, statement, their maintenance requests (without internal notes or vendor details), documents shared with them, and messages. This is enforced on the server.

## Outside services: what is sent, and when

Nothing is sent to these services unless the matching settings are configured on the server.

| Service | When it is used | What it receives |
|---|---|---|
| **Resend** (email) | Password-reset codes; reminders by email, only to tenants who agreed to email reminders and only in `NOTIFY_MODE=live` | Recipient email, subject, message text (tenant name, amount, due date, property). |
| **Twilio** (SMS / WhatsApp) | Password-reset codes; reminders by SMS/WhatsApp, only to tenants who agreed to that channel and only in `NOTIFY_MODE=live` | Recipient mobile number and the message text. |
| **AI provider** (Anthropic or an OpenAI-compatible API) | Only when `AI_PROVIDER`, `AI_API_KEY` and `AI_MODEL` are set **and** the owner switches AI on in Settings | The question typed, the last few chat messages, and the results of the assistant's tools: tenant names, property and room labels, dates, amounts, and maintenance/expense titles. **Never sent:** phone numbers, emails, ID-proof numbers, passwords, documents or bank account details. In basic mode nothing is sent anywhere. |
| **Google Fonts** | Loading the web app | Normal font requests from the browser (IP address, user agent). |

**UPI payments** use no outside service: the server builds a `upi://pay` link (owner's UPI ID and name, amount, a reference and a short note such as "Rent Oct 2026 Room 1A") and the tenant's own UPI app handles the payment. Rent Ledger never sees UPI PINs, bank details or the money. (Earlier versions used Razorpay; those payment records are kept, and the saved Razorpay keys were deleted.)

The AI only reads data through the same rule-based tools the reports use. It can't change records: anything it prepares (reminders, a maintenance task, an expense) waits as a proposal until a person approves it, and the approval is written to the audit log.

## Consent and reminders

- In-app notifications need a tenant login.
- Email, SMS and WhatsApp reminders go only to tenants whose record says they agreed. The owner can record it on the tenant's **Tenancy** page (when the tenant agreed outside the app), and the tenant can change it any time under **My profile → Language & reminders**.
- Reminders wait for the owner's approval by default. Automatic sending has to be switched on explicitly.

## Keeping and removing data

- **Move-out** ends the tenancy, removes the tenant's login and clears their contact and ID details. Money history is kept, because the ledger must stay complete.
- **Remove record** (owner only, after move-out) anonymises the tenant's name and remaining details.
- **Retention:** the owner can set **Settings → Anonymise former tenants after N days**. A daily job then anonymises former tenants automatically (0 = never).
- **Export:** the owner can download all organisation records as JSON (without password hashes or sessions). The file contains personal data, so keep it private.
- Payment, deposit and audit records are not deleted, because accounting history must stay intact. Personal identifiers on them are removed by anonymisation.

## Security measures in brief

HttpOnly session cookie or bearer token, server-side sessions with 30-day expiry, rate limits on sign-in/sign-up/reset/assistant, an origin check on cookie-authenticated writes, input validation and allow-listed fields, strict body-size limits, security headers and a CSP, upload type checks, transactional writes, idempotency keys on payments, verified Razorpay signatures and webhooks, and automatic backups.
