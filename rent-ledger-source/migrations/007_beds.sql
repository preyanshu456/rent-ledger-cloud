-- Beds under rooms (shared rooms, PGs and hostels).
--
-- Every rentable room has one or more beds, and an active tenant holds one
-- bed. Existing rooms each get one bed ("Bed 1") and their tenants are put
-- on it, so a room that had one tenant still has exactly one place.

CREATE TABLE beds (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  -- NULL = the bed uses the room's monthly rent.
  monthly_rent_paise INTEGER CHECK (monthly_rent_paise IS NULL OR monthly_rent_paise >= 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX beds_org ON beds(org_id);
CREATE INDEX beds_room ON beds(room_id);
CREATE UNIQUE INDEX beds_room_label ON beds(room_id, label COLLATE NOCASE);

-- Room tags such as "AC", "Attached washroom", "Girls only".
ALTER TABLE rooms ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE tenants ADD COLUMN bed_id TEXT REFERENCES beds(id) ON DELETE SET NULL;
-- Notice: the date the tenant said they will leave (bed shows "Under notice").
ALTER TABLE tenants ADD COLUMN notice_given_on TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN leaving_on TEXT NOT NULL DEFAULT '';

INSERT INTO beds (id, org_id, room_id, label, created_at)
  SELECT 'bed_' || id, org_id, id, 'Bed 1', created_at FROM rooms WHERE electricity_only = 0;
UPDATE tenants SET bed_id = 'bed_' || room_id WHERE EXISTS (SELECT 1 FROM beds b WHERE b.id = 'bed_' || tenants.room_id);

-- One active tenant per bed (replaces one active tenant per room).
DROP INDEX tenants_one_active_per_room;
CREATE UNIQUE INDEX tenants_one_active_per_bed ON tenants(bed_id) WHERE active = 1 AND bed_id IS NOT NULL;
CREATE INDEX tenants_bed ON tenants(bed_id);

-- Every new rentable room starts with one bed, whichever code created it.
CREATE TRIGGER rooms_default_bed AFTER INSERT ON rooms WHEN NEW.electricity_only = 0 BEGIN
  INSERT INTO beds (id, org_id, room_id, label, created_at) VALUES ('bed_' || NEW.id, NEW.org_id, NEW.id, 'Bed 1', NEW.created_at);
END;

-- A tenant added without a bed takes the first free bed in their room.
CREATE TRIGGER tenants_default_bed AFTER INSERT ON tenants WHEN NEW.bed_id IS NULL AND NEW.active = 1 BEGIN
  UPDATE tenants SET bed_id = (
    SELECT b.id FROM beds b
    WHERE b.room_id = NEW.room_id AND b.disabled = 0
      AND NOT EXISTS (SELECT 1 FROM tenants t WHERE t.bed_id = b.id AND t.active = 1)
    ORDER BY b.created_at, b.label LIMIT 1)
  WHERE id = NEW.id;
END;
