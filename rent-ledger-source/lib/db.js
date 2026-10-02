// SQLite database (Node's built-in node:sqlite, no native dependencies).
//
//   - One file: DATA_DIR/rent-ledger.sqlite (WAL mode, foreign keys on).
//   - Numbered migrations in /migrations run once each, inside a transaction,
//     after an automatic backup of the existing database file.
//   - tx(fn) runs fn atomically; nested calls join the outer transaction.
//   - backup(reason) writes a consistent copy with VACUUM INTO and keeps the
//     newest BACKUP_KEEP copies.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let DatabaseSync;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  throw new Error("Rent Ledger needs Node.js 22.13 or newer (built-in node:sqlite).");
}

const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// node:sqlite accepts null, numbers, strings, bigint and Uint8Array only.
function clean(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  return value;
}
function cleanParams(params) {
  if (params.length === 1 && params[0] && typeof params[0] === "object" && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array)) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = clean(v);
    return [out];
  }
  return params.map(clean);
}
const plain = (row) => (row ? { ...row } : row);

function openDatabase({ dataDir, backupKeep = 30, backupIntervalHours = 24, log = null, now = () => Date.now() }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, "rent-ledger.sqlite");
  const backupDir = path.join(dataDir, "backups");
  const existed = fs.existsSync(file);
  const raw = new DatabaseSync(file);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;");
  try { fs.chmodSync(file, 0o600); } catch {}

  const cache = new Map();
  const prepare = (sql) => {
    let stmt = cache.get(sql);
    if (!stmt) { stmt = raw.prepare(sql); cache.set(sql, stmt); }
    return stmt;
  };
  let depth = 0;
  let lastBackupAt = null;

  const db = {
    file,
    backupDir,
    raw,
    get: (sql, ...params) => plain(prepare(sql).get(...cleanParams(params))),
    all: (sql, ...params) => prepare(sql).all(...cleanParams(params)).map(plain),
    run: (sql, ...params) => prepare(sql).run(...cleanParams(params)),
    exec: (sql) => raw.exec(sql),
    // Atomic unit of work. Throwing inside fn rolls everything back.
    tx(fn) {
      if (depth > 0) {
        const name = `sp_${depth}`;
        raw.exec(`SAVEPOINT ${name}`);
        depth++;
        try { const result = fn(); raw.exec(`RELEASE ${name}`); return result; }
        catch (err) { raw.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw err; }
        finally { depth--; }
      }
      raw.exec("BEGIN IMMEDIATE");
      depth = 1;
      try {
        const result = fn();
        raw.exec("COMMIT");
        return result;
      } catch (err) {
        try { raw.exec("ROLLBACK"); } catch {}
        throw err;
      } finally {
        depth = 0;
      }
    },
    id: () => crypto.randomUUID(),
    nowIso: () => new Date(now()).toISOString(),
    meta(key, value) {
      if (value === undefined) return db.get("SELECT value FROM app_meta WHERE key = ?", key)?.value ?? null;
      db.run("INSERT INTO app_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(value));
      return value;
    },
    listBackups() {
      if (!fs.existsSync(backupDir)) return [];
      return fs.readdirSync(backupDir)
        .filter((name) => /^(db|rent-ledger)-.*\.(json|sqlite)$/.test(name))
        .map((name) => ({ name, mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
    },
    backup(reason = "manual") {
      fs.mkdirSync(backupDir, { recursive: true });
      const safe = String(reason).replace(/[^a-z0-9-]/gi, "").slice(0, 24) || "manual";
      let name = `rent-ledger-${stamp(new Date(now()))}-${safe}.sqlite`;
      for (let i = 2; fs.existsSync(path.join(backupDir, name)); i++) name = `rent-ledger-${stamp(new Date(now()))}-${safe}-${i}.sqlite`;
      const target = path.join(backupDir, name);
      raw.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
      try { fs.chmodSync(target, 0o600); } catch {}
      lastBackupAt = now();
      const sqliteBackups = db.listBackups().filter((b) => b.name.endsWith(".sqlite"));
      for (const old of sqliteBackups.slice(backupKeep)) fs.unlinkSync(path.join(backupDir, old.name));
      return name;
    },
    maybeBackup() {
      if (lastBackupAt === null) lastBackupAt = db.listBackups().find((b) => b.name.endsWith(".sqlite"))?.mtimeMs ?? 0;
      if (now() - lastBackupAt >= backupIntervalHours * 3_600_000) return db.backup("daily");
      return null;
    },
    close() { raw.close(); },
  };

  migrate(db, { existed, log });
  return db;
}

function migrate(db, { existed, log }) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(db.all("SELECT version FROM schema_migrations").map((r) => r.version));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const pending = files.filter((f) => !applied.has(f));
  if (!pending.length) return;
  // Back up an existing database before changing its structure.
  if (existed && applied.size) {
    const name = db.backup("pre-migration");
    log?.info("database backed up before migration", { backup: name, pending });
  }
  for (const file of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.tx(() => {
      db.exec(sql);
      db.run("INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)", file, new Date().toISOString());
    });
    log?.info("migration applied", { migration: file });
  }
}

module.exports = { openDatabase };
