// JSON-file datastore with atomic writes and rotating backups.
//
// The whole database is still one db.json file (it moves to SQLite in Stage 3).
// What changes here:
//   - saveDb writes to a temporary file, flushes it to disk, then renames it over
//     db.json. A crash mid-write can no longer leave a half-written database.
//   - A copy is kept in DATA_DIR/backups at startup and at most once per
//     BACKUP_INTERVAL_HOURS when data changes. The newest BACKUP_KEEP copies stay.
//   - A corrupt db.json is reported clearly and is never overwritten.
const fs = require("fs");
const path = require("path");

function emptyDb() {
  return {
    users: [],
    sessions: [],
    buildings: [],
    rooms: [],
    tenants: [],
    rentEntries: [],
    electricityEntries: [],
    gasEntries: [],
    passwordResetOtps: [],
    authorities: [],
    payments: [],
  };
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function createStore({ dataDir, seedPath, backupKeep = 30, backupIntervalHours = 24, now = () => Date.now() }) {
  const dbPath = path.join(dataDir, "db.json");
  const backupDir = path.join(dataDir, "backups");
  let lastBackupAt = null;

  function ensureDb() {
    if (fs.existsSync(dbPath)) return;
    fs.mkdirSync(dataDir, { recursive: true });
    if (seedPath && path.resolve(seedPath) !== path.resolve(dbPath) && fs.existsSync(seedPath)) fs.copyFileSync(seedPath, dbPath);
    else writeAtomic(JSON.stringify(emptyDb(), null, 2));
  }

  function loadDb() {
    ensureDb();
    const text = fs.readFileSync(dbPath, "utf-8");
    let db;
    try {
      db = JSON.parse(text);
    } catch {
      const err = new Error(`The database file ${dbPath} is not valid JSON. Restore the newest file from ${backupDir}.`);
      err.code = "DB_CORRUPT";
      throw err;
    }
    // Collections added after the first release default to empty.
    for (const [key, value] of Object.entries(emptyDb())) if (!Array.isArray(db[key])) db[key] = value;
    return db;
  }

  function writeAtomic(text) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${dbPath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, text);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, dbPath);
  }

  function saveDb(db) {
    writeAtomic(JSON.stringify(db, null, 2));
    maybeBackup();
  }

  function listBackups() {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir)
      .filter((name) => /^db-.*\.json$/.test(name))
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  }

  function backup(reason = "manual") {
    if (!fs.existsSync(dbPath)) return null;
    fs.mkdirSync(backupDir, { recursive: true });
    const safeReason = String(reason).replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "manual";
    let name = `db-${stamp(new Date(now()))}-${safeReason}.json`;
    for (let i = 2; fs.existsSync(path.join(backupDir, name)); i++) name = `db-${stamp(new Date(now()))}-${safeReason}-${i}.json`;
    fs.copyFileSync(dbPath, path.join(backupDir, name));
    fs.chmodSync(path.join(backupDir, name), 0o600);
    lastBackupAt = now();
    for (const old of listBackups().slice(backupKeep)) fs.unlinkSync(path.join(backupDir, old.name));
    return name;
  }

  function maybeBackup() {
    if (lastBackupAt === null) lastBackupAt = listBackups()[0]?.mtimeMs ?? 0;
    if (now() - lastBackupAt >= backupIntervalHours * 3_600_000) backup("daily");
  }

  return { dbPath, backupDir, loadDb, saveDb, backup, listBackups };
}

module.exports = { createStore, emptyDb };
