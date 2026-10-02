# Deploying Rent Ledger

Railway builds the repo's `Dockerfile` from the **`main`** branch, so **merging to `main` deploys to production**. Do new work on a branch, let GitHub Actions run the tests, check it, and only then merge.

## Before the first deploy of this release (SQLite upgrade)

This release moves data from `db.json` to a SQLite database on the same volume. The move happens automatically on first start, but take these precautions first:

1. **Volume:** in Railway, check that the service has a volume mounted at `/data` (Service → Settings → Volumes). Without it, data is lost on every deploy.
2. **Backup the current data:**
   - In the current live app: **Your profile → Data backup → Download backup**. Keep the file private.
   - If your Railway plan offers volume backups, take one as well.
3. **Messages stay quiet by default.** Automatic reminders are off, reminders need approval, and the only default channel is in-app. If you want to be extra careful, set `NOTIFY_MODE=simulate` until email/SMS/WhatsApp have been tested. Nothing then leaves the server.
4. **Optional new variables** (all described in `rent-ledger-source/.env.example`):
   - `NOTIFY_MODE`, `NOTIFY_FROM_EMAIL`, `TWILIO_WHATSAPP_FROM` for reminders
   - `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` (and `AI_BASE_URL` if needed) for Rent Ledger AI
   - `OWNER_SIGNUP=open` only if other landlords should be able to create their own organisation

## What happens on first start

1. The database is created at `/data/rent-ledger.sqlite` and the migrations in `rent-ledger-source/migrations/` are applied.
2. `db.json` is copied to `/data/backups/db-…-pre-sqlite.json`, then imported in **one transaction**.
3. Every bill's amount and paid total is checked against `db.json`. **If anything doesn't match, the import is rolled back and the server refuses to start**, with the reason in the logs. Railway keeps the previous deployment running, because the new one never passes its `/health` check.
4. On success, a marker file `db.json.MIGRATED-TO-SQLITE.txt` is written next to `db.json`. `db.json` itself is never modified.
5. Everyone signs in again once, because sign-ins are now stored in the new database.

Look for a log line `legacy data imported` with the number of bills and tenants.

## After every deploy: checklist

1. `https://rent-ledger.up.railway.app/health` returns `{"status":"ok",…}`.
2. Sign in as the owner. The dashboard totals should match what you saw before the deploy.
3. Open **Bills & payments**, and **Finance** (under **More** in the sidebar): outstanding amounts per tenant should look right.
4. Open a room: rent, electricity and gas history is all there.
5. Sign in as a tenant (or ask one): their bills and balance are correct.
6. The deploy logs show no `configuration` warnings you didn't expect. Warnings name the setting, never its value.
7. Optional: **Settings → Backups → Back up now**.

## Backups and restore

- **Automatic:** a full copy of the database is saved to `/data/backups` at every start-up, before migrations, and once a day (newest 30 kept, `BACKUP_KEEP`).
- **Manual:** **Settings → Backups → Back up now**, or download all records as JSON. The JSON file holds tenants' personal details, so keep it private.
- **Restore a database backup:** stop the service, then copy the chosen `backups/rent-ledger-….sqlite` over `/data/rent-ledger.sqlite`. Delete `rent-ledger.sqlite-wal` and `rent-ledger.sqlite-shm` if they exist, then start the service again.

## Rolling back

**Code only (most problems):** in Railway, open Deployments and redeploy the previous good deployment. Alternatively, revert the merge commit on `main` in GitHub. The database is compatible across this release's versions because migrations only add tables and columns.

**Going back to the version from before SQLite** (only if this release can't be used at all):

1. Redeploy the last pre-upgrade deployment. That code reads `db.json`, which still holds the data **as it was at the moment of the upgrade**.
2. Anything recorded after the upgrade (payments, bills, tenants) is **not** in `db.json`. Before rolling back, download **Settings → Backups → Download all records**, so those entries can be re-entered by hand. There is no automatic SQLite → `db.json` converter.
3. To upgrade again later from a `db.json` that changed in the meantime, first rename `/data/rent-ledger.sqlite` (keep it as a backup). This lets the importer run again from the updated `db.json`. Otherwise the existing database is used and the newer `db.json` changes are ignored.

Prefer rolling **forward** with a fix if you can. It keeps every record.

## Turning on optional features

| Feature | Settings | Then |
|---|---|---|
| Online payments | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | See `rent-ledger-source/RAZORPAY_SETUP.md` |
| Email reminders and reset codes | `RESEND_API_KEY`, `OTP_FROM_EMAIL` (and optional `NOTIFY_FROM_EMAIL`) | Settings → Reminders → tick Email; tenants must agree |
| SMS | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Same as above. Indian SMS may need DLT templates |
| WhatsApp | Twilio settings + `TWILIO_WHATSAPP_FROM` | Needs an approved WhatsApp sender/template with Twilio |
| Real sending | `NOTIFY_MODE=live` (the default in production) | Use `simulate` while testing |
| Rent Ledger AI | `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Owner: Settings → Organisation → "Use the AI model" |
| Enforced CSP | `CSP_ENFORCE=true` | After checking the browser console shows no CSP reports, including during a Razorpay payment |

## Scaling note

Rate limits, the hourly jobs and the outbox sender run inside the server process, and SQLite is a single file on one volume. Keep **one** Railway instance. Moving to several instances would need Postgres and a shared rate limiter.
