# Changelog

## UPI: QR code and UPI ID when the app refuses the Pay button (October 2026)
- Investigated QR versus Pay button at code level: both are built from the **same** server link (`routes/payments.js` `linkFor`). For a ₹1 bill the QR payload, the Paytm/Google Pay/PhonePe/BHIM buttons and the saved QR image are byte-for-byte identical: `upi://pay?pa=…&pn=…&am=1.00&cu=INR&tn=…`. No merchant code, `tr` or other metadata. The only difference is how the payment is started (scan inside the app versus opened from the browser), which the payer's app and bank judge.
- **"My UPI app showed an error" no longer cancels the request.** It records the decline once (`POST /api/tenant/payments/upi/:id/declined`, logged as a warning) and keeps the request pending, so the tenant can pay the same amount by QR code or UPI ID and then tap "I've paid". Nothing is retried and nothing is marked paid.
- The decline screen shows the QR code with **Save QR image** (to scan from the gallery in the UPI app), Copy UPI ID and Copy amount. The phone sheet explains when to use it, and owner settings explain that some apps refuse the Pay button for personal UPI IDs.

## UPI: person-to-person link format and diagnostics (October 2026)
- **The UPI link no longer sends `tr` (transaction reference).** NPCI's linking spec makes `tr` mandatory for *merchant* transactions; on a payment to a personal UPI ID it made the request look like an unsigned merchant request. The link now carries only `pa`, `pn`, `am`, `cu` and `tn`. No `mc`, `tid`, `url`, `mode` or signature fields are sent (a landlord is not a merchant). The Rent Ledger reference (`RL…`) stays at the end of the note, so it still shows in both UPI histories.
- UPI IDs are saved and sent in lower case. The name and note are plain ASCII, and the note is at most 50 characters, always ending with the reference.
- **Diagnostic logs:** each UPI request logs its reference, the parameter names, amount, currency, a masked UPI ID (`pr***@okaxis`) and whether any merchant fields were present. Cancellations log one of a fixed set of reasons. No full UPI ID, tenant details, PINs or bank details are logged.
- **"My UPI app showed an error":** after returning from the UPI app the tenant can report a decline. It is recorded once on the request (as "UPI app showed an error"), never retried automatically, and the tenant is told how to pay another way.

## UPI: choose the app (October 2026)
- On Android the Pay sheet now shows **Google Pay, PhonePe, Paytm, BHIM** and **Other UPI app**. Each app button opens exactly that app with the same server-built payment details, so a phone that remembers one app (for example WhatsApp) for all UPI links no longer sends every tenant there. On iPhone the Google Pay, PhonePe and Paytm buttons use those apps' own links.
- The sheet no longer opens a UPI app by itself; the tenant taps the app they want.

## UPI payments replace Razorpay (October 2026)
- **Razorpay is removed:** checkout, order/verify endpoints, webhooks, the per-owner key screen, the encrypted key store (`SECRETS_KEY`) and the Razorpay entries in the security policy. Saved Razorpay keys are deleted from the database. Old Razorpay payments and orders stay in the history unchanged.
- **Pay by UPI:** the tenant's *Pay all* (or a single bill's *Pay*) asks the server for a `upi://pay` link. The server works out the amount from the ledger and the recipient from the tenant's owner (tenant → room → building → organisation); amounts or UPI IDs sent by the browser are ignored. The link has the owner's UPI ID and name, the exact amount, INR, a unique reference (`RL…`) and a short note.
- On a phone the link opens the UPI app chooser (Google Pay, PhonePe, Paytm, BHIM, bank apps); no app is hard-coded. If nothing opens, the QR code and UPI ID are shown. On a computer a QR code is shown, with buttons to copy the UPI ID and amount.
- **Settings → UPI payments:** owners save their UPI ID and the name shown in UPI apps. Owners who already wrote a UPI ID in "How to pay" are picked up automatically.
- **No automatic verification in this phase.** A started payment is stored as *pending* and never marks a bill paid. The tenant can say "I've paid" (the owner is notified, it stays pending) or "I didn't pay". The same request is reused instead of duplicated, and older unfinished requests are replaced. Owners see pending UPI payments on the dashboard and record the money as usual once it arrives.
- New dependency: `qrcode-generator` (MIT, no dependencies) for the QR code.

## Rent in instalments (October 2026)
- New choice in **Settings → Organisation → How you record rent**: *Simple* (the original way: mark paid or set the amount paid) or *Instalments*.
- With **Instalments**, each month on a room's **Rent** tab shows the **total rent**, **received** and **remaining**, with a progress bar and every amount received (date, how it was paid, reference).
- **+ Add amount received** adds one payment at a time (e.g. ₹10,000 of ₹1,00,000 leaves ₹90,000 remaining). More than the remaining amount is refused. The month turns *paid* when nothing is left.
- The room also shows how much is still to be received in total. Simple mode is unchanged and stays the default.

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
