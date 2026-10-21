-- Leads (people asking about a room), bookings (a bed held for someone who
-- moves in on a future date) and the free public page for each property.

CREATE TABLE leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT REFERENCES buildings(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'walk_in' CHECK (source IN ('walk_in', 'phone', 'whatsapp', 'website', 'referral', 'broker', 'online_listing', 'other')),
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'visit_scheduled', 'visited', 'token_paid', 'won', 'lost')),
  visit_on TEXT NOT NULL DEFAULT '',
  move_in_from TEXT NOT NULL DEFAULT '',
  budget_paise INTEGER NOT NULL DEFAULT 0 CHECK (budget_paise >= 0),
  preference TEXT NOT NULL DEFAULT '',        -- "single room, AC", "girls, double sharing"...
  notes TEXT NOT NULL DEFAULT '',
  lost_reason TEXT NOT NULL DEFAULT '',
  next_follow_up TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX leads_org ON leads(org_id, stage);

CREATE TABLE lead_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,          -- note, stage, call, visit, booking
  body TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX lead_events_lead ON lead_events(lead_id);

CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
  bed_id TEXT NOT NULL REFERENCES beds(id),
  room_id TEXT NOT NULL REFERENCES rooms(id),
  name TEXT NOT NULL,
  mobile TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  joining_on TEXT NOT NULL,
  monthly_rent_paise INTEGER NOT NULL DEFAULT 0 CHECK (monthly_rent_paise >= 0),
  deposit_paise INTEGER NOT NULL DEFAULT 0 CHECK (deposit_paise >= 0),
  -- Token (booking amount) the person paid to hold the bed. Recorded as a
  -- tenant payment (advance) when they move in.
  token_paise INTEGER NOT NULL DEFAULT 0 CHECK (token_paise >= 0),
  token_method TEXT NOT NULL DEFAULT '',
  token_reference TEXT NOT NULL DEFAULT '',
  token_received_on TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'moved_in')),
  tenant_id TEXT REFERENCES tenants(id),
  notes TEXT NOT NULL DEFAULT '',
  cancel_reason TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX bookings_org ON bookings(org_id, status);
-- One open booking per bed.
CREATE UNIQUE INDEX bookings_one_open_per_bed ON bookings(bed_id) WHERE status IN ('pending', 'confirmed');

-- The public page for a property: rentledger.../p/<slug>.
CREATE TABLE property_sites (
  building_id TEXT PRIMARY KEY REFERENCES buildings(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
  headline TEXT NOT NULL DEFAULT '',
  about TEXT NOT NULL DEFAULT '',
  house_rules TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  show_rent INTEGER NOT NULL DEFAULT 1 CHECK (show_rent IN (0, 1)),
  show_vacancy INTEGER NOT NULL DEFAULT 1 CHECK (show_vacancy IN (0, 1)),
  map_link TEXT NOT NULL DEFAULT '',
  gender TEXT NOT NULL DEFAULT 'any' CHECK (gender IN ('any', 'boys', 'girls', 'family')),
  token_paise INTEGER NOT NULL DEFAULT 0 CHECK (token_paise >= 0),
  views INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
