// Single-line JSON logs. Railway parses these as structured logs
// (fields "level" and "message"). Anything that looks like a secret or personal
// credential is replaced before it is written.
const { config } = require("./config");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const SENSITIVE_KEY = /pass(word)?|token|secret|otp|authorization|cookie|signature|code|hash|salt/i;

function redact(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 4) return value;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: config.isProduction ? undefined : value.stack };
  const out = Array.isArray(value) ? [] : {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(inner, depth + 1);
  }
  return out;
}

function write(level, message, fields = {}) {
  if ((LEVELS[level] ?? 20) < (LEVELS[config.logLevel] ?? 20)) return;
  const entry = { level, message, timestamp: new Date().toISOString(), ...redact(fields) };
  const line = JSON.stringify(entry);
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

module.exports = {
  debug: (message, fields) => write("debug", message, fields),
  info: (message, fields) => write("info", message, fields),
  warn: (message, fields) => write("warn", message, fields),
  error: (message, fields) => write("error", message, fields),
  redact,
};
