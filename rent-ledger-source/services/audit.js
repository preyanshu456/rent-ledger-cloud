// Append-only audit trail of sensitive actions. Details must not contain
// passwords, tokens or full ID numbers.
function audit(db, ctx = {}, action, entityType = null, entityId = null, details = {}) {
  db.run(
    "INSERT INTO audit_log (org_id, actor_user_id, actor_role, action, entity_type, entity_id, details_json, request_id, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ctx.orgId || null, ctx.userId || null, ctx.role || null, action, entityType, entityId, JSON.stringify(details || {}), ctx.requestId || null, db.nowIso(),
  );
}

function listAudit(db, orgId, { limit = 200, entityType, entityId, before } = {}) {
  const where = ["org_id = :orgId"];
  const params = { orgId };
  if (entityType) { where.push("entity_type = :entityType"); params.entityType = entityType; }
  if (entityId) { where.push("entity_id = :entityId"); params.entityId = entityId; }
  if (before) { where.push("id < :before"); params.before = Number(before); }
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  return db.all(`SELECT a.*, u.name AS actor_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor_user_id WHERE ${where.map((w) => `a.${w}`).join(" AND ")} ORDER BY a.id DESC LIMIT ${n}`, params)
    .map((r) => ({ ...r, details: JSON.parse(r.details_json || "{}") }));
}

module.exports = { audit, listAudit };
