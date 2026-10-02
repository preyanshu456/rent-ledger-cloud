// Sign-up, sign-in, sessions, password reset and the signed-in person's account.
const crypto = require("crypto");
const sessionsLib = require("../lib/sessions");
const v = require("../lib/validate");
const { config } = require("../lib/config");
const { toRupees } = require("../lib/money");
const accounts = require("../services/accounts");
const { sendPasswordResetOtp } = require("../services/providers");
const { audit } = require("../services/audit");
const { tooMany } = require("../lib/security");
const { setSessionCookie, clearSessionCookie, permissionsFor, ctxOf } = require("./common");

const INVITE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I
function normalizeInviteCode(code) { return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function inviteHash(code) { return crypto.createHash("sha256").update(`invite:${normalizeInviteCode(code)}`).digest("hex"); }
function newInviteCode() {
  let raw = "";
  for (let i = 0; i < 8; i++) raw += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
function otpHash(otp) { return crypto.createHash("sha256").update(String(otp)).digest("hex"); }

function register(app, { db, auth, limits, ipOf, contactLimitKey, log }) {
  function startSession(user, req, res) {
    const token = crypto.randomBytes(32).toString("base64url");
    const now = Date.now();
    db.run("DELETE FROM sessions WHERE expires_at <= ?", new Date(now).toISOString());
    db.run("INSERT INTO sessions (id, token_hash, user_id, created_at, last_seen_at, expires_at, user_agent) VALUES (?,?,?,?,?,?,?)",
      db.id(), sessionsLib.hashToken(token), user.id, new Date(now).toISOString(), new Date(now).toISOString(),
      new Date(now + config.sessionTtlDays * 86_400_000).toISOString(), String(req.headers["user-agent"] || "").slice(0, 160));
    setSessionCookie(req, res, token);
    return token;
  }

  function createUser({ orgId, name, contact, password, role, tenantId = null, language = "en" }) {
    const id = db.id();
    const { password_hash, password_salt } = accounts.hashPassword(password);
    db.run(`INSERT INTO users (id, org_id, name, contact, contact_key, email, password_hash, password_salt, role, tenant_id, language, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, orgId, name, contact, accounts.contactKey(contact), accounts.contactKey(contact).startsWith("e:") ? contact.trim() : "",
      password_hash, password_salt, role, tenantId, language, db.nowIso());
    return db.get("SELECT * FROM users WHERE id = ?", id);
  }

  app.post("/api/auth/signup", (req, res) => {
    const limited = limits.signupPerIp.hit(ipOf(req));
    if (!limited.allowed) return tooMany(res, limited.retryAfterSeconds);
    const { password, role } = req.body || {};
    const name = v.text({ label: "Name", max: 120, required: true })(req.body?.name);
    const contact = v.text({ label: "Contact", max: 200, required: true })(req.body?.contact);
    if (!["owner", "tenant", "manager"].includes(role)) return res.status(400).json({ error: "Name, contact, password and role are required" });
    const problem = accounts.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const key = accounts.contactKey(contact);
    if (db.get("SELECT 1 FROM users WHERE contact_key = ?", key)) return res.status(409).json({ error: "An account with this contact already exists" });

    let user;
    if (role === "owner") {
      // The first owner sets up the deployment. More landlords can join only
      // when OWNER_SIGNUP=open, or with the OWNER_SETUP_CODE.
      const anyUser = db.get("SELECT 1 FROM users LIMIT 1");
      const codeOk = config.ownerSetupCode && accounts.safeEqualText(config.ownerSetupCode, String(req.body?.setupCode || ""));
      const open = String(process.env.OWNER_SIGNUP || "").toLowerCase() === "open";
      if (anyUser && !open && !codeOk) return res.status(403).json({ error: "Owner accounts are created during initial setup only" });
      if (!anyUser && config.ownerSetupCode && !codeOk) return res.status(403).json({ error: "Enter the setup code configured for this server." });
      user = db.tx(() => {
        const orgId = accounts.createOrg(db, { name: `${name}'s properties` });
        const created = createUser({ orgId, name, contact, password, role: "owner" });
        audit(db, { orgId, userId: created.id, role: "owner", requestId: req.id }, "account.created", "user", created.id, { role: "owner" });
        return created;
      });
    } else if (role === "tenant") {
      // A tenant needs the mobile number the owner saved AND the invite code
      // they shared. One message for every failure, so the form can't be used
      // to discover which numbers belong to tenants.
      const failure = "The mobile number or invite code is not valid. Ask your owner for a new invite code.";
      // The same number could be a tenant with more than one landlord: the
      // invite code decides which tenancy this login belongs to.
      const candidates = db.all("SELECT * FROM tenants WHERE active = 1 AND mobile <> ''").filter((t) => accounts.sameMobile(t.mobile, contact));
      if (!candidates.length) return res.status(400).json({ error: failure });
      const code = inviteHash(req.body?.inviteCode);
      const isActive = (t) => t.invite_code_hash && Date.parse(t.invite_expires_at) > Date.now() && t.invite_attempts < config.inviteMaxAttempts;
      const tenant = candidates.find((t) => isActive(t) && accounts.safeEqualText(t.invite_code_hash, code));
      if (!tenant) {
        if (candidates.some((t) => db.get("SELECT 1 FROM users WHERE tenant_id = ?", t.id)) && !candidates.some(isActive)) {
          return res.status(409).json({ error: 'This tenant already has a login. Use "Forgot password?" on the sign-in page.' });
        }
        for (const t of candidates.filter(isActive)) {
          const attempts = t.invite_attempts + 1;
          if (attempts >= config.inviteMaxAttempts) db.run("UPDATE tenants SET invite_code_hash = NULL, invite_expires_at = NULL, invite_attempts = 0 WHERE id = ?", t.id);
          else db.run("UPDATE tenants SET invite_attempts = ? WHERE id = ?", attempts, t.id);
        }
        return res.status(400).json({ error: failure });
      }
      if (db.get("SELECT 1 FROM users WHERE tenant_id = ?", tenant.id)) return res.status(409).json({ error: 'This tenant already has a login. Use "Forgot password?" on the sign-in page.' });
      user = db.tx(() => {
        db.run("UPDATE tenants SET invite_code_hash = NULL, invite_expires_at = NULL, invite_attempts = 0 WHERE id = ?", tenant.id); // single use
        const org = db.get("SELECT default_language FROM organizations WHERE id = ?", tenant.org_id);
        const created = createUser({ orgId: tenant.org_id, name, contact, password, role: "tenant", tenantId: tenant.id, language: org?.default_language || "en" });
        audit(db, { orgId: tenant.org_id, userId: created.id, role: "tenant", requestId: req.id }, "account.created", "user", created.id, { role: "tenant", tenantId: tenant.id });
        return created;
      });
    } else {
      // Property managers join with a team invite created by the owner.
      const failure = "The contact or invite code is not valid. Ask the owner for a new invite.";
      const invite = db.get("SELECT * FROM team_invites WHERE contact_key = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC", key, new Date().toISOString());
      if (!invite || invite.attempts >= config.inviteMaxAttempts) return res.status(400).json({ error: failure });
      if (!accounts.safeEqualText(invite.code_hash, inviteHash(req.body?.inviteCode))) {
        db.run("UPDATE team_invites SET attempts = attempts + 1 WHERE id = ?", invite.id);
        return res.status(400).json({ error: failure });
      }
      user = db.tx(() => {
        db.run("UPDATE team_invites SET used_at = ? WHERE id = ?", db.nowIso(), invite.id);
        const created = createUser({ orgId: invite.org_id, name, contact, password, role: "manager" });
        audit(db, { orgId: invite.org_id, userId: created.id, role: "manager", requestId: req.id }, "account.created", "user", created.id, { role: "manager" });
        return created;
      });
    }
    const token = startSession(user, req, res);
    log.info("account created", { userId: user.id, role: user.role });
    res.status(201).json({ token, user: accounts.safeUser(user) });
  });

  app.post("/api/auth/login", (req, res) => {
    const contact = contactLimitKey(req.body?.contact);
    const password = req.body?.password;
    const perIp = limits.loginPerIp.hit(ipOf(req));
    if (!perIp.allowed) return tooMany(res, perIp.retryAfterSeconds);
    if (contact && limits.loginFailuresPerContact.peek(contact)) {
      return tooMany(res, 15 * 60, "Too many incorrect attempts for this account. Please wait 15 minutes or reset your password.");
    }
    const candidate = contact && typeof password === "string" ? accounts.findUserByContact(db, contact) : null;
    const user = candidate && accounts.validPassword(candidate, password) ? candidate : null;
    if (!user) {
      if (contact) limits.loginFailuresPerContact.hit(contact);
      return res.status(401).json({ error: "Incorrect contact or password" });
    }
    limits.loginFailuresPerContact.reset(contact);
    if (!user.password_salt) {
      const upgraded = accounts.hashPassword(password);
      db.run("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", upgraded.password_hash, upgraded.password_salt, user.id);
    }
    const token = startSession(user, req, res);
    res.json({ token, user: accounts.safeUser(user) });
  });

  app.post("/api/auth/logout", (req, res) => {
    const token = sessionsLib.bearerToken(req) || require("./common").readCookie(req, "rl_session");
    if (token) db.run("DELETE FROM sessions WHERE token_hash = ?", sessionsLib.hashToken(token));
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  app.get("/api/auth/me", auth, (req, res) => {
    const org = req.orgId ? accounts.getOrg(db, req.orgId) : null;
    res.json({ user: accounts.safeUser(req.user), org: org ? { id: org.id, name: org.name, timeZone: org.time_zone, defaultLanguage: org.default_language } : null, permissions: permissionsFor(req.user) });
  });

  app.post("/api/auth/request-password-reset", async (req, res, next) => {
    try {
      const limited = limits.resetPerIp.hit(ipOf(req));
      if (!limited.allowed) return tooMany(res, limited.retryAfterSeconds);
      db.run("DELETE FROM password_reset_otps WHERE expires_at <= ?", new Date().toISOString());
      const user = accounts.findUserByContact(db, req.body?.contact);
      // Deliberately does not reveal whether an account exists.
      const message = "If an account matches those details, a one-time code has been sent.";
      if (!user) return res.json({ message });
      const recent = db.get("SELECT 1 FROM password_reset_otps WHERE user_id = ? AND created_at > ?", user.id, new Date(Date.now() - 60_000).toISOString());
      if (recent) return res.status(429).json({ error: "Please wait one minute before requesting another code." });
      const otp = crypto.randomInt(100000, 1000000).toString();
      let delivery;
      try { delivery = await sendPasswordResetOtp(user, otp); }
      catch (error) {
        log.warn("password reset delivery failed", { userId: user.id, error: error.message });
        return res.status(503).json({ error: error.message || "Unable to send a reset code right now." });
      }
      db.run("INSERT INTO password_reset_otps (user_id, otp_hash, attempts, created_at, expires_at) VALUES (?,?,0,?,?) ON CONFLICT(user_id) DO UPDATE SET otp_hash = excluded.otp_hash, attempts = 0, created_at = excluded.created_at, expires_at = excluded.expires_at",
        user.id, otpHash(otp), db.nowIso(), new Date(Date.now() + 10 * 60_000).toISOString());
      res.json({ message, delivery });
    } catch (err) { next(err); }
  });

  app.post("/api/auth/reset-password", (req, res) => {
    const limited = limits.resetPerIp.hit(ipOf(req));
    if (!limited.allowed) return tooMany(res, limited.retryAfterSeconds);
    const { contact, otp, password } = req.body || {};
    if (!contact || !otp || !password) return res.status(400).json({ error: "Contact, 6-digit code and a new password are required." });
    const problem = accounts.passwordProblem(password);
    if (problem) return res.status(400).json({ error: problem });
    const user = accounts.findUserByContact(db, contact);
    const record = user && db.get("SELECT * FROM password_reset_otps WHERE user_id = ?", user.id);
    const invalid = "This code is invalid or expired. Request a new code.";
    if (!record || Date.parse(record.expires_at) <= Date.now() || record.attempts >= 5) return res.status(400).json({ error: invalid });
    if (!crypto.timingSafeEqual(Buffer.from(record.otp_hash, "hex"), Buffer.from(otpHash(otp), "hex"))) {
      db.run("UPDATE password_reset_otps SET attempts = attempts + 1 WHERE user_id = ?", user.id);
      return res.status(400).json({ error: invalid });
    }
    const hashed = accounts.hashPassword(password);
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", hashed.password_hash, hashed.password_salt, user.id);
      db.run("DELETE FROM password_reset_otps WHERE user_id = ?", user.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", user.id);
      audit(db, { orgId: user.org_id, userId: user.id, role: user.role, requestId: req.id }, "account.password_reset", "user", user.id, {});
    });
    limits.loginFailuresPerContact.reset(contactLimitKey(contact));
    res.json({ message: "Password reset. Please sign in with your new password." });
  });

  app.get("/api/account/profile", auth, (req, res) => {
    const user = req.user;
    const account = { id: user.id, name: user.name, contact: user.contact, role: user.role, createdAt: user.created_at, language: user.language };
    if (user.role !== "tenant") {
      const buildings = db.all("SELECT * FROM buildings WHERE org_id = ? ORDER BY created_at", req.orgId).map((b) => {
        const rooms = db.all("SELECT status FROM rooms WHERE building_id = ?", b.id);
        return { id: b.id, name: b.name, address: b.address || "", totalFloors: b.total_floors || 0, rooms: rooms.length, occupiedRooms: rooms.filter((r) => r.status === "occupied").length, status: b.status };
      });
      const org = accounts.getOrg(db, req.orgId);
      return res.json({ account, org: org ? { id: org.id, name: org.name } : null, buildings });
    }
    const tenant = db.get("SELECT * FROM tenants WHERE id = ? AND active = 1", user.tenant_id);
    if (!tenant) return res.status(404).json({ error: "No active tenancy found" });
    const room = db.get("SELECT * FROM rooms WHERE id = ?", tenant.room_id);
    const building = room && db.get("SELECT * FROM buildings WHERE id = ?", room.building_id);
    // Older tenant records have no deposit of their own; the room's deposit applies.
    const depositPaise = tenant.deposit_paise === null || tenant.deposit_paise === undefined ? (room?.deposit_paise || 0) : tenant.deposit_paise;
    res.json({
      account,
      tenant: { name: tenant.name, mobile: tenant.mobile || "", altMobile: tenant.alt_mobile || "", email: tenant.email || "", idProofType: tenant.id_proof_type || "", moveInDate: tenant.move_in_date || "", deposit: toRupees(depositPaise),
        notifyEmail: Boolean(tenant.notify_email), notifySms: Boolean(tenant.notify_sms), notifyWhatsapp: Boolean(tenant.notify_whatsapp) },
      home: { buildingName: building?.name || "", buildingAddress: building?.address || "", roomLabel: room?.label || "", floorNumber: room?.floor_number ?? "", monthlyRent: toRupees(room?.monthly_rent_paise || 0) },
    });
  });

  app.put("/api/account/password", auth, (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) return res.status(400).json({ error: "Enter your current password and a new password." });
    const problem = accounts.passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (!accounts.validPassword(req.user, currentPassword)) return res.status(400).json({ error: "Your current password is incorrect." });
    const hashed = accounts.hashPassword(newPassword);
    db.tx(() => {
      db.run("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?", hashed.password_hash, hashed.password_salt, req.user.id);
      db.run("DELETE FROM sessions WHERE user_id = ?", req.user.id);
      audit(db, ctxOf(req), "account.password_changed", "user", req.user.id, {});
    });
    clearSessionCookie(req, res);
    res.json({ message: "Password updated. Please sign in again." });
  });

  // Language and (for tenants) contact details and notification consent.
  app.put("/api/account/preferences", auth, (req, res) => {
    const body = req.body || {};
    if (body.language !== undefined) {
      if (!["en", "hi"].includes(body.language)) return res.status(400).json({ error: "Language must be English or Hindi." });
      db.run("UPDATE users SET language = ? WHERE id = ?", body.language, req.user.id);
    }
    if (req.user.role === "tenant" && req.user.tenant_id) {
      const sets = [];
      const params = [];
      if (body.email !== undefined) { sets.push("email = ?"); params.push(v.email()(body.email)); }
      if (body.altMobile !== undefined) { sets.push("alt_mobile = ?"); params.push(v.mobile({ label: "Alternate mobile" })(body.altMobile)); }
      for (const [field, column] of [["notifyEmail", "notify_email"], ["notifySms", "notify_sms"], ["notifyWhatsapp", "notify_whatsapp"]]) {
        if (body[field] !== undefined) { sets.push(`${column} = ?`); params.push(body[field] ? 1 : 0); }
      }
      if (sets.length) {
        db.run(`UPDATE tenants SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, ...params, db.nowIso(), req.user.tenant_id);
        audit(db, ctxOf(req), "tenant.preferences_updated", "tenant", req.user.tenant_id, { fields: Object.keys(body) });
      }
    }
    res.json({ ok: true, user: accounts.safeUser(db.get("SELECT * FROM users WHERE id = ?", req.user.id)) });
  });
}

module.exports = { register, inviteHash, newInviteCode, normalizeInviteCode };
