// Files attached to tenants, leases, properties, maintenance requests,
// expenses and move-in/move-out records. Downloads check access every time.
const { decodeUpload, documentView } = require("../services/documents");
const { audit } = require("../services/audit");
const { requirePermission, ctxOf, notFound } = require("./common");

const ENTITY_TABLES = { tenant: "tenants", lease: "leases", building: "buildings", room: "rooms", maintenance: "maintenance_requests", expense: "expenses", move_record: "move_records", charge: "charges", settlement: "deposit_settlements" };
const KINDS = ["lease_document", "id_proof", "photo", "receipt", "payment_proof", "agreement", "other"];

// May this tenant open this document? Only their own records, and only files
// the owner shared (or files they uploaded themselves).
function tenantCanSee(db, user, doc) {
  const tenantId = user.tenant_id;
  if (doc.uploaded_by_user_id === user.id) return true;
  if (!doc.visible_to_tenant) return false;
  switch (doc.entity_type) {
    case "tenant": return doc.entity_id === tenantId;
    case "lease": return Boolean(db.get("SELECT 1 FROM leases WHERE id = ? AND tenant_id = ?", doc.entity_id, tenantId));
    case "charge": return Boolean(db.get("SELECT 1 FROM charges WHERE id = ? AND tenant_id = ?", doc.entity_id, tenantId));
    case "maintenance": return Boolean(db.get("SELECT 1 FROM maintenance_requests WHERE id = ? AND tenant_id = ?", doc.entity_id, tenantId));
    case "move_record": return Boolean(db.get("SELECT 1 FROM move_records WHERE id = ? AND tenant_id = ?", doc.entity_id, tenantId));
    case "settlement": return Boolean(db.get("SELECT 1 FROM deposit_settlements WHERE id = ? AND tenant_id = ?", doc.entity_id, tenantId));
    default: return false;
  }
}

function register(app, { db, docs }) {
  app.get("/api/documents", requirePermission("documents.manage"), (req, res) => {
    const { entityType, entityId } = req.query;
    if (!ENTITY_TABLES[entityType] || !entityId) return res.status(400).json({ error: "entityType and entityId are required." });
    const rows = db.all("SELECT * FROM documents WHERE org_id = ? AND entity_type = ? AND entity_id = ? AND status = 'active' ORDER BY created_at DESC", req.orgId, entityType, String(entityId));
    res.json(rows.map(documentView));
  });

  app.post("/api/documents", requirePermission("documents.manage"), (req, res) => {
    const { entityType, entityId, kind = "other" } = req.body || {};
    const table = ENTITY_TABLES[entityType];
    if (!table || entityType === "charge") return res.status(400).json({ error: "Choose what this document belongs to." });
    if (!KINDS.includes(kind)) return res.status(400).json({ error: "Choose a document type." });
    if (!db.get(`SELECT 1 FROM ${table} WHERE id = ? AND org_id = ?`, String(entityId || ""), req.orgId)) return notFound(res, "Record");
    const upload = decodeUpload(req.body);
    if (!upload) return res.status(400).json({ error: "Upload a valid JPG, PNG, WEBP image or PDF up to 10 MB." });
    const id = docs.save(db, ctxOf(req), { entityType, entityId, kind, upload, visibleToTenant: req.body?.visibleToTenant === true });
    audit(db, ctxOf(req), "document.uploaded", entityType, entityId, { documentId: id, kind });
    res.status(201).json(documentView(db.get("SELECT * FROM documents WHERE id = ?", id)));
  });

  app.put("/api/documents/:id", requirePermission("documents.manage"), (req, res) => {
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ? AND status = 'active'", req.params.id, req.orgId);
    if (!doc) return notFound(res, "Document");
    if (req.body?.visibleToTenant !== undefined) db.run("UPDATE documents SET visible_to_tenant = ? WHERE id = ?", req.body.visibleToTenant ? 1 : 0, doc.id);
    res.json(documentView(db.get("SELECT * FROM documents WHERE id = ?", doc.id)));
  });

  app.delete("/api/documents/:id", requirePermission("documents.manage"), (req, res) => {
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ?", req.params.id, req.orgId);
    if (!doc) return notFound(res, "Document");
    if (doc.kind === "payment_proof" && doc.review_status === "accepted") return res.status(409).json({ error: "This proof supports a recorded payment and is kept." });
    docs.remove(db, req.orgId, doc.id);
    audit(db, ctxOf(req), "document.deleted", doc.entity_type, doc.entity_id, { documentId: doc.id });
    res.json({ ok: true });
  });

  app.get("/api/documents/:id/file", (req, res) => {
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ? AND status = 'active'", req.params.id, req.orgId);
    if (!doc || (req.user.role === "tenant" && !tenantCanSee(db, req.user, doc))) return notFound(res, "Document");
    const file = docs.filePath(doc);
    if (!file) return res.status(404).json({ error: "The file is unavailable." });
    res.type(doc.mime_type);
    res.setHeader("Content-Disposition", `${req.query.download ? "attachment" : "inline"}; filename="${doc.original_name.replace(/["\\\r\n]/g, "")}"`);
    res.sendFile(file);
  });
}

module.exports = { register, tenantCanSee };
