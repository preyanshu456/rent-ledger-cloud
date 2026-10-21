-- Hostel operations (a separate window in the app): food menu and meals,
-- attendance and leave, entry/exit and gate passes, tasks, assets and
-- notices. All of it is free to run: no face scan, GPS or paid messages.

-- Per-property hostel settings (meals served, timings, curfew...).
CREATE TABLE hostel_settings (
  building_id TEXT PRIMARY KEY REFERENCES buildings(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  settings_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);

-- Weekly menu: one line per property, weekday (0 = Sunday) and meal.
CREATE TABLE meal_menu (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'snacks', 'dinner')),
  items TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX meal_menu_slot ON meal_menu(building_id, weekday, meal);

-- A tenant says whether they will eat a meal (so the kitchen cooks the
-- right amount), and staff tick when it was served.
CREATE TABLE meal_marks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL,
  meal_date TEXT NOT NULL,
  meal TEXT NOT NULL CHECK (meal IN ('breakfast', 'lunch', 'snacks', 'dinner')),
  going INTEGER NOT NULL CHECK (going IN (0, 1)),
  served INTEGER NOT NULL DEFAULT 0 CHECK (served IN (0, 1)),
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX meal_marks_once ON meal_marks(tenant_id, meal_date, meal);
CREATE INDEX meal_marks_day ON meal_marks(building_id, meal_date);

-- Daily attendance (night roll call), marked by the warden or owner.
CREATE TABLE attendance (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL,
  att_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('present', 'absent', 'leave', 'late')),
  note TEXT NOT NULL DEFAULT '',
  marked_by TEXT,
  marked_at TEXT NOT NULL
);
CREATE UNIQUE INDEX attendance_once ON attendance(tenant_id, att_date);
CREATE INDEX attendance_day ON attendance(building_id, att_date);

CREATE TABLE leave_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  going_to TEXT NOT NULL DEFAULT '',
  skip_meals INTEGER NOT NULL DEFAULT 1 CHECK (skip_meals IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  decided_by TEXT,
  decided_at TEXT,
  decision_note TEXT NOT NULL DEFAULT '',
  created_by_role TEXT NOT NULL DEFAULT 'tenant',
  created_at TEXT NOT NULL
);
CREATE INDEX leave_requests_org ON leave_requests(org_id, status);

-- Permission to go out (and come back by a time).
CREATE TABLE gate_passes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  out_at TEXT NOT NULL,              -- planned, local "YYYY-MM-DDTHH:MM"
  return_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'out', 'returned', 'cancelled')),
  code TEXT NOT NULL,                -- short code the guard checks
  decided_by TEXT,
  decided_at TEXT,
  went_out_at TEXT,
  came_back_at TEXT,
  late INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX gate_passes_org ON gate_passes(org_id, status);

-- Entry/exit register (residents and visitors).
CREATE TABLE gate_log (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  visitor_name TEXT NOT NULL DEFAULT '',
  visitor_mobile TEXT NOT NULL DEFAULT '',
  visiting TEXT NOT NULL DEFAULT '',
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  at TEXT NOT NULL,
  gate_pass_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  logged_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX gate_log_day ON gate_log(building_id, at);

-- Staff tasks and checklists (cleaning, repairs, inspections), one-off or repeating.
CREATE TABLE hostel_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  assignee TEXT NOT NULL DEFAULT '',
  due_on TEXT NOT NULL DEFAULT '',
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  done_at TEXT,
  done_by TEXT,
  done_note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX hostel_tasks_org ON hostel_tasks(org_id, status, due_on);

-- Things the property owns: beds, fans, ACs, geysers, mattresses...
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
  room_id TEXT REFERENCES rooms(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other',
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 0),
  condition TEXT NOT NULL DEFAULT 'good' CHECK (condition IN ('good', 'needs_repair', 'broken', 'in_storage', 'retired')),
  brand TEXT NOT NULL DEFAULT '',
  serial_no TEXT NOT NULL DEFAULT '',
  purchased_on TEXT NOT NULL DEFAULT '',
  cost_paise INTEGER NOT NULL DEFAULT 0 CHECK (cost_paise >= 0),
  warranty_until TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX assets_building ON assets(building_id);

-- Notice board: shown to tenants of the property (or of every property).
CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  building_id TEXT REFERENCES buildings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  expires_on TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX notices_org ON notices(org_id, created_at);
