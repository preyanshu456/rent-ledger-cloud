# Rent Ledger

Rent, utility and tenancy management for Indian landlords and property managers, with a self-service portal for tenants.

Live: https://rent-ledger.up.railway.app

## What it does

**Owners and managers**
- Properties, floors, rooms, tenants, and leases with automatic rent schedules, renewals and expiry tracking.
- An append-only **ledger** for rent, electricity, gas, maintenance, late fees, damage and other charges. Payments by UPI, cash, bank transfer or cheque are applied to bills (older Razorpay payments stay in the history). Partial payments and tenant credit are handled. Corrections are recorded as adjustments, voids and reversals, so paid history is never edited.
- **Bank reconciliation:** import a statement CSV and get suggested tenant matches with the evidence behind each one. Nothing is recorded until you confirm.
- **Finance dashboard and reports:** collection, outstanding, payments, property income, cash flow, lease expiry, expenses and deposits, as a printable page/PDF or CSV.
- **Reminders** in English and Hindi, through in-app, email, SMS or WhatsApp. Messages are drafted, reviewed and approved before anything is sent. Duplicates are prevented and failed sends are retried.
- **Maintenance** requests with a status timeline, internal notes, photos and linked costs, plus **expenses** with receipts.
- **Move-in/move-out** records (checklists, meter readings, photos), security deposits held separately from income, and **deposit settlement** with line-by-line deductions.
- **Rent Ledger AI:** ask questions in plain English or Hindi. It can also prepare reminders, maintenance tasks and expenses for you to approve. It never changes payments or balances. Without an AI key it runs in a rule-based "basic mode".
- **Insights:** a cash-flow forecast labelled as an estimate (with its assumptions), and review alerts for possible duplicate payments, unusual adjustments and unmatched money.
- **Team:** several landlords can each have their own separate organisation, and an owner can invite property managers with limited permissions. Sensitive changes go to an audit log.

**Tenants**
- See balance, upcoming dues, lease, bills and receipts.
- Pay by UPI: the Pay button opens their own UPI app (Google Pay, PhonePe, Paytm, BHIM…) with the owner's UPI ID and the exact amount filled in, or shows a QR code on a computer. Or upload a payment proof. UPI payments stay pending until the owner records the money (no automatic verification yet).
- Download statements and printable receipts.
- Raise and track maintenance requests.
- Read shared documents and message the owner.
- Choose the language and which reminder channels they agree to.

## How it is built

| Part | What it is |
|---|---|
| `rent-ledger-source/server.js` | Express app set-up: security headers, sessions, tenant firewall, module loading, error handling |
| `rent-ledger-source/routes/` | One file per area (auth, properties, tenants, leases, ledger, payments, reconciliation, finance, notifications, maintenance, expenses, tenancy, assistant, team, portal…) |
| `rent-ledger-source/services/` | Business logic: `ledger.js` (accounting core), `schedules.js`, `reconciliation.js`, `finance.js`, `reminders.js`, `delivery.js`, `jobs.js`, `insights.js`, `extract.js`, `assistant/`, `importer.js` |
| `rent-ledger-source/migrations/` | Numbered SQL migrations, applied automatically at start-up |
| `rent-ledger-source/lib/` | Database (`db.js`), money in paise (`money.js`), settings, logs, sessions, validation, dates, security |
| `rent-ledger-source/public/` | The web app (plain JavaScript, no build step, installable as a PWA): `app.js` (core screens), `modules.js` (new screens), `i18n.js` (English/हिन्दी) |
| `rent-ledger-source/test/` | Automated tests (Node's built-in test runner) |
| `Dockerfile`, `rent-ledger-source/railway.json` | How Railway builds and health-checks the app |

**Data:** a SQLite database (`rent-ledger.sqlite`, using Node's built-in `node:sqlite`) in `DATA_DIR` (`/data` on Railway, which must be a mounted volume). Money is stored as whole paise. Documents are kept in `DATA_DIR/documents`, older payment proofs stay in `DATA_DIR/receipts`, and backups go to `DATA_DIR/backups`.

On first start after upgrading from the old `db.json` version, the data is imported in one transaction and checked bill by bill. If anything doesn't match, nothing is kept and the server refuses to start. `db.json` itself is never changed, and a copy is saved in `backups/`.

## Run it on your computer

Needs Node.js 22.13 or newer.

```bash
cd rent-ledger-source
npm install
npm start            # http://localhost:4000
```

Local data goes to `rent-ledger-source/data/`, which git ignores. Outside production, reminders run in **simulate** mode: in-app messages are delivered, but email, SMS and WhatsApp are only marked "simulated". To try online payments, real messages or the AI assistant, copy `.env.example` to `.env` and fill in the keys you need. Every setting is described there.

## Tests

```bash
cd rent-ledger-source
npm test
```

There are 93 tests covering authentication and sessions, the ledger (allocation, partial payments, credit, reversals, immutability), the db.json importer, leases and schedules, reconciliation, reports, reminders and the outbox, maintenance, expenses, deposit settlement, insights, and the assistant (basic mode plus mocked Anthropic and OpenAI-compatible providers).

The tests use a temporary data folder and never send real messages, call real AI providers or make real payments. GitHub Actions runs them on every push (`.github/workflows/ci.yml`).

## Deploying, rollback and backups

See **[DEPLOYMENT.md](DEPLOYMENT.md)**. In short: Railway deploys `main` automatically, so work on a branch, check it, then merge. Privacy and the data shared with each provider are described in **[PRIVACY.md](PRIVACY.md)**.

## Roles

| | Owner | Manager | Tenant |
|---|---|---|---|
| Properties, tenants, leases, bills, payments, reconciliation, maintenance, expenses, reminders, reports, assistant | ✓ | ✓ | – |
| Reverse payments, void bills, waive or write off money, agree and refund deposit settlements | ✓ | – | – |
| Team, organisation settings, audit log, data export, backups | ✓ | – | – |
| Own bills, payments, receipts, statement, maintenance requests, shared documents, messages | – | – | ✓ |

All of this is enforced on the server. Every query is scoped to the signed-in user's organisation, and tenant accounts can only reach their own portal routes.

## Known limits

- Rate limits and background jobs run inside one server process, so run a single Railway instance (the default).
- The Content-Security-Policy runs in report-only mode by default. After checking the browser console shows no CSP reports, set `CSP_ENFORCE=true`.
- UPI payments are not verified automatically: a started payment stays *pending* until the owner records the money they received.
- Lease field extraction reads text-based PDFs and pasted text. Scanned images need the text pasted in.
- The Hindi translation covers navigation, common labels, statuses, the tenant portal and reminder templates. Some longer explanations and server messages are still in English.
- WhatsApp sending uses Twilio and needs an approved WhatsApp sender. SMS and WhatsApp to India may also need DLT/template registration with your provider.
