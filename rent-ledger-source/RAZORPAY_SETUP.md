# Razorpay online payments: setup

Tenants see a **Pay** button on every pending rent, electricity and gas bill, and a **Pay all** button for the full total. Payments go through Razorpay Checkout, which supports UPI, cards, net banking and wallets. Once Razorpay confirms a payment, the bills are marked paid automatically. The owner dashboard shows each payment under **Online payments received**.

Money settles into the bank account linked to the owner's Razorpay account, on Razorpay's normal settlement schedule and after Razorpay's transaction fee. The app never sees card or bank details, because those stay inside Razorpay's checkout.

No extra npm packages are needed. The server calls Razorpay's REST API directly with the `fetch` built into Node 22.

| Razorpay step | In Rent Ledger |
|---|---|
| Create order | `POST /api/tenant/payments/order` in `server.js`. The tenant chooses bills; the server works out the amount (minimum ₹1 = 100 paise) and calls `POST https://api.razorpay.com/v1/orders`. |
| Checkout | The **Pay** / **Pay all** buttons in the tenant portal (`public/app.js`). They load `https://checkout.razorpay.com/v1/checkout.js` when first clicked and open the Razorpay modal with the order ID. |
| Verify signature | `POST /api/tenant/payments/verify` in `server.js`. It checks HMAC-SHA256(`order_id|payment_id`, key secret), then confirms with Razorpay that the payment is captured before marking bills paid. |

## 1. Get API keys (start in Test Mode)

1. Sign up or log in at https://dashboard.razorpay.com.
2. Switch the dashboard to **Test Mode** using the toggle at the top.
3. Go to **Account & Settings → API Keys → Generate Key**.
4. Copy the **Key ID** (starts with `rzp_test_`) and the **Key Secret**. Razorpay shows the secret only once.

## 2. Add Railway variables

In Railway, open the Rent Ledger service, go to **Variables**, and add:

| Variable | Value |
|---|---|
| `RAZORPAY_KEY_ID` | your Key ID |
| `RAZORPAY_KEY_SECRET` | your Key Secret |
| `RAZORPAY_WEBHOOK_SECRET` | *(optional, see step 3)* a long random string you make up |

Never put the Key Secret in the code or on GitHub. It belongs only in Railway variables. For local testing, put the same values in `.env` next to `server.js` (see `.env.example`).

## 3. Webhook (optional, but recommended)

The browser confirms each payment as soon as it's made. The webhook is a backup: if a tenant pays and then closes the page before the confirmation reaches the app, Razorpay still notifies the app and the bill gets marked paid.

1. In Razorpay go to **Account & Settings → Webhooks → Add New Webhook**.
2. For the URL, enter `https://rent-ledger.up.railway.app/api/payments/razorpay/webhook`.
3. For the secret, use the same value you set as `RAZORPAY_WEBHOOK_SECRET`.
4. Select the events **payment.captured** and **order.paid**.

## 4. Test it

1. Sign in as a tenant who has a pending bill, then tap **Pay**. (If the keys are wrong, the tenant sees "Online payments are misconfigured" and the server log says Razorpay rejected the API keys.)
2. Complete the payment with the test payment details from Razorpay's Test Mode documentation. In Test Mode, no real money moves.
3. The bill should turn **paid** and show **✓ Paid online**. The payment should also appear on the owner dashboard.
4. Open the browser's developer console while paying. If you see messages starting `[Report Only] Refused to…`, note the blocked address before turning on `CSP_ENFORCE=true`.

## 5. Go live

1. Complete account activation (KYC and bank account) in the Razorpay dashboard.
2. Switch to **Live Mode**, generate live keys (they start with `rzp_live_`), and replace the two key variables in Railway.
3. If you use the webhook, add it again in Live Mode. Live and Test webhooks are configured separately.

## How it works and what protects it

- The tenant chooses which bills to pay. The **server** calculates the amount from the stored bills, so the amount can't be changed in the browser. For partly paid rent, the tenant pays only the remaining balance.
- Tenants can pay only their own bills.
- The server checks every payment's Razorpay signature, then asks Razorpay directly whether the payment is captured and whether the amount matches. If the account uses manual capture, the server captures the payment itself.
- A payment is applied only once, even if both the browser and the webhook report it.
- If the owner marks a bill paid by hand while the tenant is paying it online, the online payment is still recorded, and that bill is flagged `already-paid` in the payment record. The owner can then refund the tenant from the Razorpay dashboard.
- Until the keys are set, tenants see their total due with a note that online payment isn't enabled yet. They can still upload a payment proof.
