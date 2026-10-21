// Free public page for each property: /p/<slug>.
//
// The owner turns the page on, adds photos and a description, and shares
// the link (WhatsApp, Instagram, Google Business). Visitors see the rooms,
// rent and free beds, and can send an enquiry, which arrives as a lead.
// The page is plain HTML with no scripts, so it loads fast on any phone.
const express = require("express");
const v = require("../lib/validate");
const { toPaise, toRupees, formatInr } = require("../lib/money");
const { audit } = require("../services/audit");
const { decodeUpload } = require("../services/documents");
const occ = require("../services/occupancy");
const upi = require("../services/upi");
const { createRateLimiter } = require("../lib/security");
const { requirePermission, ctxOf, notFound, escapeHtml } = require("./common");

const RESERVED = new Set(["admin", "api", "app", "login", "signup", "p", "www", "static", "assets"]);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const MAX_PHOTOS = 12;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function slugify(text) {
  return String(text || "").toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").replace(/[\s_]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "property";
}

function uniqueSlug(db, base, exceptBuildingId) {
  let slug = SLUG_RE.test(base) ? base : `${base}-home`.slice(0, 60);
  for (let i = 2; db.get("SELECT 1 FROM property_sites WHERE slug = ? AND building_id <> ?", slug, exceptBuildingId || "") || RESERVED.has(slug); i++) slug = `${base}-${i}`.slice(0, 60);
  return slug;
}

function siteView(db, s, b) {
  const photos = db.all("SELECT id, original_name, created_at FROM documents WHERE entity_type = 'building' AND entity_id = ? AND kind = 'site_photo' AND status = 'active' ORDER BY created_at", b.id)
    .map((p) => ({ id: p.id, name: p.original_name, url: s ? `/p/${s.slug}/photo/${p.id}` : "" }));
  return {
    buildingId: b.id, buildingName: b.name, exists: Boolean(s), slug: s?.slug || uniqueSlug(db, slugify(b.name), b.id), published: Boolean(s?.published),
    headline: s?.headline || "", about: s?.about || "", houseRules: s?.house_rules || "", contactName: s?.contact_name || "", contactPhone: s?.contact_phone || "",
    showRent: s ? Boolean(s.show_rent) : true, showVacancy: s ? Boolean(s.show_vacancy) : true, mapLink: s?.map_link || "", gender: s?.gender || "any",
    token: toRupees(s?.token_paise || 0), views: s?.views || 0, path: s ? `/p/${s.slug}` : "", photos,
  };
}

const GENDER = { any: "Everyone welcome", boys: "Boys only", girls: "Girls only", family: "Families" };

function page(title, body, { description = "" } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${description ? `<meta name="description" content="${escapeHtml(description.slice(0, 160))}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description.slice(0, 160))}">` : ""}
<style>
:root{--ink:#1d1d2b;--muted:#5b5b70;--line:#e3e3ec;--bg:#f7f7fb;--card:#fff;--accent:#3b4bd8;--ok:#1d7a4a}
@media (prefers-color-scheme:dark){:root{--ink:#ececf4;--muted:#a3a3b8;--line:#2c2c3a;--bg:#14141c;--card:#1d1d28;--accent:#8f9bff;--ok:#5fd39a}}
*{box-sizing:border-box}body{margin:0;font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);background:var(--bg)}
main{max-width:880px;margin:0 auto;padding:20px 16px 48px}h1{font-size:28px;line-height:1.2;margin:8px 0 4px}h2{font-size:19px;margin:28px 0 10px}
.muted{color:var(--muted)}.chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0}.chip{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:3px 11px;font-size:14px}
.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:8px;margin:16px 0}.photos img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;display:block;background:var(--line)}
.rooms{display:grid;gap:10px}.room{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
.room b{font-size:17px}.free{color:var(--ok);font-weight:600}.price{font-size:18px;font-weight:700;text-align:right;margin-left:auto}@media(max-width:560px){.price{text-align:left;margin-left:0}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}label{display:block;font-size:14px;margin:10px 0 4px;color:var(--muted)}
input,textarea,select{width:100%;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
.btn{display:inline-block;background:var(--accent);color:#fff;border:0;border-radius:8px;padding:11px 18px;font:inherit;font-weight:600;text-decoration:none;cursor:pointer;margin-top:12px}
.btn.alt{background:transparent;color:var(--accent);border:1px solid var(--accent)}.row{display:flex;gap:10px;flex-wrap:wrap}.hp{position:absolute;left:-9999px}
.notice{border-left:4px solid var(--ok);padding:10px 14px;background:var(--card);border-radius:8px;margin:12px 0}pre{white-space:pre-wrap;font:inherit;margin:0}
footer{margin-top:40px;font-size:13px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}@media(max-width:560px){.grid2{grid-template-columns:1fr}h1{font-size:24px}}
</style></head><body><main>${body}</main></body></html>`;
}

function register(app, { db, docs, config, ipOf, todayFor }) {
  const manage = requirePermission("properties.manage");
  const enquiryLimit = createRateLimiter({ windowMs: 60 * 60_000, max: 10 });
  const buildingOf = (req) => db.get("SELECT * FROM buildings WHERE id = ? AND org_id = ?", req.params.buildingId, req.orgId);
  const siteOf = (buildingId) => db.get("SELECT * FROM property_sites WHERE building_id = ?", buildingId);

  // ---------- owner settings ----------
  app.get("/api/sites", (req, res) => {
    res.json(db.all("SELECT * FROM buildings WHERE org_id = ? AND status = 'active' ORDER BY created_at", req.orgId).map((b) => siteView(db, siteOf(b.id), b)));
  });

  app.get("/api/sites/:buildingId", (req, res) => {
    const b = buildingOf(req);
    if (!b) return notFound(res, "Building");
    res.json(siteView(db, siteOf(b.id), b));
  });

  app.put("/api/sites/:buildingId", manage, (req, res) => {
    const b = buildingOf(req);
    if (!b) return notFound(res, "Building");
    const body = req.body || {};
    const existing = siteOf(b.id);
    let slug = existing?.slug || uniqueSlug(db, slugify(b.name), b.id);
    if (body.slug !== undefined && body.slug !== slug) {
      const wanted = String(body.slug || "").trim().toLowerCase();
      if (!SLUG_RE.test(wanted) || RESERVED.has(wanted)) return res.status(400).json({ error: "Use 3–60 small letters, numbers and dashes for the page address, like sunrise-pg-noida." });
      if (db.get("SELECT 1 FROM property_sites WHERE slug = ? AND building_id <> ?", wanted, b.id)) return res.status(409).json({ error: "That page address is taken. Try another." });
      slug = wanted;
    }
    const f = {
      headline: v.text({ label: "Headline", max: 120 })(body.headline ?? existing?.headline),
      about: v.text({ label: "About", max: 3000 })(body.about ?? existing?.about),
      houseRules: v.text({ label: "House rules", max: 2000 })(body.houseRules ?? existing?.house_rules),
      contactName: v.text({ label: "Contact name", max: 80 })(body.contactName ?? existing?.contact_name),
      contactPhone: v.mobile({ label: "Contact phone" })(body.contactPhone ?? existing?.contact_phone),
      mapLink: (() => {
        const raw = String(body.mapLink ?? existing?.map_link ?? "").trim();
        if (!raw) return "";
        try { const u = new URL(raw); if (!["https:", "http:"].includes(u.protocol)) throw new Error(); return u.toString().slice(0, 500); } catch { throw new v.ValidationError("Paste a full map link starting with https://"); }
      })(),
      gender: ["any", "boys", "girls", "family"].includes(body.gender) ? body.gender : existing?.gender || "any",
      showRent: body.showRent !== undefined ? v.bool()(body.showRent) : existing ? Boolean(existing.show_rent) : true,
      showVacancy: body.showVacancy !== undefined ? v.bool()(body.showVacancy) : existing ? Boolean(existing.show_vacancy) : true,
      published: body.published !== undefined ? v.bool()(body.published) : Boolean(existing?.published),
      token: body.token !== undefined ? toPaise(v.money("Token amount")(body.token)) : existing?.token_paise || 0,
    };
    if (existing) {
      db.run(`UPDATE property_sites SET slug = ?, published = ?, headline = ?, about = ?, house_rules = ?, contact_name = ?, contact_phone = ?, show_rent = ?, show_vacancy = ?, map_link = ?, gender = ?, token_paise = ?, updated_at = ? WHERE building_id = ?`,
        slug, f.published ? 1 : 0, f.headline, f.about, f.houseRules, f.contactName, f.contactPhone, f.showRent ? 1 : 0, f.showVacancy ? 1 : 0, f.mapLink, f.gender, f.token, db.nowIso(), b.id);
    } else {
      db.run(`INSERT INTO property_sites (building_id, org_id, slug, published, headline, about, house_rules, contact_name, contact_phone, show_rent, show_vacancy, map_link, gender, token_paise, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        b.id, req.orgId, slug, f.published ? 1 : 0, f.headline, f.about, f.houseRules, f.contactName, f.contactPhone, f.showRent ? 1 : 0, f.showVacancy ? 1 : 0, f.mapLink, f.gender, f.token, db.nowIso());
    }
    audit(db, ctxOf(req), "site.updated", "building", b.id, { published: f.published, slug });
    res.json(siteView(db, siteOf(b.id), b));
  });

  app.post("/api/sites/:buildingId/photos", manage, (req, res) => {
    const b = buildingOf(req);
    if (!b) return notFound(res, "Building");
    if (!siteOf(b.id)) return res.status(400).json({ error: "Save the page settings first." });
    const upload = decodeUpload(req.body);
    if (!upload || !PHOTO_TYPES.includes(upload.mimeType)) return res.status(400).json({ error: "Upload a JPG, PNG or WEBP photo up to 10 MB." });
    if (db.get("SELECT COUNT(*) AS n FROM documents WHERE entity_type = 'building' AND entity_id = ? AND kind = 'site_photo' AND status = 'active'", b.id).n >= MAX_PHOTOS) return res.status(400).json({ error: `A page can have up to ${MAX_PHOTOS} photos.` });
    docs.save(db, ctxOf(req), { entityType: "building", entityId: b.id, kind: "site_photo", upload });
    res.status(201).json(siteView(db, siteOf(b.id), b));
  });

  app.delete("/api/sites/:buildingId/photos/:docId", manage, (req, res) => {
    const b = buildingOf(req);
    if (!b) return notFound(res, "Building");
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND org_id = ? AND entity_type = 'building' AND entity_id = ? AND kind = 'site_photo'", req.params.docId, req.orgId, b.id);
    if (doc) docs.remove(db, req.orgId, doc.id);
    res.json(siteView(db, siteOf(b.id), b));
  });

  // ---------- the public page ----------
  const publicSite = (slug) => {
    const s = db.get("SELECT * FROM property_sites WHERE slug = ? AND published = 1", String(slug || "").toLowerCase());
    if (!s) return null;
    const b = db.get("SELECT * FROM buildings WHERE id = ? AND status = 'active'", s.building_id);
    return b ? { s, b } : null;
  };
  const notFoundPage = (res) => res.status(404).type("html").send(page("Page not found", `<h1>This page isn't available</h1><p class="muted">The property page may have been turned off.</p>`));

  app.get("/p/:slug", (req, res) => {
    const found = publicSite(req.params.slug);
    if (!found) return notFoundPage(res);
    const { s, b } = found;
    db.run("UPDATE property_sites SET views = views + 1 WHERE building_id = ?", b.id);
    const view = siteView(db, s, b);
    const o = occ.occupancy(db, b.org_id, { buildingId: b.id }).buildings[0];
    const amenities = (() => { try { return JSON.parse(b.amenities_json || "[]"); } catch { return []; } })();
    const rooms = (o?.floors || []).flatMap((f) => f.rooms).filter((r) => r.status !== "disabled");
    // Group similar rooms: same sharing, rent and tags.
    const groups = new Map();
    for (const r of rooms) {
      const live = r.beds.filter((x) => x.status !== "disabled");
      const key = `${r.sharing}|${r.monthlyRent}|${r.tags.join(",")}`;
      const g = groups.get(key) || { sharing: r.sharing, rent: Math.min(...live.map((x) => x.monthlyRent)), tags: r.tags, rooms: 0, free: 0 };
      g.rooms++;
      g.free += live.filter((x) => x.status === "vacant").length;
      groups.set(key, g);
    }
    const roomRows = [...groups.values()].sort((a, b2) => a.rent - b2.rent).map((g) => `<div class="room"><div><b>${escapeHtml(g.sharing)}</b>${g.tags.length ? `<div class="chips">${g.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}${s.show_vacancy ? `<div class="${g.free ? "free" : "muted"}">${g.free ? `${g.free} bed${g.free === 1 ? "" : "s"} free now` : "Full right now — ask about upcoming vacancies"}</div>` : ""}</div>${s.show_rent ? `<div class="price">${formatInr(toPaise(g.rent))}<div class="muted" style="font-size:13px;font-weight:400">per month, per bed</div></div>` : ""}</div>`).join("");
    const phone = s.contact_phone;
    const wa = phone ? `https://wa.me/${phone.replace(/\D/g, "").replace(/^(\d{10})$/, "91$1")}?text=${encodeURIComponent(`Hello, I saw ${b.name} on your page and would like to know more.`)}` : "";
    const payee = s.token_paise > 0 ? upi.payeeFor(db, b.org_id) : null;
    const token = payee ? `<h2>Reserve a bed</h2><div class="card"><p>Pay a token of <b>${formatInr(s.token_paise)}</b> to hold a bed. Pay by UPI to <b>${escapeHtml(payee.vpa)}</b> (${escapeHtml(payee.name)}), then send us the payment screenshot${phone ? " on WhatsApp" : ""}. The token is adjusted against your first bills.</p>
      <a class="btn" href="${escapeHtml(upi.buildUri({ vpa: payee.vpa, name: payee.name, amountPaise: s.token_paise, note: `Token ${b.name}`.slice(0, 50) }))}">Pay token with a UPI app</a></div>` : "";
    const sent = req.query.sent === "1" ? `<div class="notice">Thank you! Your enquiry was sent. ${escapeHtml(s.contact_name || "The owner")} will contact you soon.</div>` : "";
    const err = req.query.error ? `<div class="notice" style="border-color:#c0392b">Please enter your name and a 10-digit mobile number.</div>` : "";
    const description = s.headline || `${b.name}${b.address ? `, ${b.address}` : ""}`;
    res.type("html").send(page(`${b.name}${s.headline ? ` – ${s.headline}` : ""}`, `
      ${sent}${err}
      <p class="muted" style="margin:0">${escapeHtml(GENDER[s.gender])}</p>
      <h1>${escapeHtml(b.name)}</h1>
      ${s.headline ? `<p style="font-size:18px;margin:4px 0">${escapeHtml(s.headline)}</p>` : ""}
      ${b.address ? `<p class="muted">${escapeHtml(b.address)}${s.map_link ? ` · <a href="${escapeHtml(s.map_link)}" target="_blank" rel="noopener">Open in maps</a>` : ""}</p>` : ""}
      <div class="row">${wa ? `<a class="btn" href="${escapeHtml(wa)}" target="_blank" rel="noopener">Chat on WhatsApp</a>` : ""}${phone ? `<a class="btn alt" href="tel:${escapeHtml(phone)}">Call ${escapeHtml(s.contact_name || "")}</a>` : ""}<a class="btn alt" href="#enquire">Book a visit</a></div>
      ${view.photos.length ? `<div class="photos">${view.photos.map((p) => `<img src="${escapeHtml(p.url)}" alt="Photo of ${escapeHtml(b.name)}" loading="lazy">`).join("")}</div>` : ""}
      ${amenities.length ? `<h2>Amenities</h2><div class="chips">${amenities.map((a) => `<span class="chip">${escapeHtml(a)}</span>`).join("")}</div>` : ""}
      ${s.about ? `<h2>About</h2><pre>${escapeHtml(s.about)}</pre>` : ""}
      ${roomRows ? `<h2>Rooms</h2><div class="rooms">${roomRows}</div>` : ""}
      ${s.house_rules ? `<h2>House rules</h2><pre>${escapeHtml(s.house_rules)}</pre>` : ""}
      ${token}
      <h2 id="enquire">Book a visit or ask a question</h2>
      <form class="card" method="post" action="/p/${escapeHtml(s.slug)}/enquire">
        <div class="grid2"><div><label for="n">Your name *</label><input id="n" name="name" required maxlength="120" autocomplete="name"></div>
        <div><label for="m">Mobile number *</label><input id="m" name="mobile" required inputmode="tel" maxlength="15" autocomplete="tel"></div>
        <div><label for="v">Visit date</label><input id="v" type="date" name="visitOn" min="${escapeHtml(todayFor({ orgId: b.org_id }))}"></div>
        <div><label for="w">Move-in from</label><input id="w" type="date" name="moveInFrom"></div></div>
        <label for="q">What are you looking for?</label><textarea id="q" name="message" rows="3" maxlength="600" placeholder="For example: single room with AC from next month"></textarea>
        <input class="hp" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
        <button class="btn" type="submit">Send</button>
      </form>
      <footer class="muted">Page made with Rent Ledger.</footer>`, { description }));
  });

  app.get("/p/:slug/photo/:docId", (req, res) => {
    const found = publicSite(req.params.slug);
    if (!found) return res.status(404).end();
    const doc = db.get("SELECT * FROM documents WHERE id = ? AND entity_type = 'building' AND entity_id = ? AND kind = 'site_photo' AND status = 'active'", req.params.docId, found.b.id);
    const file = doc && docs.filePath(doc);
    if (!file) return res.status(404).end();
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.type(doc.mime_type).sendFile(file);
  });

  app.post("/p/:slug/enquire", express.urlencoded({ extended: false, limit: "10kb" }), (req, res) => {
    const found = publicSite(req.params.slug);
    if (!found) return notFoundPage(res);
    const { s, b } = found;
    const back = `/p/${s.slug}`;
    // Bots fill the hidden field; pretend it worked.
    if (req.body?.website) return res.redirect(303, `${back}?sent=1#enquire`);
    if (!enquiryLimit.hit(`${ipOf(req)}:${s.slug}`).allowed) return res.status(429).type("html").send(page("Too many enquiries", `<h1>Please try again later</h1><p><a href="${escapeHtml(back)}">Back</a></p>`));
    let name, mobile, visitOn, moveInFrom, message;
    try {
      name = v.text({ label: "Name", max: 120, required: true })(req.body?.name);
      mobile = v.mobile({ label: "Mobile", required: true })(req.body?.mobile);
      visitOn = v.date({ label: "Visit date" })(req.body?.visitOn);
      moveInFrom = v.date({ label: "Move-in" })(req.body?.moveInFrom);
      message = v.text({ label: "Message", max: 600 })(req.body?.message);
    } catch {
      return res.redirect(303, `${back}?error=1#enquire`);
    }
    const id = db.id();
    db.run(`INSERT INTO leads (id, org_id, building_id, name, mobile, source, stage, visit_on, move_in_from, preference, notes, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, b.org_id, b.id, name, mobile, "website", visitOn ? "visit_scheduled" : "new", visitOn, moveInFrom, message.slice(0, 200), message, db.nowIso());
    db.run("INSERT INTO lead_events (id, org_id, lead_id, kind, body, created_at) VALUES (?,?,?,?,?,?)", db.id(), b.org_id, id, "created", `Enquiry from the property page${message ? `: ${message}` : ""}`, db.nowIso());
    app.locals.newWebsiteLead?.(b.org_id, b.name, name);
    res.redirect(303, `${back}?sent=1#enquire`);
  });

  void config;
}

module.exports = { register, slugify };
