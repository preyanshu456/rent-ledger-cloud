# Changelog

## Each owner gets paid into their own bank account (October 2026)
- **Settings → Online payments:** every owner connects their own Razorpay account (Key ID and Key Secret, checked with Razorpay before saving). Tenant payments go into that owner's Razorpay account and settle to the owner's own bank account. Rent Ledger never holds the money.
- There is no shared account any more: an owner's tenants see the Pay button only after that owner connects.
- Saved secrets are encrypted (AES-256-GCM, key from `SECRETS_KEY` or `DATA_DIR/secrets.key`), never sent to a browser and never exported. Only the owner can change them; changes are in the audit log.
- Each owner has their own webhook URL and secret.
- If Razorpay rejects an owner's keys, the owner is notified to reconnect.
- Orders remember which key created them; payments started with the old server-wide keys still finish normally.
- Failed checkouts are reported to the server (from the earlier Razorpay change).

## Faster on phones, ready for Android and iPhone apps (October 2026)
- **Taps answer at once.** The tab you tap lights up immediately and the More panel closes straight away. Pages you have already opened appear instantly and refresh in the background; a new page shows a placeholder while it loads. Each page now waits for one round trip to the server instead of three. (Measured with a slow connection: from about 1.1–1.5 s to 0.07 s for pages seen before and 0.5 s for new ones.)
- **Smoother scrolling on phones.** The live blur behind every card and panel is replaced on phones with solid frosted colours. Numbers no longer count up from zero.
- **The app opens from the phone's cache** and updates itself in the background.
- **Back button:** Android's Back goes to the previous screen (closing the More panel or a pop-up first) instead of leaving the app.
- **No more zooming or jumping while typing:** text fields are 16px on phones, and the sign-in screen is short enough to fit without scrolling.
- **Safer building page:** floor rent and *Delete floor* are under *Change floor rent or remove a floor*, below the rooms, with a small delete link instead of a big button.
- **Amounts** always show whole rupees or two decimals (₹30,442.10, not ₹30,442.1).
- **Shorter cards on phones:** empty values are left out; payments show "Verified" only when a payment really was verified.
- **Reminders:** templates read like the real message, with example details highlighted; channel chips say whether a channel is on or off; tabs (Outbox, Prepare, Templates, Settings) fit the screen. Switching tabs no longer reloads everything.
- **Insights:** the collection trend compares recent months with earlier ones, so one late payer doesn't make it say "falling".
- **Profile** keeps just your account, password and backup; colours and language stay in Settings.
- **Finance on phones:** "Month by month" stays a short table (month, billed, collected).
- **"Rent Ledger" stays readable at the top:** the name is solid white over the moving clouds, and the sign-in header on phones is no longer see-through. On iPhones the top bar used to sit behind the clock and battery (it only showed when you pulled the page down); it now starts below them, on a light strip, for owners and tenants.
- **Home no longer has the "Gas bills to enter" section.** Gas bills are still entered on each room's Gas tab.
- **Home shows "Received this month":** the money that actually came in this month, whichever month's bill it paid. (It used to count only payments against this month's bills, so a payment for last month's rent showed ₹0.) The split under *Show details* is labelled "This month's bills".
- **Tenant home on phones:** the "Total pending" card and the balance row were faded and showed the sunset through them; they are solid now.
- **The field you are typing in** is outlined in the theme colour instead of orange, so it no longer looks like an error.
- **Hindi:** about 220 more labels and help texts are translated (Settings, Reports, Insights, Leases, Expenses, Bank matching, the building and room pages, sign-up and password reset), including text with numbers and dates such as "Floor 2" and "Rent Oct 2026".
- **Bills in Hindi and with ₹:** names, addresses and notes written in Hindi now print correctly on bill PDFs (they used to print as "???"), and amounts show "₹" instead of "Rs.". The PDF carries only the letters it uses from Noto Sans Devanagari (in `rent-ledger-source/fonts`, free licence), so a bill stays small.
- **Android / iPhone apps:** Capacitor setup for both (`capacitor.config.json`, `npm run android:open` / `ios:open`). The apps connect to the live server by default (no server address to type), the server accepts them, and bills, receipts and statements open the phone's share sheet. See `MOBILE_APPS.md`. Capacitor is on 8.5.3, which fixes a security advisory in the app shell (GHSA-rvm3-566m-v7fv).

## Bills as PDF (October 2026)
- **Finance → Make bills:** pick a property, a floor or a room, and what to include (rent, electricity, gas, other charges). The list shows what each room still owes; tick the bills you want and download one PDF, or a single room's bill with its own **PDF** button. On phones that support it, **Share** sends the PDF straight to WhatsApp or email.
- Each bill is one A4 page (more if the list is long): who it is from, the tenant and room, every unpaid charge with its period and due date, electricity meter readings and units, what is already paid, any advance the tenant has paid, and the amount to pay. Overdue bills say so.
- **How to pay** (UPI ID, bank account, cash timings) is set once, on the Make bills page or in Settings, and printed on every bill.
- Tenants who moved out are left out unless you tick them in. Bills only read the ledger; making one changes nothing, and each PDF made is noted in the audit log.
- Hindi labels for the new screens. Tab underlines now fit Hindi labels.

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
