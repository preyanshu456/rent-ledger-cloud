// Small input-validation helpers. Each field rule turns a raw request value
// into a clean value or throws a ValidationError with a message the UI can show.
//
// Only fields listed in a schema are ever copied onto a stored record, which
// closes the old "Object.assign(record, req.body)" mass-assignment hole.
const { isIsoDate } = require("./dates");

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function text({ label, max = 200, required = false } = {}) {
  return (value) => {
    if (isBlank(value)) {
      if (required) throw new ValidationError(`${label} is required.`);
      return "";
    }
    if (typeof value !== "string" && typeof value !== "number") throw new ValidationError(`${label} must be text.`);
    const out = String(value).trim();
    if (out.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
    return out;
  };
}

// Numbers arrive as strings from HTML forms. A blank optional number becomes
// the default (0), matching the app's previous behaviour.
function number({ label, min = 0, max = 1e9, integer = false, required = false, fallback = 0 } = {}) {
  return (value) => {
    if (isBlank(value)) {
      if (required) throw new ValidationError(`${label} is required.`);
      return fallback;
    }
    const out = Number(value);
    if (!Number.isFinite(out)) throw new ValidationError(`${label} must be a number.`);
    if (integer && !Number.isInteger(out)) throw new ValidationError(`${label} must be a whole number.`);
    if (out < min || out > max) throw new ValidationError(`${label} must be between ${min} and ${max}.`);
    return integer ? out : Math.round(out * 100) / 100;
  };
}

function date({ label } = {}) {
  return (value) => {
    if (isBlank(value)) return "";
    if (!isIsoDate(String(value))) throw new ValidationError(`${label} must be a valid date.`);
    return String(value);
  };
}

function bool() {
  return (value) => value === true || value === "true" || value === "on" || value === 1 || value === "1";
}

function mobile({ label = "Mobile number", required = false } = {}) {
  return (value) => {
    if (isBlank(value)) {
      if (required) throw new ValidationError(`${label} is required.`);
      return "";
    }
    const out = String(value).trim();
    const digits = out.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15 || !/^[+\d\s()-]+$/.test(out)) throw new ValidationError(`${label} must be a valid phone number.`);
    return out;
  };
}

function email({ label = "Email" } = {}) {
  return (value) => {
    if (isBlank(value)) return "";
    const out = String(value).trim();
    if (out.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out)) throw new ValidationError(`${label} must be a valid email address.`);
    return out;
  };
}

// Apply a schema. With partial=true only fields present in `body` are returned
// (used for updates); otherwise every field is validated (used for creates).
function clean(body, schema, { partial = false } = {}) {
  const input = body && typeof body === "object" ? body : {};
  const out = {};
  for (const [field, rule] of Object.entries(schema)) {
    if (partial && !Object.prototype.hasOwnProperty.call(input, field)) continue;
    out[field] = rule(input[field]);
  }
  return out;
}

const month = (label = "Month") => number({ label, min: 1, max: 12, integer: true, required: true });
const year = (label = "Year") => number({ label, min: 2000, max: 2100, integer: true, required: true });
const money = (label) => number({ label, min: 0, max: 100_000_000 });

module.exports = { ValidationError, text, number, date, bool, mobile, email, clean, month, year, money };
