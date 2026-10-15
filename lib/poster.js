const { readJSON } = require('./store');
const { normalize, toTargetUnitQtyPrice } = require('./convert');

const BASE = 'https://joinposter.com/api';

// Poster's error shape is inconsistent: sometimes {error: {message: "..."}}, but often
// {error: 38, message: "ingredient_name is already exist", item_id: 59} — a bare numeric code with
// the real text as a SIBLING field, not nested under error. Checking only data.error.message (as
// this used to) silently throws away the actual message AND anything useful like item_id whenever
// error is a bare number — which it usually is.
function posterError(method, data) {
  const msg = (typeof data.error === 'object' && data.error.message) || data.message || data.error;
  const err = new Error(`${method}: ${msg}`);
  err.posterErrorCode = typeof data.error === 'object' ? data.error.code : data.error;
  Object.keys(data).forEach(k => { if (!['error', 'message', 'response'].includes(k)) err[k] = data[k]; });
  return err;
}

async function posterCall(method, params = {}) {
  const token = process.env.POSTER_TOKEN;
  if (!token) throw new Error('POSTER_TOKEN не задано в .env');

  const qs = new URLSearchParams({ token, ...params });
  const res = await fetch(`${BASE}/${method}?${qs.toString()}`);
  const data = await res.json();

  if (data.error) throw posterError(method, data);
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

  if (data.error) throw posterError(method, data);
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

// Not in Poster's docs under this name — found by trial: storage.removeSupply/removeSupplies/
// editSupply all 405 "Method Not Allowed", but storage.deleteSupply works (soft-delete, the
// document stays in storage.getSupplies with delete:"1" and its stock/cost effect is reversed).
// For undoing a wrongly-pushed test/mistaken supply — confirmed live (test supply's qty/cost
// contribution to the product's moving-average cost was gone after calling this).
async function deletePosterSupply(supplyId) {
  return posterCallPost('storage.deleteSupply', { supply_id: supplyId });
}

// menu.createIngredient — unlike several other write methods this session, worked first try
// exactly as documented. type is Poster's own unit code (kg/l/p); weightIngredient (grams) is
// required when type is 'p' (piece-counted) so Poster knows how much one piece weighs.
// Returns the new ingredient_id. Stock/cost aren't set here — Poster derives those from a real
// supply document (createPosterSupply), not from any field on the ingredient itself.
async function createPosterIngredient({ name, categoryId, unit, weightIngredient }) {
  const body = { ingredient_name: name, category_id: categoryId, type: unit };
  if (unit === 'p' && weightIngredient) body.weight_ingredient = weightIngredient;
  return posterCallPost('menu.createIngredient', body);
}

// Poster supplier created once via storage.createSupplier specifically for text-reported receipts
// whose ingredient has no (or an ambiguous) supplier assignment — supplier_id 4 in this Poster
// account ("Telegram-прихід (без визначеного постачальника)"). Shared between routes/telegram.js
// and anywhere else that creates a Poster supply without a confidently-resolved real supplier.
const FALLBACK_POSTER_SUPPLIER_ID = 4;

// Pushes a накладна's items into Poster as real supply documents, keeping Poster's own ingredient
// cost (prime_cost) in sync with what накладні actually record — WITHOUT this, Poster's cost basis
// only ever updates when someone enters a прихід directly in Poster itself, so a price change
// visible on a накладна can silently never reach Poster, and our dashboard's "Фудкост%"/COGS (which
// is entirely Poster's own dash.getProductsSales profit margin, not something we compute
// ourselves) quietly drifts stale.
//
// Called once a накладна is actually CONFIRMED — either immediately at creation for a website
// накладна (an admin already reviewed it before clicking "Зберегти", so there's no separate
// approval step), or when a Telegram-sourced накладна's pendingReview flips to false via "✓
// Підтвердити". Never at creation time for a pending накладна — a waiter's text-прихід or an
// unreviewed OCR photo hasn't been looked at by anyone yet.
//
// Matching накладна item.name against Poster is EXACT-normalized-name only, deliberately NOT
// fuzzy — tested against накладні's real catalog names (which are often raw/half-cleaned OCR text,
// e.g. "НАПІЙ \"COCA-COLA\" 330МЛ." or "Cola 0.5") against Poster's own naming and found fuzzy
// matching happily mismatches one bottled drink for another (score ~0.4, under the threshold that
// seemed safe) — silently attributing one product's price to a DIFFERENT product's cost is worse
// than just skipping it and telling the admin to fix the name or re-match via "✎".
//
// Checks both менюtypes накладні items can resolve to: real recipe ingredients (menu.getIngredients,
// kg/l/p — type 4 in a supply) AND resold-as-is products like bottled drinks (menu.getProducts
// filtered to type==='3' — "товар", pushed as supply type 1 keyed by product_id, always pcs,
// no unit scaling since a bottle/can is inherently piece-counted in both systems).
async function pushInvoiceToPoster(invoice) {
  const [ingredients, products, productSuppliers, suppliers] = await Promise.all([
    posterCall('menu.getIngredients'),
    posterCall('menu.getProducts'),
    readJSON('productSuppliers.json', {}),
    readJSON('suppliers.json', [])
  ]);
  const ingredientByName = new Map(ingredients.map(i => [normalize(i.ingredient_name), i]));
  const resoldProducts = products.filter(p => String(p.type) === '3');
  const productByName = new Map(resoldProducts.map(p => [normalize(p.product_name), p]));
  const invoiceSupplierRecord = suppliers.find(s => s.name === invoice.supplier);

  const groups = new Map(); // posterSupplierId -> items[]
  const skippedNew = [];
  let skippedChemistry = 0;

  for (const item of invoice.items || []) {
    if (item.skipped) continue;
    if (item.isChemistry) { skippedChemistry++; continue; } // not a stock item, never in Poster

    const key = normalize(item.name);
    const ing = ingredientByName.get(key);
    const prod = !ing ? productByName.get(key) : null;
    if (!ing && !prod) { skippedNew.push(item.name); continue; } // no exact Poster match — safer to skip than guess

    let supplyItem, assignedIds;
    if (ing) {
      const scaled = toTargetUnitQtyPrice(item.unit, ing.ingredient_unit, item.qty || 0, item.price || 0);
      if (!(scaled.qty > 0)) continue;
      supplyItem = { ingredientId: ing.ingredient_id, type: 4, qty: scaled.qty, sum: scaled.price };
      assignedIds = productSuppliers[ing.ingredient_id]?.supplierIds || [];
    } else {
      if (!((item.qty || 0) > 0)) continue;
      supplyItem = { ingredientId: prod.product_id, type: 1, qty: item.qty, sum: item.price || 0 };
      assignedIds = productSuppliers[prod.product_id]?.supplierIds || [];
    }

    // Prefer the per-ingredient supplier assignment ("Постачальники товарів"), then the накладна's
    // own supplier (if it's linked to a real Poster supplier), else the generic fallback.
    const assignedSupplier = assignedIds.length === 1 ? suppliers.find(s => s.id === assignedIds[0]) : null;
    const posterSupplierId = assignedSupplier?.posterSupplierId || invoiceSupplierRecord?.posterSupplierId || FALLBACK_POSTER_SUPPLIER_ID;

    if (!groups.has(posterSupplierId)) groups.set(posterSupplierId, []);
    groups.get(posterSupplierId).push(supplyItem);
  }

  let pushedCount = 0;
  const failed = [];
  const date = posterDateTimeStr();
  for (const [posterSupplierId, items] of groups) {
    try {
      await createPosterSupply({ date, supplierId: posterSupplierId, items });
      pushedCount += items.length;
    } catch (err) {
      console.error('pushInvoiceToPoster: createPosterSupply failed:', err);
      failed.push(...items.map(i => i.ingredientId));
    }
  }

  return { pushedCount, skippedNew, skippedChemistry, failedCount: failed.length };
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
  posterCall, posterCallPost, createPosterSupply, deletePosterSupply, createPosterExpenseTransaction, createPosterIngredient,
  pushInvoiceToPoster,
  FALLBACK_POSTER_SUPPLIER_ID, ymd, sleep, normalizeModName, localDateStr, posterDateTimeStr
};
