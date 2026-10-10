-- Razorpay is replaced by direct UPI Intent payments.
--
-- 1. Owners' saved Razorpay keys are no longer used: remove them.
DROP TABLE IF EXISTS org_payment_accounts;

-- 2. payment_orders now also records UPI payments a tenant started. Old
--    Razorpay rows are kept exactly as they were (provider = 'razorpay').
--    A UPI initiation stays 'pending' (not verified) until payment
--    verification is added; it never creates a ledger payment by itself.
CREATE TABLE payment_orders_new (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'razorpay' CHECK (provider IN ('razorpay', 'upi')),
  razorpay_order_id TEXT UNIQUE,
  upi_reference TEXT UNIQUE,
  payee_vpa TEXT,
  payee_name TEXT,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed', 'pending', 'cancelled')),
  payment_id TEXT,
  method TEXT,
  failure_reason TEXT,
  tenant_reported_at TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT,
  key_id TEXT
);
INSERT INTO payment_orders_new (id, org_id, tenant_id, room_id, provider, razorpay_order_id, amount_paise, currency, items_json, status, payment_id, method, failure_reason, created_at, paid_at, key_id)
  SELECT id, org_id, tenant_id, room_id, 'razorpay', razorpay_order_id, amount_paise, currency, items_json, status, payment_id, method, failure_reason, created_at, paid_at, key_id FROM payment_orders;
DROP TABLE payment_orders;
ALTER TABLE payment_orders_new RENAME TO payment_orders;
CREATE INDEX payment_orders_tenant ON payment_orders(tenant_id);
CREATE INDEX payment_orders_org_status ON payment_orders(org_id, status, created_at);
