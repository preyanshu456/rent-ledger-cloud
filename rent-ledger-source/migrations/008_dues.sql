-- Dues engine: charge packages (laundry, mess, parking...), late fees and
-- discounts that expire. Everything still goes through the append-only
-- ledger: packages create charges, late fees are charges (and daily
-- increases are adjustments), discounts are adjustments.

CREATE TABLE dues_packages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT REFERENCES buildings(id) ON DELETE CASCADE,   -- NULL = every property
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('maintenance', 'other')),
  -- fixed    = the same amount every time
  -- per_unit = units used x rate (loads of laundry, plates, kWh), with an optional minimum bill
  billing_mode TEXT NOT NULL CHECK (billing_mode IN ('fixed', 'per_unit')),
  rate_paise INTEGER NOT NULL DEFAULT 0 CHECK (rate_paise >= 0),
  unit_label TEXT NOT NULL DEFAULT '',
  min_bill_paise INTEGER NOT NULL DEFAULT 0 CHECK (min_bill_paise >= 0),
  -- Fixed packages can be added to every active tenant automatically each month.
  auto_monthly INTEGER NOT NULL DEFAULT 0 CHECK (auto_monthly IN (0, 1)),
  due_day INTEGER NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX dues_packages_org ON dues_packages(org_id);

-- At most one automatic charge per package, tenant and month.
CREATE TABLE package_runs (
  package_id TEXT NOT NULL REFERENCES dues_packages(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  period_year INTEGER NOT NULL,
  period_month INTEGER NOT NULL,
  charge_id TEXT NOT NULL REFERENCES charges(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (package_id, tenant_id, period_year, period_month)
);

-- One late-fee charge per overdue bill. Daily fees grow by adjustments.
CREATE TABLE late_fees (
  charge_id TEXT PRIMARY KEY REFERENCES charges(id),
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  fee_charge_id TEXT NOT NULL REFERENCES charges(id),
  mode TEXT NOT NULL CHECK (mode IN ('flat', 'daily')),
  days_charged INTEGER NOT NULL DEFAULT 0,
  last_applied_on TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX late_fees_org ON late_fees(org_id);

-- A discount that only holds if the bill is paid by valid_until. If the bill
-- is still unpaid after that date the discount is taken back automatically.
CREATE TABLE discount_offers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL REFERENCES charges(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  valid_until TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'expired', 'cancelled')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX discount_offers_org ON discount_offers(org_id, status);
CREATE INDEX discount_offers_charge ON discount_offers(charge_id);
