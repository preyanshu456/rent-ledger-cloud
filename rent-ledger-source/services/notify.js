// In-app notifications (the bell). Always available; no provider needed.
function notify(db, { orgId, userId, kind, title, body = "", link = "" }) {
  db.run("INSERT INTO notifications (id, org_id, user_id, kind, title, body, link, created_at) VALUES (?,?,?,?,?,?,?,?)",
    db.id(), orgId, userId, kind, String(title).slice(0, 200), String(body).slice(0, 1000), String(link).slice(0, 200), db.nowIso());
}

// Notify every owner/manager of an organisation.
function notifyStaff(db, orgId, payload, { ownersOnly = false } = {}) {
  const staff = db.all(`SELECT id FROM users WHERE org_id = ? AND role IN (${ownersOnly ? "'owner'" : "'owner','manager'"}) AND disabled_at IS NULL`, orgId);
  for (const u of staff) notify(db, { ...payload, orgId, userId: u.id });
  return staff.length;
}

module.exports = { notify, notifyStaff };
