-- Stage 5: leases (and the rent schedule they drive).
CREATE TABLE leases (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL DEFAULT '',
  rent_paise INTEGER NOT NULL CHECK (rent_paise >= 0),
  deposit_paise INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (frequency IN ('monthly', 'quarterly', 'half_yearly', 'yearly')),
  due_day INTEGER NOT NULL DEFAULT 5 CHECK (due_day BETWEEN 1 AND 28),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'ended', 'terminated')),
  auto_generate_rent INTEGER NOT NULL DEFAULT 1,
  schedule_start TEXT,                       -- first period the schedule bills (YYYY-MM)
  notice_days INTEGER NOT NULL DEFAULT 30,
  terms TEXT NOT NULL DEFAULT '',
  renewal_of_lease_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  activated_at TEXT,
  ended_at TEXT,
  end_reason TEXT
);
CREATE INDEX leases_org ON leases(org_id, status);
CREATE UNIQUE INDEX leases_one_active_per_tenant ON leases(tenant_id) WHERE status = 'active';

-- Stage 7: bank / UPI statement reconciliation.
CREATE TABLE bank_imports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL DEFAULT '',
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE bank_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  import_id TEXT NOT NULL REFERENCES bank_imports(id),
  txn_date TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  reference TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  payer TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unmatched' CHECK (status IN ('unmatched', 'matched', 'ignored')),
  flags_json TEXT NOT NULL DEFAULT '[]',
  matched_payment_id TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX bank_txn_fingerprint ON bank_transactions(org_id, fingerprint);
CREATE INDEX bank_txn_status ON bank_transactions(org_id, status);
