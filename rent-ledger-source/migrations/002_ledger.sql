-- Stage 6/7: append-only financial ledger.
--   charges      = what a tenant owes (rent, electricity, gas, fees ...)
--   adjustments  = changes to a charge (corrections, waivers, discounts) - never edits
--   payments     = money received; corrections are reversals, never edits
--   allocations  = which payment covers which charge (negative rows undo an allocation)
-- Balances are always computed from these rows.

CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  visible_to_tenant INTEGER NOT NULL DEFAULT 0,
  review_status TEXT CHECK (review_status IS NULL OR review_status IN ('unverified', 'accepted', 'rejected')),
  uploaded_by_user_id TEXT,
  uploaded_by_role TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deleted')),
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX documents_entity ON documents(entity_type, entity_id);
CREATE INDEX documents_org ON documents(org_id);

CREATE TABLE charges (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id),
  tenant_id TEXT REFERENCES tenants(id),
  lease_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('rent', 'electricity', 'gas', 'maintenance', 'late_fee', 'damage', 'other')),
  period_year INTEGER,
  period_month INTEGER CHECK (period_month IS NULL OR period_month BETWEEN 1 AND 12),
  due_date TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  base_amount_paise INTEGER NOT NULL CHECK (base_amount_paise >= 0),
  details_json TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE INDEX charges_org ON charges(org_id);
CREATE INDEX charges_room ON charges(room_id);
CREATE INDEX charges_tenant ON charges(tenant_id);
CREATE INDEX charges_period ON charges(org_id, period_year, period_month);
-- A lease's schedule creates at most one rent charge per period.
CREATE UNIQUE INDEX charges_schedule_once ON charges(lease_id, kind, period_year, period_month) WHERE lease_id IS NOT NULL AND voided_at IS NULL;

CREATE TABLE charge_adjustments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  charge_id TEXT NOT NULL REFERENCES charges(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  kind TEXT NOT NULL CHECK (kind IN ('correction', 'waiver', 'discount', 'late_fee', 'write_off')),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX adjustments_charge ON charge_adjustments(charge_id);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id),
  room_id TEXT REFERENCES rooms(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method TEXT NOT NULL CHECK (method IN ('cash', 'upi', 'bank_transfer', 'cheque', 'razorpay', 'deposit_adjustment', 'other')),
  reference TEXT NOT NULL DEFAULT '',
  received_on TEXT NOT NULL,
  -- verified  = confirmed by the payment provider or a bank statement
  -- recorded  = entered by the owner/manager (e.g. cash) without external proof
  verification TEXT NOT NULL CHECK (verification IN ('verified', 'recorded')),
  source TEXT NOT NULL CHECK (source IN ('manual', 'razorpay', 'reconciliation', 'import', 'proof', 'settlement')),
  idempotency_key TEXT UNIQUE,
  provider TEXT,
  provider_payment_id TEXT UNIQUE,
  provider_order_id TEXT,
  evidence_document_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX payments_org ON payments(org_id, received_on);
CREATE INDEX payments_tenant ON payments(tenant_id);

CREATE TABLE payment_reversals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL UNIQUE REFERENCES payments(id),
  reason TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE allocations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  payment_id TEXT NOT NULL REFERENCES payments(id),
  charge_id TEXT NOT NULL REFERENCES charges(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise <> 0),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX allocations_charge ON allocations(charge_id);
CREATE INDEX allocations_payment ON allocations(payment_id);

-- Financial rows are never edited or deleted.
CREATE TRIGGER payments_immutable BEFORE UPDATE OF amount_paise, method, received_on, verification, tenant_id ON payments BEGIN SELECT RAISE(ABORT, 'payments are immutable; record a reversal instead'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments WHEN EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) BEGIN SELECT RAISE(ABORT, 'payments cannot be deleted'); END;
CREATE TRIGGER allocations_immutable BEFORE UPDATE ON allocations BEGIN SELECT RAISE(ABORT, 'allocations are immutable'); END;
CREATE TRIGGER allocations_no_delete BEFORE DELETE ON allocations WHEN EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) BEGIN SELECT RAISE(ABORT, 'allocations cannot be deleted'); END;
CREATE TRIGGER adjustments_immutable BEFORE UPDATE ON charge_adjustments BEGIN SELECT RAISE(ABORT, 'adjustments are immutable'); END;
CREATE TRIGGER adjustments_no_delete BEFORE DELETE ON charge_adjustments WHEN EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) BEGIN SELECT RAISE(ABORT, 'adjustments cannot be deleted'); END;
CREATE TRIGGER reversals_immutable BEFORE UPDATE ON payment_reversals BEGIN SELECT RAISE(ABORT, 'reversals are immutable'); END;
CREATE TRIGGER charges_amount_immutable BEFORE UPDATE OF base_amount_paise, org_id ON charges BEGIN SELECT RAISE(ABORT, 'charge amounts change through adjustments'); END;
CREATE TRIGGER charges_no_delete BEFORE DELETE ON charges WHEN EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) BEGIN SELECT RAISE(ABORT, 'charges are voided, not deleted'); END;

-- Razorpay orders started by tenants.
CREATE TABLE payment_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  razorpay_order_id TEXT UNIQUE,
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  currency TEXT NOT NULL DEFAULT 'INR',
  items_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'paid', 'failed')),
  payment_id TEXT,
  method TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX payment_orders_tenant ON payment_orders(tenant_id);
