-- Stage 9: notifications, message templates, outbox and communication history.
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX notifications_user ON notifications(user_id, read_at);

CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  language TEXT NOT NULL CHECK (language IN ('en', 'hi')),
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX message_templates_key ON message_templates(org_id, key, language);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT,
  user_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('inapp', 'email', 'sms', 'whatsapp')),
  recipient TEXT NOT NULL DEFAULT '',
  template_key TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'en',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  -- simulated = preview mode: the provider isn't configured, nothing was sent
  status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'sending', 'sent', 'failed', 'cancelled', 'simulated')),
  dedupe_key TEXT UNIQUE,
  related_type TEXT,
  related_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TEXT,
  provider_message_id TEXT,
  created_by TEXT,
  approved_by TEXT,
  created_at TEXT NOT NULL,
  approved_at TEXT,
  sent_at TEXT
);
CREATE INDEX outbox_status ON outbox(org_id, status);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  direction TEXT NOT NULL CHECK (direction IN ('to_owner', 'to_tenant')),
  body TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX messages_tenant ON messages(tenant_id, created_at);

-- Stage 11: maintenance and expenses.
CREATE TABLE maintenance_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id),
  room_id TEXT REFERENCES rooms(id),
  tenant_id TEXT REFERENCES tenants(id),
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'under_review', 'approved', 'assigned', 'in_progress', 'awaiting_tenant', 'resolved', 'closed')),
  assigned_to TEXT NOT NULL DEFAULT '',
  resolution TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_by_role TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolved_at TEXT,
  closed_at TEXT
);
CREATE INDEX maintenance_org ON maintenance_requests(org_id, status);

CREATE TABLE maintenance_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL REFERENCES maintenance_requests(id),
  actor_user_id TEXT,
  actor_role TEXT,
  type TEXT NOT NULL CHECK (type IN ('created', 'status', 'comment', 'assigned', 'updated')),
  from_status TEXT,
  to_status TEXT,
  comment TEXT NOT NULL DEFAULT '',
  visible_to_tenant INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX maintenance_events_request ON maintenance_events(request_id, created_at);

CREATE TABLE expenses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id),
  room_id TEXT REFERENCES rooms(id),
  maintenance_request_id TEXT REFERENCES maintenance_requests(id),
  category TEXT NOT NULL CHECK (category IN ('maintenance', 'repairs', 'utilities', 'property_tax', 'insurance', 'management_fee', 'other')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  spent_on TEXT NOT NULL,
  vendor TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT
);
CREATE INDEX expenses_org ON expenses(org_id, spent_on);
CREATE TRIGGER expenses_amount_immutable BEFORE UPDATE OF amount_paise, org_id ON expenses BEGIN SELECT RAISE(ABORT, 'void the expense and record a new one'); END;

-- Stage 12: AI assistant conversations and approval-gated actions.
CREATE TABLE assistant_messages (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  mode TEXT NOT NULL DEFAULT 'basic',
  created_at TEXT NOT NULL
);
CREATE INDEX assistant_messages_user ON assistant_messages(user_id, created_at);

CREATE TABLE assistant_actions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'executed', 'rejected', 'failed')),
  result_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX assistant_actions_org ON assistant_actions(org_id, status);

-- Stage 10/13: move-in / move-out records and deposit settlement.
CREATE TABLE move_records (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  type TEXT NOT NULL CHECK (type IN ('move_in', 'move_out')),
  record_date TEXT NOT NULL DEFAULT '',
  proposed_date TEXT NOT NULL DEFAULT '',
  meter_readings_json TEXT NOT NULL DEFAULT '{}',
  condition_notes TEXT NOT NULL DEFAULT '',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  keys_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX move_records_once ON move_records(tenant_id, type);

CREATE TABLE deposit_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  type TEXT NOT NULL CHECK (type IN ('received', 'refunded', 'applied_to_dues')),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  txn_date TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT '',
  reference TEXT NOT NULL DEFAULT '',
  settlement_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX deposit_txn_tenant ON deposit_transactions(tenant_id);
CREATE TRIGGER deposit_txn_immutable BEFORE UPDATE ON deposit_transactions BEGIN SELECT RAISE(ABORT, 'deposit transactions are immutable'); END;

CREATE TABLE deposit_settlements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  deposit_held_paise INTEGER NOT NULL DEFAULT 0,
  outstanding_dues_paise INTEGER NOT NULL DEFAULT 0,
  deductions_json TEXT NOT NULL DEFAULT '[]',
  refund_paise INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'agreed', 'refunded')),
  notes TEXT NOT NULL DEFAULT '',
  refund_method TEXT,
  refund_reference TEXT,
  agreed_at TEXT,
  refunded_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE UNIQUE INDEX deposit_settlement_once ON deposit_settlements(tenant_id);
