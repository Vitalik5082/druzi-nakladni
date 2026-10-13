// Local calendar date as YYYY-MM-DD. Never use Date#toISOString() for this — it converts to UTC
// first, which for timezones ahead of UTC (Europe/Kyiv, Chisinau, UTC+2/+3) silently rolls local
// midnight back to the previous day.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayStr() {
  return localDateStr(new Date());
}
