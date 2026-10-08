// Hindi (Devanagari) text and the ₹ sign in PDFs.
//
// The built-in PDF fonts only cover Western letters, so names written in
// Hindi used to print as "???". This module embeds Noto Sans Devanagari
// (fonts/, SIL Open Font License) and uses HarfBuzz to arrange the letters
// and vowel signs correctly. Only the glyphs a PDF actually uses are
// embedded, so a bill grows by a few kilobytes, not the whole font.
//
// HarfBuzz loads asynchronously; `ready` resolves when it can be used.
// If anything fails to load, `available()` stays false and the PDF writer
// falls back to its old behaviour (Rs. and "?").
const fs = require("node:fs");
const path = require("node:path");

const FONT_DIR = path.join(__dirname, "..", "fonts");
const FILES = { regular: "NotoSansDevanagari-Regular.ttf", bold: "NotoSansDevanagari-Bold.ttf" };
const state = { hb: null, fonts: {}, error: null };

// ---------- TrueType reading ----------
function parseFont(buf) {
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables[buf.toString("latin1", rec, rec + 4)] = { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) };
  }
  const t = (tag) => tables[tag] && buf.subarray(tables[tag].offset, tables[tag].offset + tables[tag].length);
  const head = t("head"), hhea = t("hhea"), maxp = t("maxp"), hmtx = t("hmtx"), loca = t("loca"), glyf = t("glyf"), os2 = t("OS/2");
  const unitsPerEm = head.readUInt16BE(18);
  const bbox = [head.readInt16BE(36), head.readInt16BE(38), head.readInt16BE(40), head.readInt16BE(42)];
  const longLoca = head.readInt16BE(50) === 1;
  const numGlyphs = maxp.readUInt16BE(4);
  const numHMetrics = hhea.readUInt16BE(34);
  const advances = new Array(numGlyphs);
  for (let g = 0; g < numGlyphs; g++) advances[g] = hmtx.readUInt16BE(4 * Math.min(g, numHMetrics - 1));
  const offsets = new Array(numGlyphs + 1);
  for (let g = 0; g <= numGlyphs; g++) offsets[g] = longLoca ? loca.readUInt32BE(g * 4) : loca.readUInt16BE(g * 2) * 2;
  return {
    buf, tables, unitsPerEm, bbox, numGlyphs, advances, offsets, glyf,
    ascent: hhea.readInt16BE(4), descent: hhea.readInt16BE(6),
    capHeight: os2 && os2.length >= 90 ? os2.readInt16BE(88) : Math.round(unitsPerEm * 0.7),
  };
}

// Glyphs a composite glyph is built from.
function components(font, gid) {
  const start = font.offsets[gid], end = font.offsets[gid + 1];
  if (end <= start) return [];
  const g = font.glyf.subarray(start, end);
  if (g.readInt16BE(0) >= 0) return [];
  const out = [];
  let p = 10;
  for (;;) {
    const flags = g.readUInt16BE(p);
    out.push(g.readUInt16BE(p + 2));
    p += 4 + (flags & 0x0001 ? 4 : 2);
    if (flags & 0x0008) p += 2; else if (flags & 0x0040) p += 4; else if (flags & 0x0080) p += 8;
    if (!(flags & 0x0020)) break;
  }
  return out;
}

function checksum(data) {
  const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + padded.readUInt32BE(i)) >>> 0;
  return sum;
}

// A copy of the font that keeps glyph numbers but only the outlines of the
// glyphs in `used` (others are left empty). Layout tables are dropped; the
// PDF already has the glyphs in the right places.
function subset(font, used) {
  const keep = new Set([0, ...used]);
  const queue = [...keep];
  while (queue.length) for (const c of components(font, queue.pop())) if (!keep.has(c)) { keep.add(c); queue.push(c); }
  const parts = [];
  const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
  let pos = 0;
  for (let g = 0; g < font.numGlyphs; g++) {
    loca.writeUInt32BE(pos, g * 4);
    if (keep.has(g)) {
      const data = font.glyf.subarray(font.offsets[g], font.offsets[g + 1]);
      const pad = Buffer.alloc((4 - (data.length % 4)) % 4);
      parts.push(data, pad);
      pos += data.length + pad.length;
    }
  }
  loca.writeUInt32BE(pos, font.numGlyphs * 4);
  const src = (tag) => Buffer.from(font.buf.subarray(font.tables[tag].offset, font.tables[tag].offset + font.tables[tag].length));
  const head = src("head");
  head.writeUInt32BE(0, 8); // checksumAdjustment, set below
  head.writeInt16BE(1, 50); // long loca offsets
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0); // version 3: no glyph names
  const tables = { head, hhea: src("hhea"), maxp: src("maxp"), hmtx: src("hmtx"), loca, glyf: Buffer.concat(parts), post };
  for (const tag of ["OS/2", "cmap", "name"]) if (font.tables[tag]) tables[tag] = src(tag);
  const tags = Object.keys(tables).sort();
  const n = tags.length;
  const entrySelector = Math.floor(Math.log2(n));
  const header = Buffer.alloc(12 + 16 * n);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(n, 4);
  header.writeUInt16BE(16 * 2 ** entrySelector, 6);
  header.writeUInt16BE(entrySelector, 8);
  header.writeUInt16BE(16 * n - 16 * 2 ** entrySelector, 10);
  let offset = header.length;
  const bodies = [];
  tags.forEach((tag, i) => {
    const data = tables[tag];
    const rec = 12 + i * 16;
    header.write(tag.padEnd(4, " "), rec, 4, "latin1");
    header.writeUInt32BE(checksum(data), rec + 4);
    header.writeUInt32BE(offset, rec + 8);
    header.writeUInt32BE(data.length, rec + 12);
    const padded = Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]);
    bodies.push(padded);
    offset += padded.length;
  });
  const out = Buffer.concat([header, ...bodies]);
  const headOffset = header.readUInt32BE(12 + tags.indexOf("head") * 16 + 8);
  out.writeUInt32BE((0xB1B0AFBA - checksum(out)) >>> 0, headOffset + 8);
  return out;
}

// ---------- loading ----------
const ready = (async () => {
  try {
    const hb = await import("harfbuzzjs");
    for (const [weight, file] of Object.entries(FILES)) {
      const bytes = fs.readFileSync(path.join(FONT_DIR, file));
      const face = new hb.Face(new hb.Blob(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)));
      state.fonts[weight] = {
        name: file.replace(/\.ttf$/, ""),
        info: parseFont(bytes),
        hbFont: new hb.Font(face),
        covers: new Set(face.collectUnicodes()),
        shapes: new Map(),
      };
    }
    state.hb = hb;
  } catch (err) {
    state.error = err;
  }
})();

const available = () => Boolean(state.hb);
const covers = (codePoint) => available() && state.fonts.regular.covers.has(codePoint);

// Glyphs for a run of Hindi text, in font units (1000 per em).
// Each glyph: { gid, ax, dx, dy, text } — text is set on the first glyph of
// each letter cluster, for copying and searching in the PDF.
function shape(text, bold = false) {
  const font = state.fonts[bold ? "bold" : "regular"];
  const cached = font.shapes.get(text);
  if (cached) return cached;
  const points = [...text].map((ch) => ch.codePointAt(0));
  const buffer = new state.hb.Buffer();
  buffer.addCodePoints(points);
  buffer.guessSegmentProperties();
  state.hb.shape(font.hbFont, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  const scale = 1000 / font.info.unitsPerEm;
  const clusterStarts = [...new Set(infos.map((g) => g.cluster))].sort((a, b) => a - b);
  const clusterText = (c) => { const next = clusterStarts.find((s) => s > c) ?? points.length; return String.fromCodePoint(...points.slice(c, next)); };
  const seen = new Set();
  const glyphs = infos.map((g, i) => {
    const first = !seen.has(g.cluster);
    seen.add(g.cluster);
    return { gid: g.codepoint, ax: positions[i].xAdvance * scale, dx: positions[i].xOffset * scale, dy: positions[i].yOffset * scale, text: first ? clusterText(g.cluster) : "" };
  });
  const result = { glyphs, width: glyphs.reduce((s, g) => s + g.ax, 0) };
  if (font.shapes.size > 2000) font.shapes.clear();
  font.shapes.set(text, result);
  return result;
}

// PDF objects for one embedded weight. `add` appends an object and returns
// its number; `stream` builds a compressed stream object body.
function pdfFontObjects(bold, used, add, stream) {
  const font = state.fonts[bold ? "bold" : "regular"];
  const info = font.info;
  const tag = `${bold ? "RLBDVB" : "RLBDVA"}+${font.name}`;
  const gids = [...used.keys()].sort((a, b) => a - b);
  const scale = 1000 / info.unitsPerEm;
  const fontFile = subset(info, gids);
  const file = add(stream(fontFile, `/Length1 ${fontFile.length}`));
  const descriptor = add(`<< /Type /FontDescriptor /FontName /${tag} /Flags 4 /FontBBox [${info.bbox.map((v) => Math.round(v * scale)).join(" ")}] /ItalicAngle 0 /Ascent ${Math.round(info.ascent * scale)} /Descent ${Math.round(info.descent * scale)} /CapHeight ${Math.round(info.capHeight * scale)} /StemV ${bold ? 120 : 80} /FontFile2 ${file} 0 R >>`);
  const widths = gids.map((g) => `${g} [${Math.round(info.advances[g] * scale)}]`).join(" ");
  const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${tag} /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /CIDToGIDMap /Identity /DW 1000 /W [${widths}] >>`);
  const hex4 = (n) => n.toString(16).padStart(4, "0").toUpperCase();
  const utf16hex = (s) => [...s].map((ch) => { const c = ch.codePointAt(0); return c > 0xFFFF ? hex4(0xD800 + ((c - 0x10000) >> 10)) + hex4(0xDC00 + ((c - 0x10000) & 0x3FF)) : hex4(c); }).join("");
  const mapped = gids.filter((g) => used.get(g));
  const blocks = [];
  for (let i = 0; i < mapped.length; i += 100) {
    const chunk = mapped.slice(i, i + 100);
    blocks.push(`${chunk.length} beginbfchar\n${chunk.map((g) => `<${hex4(g)}> <${utf16hex(used.get(g))}>`).join("\n")}\nendbfchar`);
  }
  const cmap = `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${blocks.join("\n")}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
  const toUnicode = add(stream(Buffer.from(cmap, "latin1")));
  return add(`<< /Type /Font /Subtype /Type0 /BaseFont /${tag} /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
}

module.exports = { ready, available, covers, shape, pdfFontObjects, subset, parseFont };
