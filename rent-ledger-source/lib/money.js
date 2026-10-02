// Money is stored as integer paise so sums are exact. The API keeps sending
// and receiving rupees (e.g. 12000.5) so the existing screens keep working.
function toPaise(rupees) {
  const n = Number(rupees);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}
function toRupees(paise) {
  return Math.round(Number(paise) || 0) / 100;
}
function formatInr(paise) {
  return `₹${(toRupees(paise)).toLocaleString("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: (Number(paise) % 100) ? 2 : 0 })}`;
}
module.exports = { toPaise, toRupees, formatInr };
