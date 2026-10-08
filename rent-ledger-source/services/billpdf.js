// A small PDF writer: A4 pages, text, lines and boxes; the output opens in
// any PDF viewer or phone. Western text uses the two built-in Helvetica fonts.
// Hindi (Devanagari) text and "₹" use an embedded Noto Sans Devanagari font
// (see unifont.js); if that can't load, "₹" is written as "Rs." and letters
// from other scripts are replaced with "?".
const zlib = require("node:zlib");
const unifont = require("./unifont");

const A4 = { width: 595.28, height: 841.89 };

// Character widths (1/1000 of the font size) for codes 32-126, from the
// standard Adobe font metrics.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
  556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
  667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
  611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];
// Characters outside plain ASCII that the built-in fonts have: [code, regular width, bold width].
const EXTRA = {
  "•": [0x95, 350, 350], "–": [0x96, 556, 556], "—": [0x97, 1000, 1000], "…": [0x85, 1000, 1000],
  "‘": [0x91, 222, 278], "’": [0x92, 222, 278], "“": [0x93, 333, 500], "”": [0x94, 333, 500],
  "·": [0xB7, 278, 278], "×": [0xD7, 584, 584], " ": [0xA0, 278, 278],
};
const REPLACE = [[/→/g, "->"], [/[‐‑−]/g, "-"], [/[​﻿]/g, ""], [/[\r\n\t]+/g, " "]];
const JOINERS = /[‌‍]/g; // zero-width (non-)joiner: only meaningful inside Hindi text

function buildWidths(ascii, bold) {
  const w = new Array(256).fill(556);
  ascii.forEach((value, i) => { w[32 + i] = value; });
  for (const [code, regular, heavy] of Object.values(EXTRA)) w[code] = bold ? heavy : regular;
  // Accented Latin letters (é, ñ, ü…) are as wide as their plain letter.
  for (let code = 0xC0; code <= 0xFF; code++) {
    const base = String.fromCharCode(code).normalize("NFD")[0];
    if (base && base.charCodeAt(0) >= 32 && base.charCodeAt(0) <= 126) w[code] = ascii[base.charCodeAt(0) - 32];
  }
  return w;
}
const WIDTHS = { regular: buildWidths(HELVETICA, false), bold: buildWidths(HELVETICA_BOLD, true) };

// Unicode text -> the form the page is drawn from: Western characters become
// one byte each in the Helvetica fonts' encoding (codes below 256); Hindi
// letters and "₹" stay as they are (codes 256 and up) for the embedded font.
function encode(text) {
  let s = String(text ?? "");
  for (const [re, to] of REPLACE) s = s.replace(re, to);
  const unicode = unifont.available();
  if (!unicode) s = s.replace(/₹\s?/g, "Rs. ").replace(JOINERS, "");
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const code = ch.codePointAt(0);
    if (code >= 32 && code <= 126) out += ch;
    else if (EXTRA[ch]) out += String.fromCharCode(EXTRA[ch][0]);
    else if (code >= 0xA1 && code <= 0xFF) out += ch;
    else if (code < 32) continue;
    else if (unicode && (unifont.covers(code) || code === 0x200C || code === 0x200D)) out += ch;
    else out += "?";
  }
  return out;
}

// Splits drawn text into Helvetica parts and embedded-font parts.
function runs(encoded) {
  const out = [];
  for (const ch of encoded) {
    const uni = ch.codePointAt(0) > 0xFF;
    const last = out[out.length - 1];
    if (last && last.uni === uni) last.text += ch; else out.push({ uni, text: ch });
  }
  return out;
}

function widthOf(encoded, size, bold = false) {
  const table = bold ? WIDTHS.bold : WIDTHS.regular;
  let total = 0;
  for (const run of runs(encoded)) {
    if (run.uni) total += unifont.shape(run.text, bold).width;
    else for (let i = 0; i < run.text.length; i++) total += table[run.text.charCodeAt(i)];
  }
  return (total * size) / 1000;
}

function pdfString(encoded) {
  return `(${encoded.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

const num = (n) => (Math.round(n * 100) / 100).toString();
const rgb = (c) => (c || [0, 0, 0]).map((v) => num(v / 255)).join(" ");

class Page {
  constructor(doc) {
    this.doc = doc;
    this.ops = [];
  }

  // y is measured from the top of the page to the text's baseline.
  text(value, x, y, opts = {}) {
    return this.drawEncoded(encode(value), x, y, opts);
  }

  drawEncoded(encoded, x, y, { size = 10, bold = false, color, align = "left", maxWidth } = {}) {
    let s = encoded;
    if (maxWidth && widthOf(s, size, bold) > maxWidth) s = truncate(s, maxWidth, size, bold);
    if (!s) return 0;
    const w = widthOf(s, size, bold);
    let pen = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
    const base = this.doc.height - y;
    const parts = [];
    for (const run of runs(s)) {
      if (!run.uni) {
        parts.push(`/${bold ? "F2" : "F1"} ${num(size)} Tf 1 0 0 1 ${num(pen)} ${num(base)} Tm ${pdfString(run.text)} Tj`);
        pen += widthOf(run.text, size, bold);
        continue;
      }
      // Each Hindi glyph is placed where HarfBuzz put it (vowel signs sit above,
      // below or before their letter).
      const used = this.doc.unicodeGlyphs[bold ? "bold" : "regular"];
      parts.push(`/${bold ? "F4" : "F3"} ${num(size)} Tf`);
      for (const g of unifont.shape(run.text, bold).glyphs) {
        if (!used.has(g.gid) || (g.text && !used.get(g.gid))) used.set(g.gid, g.text || used.get(g.gid) || "");
        parts.push(`1 0 0 1 ${num(pen + (g.dx * size) / 1000)} ${num(base + (g.dy * size) / 1000)} Tm <${g.gid.toString(16).padStart(4, "0")}> Tj`);
        pen += (g.ax * size) / 1000;
      }
    }
    this.ops.push(`BT ${rgb(color)} rg ${parts.join(" ")} ET`);
    return w;
  }

  // Wraps text to maxWidth; returns the y below the last line.
  paragraph(value, x, y, { size = 10, bold = false, color, maxWidth, lineHeight = size * 1.35, maxLines = 40 } = {}) {
    const lines = wrap(value, maxWidth, size, bold).slice(0, maxLines);
    lines.forEach((line, i) => this.drawEncoded(line, x, y + i * lineHeight, { size, bold, color }));
    return y + lines.length * lineHeight;
  }

  line(x1, y1, x2, y2, { color = [210, 210, 220], width = 0.75 } = {}) {
    const H = this.doc.height;
    this.ops.push(`${rgb(color)} RG ${num(width)} w ${num(x1)} ${num(H - y1)} m ${num(x2)} ${num(H - y2)} l S`);
  }

  // x, y = top-left corner.
  rect(x, y, w, h, { fill, stroke, width = 0.75, radius = 0 } = {}) {
    const H = this.doc.height;
    const top = H - y;
    const bottom = H - y - h;
    let path;
    if (radius > 0) {
      const r = Math.min(radius, w / 2, h / 2);
      const k = r * 0.5523;
      path = [
        `${num(x + r)} ${num(bottom)} m`, `${num(x + w - r)} ${num(bottom)} l`,
        `${num(x + w - r + k)} ${num(bottom)} ${num(x + w)} ${num(bottom + r - k)} ${num(x + w)} ${num(bottom + r)} c`,
        `${num(x + w)} ${num(top - r)} l`,
        `${num(x + w)} ${num(top - r + k)} ${num(x + w - r + k)} ${num(top)} ${num(x + w - r)} ${num(top)} c`,
        `${num(x + r)} ${num(top)} l`,
        `${num(x + r - k)} ${num(top)} ${num(x)} ${num(top - r + k)} ${num(x)} ${num(top - r)} c`,
        `${num(x)} ${num(bottom + r)} l`,
        `${num(x)} ${num(bottom + r - k)} ${num(x + r - k)} ${num(bottom)} ${num(x + r)} ${num(bottom)} c`, "h",
      ].join(" ");
    } else {
      path = `${num(x)} ${num(bottom)} ${num(w)} ${num(h)} re`;
    }
    const paint = fill && stroke ? "B" : fill ? "f" : "S";
    this.ops.push(`${fill ? `${rgb(fill)} rg ` : ""}${stroke ? `${rgb(stroke)} RG ${num(width)} w ` : ""}${path} ${paint}`);
  }
}

function truncate(encoded, maxWidth, size, bold) {
  const dots = String.fromCharCode(0x85);
  let s = [...encoded];
  while (s.length > 1 && widthOf(s.join("") + dots, size, bold) > maxWidth) s.pop();
  // Don't end on a Hindi vowel sign or virama cut off from its letter.
  while (s.length > 1 && /[\u0900-\u0903\u093A-\u094F\u0951-\u0957\u0962\u0963\u200C\u200D]/.test(s[s.length - 1])) s.pop();
  return s.join("").trimEnd() + dots;
}

// Splits text into lines no wider than maxWidth (long words are cut).
// Returns lines already encoded for the fonts.
function wrap(value, maxWidth, size, bold = false) {
  const out = [];
  for (const para of String(value ?? "").split(/\r?\n/)) {
    const words = encode(para).split(" ").filter(Boolean);
    if (!words.length) { out.push(""); continue; }
    let line = "";
    for (let word of words) {
      while (widthOf(word, size, bold) > maxWidth && word.length > 1) {
        let cut = word.length - 1;
        while (cut > 1 && widthOf(word.slice(0, cut), size, bold) > maxWidth) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      const next = line ? `${line} ${word}` : word;
      if (widthOf(next, size, bold) <= maxWidth) line = next;
      else { out.push(line); line = word; }
    }
    if (line) out.push(line);
  }
  return out;
}

class PdfDocument {
  constructor({ title = "Document", width = A4.width, height = A4.height } = {}) {
    this.title = title;
    this.width = width;
    this.height = height;
    this.pages = [];
    // Hindi glyphs drawn so far (glyph number -> the text it stands for).
    this.unicodeGlyphs = { regular: new Map(), bold: new Map() };
  }

  addPage() {
    const page = new Page(this);
    this.pages.push(page);
    return page;
  }

  toBuffer() {
    if (!this.pages.length) this.addPage();
    const objects = [];
    const reserve = () => objects.push(null);
    const add = (body) => objects.push(body);
    const catalog = reserve();
    const pagesRoot = reserve();
    const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
    const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
    const stream = (data, extra = "") => {
      const packed = zlib.deflateSync(data);
      return Buffer.concat([Buffer.from(`<< /Length ${packed.length} /Filter /FlateDecode ${extra}>>\nstream\n`, "latin1"), packed, Buffer.from("\nendstream", "latin1")]);
    };
    let fontRefs = `/F1 ${regular} 0 R /F2 ${bold} 0 R`;
    for (const [weight, key] of [["regular", "F3"], ["bold", "F4"]]) {
      const used = this.unicodeGlyphs[weight];
      if (used.size) fontRefs += ` /${key} ${unifont.pdfFontObjects(weight === "bold", used, add, stream)} 0 R`;
    }
    const kids = [];
    for (const page of this.pages) {
      const data = zlib.deflateSync(Buffer.from(page.ops.join("\n"), "latin1"));
      const content = add(Buffer.concat([Buffer.from(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]));
      kids.push(add(`<< /Type /Page /Parent ${pagesRoot} 0 R /MediaBox [0 0 ${num(this.width)} ${num(this.height)}] /Resources << /Font << ${fontRefs} >> >> /Contents ${content} 0 R >>`));
    }
    objects[pagesRoot - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`;
    objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesRoot} 0 R >>`;
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    // Document info text is UTF-16 (any language), unlike page text.
    const utf16 = (str) => `<FEFF${[...String(str)].map((ch) => { const c = ch.codePointAt(0); return c > 0xFFFF ? String.fromCharCode(0xD800 + ((c - 0x10000) >> 10), 0xDC00 + ((c - 0x10000) & 0x3FF)) : ch; }).join("").split("").map((ch) => ch.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase()}>`;
    const info = add(`<< /Title ${utf16(this.title)} /Producer (Rent Ledger) /Creator (Rent Ledger) /CreationDate (D:${stamp}Z) >>`);

    const chunks = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
    let offset = chunks[0].length;
    const offsets = [];
    objects.forEach((body, i) => {
      const buf = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), Buffer.isBuffer(body) ? body : Buffer.from(body, "latin1"), Buffer.from("\nendobj\n", "latin1")]);
      offsets.push(offset);
      chunks.push(buf);
      offset += buf.length;
    });
    const xref = [`xref\n0 ${objects.length + 1}\n`, "0000000000 65535 f \n", ...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${offset}\n%%EOF\n`, "latin1"));
    return Buffer.concat(chunks);
  }
}

module.exports = { PdfDocument, encode, widthOf, wrap, A4, ready: unifont.ready };
