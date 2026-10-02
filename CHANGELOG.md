# Changelog

## Simpler layout (October 2026)
- Sidebar: five main buttons (Dashboard, Bills & payments, Reminders, Repairs, Settings), with the rest under **More**. Notifications are a bell next to the name. Profile and Sign out share one row. Theme and language moved to **Settings**.
- Dashboard: four headline numbers (rooms occupied, collected this month, still to collect, overdue). The rent / electricity / gas split is under **Show details**.
- Row buttons in tables are grouped into one **⋯** menu, and page headers with many buttons show **More**. Filters sit in one compact row. Page descriptions and notices are shorter.
- Plainer names: Ledger → Bills & payments, Maintenance → Repairs, Reconciliation → Bank matching. Nothing was removed; every screen and action is still there.

## Stages 3–16 — full feature release (October 2026)

### Data and accounting
- **SQLite database** (Node's built-in `node:sqlite`) on the same `/data` volume, with numbered migrations and automatic backups (start-up, pre-migration, daily). Money is stored as whole paise.
- **Verified one-time import** of `db.json`: done in one transaction and checked bill by bill. It rolls back and refuses to start on any mismatch, and never modifies `db.json`.
- **Append-only ledger:** charges (rent, electricity, gas, maintenance, late fee, damage, other), payments, allocations, adjustments (correction, discount, late fee, waiver, write-off), voids and reversals. Database triggers block edits and deletes of money rows.
- Bill statuses: due, overdue, partial, paid, waived, void. Partial payments and tenant credit are supported, as are verified vs recorded payments and idempotent payment recording.
- Existing screens keep working: editing "amount paid" now records a payment or a reverse-and-replace instead of overwriting history.

### Organisations, people and tenancy
- Multiple landlords, each in a separate organisation. Property managers join by invite and have limited permissions. A tenant firewall restricts tenant accounts to their own portal routes.
- Leases (draft → active → ended/terminated) with rent schedules (monthly, quarterly, half-yearly, yearly), renewals and expiry tracking. Field suggestions can be read from a lease PDF or pasted text.
- Move-in/move-out records with checklists, meter readings and photos. Security deposits are held separately from income. Deposit settlement with line-by-line deductions turns into ledger entries only when the owner agrees.
- Retention setting that anonymises former tenants after N days.

### Money in
- **Bank reconciliation:** CSV import with duplicate detection, scored tenant suggestions with evidence, and confirm/ignore/reopen. Confirmed matches become verified payments.
- Owner review of tenant payment proofs (accept records a payment linked to the proof).
- Printable receipts and tenant statements (HTML/PDF via print, plus CSV).

### Insight and reporting
- Finance dashboard with selectable months: billed, collected, collection rate, received, expenses, net cash flow, outstanding, overdue, by property, tenant balances and lease expiries.
- Eight reports, each as an on-screen table, printable page or CSV.
- Cash-flow forecast labelled as an estimate (with assumptions), and review alerts (possible duplicates, unusual adjustments or rent changes, unmatched or unapplied money, repeated failed payments).

### Communication
- Reminders (upcoming, due today, overdue, lease ending) with English and Hindi templates you can edit. Drafted for approval by default. Channels are in-app, email (Resend), SMS and WhatsApp (Twilio), respecting each tenant's consent. Duplicates are prevented and failures retried (3 attempts with backoff). `NOTIFY_MODE=simulate` sends nothing outside the app.
- In-app notifications for owners, managers and tenants, plus owner–tenant messages.

### Operations
- Maintenance requests from tenants or staff: status workflow, timeline, internal notes, photos, vendor assignment, tenant confirmation, and linked costs.
- Expenses by property and category with receipts. Amounts are immutable; voiding is owner-only.

### Rent Ledger AI
- Answers questions using the same rule-based tools as the reports (overdue tenants, collection, leases, outstanding, expenses, maintenance, balances, cash flow, alerts, reconciliation).
- Prepares reminders, maintenance tasks and expenses as **proposals** that a person edits and approves. It has no tool that can change payments or balances.
- Basic (rule-based) mode works with no AI key. AI mode supports Anthropic or any OpenAI-compatible API (`AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL`) and is off until the owner switches it on. Only names, labels, dates and amounts reach the provider. It falls back to basic mode if the provider fails, and is rate limited per user.

### Interface
- New screens: Finance, Insights, Ledger, Reconciliation, Reports, Leases, Reminders, Maintenance, Expenses, Assistant, Notifications, Settings & team (organisation, team, audit log, backups) and Tenancy.
- Tenant portal: balance, upcoming dues, lease, other charges, receipts, statement, maintenance, documents, messages, notifications, language and reminder consent.
- English / हिन्दी switch (saved per account).

### Docs
- New `DEPLOYMENT.md` (deploy checklist, backups, rollback) and `PRIVACY.md` (data stored and what each provider receives). Updated `README.md` and `.env.example`.

## Stage 2 — security and reliability baseline (October 2026)

### Sign-in and accounts
- Sessions are stored on the server (only a hash of each token), survive restarts and deploys, expire after 30 days (`SESSION_TTL_DAYS`) and are ended by **Sign out** (`POST /api/auth/logout`). Changing or resetting a password ends every session of that account.
- Tenants can no longer claim a login with only a mobile number. The owner creates a one-time invite code (`POST /api/tenants/:id/invite`, valid 7 days, 5 attempts) and the tenant needs it to sign up. Existing tenant logins are unaffected.
- New passwords need 8+ characters (existing ones keep working). Very long passwords (>200) are refused.
- Login is rate limited: 10 wrong passwords for one account pauses it for 15 minutes; 100 attempts per IP per 15 minutes. Sign-up and password reset are limited per IP. On Railway the visitor IP comes from `X-Real-IP`.
- Optional `OWNER_SETUP_CODE` protects first-owner sign-up on a fresh deployment.
- Phone numbers match with or without +91, spaces or dashes.

### Data safety
- `db.json` is written atomically (temporary file, flush, rename), so a crash mid-write can't corrupt it.
- Automatic backups in `DATA_DIR/backups` at start-up and daily while data changes (newest 30 kept).
- Owner data export: **Your profile → Data backup** (`GET /api/admin/export`).
- A corrupt `db.json` is reported clearly and never overwritten.

### API hardening
- Security headers on every response (nosniff, frame denial, referrer policy, permissions policy, HSTS over HTTPS); `X-Powered-By` removed; API responses are `no-store`.
- Content-Security-Policy in report-only mode (`CSP_ENFORCE=true` to enforce). The inline service-worker script moved to `public/sw-register.js`.
- Request bodies are limited to 100 KB, except receipt uploads (15 MB), which now require sign-in *before* the body is read.
- Every create/update route validates its input and copies only allowed fields. Ids, statuses, receipts and payment records can't be overwritten through the API any more.
- Errors return safe JSON with a request id; details go to structured JSON logs with secrets redacted. Async route errors can no longer crash the server.
- New `GET /health` for Railway (checks the data file is readable and the folder writable). Graceful shutdown on SIGTERM.
- Start-up warns about half-configured providers (Razorpay, Resend, Twilio) and a missing `DATA_DIR` in production, without printing secrets.

### Bug fixes
- The tenant profile showed a ₹0 security deposit; it now shows the room's deposit (saved on the tenant from now on).
- A room could get two active tenants through the API; now refused. Two active tenants can't share a mobile number, and owner-only floors can't have tenants.
- Bills can only be linked to a tenant of that room.
- "This month" on the dashboard, "paid on" dates and move-out dates used UTC, which was the previous day before 05:30 IST. They now use `APP_TIMEZONE` (default Asia/Kolkata) on the server and the device's local date in the browser.
- The tenant portal returned a server error if the tenant's room was missing; it now returns a clear message.
- An expired session now returns the user to the sign-in screen with a message.

### Project
- Automated tests (`npm test`, 46 tests) and a GitHub Actions workflow.
- Mobile-app (Capacitor) packages moved to `devDependencies`, so they're no longer installed in the server image. Lockfile updated (Express 4.22.3, qs 6.16.0, 0 production advisories).
- Docker build uses `npm ci`; Railway health check points at `/health`.
- `README.md`, this changelog and a full `.env.example`.
