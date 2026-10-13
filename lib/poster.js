const BASE = 'https://joinposter.com/api';

async function posterCall(method, params = {}) {
  const token = process.env.POSTER_TOKEN;
  if (!token) throw new Error('POSTER_TOKEN не задано в .env');

  const qs = new URLSearchParams({ token, ...params });
  const res = await fetch(`${BASE}/${method}?${qs.toString()}`);
  const data = await res.json();

  if (data.error) {
    const msg = typeof data.error === 'object' ? data.error.message : data.error;
    throw new Error(`${method}: ${msg}`);
  }
  return data.response;
}

function ymd(dateStr) {
  return dateStr.replace(/-/g, '');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function normalizeModName(s) {
  return (s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

// Local calendar date as YYYY-MM-DD. Deliberately avoids Date#toISOString(), which converts to
// UTC first — for timezones ahead of UTC (e.g. Europe/Kyiv, UTC+2/+3) that silently rolls local
// midnight back to the previous day, shifting every date-ranged sync by a day.
function localDateStr(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

module.exports = { posterCall, ymd, sleep, normalizeModName, localDateStr };
