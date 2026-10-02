-- Stage 3/4: core records. Every business table carries org_id so each
-- landlord's data is isolated. Money is stored as integer paise.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  default_language TEXT NOT NULL DEFAULT 'en' CHECK (default_language IN ('en', 'hi')),
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  contact_key TEXT NOT NULL UNIQUE,          -- normalised login: lower-case email or last 10 phone digits
  email TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT,                        -- NULL = legacy unsalted SHA-256, upgraded on next login
  role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'tenant', 'admin')),
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  language TEXT NOT NULL DEFAULT 'en' CHECK (language IN ('en', 'hi')),
  created_at TEXT NOT NULL,
  disabled_at TEXT
);
CREATE INDEX users_org ON users(org_id);
CREATE UNIQUE INDEX users_one_login_per_tenant ON users(tenant_id) WHERE tenant_id IS NOT NULL;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);

CREATE TABLE password_reset_otps (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  otp_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE team_invites (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('manager')),
  name TEXT NOT NULL,
  contact_key TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX team_invites_org ON team_invites(org_id);

CREATE TABLE buildings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  property_type TEXT NOT NULL DEFAULT 'residential',
  total_floors INTEGER NOT NULL DEFAULT 0,
  amenities_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX buildings_org ON buildings(org_id);

CREATE TABLE authorities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bill_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX authorities_org_name ON authorities(org_id, name COLLATE NOCASE);

CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  floor_number INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  electricity_only INTEGER NOT NULL DEFAULT 0 CHECK (electricity_only IN (0, 1)),
  monthly_rent_paise INTEGER NOT NULL DEFAULT 0 CHECK (monthly_rent_paise >= 0),
  deposit_paise INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  status TEXT NOT NULL DEFAULT 'vacant' CHECK (status IN ('vacant', 'occupied', 'owner', 'archived')),
  payment_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (payment_frequency IN ('monthly', 'quarterly', 'half_yearly', 'yearly')),
  utility_notes TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  gas_meter_id TEXT NOT NULL DEFAULT '',
  gas_authority_id TEXT REFERENCES authorities(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX rooms_org ON rooms(org_id);
CREATE INDEX rooms_building ON rooms(building_id);

CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  alt_mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  id_proof_type TEXT NOT NULL DEFAULT '',
  id_proof_number TEXT NOT NULL DEFAULT '',
  move_in_date TEXT NOT NULL DEFAULT '',
  move_out_date TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  deposit_paise INTEGER CHECK (deposit_paise IS NULL OR deposit_paise >= 0),
  notes TEXT NOT NULL DEFAULT '',
  invite_code_hash TEXT,
  invite_expires_at TEXT,
  invite_attempts INTEGER NOT NULL DEFAULT 0,
  invite_created_at TEXT,
  notify_email INTEGER NOT NULL DEFAULT 0,
  notify_sms INTEGER NOT NULL DEFAULT 0,
  notify_whatsapp INTEGER NOT NULL DEFAULT 0,
  anonymized_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX tenants_org ON tenants(org_id);
CREATE INDEX tenants_room ON tenants(room_id);
-- Database-enforced: a room has at most one active tenant.
CREATE UNIQUE INDEX tenants_one_active_per_room ON tenants(room_id) WHERE active = 1;

-- Append-only record of sensitive actions (who did what, when).
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT,
  actor_user_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  request_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_org_time ON audit_log(org_id, created_at);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log WHEN OLD.org_id IS NOT NULL AND EXISTS (SELECT 1 FROM organizations WHERE id = OLD.org_id) BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TABLE app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
