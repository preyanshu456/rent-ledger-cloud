const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { setupEnv } = require("./helpers");

setupEnv();
const { localDate, currentPeriod, isIsoDate } = require("../lib/dates");
const { openDatabase } = require("../lib/db");
const sessions = require("../lib/sessions");
const { createRateLimiter } = require("../lib/security");
const v = require("../lib/validate");
const log = require("../lib/log");
const { configWarnings } = require("../lib/config");
const { toPaise, toRupees } = require("../lib/money");
const { sameMobile, contactKey } = require("../services/accounts");
const { newInviteCode, inviteHash } = require("../routes/auth");
const { csvEscape } = require("../routes/common");

test("business dates follow India time, not the UTC server clock", () => {
  const instant = new Date("2026-10-31T20:00:00Z"); // already 1 Nov in India
  assert.equal(localDate("Asia/Kolkata", instant), "2026-11-01");
  assert.deepEqual(currentPeriod("Asia/Kolkata", instant), { year: 2026, month: 11 });
  assert.equal(localDate("UTC", instant), "2026-10-31");
  assert.ok(isIsoDate("2024-02-29"));
  assert.ok(!isIsoDate("2026-02-29"));
  assert.ok(!isIsoDate("02/03/2026"));
});

test("money is exact in paise", () => {
  assert.equal(toPaise("12000.5"), 1200050);
  assert.equal(toPaise(0.1 + 0.2), 30);
  assert.equal(toRupees(1200050), 12000.5);
});

test("database: migrations run once, foreign keys and constraints are on", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-db-"));
  const db = openDatabase({ dataDir: dir });
  const versions = db.all("SELECT version FROM schema_migrations").map((r) => r.version);
  assert.ok(versions.includes("001_core.sql") && versions.includes("004_operations.sql"));
  assert.equal(db.get("PRAGMA foreign_keys").foreign_keys, 1);
  db.close();
  const again = openDatabase({ dataDir: dir }); // re-open: nothing re-applied
  assert.equal(again.all("SELECT version FROM schema_migrations").length, versions.length);
  assert.throws(() => again.run("INSERT INTO rooms (id, org_id, building_id, label, created_at) VALUES ('r','missing-org','missing-b','x','now')"), /FOREIGN KEY/);
  again.close();
});

test("database: transactions roll back completely on error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-tx-"));
  const db = openDatabase({ dataDir: dir });
  db.run("INSERT INTO organizations (id, name, created_at) VALUES ('o1','Org','now')");
  assert.throws(() => db.tx(() => {
    db.run("INSERT INTO buildings (id, org_id, name, created_at) VALUES ('b1','o1','A','now')");
    db.tx(() => { db.run("INSERT INTO buildings (id, org_id, name, created_at) VALUES ('b2','o1','B','now')"); });
    throw new Error("boom");
  }), /boom/);
  assert.equal(db.get("SELECT COUNT(*) AS n FROM buildings").n, 0);
  db.close();
});

test("database: backups are consistent copies and rotate", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rl-bk-"));
  let clock = Date.parse("2026-10-01T00:00:00Z");
  const db = openDatabase({ dataDir: dir, backupKeep: 3, backupIntervalHours: 24, now: () => clock });
  db.run("INSERT INTO organizations (id, name, created_at) VALUES ('o1','Org','now')");
  for (let i = 0; i < 5; i++) { clock += 3_600_000; db.backup("manual"); }
  const backups = db.listBackups().filter((b) => b.name.endsWith(".sqlite"));
  assert.equal(backups.length, 3);
  const copy = openDatabase({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "rl-restore-")) });
  copy.close();
  // The backup file is a complete database with the data in it.
  const { DatabaseSync } = require("node:sqlite");
  const restored = new DatabaseSync(path.join(dir, "backups", backups[0].name));
  assert.equal(restored.prepare("SELECT name FROM organizations").get().name, "Org");
  restored.close();
  assert.equal(db.maybeBackup(), null); // within 24h of the last one
  clock += 25 * 3_600_000;
  assert.match(db.maybeBackup(), /daily/);
  db.close();
});

test("sessions: tokens are random, stored hashed", () => {
  const token = "a".repeat(43);
  assert.equal(sessions.hashToken(token).length, 64);
  assert.notEqual(sessions.hashToken(token), token);
  assert.equal(sessions.bearerToken({ headers: { authorization: `Bearer ${token}` } }), token);
  assert.equal(sessions.bearerToken({ headers: { authorization: "Bearer <x>" } }), "");
});

test("rate limiter blocks after the limit and resets after the window", () => {
  const limiter = createRateLimiter({ windowMs: 1000, max: 2 });
  assert.ok(limiter.hit("k", 0).allowed);
  assert.ok(limiter.hit("k", 1).allowed);
  assert.ok(!limiter.hit("k", 2).allowed);
  assert.ok(limiter.hit("k", 1001).allowed);
});

test("validation helpers", () => {
  assert.equal(v.number({ label: "N" })(""), 0);
  assert.equal(v.number({ label: "N" })("12.345"), 12.35);
  assert.throws(() => v.number({ label: "N" })("1e999"), /must be a number/);
  assert.throws(() => v.text({ label: "T", max: 3 })("abcd"), /3 characters/);
  assert.throws(() => v.mobile({ required: true })("123"), /valid phone/);
  assert.deepEqual(v.clean({ name: "A", extra: "ignored" }, { name: v.text({ label: "Name" }), notes: v.text({ label: "Notes" }) }, { partial: true }), { name: "A" });
});

test("log redaction hides secrets", () => {
  const out = log.redact({ password: "p", nested: { token: "t", ok: 1 }, authorization: "Bearer x" });
  assert.deepEqual(out, { password: "[redacted]", nested: { token: "[redacted]", ok: 1 }, authorization: "[redacted]" });
});

test("config warnings catch half-configured providers without printing secrets", () => {
  const warnings = configWarnings({ RAZORPAY_KEY_ID: "rzp_test_123", NODE_ENV: "production" });
  assert.ok(warnings.some((w) => w.includes("Razorpay")));
  assert.ok(warnings.some((w) => w.includes("DATA_DIR")));
  assert.ok(warnings.every((w) => !w.includes("rzp_test_123")));
});

test("phone numbers and emails map to one login key", () => {
  assert.ok(sameMobile("9876543210", "+91 98765 43210"));
  assert.ok(!sameMobile("9876543210", "9876543211"));
  assert.equal(contactKey("+91 98765-43210"), contactKey("9876543210"));
  assert.equal(contactKey("Owner@Example.com"), "e:owner@example.com");
});

test("invite codes use an unambiguous alphabet and hash case-insensitively", () => {
  const code = newInviteCode();
  assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(inviteHash(code), inviteHash(code.toLowerCase().replace("-", " ")));
});

test("CSV export cells can't inject spreadsheet formulas", () => {
  assert.equal(csvEscape("=HYPERLINK(\"x\")"), "\"'=HYPERLINK(\"\"x\"\")\"");
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), "\"a,b\"");
});
