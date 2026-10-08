-- Each owner (organisation) connects their own Razorpay account, so tenant
-- payments settle straight into that owner's bank account.
CREATE TABLE org_payment_accounts (
  org_id TEXT PRIMARY KEY REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'razorpay',
  key_id TEXT NOT NULL,
  key_secret_enc TEXT NOT NULL,
  webhook_secret_enc TEXT,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  verified_at TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Which Razorpay key created each order, so it is checked with the same account.
ALTER TABLE payment_orders ADD COLUMN key_id TEXT;
