// Business dates in the configured time zone (Asia/Kolkata by default).
// Railway's servers run on UTC, so "today" and "this month" from the plain
// Date API are wrong for India between midnight and 05:30 IST.

function localDate(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function currentPeriod(timeZone, date = new Date()) {
  const [year, month] = localDate(timeZone, date).split("-").map(Number);
  return { year, month };
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

module.exports = { localDate, currentPeriod, isIsoDate };
