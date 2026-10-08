# Razorpay online payments: setup

Tenants see a **Pay** button on every pending rent, electricity and gas bill, and a **Pay all** button for the full total. Payments go through Razorpay Checkout (UPI, cards, net banking, wallets). Once Razorpay confirms a payment, the bills are marked paid automatically and the owner sees it under **Online payments received**.

**Every owner uses their own Razorpay account.** A tenant's money goes into the Razorpay account of the owner who bills them, and Razorpay settles it to the bank account that owner linked, on Razorpay's normal schedule and after Razorpay's fee. Rent Ledger never holds the money, and there is no shared account: until an owner connects their account, their tenants simply don't see a Pay button.

The app never sees card or bank details; those stay inside Razorpay's checkout. No extra npm packages are needed: the server calls Razorpay's REST API with Node's built-in `fetch`.

## For each owner: connect your Razorpay account

1. Sign up at https://dashboard.razorpay.com and finish activation (KYC). Add your bank account under **Account & Settings → Bank account**. This is where your tenants' money will arrive.
2. Go to **Account & Settings → API Keys → Generate Key**. (Switch to **Test Mode** first if you want to try it without real money. Test keys start with `rzp_test_`, live keys with `rzp_live_`.)
3. In Rent Ledger, open **Settings → Online payments**, paste the **Key ID** and **Key Secret**, and tap **Check and save**. Rent Ledger checks the keys with Razorpay before saving them.
4. Done: your tenants now see the Pay button.

To switch from test to live, or after regenerating keys in Razorpay, paste the new pair the same way. **Disconnect** removes the keys and hides the Pay button again.

### Webhook (optional, recommended)

If a tenant pays and closes the app before the confirmation arrives, the webhook still lets Razorpay tell Rent Ledger.

1. In Razorpay go to **Account & Settings → Webhooks → Add New Webhook**.
2. Paste the URL shown on **Settings → Online payments** (it ends with `/api/payments/razorpay/webhook/<your organisation ID>`).
3. Choose a secret, and tick **payment.captured**, **payment.failed** and **order.paid**.
4. Enter the same secret in Rent Ledger under **Webhook secret** and save.

Live and Test mode webhooks are set up separately in Razorpay.

## How the keys are kept safe

- The Key Secret and webhook secret are stored **encrypted** (AES-256-GCM). They are never shown again, never sent to a browser, and never included in the data export.
- The encryption key comes from the `SECRETS_KEY` server variable if set (64 hex characters, e.g. `openssl rand -hex 32`). Otherwise the server creates `DATA_DIR/secrets.key` once. Database backups don't contain that file. If the key is ever lost, owners just paste their Razorpay keys again.
- Only the owner (not managers or tenants) can view or change the connection. Each change is recorded in the audit log.
- Never put Razorpay keys in the code, in `.env.example`, or anywhere on GitHub.

## How payments are protected

- The tenant chooses which bills to pay. The **server** works out the amount from the stored bills, so it can't be changed in the browser. Minimum ₹1 (100 paise).
- Orders are created with the paying tenant's owner's keys, and each order remembers which key made it. The payment signature (HMAC-SHA256 of `order_id|payment_id`) is checked with that owner's secret, and the server then asks Razorpay whether the payment is captured and the amount matches before marking bills paid. Manual-capture accounts are captured automatically.
- Tenants can pay only their own bills. An owner's webhook only accepts that owner's secret and only updates that owner's orders.
- A payment is applied only once, even if both the browser and the webhook report it.
- If Razorpay rejects an owner's keys (for example after they were regenerated), the tenant sees "Online payments are misconfigured" and the owner gets a notification to reconnect.

## Moving from the old single-account setup

Earlier versions used one Razorpay account for everyone, set with `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` on the server. Those keys no longer turn on payments. They are only used to finish orders that were started with them. After deploying:

1. Each owner connects their own account in **Settings → Online payments** (the original owner can paste the same keys that were on the server).
2. After a day or so, when no old payments are pending, remove `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` and `RAZORPAY_WEBHOOK_SECRET` from Railway.

## Test it

1. As the owner, connect test keys in **Settings → Online payments**.
2. Sign in as a tenant with a pending bill and tap **Pay**. Use Razorpay's Test Mode payment details; no real money moves.
3. The bill should turn **paid**, and the payment should appear on the owner dashboard.
