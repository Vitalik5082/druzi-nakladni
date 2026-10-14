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

// Poster's write methods (storage.createSupply etc.) need a real POST with a JSON body — posterCall
// always sends GET with params flattened into the query string via URLSearchParams, which silently
// mangles any nested object/array into "[object Object]" and comes back as a generic "Method Not
// Allowed" that looks identical to the method not existing at all. Discovered by comparing against
// Poster's official PHP SDK (joinposter/api-php), which calls write methods via POST.
async function posterCallPost(method, body) {
  const token = process.env.POSTER_TOKEN;
  if (!token) throw new Error('POSTER_TOKEN не задано в .env');

  const res = await fetch(`${BASE}/${method}?token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json();

  if (data.error) {
    const msg = typeof data.error === 'object' ? data.error.message : data.error;
    throw new Error(`${method}: ${msg}`);
  }
  return data.response;
}

// Ingredient type codes per Poster's own docs: товар (dish/product) = 1, ingredient = 4,
// modifier = 5. sum is price PER UNIT in ₴ — pass 0 for a count-only correction/receipt with no
// known cost. Returns the new supply document's id.
async function createPosterSupply({ date, supplierId, storageId = 1, items }) {
  return posterCallPost('storage.createSupply', {
    date, supplier_id: supplierId, storage_id: storageId,
    ingredients: items.map(i => ({ id: i.ingredientId, type: i.type || 4, num: i.qty, sum: i.sum || 0 }))
  });
}

// finance.createTransactions — Poster's own docs (the PHP SDK's docblock) don't mention the money
// field at all and get the date format wrong (claim `dmY`; real stored transactions, confirmed via
// finance.getTransactions, use `Y-m-d H:i:s`). The actual required fields, found by reading the
// real error messages Poster returns for each missing one in turn: `amount_from` (not `amount`) and
// `account_from` (not `account_id`) — named that way because this same endpoint also creates type:2
// transfers between two different accounts/currencies.
// amount_from is PLAIN ₴ (NOT kopecks) — confirmed the hard way: sending 1000 for an intended 10₴
// test created a real -1000₴ transaction (finance.getTransactions' OWN amount field is in kopecks,
// e.g. -100000 for that same transaction, which is a different, derived representation — the write
// side and the read side don't use the same scale here).
// type: 0 = expense (видаток), 1 = income, 2 = transfer. accountId 1 = "Розрахунковий рахунок"
// (bank account) — the default for office-type expenses (rent/utilities/taxes), vs 3 = cash box.
// userId 4 = the only Poster employee on this account ("Vitaliy").
// No delete method exists for a plain transaction (only for cash-shift transactions) — treat a
// mistaken entry as needing updateTransactions(transactionId, { amountFrom: 0, ... }) instead.
async function createPosterExpenseTransaction({ categoryId, amount, date, accountId = 1, userId = 4, comment }) {
  return posterCallPost('finance.createTransactions', {
    type: 0, category: categoryId, amount_from: Number(amount.toFixed(2)), account_from: accountId,
    user_id: userId, date: date || posterDateTimeStr(), comment: comment || ''
  });
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

// Poster's supply-document date field wants `Y-m-d H:i:s`, not just a date.
function posterDateTimeStr(d) {
  d = d || new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${localDateStr(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

module.exports = {
  posterCall, posterCallPost, createPosterSupply, createPosterExpenseTransaction,
  ymd, sleep, normalizeModName, localDateStr, posterDateTimeStr
};
