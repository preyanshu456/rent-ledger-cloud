// File storage for payment proofs, lease documents, maintenance photos,
// expense receipts and move-in/move-out photos. Files live in
// DATA_DIR/documents with random names; access always goes through
// GET /api/documents/:id/file, which checks the organisation and, for
// tenants, that the file is theirs or shared with them.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TYPES = new Map([
  ["image/jpeg", ".jpg"], ["image/png", ".png"], ["image/webp", ".webp"], ["application/pdf", ".pdf"],
]);
const MAX_BYTES = 10 * 1024 * 1024;

function validSignature(mimeType, bytes) {
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/webp") return bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  return mimeType === "application/pdf" && bytes.subarray(0, 5).toString() === "%PDF-";
}

// Base64 JSON uploads (no multipart dependency). Returns null when invalid.
function decodeUpload(payload) {
  const { data, mimeType, originalName } = payload || {};
  if (!TYPES.has(mimeType) || typeof data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 !== 0) return null;
  const bytes = Buffer.from(data, "base64");
  if (!bytes.length || bytes.length > MAX_BYTES || !validSignature(mimeType, bytes)) return null;
  return { bytes, mimeType, originalName: path.basename(String(originalName || "document")).replace(/[\r\n"\\]/g, "").slice(0, 120) };
}

function createDocumentStore(dataDir) {
  const dir = path.join(dataDir, "documents");
  const legacyDir = path.join(dataDir, "receipts");
  return {
    dir,
    save(db, ctx, { entityType, entityId, kind, upload, visibleToTenant = false, reviewStatus = null }) {
      const id = db.id();
      const fileName = `${crypto.randomUUID()}${TYPES.get(upload.mimeType)}`;
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, fileName), upload.bytes, { flag: "wx", mode: 0o600 });
      db.run(`INSERT INTO documents (id, org_id, entity_type, entity_id, kind, file_name, original_name, mime_type, size_bytes, visible_to_tenant, review_status, uploaded_by_user_id, uploaded_by_role, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id, ctx.orgId, entityType, entityId, kind, fileName, upload.originalName, upload.mimeType, upload.bytes.length, visibleToTenant ? 1 : 0, reviewStatus, ctx.userId || null, ctx.role || null, db.nowIso());
      return id;
    },
    filePath(doc) {
      const name = path.basename(doc.file_name);
      const current = path.join(dir, name);
      if (fs.existsSync(current)) return current;
      const legacy = path.join(legacyDir, name); // files uploaded before Stage 3
      return fs.existsSync(legacy) ? legacy : null;
    },
    // Soft delete: the record stays (with who/when), the file is removed.
    remove(db, orgId, docId) {
      const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ?", docId, orgId);
      if (!doc || doc.status !== "active") return false;
      db.run("UPDATE documents SET status = 'deleted', deleted_at = ? WHERE id = ?", db.nowIso(), doc.id);
      const file = this.filePath(doc);
      if (file) fs.unlinkSync(file);
      return true;
    },
  };
}

function documentView(d) {
  return {
    id: d.id, entityType: d.entity_type, entityId: d.entity_id, kind: d.kind, originalName: d.original_name, mimeType: d.mime_type,
    size: d.size_bytes, visibleToTenant: Boolean(d.visible_to_tenant), reviewStatus: d.review_status || null, uploadedByRole: d.uploaded_by_role,
    createdAt: d.created_at,
  };
}

module.exports = { createDocumentStore, decodeUpload, documentView, TYPES, MAX_BYTES };
