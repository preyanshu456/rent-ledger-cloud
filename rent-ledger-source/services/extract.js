// Best-effort extraction of lease details from an uploaded document.
// Results are *suggestions only*: the owner sees each value next to the text
// it came from, corrects it, and nothing is saved until they confirm.
// Works on text-based PDFs and pasted text. Scanned images need OCR, which is
// not included (the response says so instead of guessing).
const zlib = require("zlib");

// Pull text out of a PDF's content streams (handles Flate-compressed streams
// and the common Tj / TJ text operators). Not a full PDF parser.
function pdfText(buffer) {
  const raw = buffer.toString("latin1");
  const chunks = [];
  const streamRe = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m;
  while ((m = streamRe.exec(raw))) {
    const dict = m[1];
    let data = Buffer.from(m[2], "latin1");
    if (/\/FlateDecode/.test(dict)) {
      try { data = zlib.inflateSync(data); } catch { try { data = zlib.inflateRawSync(data); } catch { continue; } }
    } else if (/\/Filter/.test(dict)) continue; // images and other encodings
    chunks.push(textFromContent(data.toString("latin1")));
  }
  return chunks.join("\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function unescapePdf(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => ({ n: "\n", r: "", t: " ", b: "", f: "", "(": "(", ")": ")", "\\": "\\" }[c] ?? String.fromCharCode(parseInt(c, 8))));
}

function textFromContent(content) {
  const out = [];
  const re = /\[((?:\\.|[^\]])*)\]\s*TJ|\(((?:\\.|[^)])*)\)\s*(?:Tj|'|")|(T\*|Td|TD|ET)/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[1] !== undefined) {
      const parts = [];
      const inner = /\(((?:\\.|[^)])*)\)|(-?\d+(?:\.\d+)?)/g;
      let p;
      while ((p = inner.exec(m[1]))) {
        if (p[1] !== undefined) parts.push(unescapePdf(p[1]));
        else if (Number(p[2]) < -200) parts.push(" ");
      }
      out.push(parts.join(""));
    } else if (m[2] !== undefined) out.push(unescapePdf(m[2]));
    else out.push("\n");
  }
  return out.join("").replace(/\n\s*\n/g, "\n");
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
const monthNum = (name) => MONTHS[String(name).slice(0, 4).toLowerCase()] || MONTHS[String(name).slice(0, 3).toLowerCase()] || null;

function parseDate(s) {
  let m = /\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b/.exec(s); // dd/mm/yyyy (India)
  if (m) return valid(+m[3], +m[2], +m[1]);
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+day\s+of)?\s+([A-Za-z]{3,9})[,\s]+(\d{4})\b/.exec(s);
  if (m && monthNum(m[2])) return valid(+m[3], monthNum(m[2]), +m[1]);
  m = /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/.exec(s);
  if (m && monthNum(m[1])) return valid(+m[3], monthNum(m[1]), +m[2]);
  return null;
}
function valid(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
  const iso = `${y}-${pad(mo)}-${pad(d)}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

function parseAmount(s) {
  const m = /(?:₹|rs\.?|inr|rupees)\s*([\d,]+(?:\.\d{1,2})?)|([\d,]{3,}(?:\.\d{1,2})?)\s*(?:\/-|rupees|only)/i.exec(s);
  if (!m) return null;
  const n = Number((m[1] || m[2]).replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 && n < 1e8 ? n : null;
}

// Look for a value near keywords; return the value and the sentence it came from.
function near(text, keywords, parser) {
  // Sentences, without breaking after "Mr.", "Rs." and similar abbreviations.
  const lines = text.split(/\n|(?<!\b(?:Mr|Mrs|Ms|Dr|Rs|No|Smt|Shri|Sh|Sr|Jr|St))\.\s+(?=[A-Z])/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (keywords.some((k) => k.test(line))) {
      const value = parser(line);
      if (value !== null && value !== undefined) return { value, source: line.slice(0, 240) };
    }
  }
  return null;
}

function extractLeaseFields(text) {
  const clean = String(text || "").replace(/\r/g, "");
  const fields = {};
  const rent = near(clean, [/\b(monthly\s+)?rent\b/i, /\blicen[cs]e\s+fee\b/i], parseAmount);
  if (rent) fields.rent = rent;
  const deposit = near(clean, [/\bdeposit\b/i, /\bsecurity\b/i, /\badvance\b/i], parseAmount);
  if (deposit) fields.deposit = deposit;
  const start = near(clean, [/\b(commenc|start|effective|from)\w*/i], parseDate);
  if (start) fields.startDate = start;
  const end = near(clean, [/\b(expir|end|terminat|till|until|upto|up to)\w*/i], (line) => {
    const dates = [...line.matchAll(/\d{1,2}[/.-]\d{1,2}[/.-]\d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3,9},?\s+\d{4}/g)].map((x) => parseDate(x[0])).filter(Boolean);
    return dates.length ? dates[dates.length - 1] : null;
  });
  if (end && end.value !== start?.value) fields.endDate = end;
  const term = near(clean, [/\b(period|term|duration)\b/i], (line) => {
    const m = /(\d{1,2})\s*(?:\(\w+\)\s*)?months?/i.exec(line);
    return m ? Number(m[1]) : null;
  });
  if (term) fields.termMonths = term;
  const dueDay = near(clean, [/\b(on or before|before the|by the|payable on)\b/i], (line) => {
    const m = /(\d{1,2})(?:st|nd|rd|th)?\s+(?:day\s+)?of\s+(?:each|every)\s+(?:calendar\s+)?month/i.exec(line);
    return m && +m[1] >= 1 && +m[1] <= 28 ? +m[1] : null;
  });
  if (dueDay) fields.dueDay = dueDay;
  const tenant = near(clean, [/\b(lessee|licensee|tenant)\b/i], (line) => {
    const m = /(?:lessee|licensee|tenant)\s*(?:name)?\s*[:\-–]\s*(?:mr\.?|mrs\.?|ms\.?|shri|smt\.?)?\s*([A-Z][A-Za-z.]+(?:\s+[A-Z][A-Za-z.]+){0,3})/.exec(line)
      || /(?:mr|mrs|ms|shri|smt)\.?\s+([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+){0,3})\s*\((?:the\s+)?(?:lessee|licensee|tenant)/i.exec(line);
    return m ? m[1].trim() : null;
  });
  if (tenant) fields.tenantName = tenant;
  return fields;
}

function extractFromUpload(upload) {
  if (upload.mimeType === "application/pdf") {
    const text = pdfText(upload.bytes);
    if (text.replace(/\s/g, "").length < 40) {
      return { text: "", fields: {}, note: "No readable text found. This looks like a scanned image; please type the details in." };
    }
    return { text: text.slice(0, 20000), fields: extractLeaseFields(text), note: "" };
  }
  return { text: "", fields: {}, note: "Images can't be read automatically yet (no OCR). Please type the details in, or upload a text-based PDF." };
}

module.exports = { pdfText, extractLeaseFields, extractFromUpload, parseDate, parseAmount };
