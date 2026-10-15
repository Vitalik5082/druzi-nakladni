const express = require('express');
const {
  posterCall, posterCallPost, ymd, sleep, normalizeModName, localDateStr,
  createPosterSupply, createPosterIngredient, posterDateTimeStr, FALLBACK_POSTER_SUPPLIER_ID
} = require('../lib/poster');
const { findSupplier } = require('../lib/convert');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();

function modifierSubUnit(baseUnit) {
  if (baseUnit === 'l') return 'ml';
  if (baseUnit === 'kg') return 'g';
  return baseUnit; // 'p' (pieces) has no sub-unit
}

function dateRange(from, to) {
  const dates = [];
  let d = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (d <= end) {
    dates.push(localDateStr(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

// ── SALES ─────────────────────────────────────────────────────────
router.post('/poster/sync-sales', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const sales = await readJSON('posterSales.json', {});
    const dates = dateRange(from, to);

    for (const date of dates) {
      const dayStr = ymd(date);
      const response = await posterCall('dash.getProductsSales', { dateFrom: dayStr, dateTo: dayStr });
      sales[date] = (response || []).map(p => ({
        product_id: p.product_id,
        product_name: p.product_name,
        modificator_name: p.modificator_name || null,
        modification_id: p.modification_id && p.modification_id !== '0' ? p.modification_id : null,
        qty: Number(p.count) || 0,
        grossSum: Number(p.product_sum) / 100,
        profit: Number(p.product_profit) / 100
      }));
      await sleep(150);
    }

    await writeJSON('posterSales.json', sales);
    res.json({ success: true, daysSynced: dates.length, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pulls per-day revenue totals into our own cashdays.json, so "Каса" doesn't need manual typing
// every day. Days that were manually overridden (edited: true) are left untouched.
router.post('/poster/sync-cash', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const sales = await readJSON('posterSales.json', {});
    const dates = dateRange(from, to);

    for (const date of dates) {
      if (!sales[date]) {
        const dayStr = ymd(date);
        const response = await posterCall('dash.getProductsSales', { dateFrom: dayStr, dateTo: dayStr });
        sales[date] = (response || []).map(p => ({
          product_id: p.product_id,
          product_name: p.product_name,
          modificator_name: p.modificator_name || null,
          modification_id: p.modification_id && p.modification_id !== '0' ? p.modification_id : null,
          qty: Number(p.count) || 0,
          grossSum: Number(p.product_sum) / 100,
          profit: Number(p.product_profit) / 100
        }));
        await sleep(150);
      }
    }
    await writeJSON('posterSales.json', sales);

    const cashDays = await readJSON('cashdays.json', []);
    const list = Array.isArray(cashDays) ? cashDays : [];
    let updated = 0, skippedEdited = 0;

    for (const date of dates) {
      const revenue = Number(((sales[date] || []).reduce((s, i) => s + i.grossSum, 0)).toFixed(2));
      let day = list.find(d => d.date === date);

      if (day && day.edited) { skippedEdited++; continue; }

      if (day) {
        day.revenue = revenue;
        day.source = 'poster';
        day.edited = false;
      } else {
        list.push({ id: nextId(list), date, revenue, note: '', source: 'poster', edited: false });
      }
      updated++;
    }

    await writeJSON('cashdays.json', list);
    res.json({ success: true, updated, skippedEdited });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/poster/sales', async (req, res) => {
  const { from, to } = req.query;
  const sales = await readJSON('posterSales.json', {});
  const dates = Object.keys(sales).filter(d => (!from || d >= from) && (!to || d <= to)).sort();

  const byProduct = {};
  for (const date of dates) {
    for (const item of sales[date]) {
      const key = item.product_id + '_' + (item.modificator_name || '');
      if (!byProduct[key]) {
        byProduct[key] = { product_id: item.product_id, product_name: item.product_name,
          modificator_name: item.modificator_name, qty: 0, grossSum: 0, profit: 0 };
      }
      byProduct[key].qty += item.qty;
      byProduct[key].grossSum += item.grossSum;
      byProduct[key].profit += item.profit;
    }
  }

  const list = Object.values(byProduct).sort((a, b) => b.grossSum - a.grossSum);
  res.json({ from: dates[0] || null, to: dates[dates.length - 1] || null, daysCount: dates.length, products: list });
});

// ── PREPACKS (напівфабрикати) ─────────────────────────────────────
// A modifier's ingredient_id usually points into THIS table, not into raw ingredients —
// different numbering space from menu.getIngredients, confirmed by checking the Poster UI directly.
async function syncPrepacks() {
  const list = await posterCall('menu.getPrepacks');
  const prepacks = {};
  for (const p of list) {
    const detail = await posterCall('menu.getPrepack', { product_id: p.product_id });
    prepacks[p.product_id] = {
      product_id: p.product_id,
      name: p.product_name,
      out: Number(detail.out) || 0,
      ingredients: (detail.ingredients || []).map(i => ({
        ingredient_id: i.ingredient_id,
        name: i.ingredient_name,
        brutto: Number(i.structure_brutto) || 0,
        netto: Number(i.structure_netto) || 0,
        unit: i.structure_unit,
        selfprice: Number(i.structure_selfprice) / 100
      }))
    };
    await sleep(100);
  }
  await writeJSON('prepacks.json', prepacks);
  return prepacks;
}

router.post('/poster/sync-prepacks', async (req, res) => {
  try {
    const prepacks = await syncPrepacks();
    res.json({ success: true, synced: Object.keys(prepacks).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/poster/prepacks', async (req, res) => {
  res.json(Object.values(await readJSON('prepacks.json', {})));
});

// ── TECHCARDS ─────────────────────────────────────────────────────
router.post('/poster/sync-techcards', async (req, res) => {
  try {
    const prepacks = await syncPrepacks();
    const products = await posterCall('menu.getProducts');
    const ingredientsRef = await readJSON('posterIngredients.json', {});
    const techcards = {}; // rebuilt fresh each sync so stale expanded entries don't linger
    let synced = 0;
    let expanded = 0;

    for (const p of products) {
      const detail = await posterCall('menu.getProduct', { product_id: p.product_id });

      const baseIngredients = (detail.ingredients || []).map(i => ({
        ingredient_id: i.ingredient_id,
        name: i.ingredient_name,
        brutto: Number(i.structure_brutto) || 0,
        netto: Number(i.structure_netto) || 0,
        unit: i.structure_unit,
        selfprice: Number(i.structure_selfprice) / 100
      }));

      const modifications = [];
      for (const group of detail.group_modifications || []) {
        for (const m of group.modifications || []) {
          const prepack = prepacks[m.ingredient_id];
          const ref = ingredientsRef[m.ingredient_id];
          // Poster doesn't give modifications their own structure_unit (unlike regular техкарта
          // lines) — m.brutto is always in the ingredient's SUB-unit (ml for a litre-tracked
          // ingredient, g for a kg-tracked one), never the ingredient's own storage unit.
          modifications.push({
            dish_modification_id: String(m.dish_modification_id),
            group_name: group.name,
            name: m.name,
            ingredient_id: m.ingredient_id,
            ingredient_name: prepack ? prepack.name : (ref ? ref.name : `#${m.ingredient_id}`),
            unit: ref ? modifierSubUnit(ref.unit) : '',
            brutto: Number(m.brutto) || 0,
            isPrepack: !!prepack
          });
        }
      }

      techcards[p.product_id] = {
        product_id: p.product_id,
        name: p.product_name,
        category_name: p.category_name,
        type: p.type,
        ingredient_id: detail.ingredient_id && detail.ingredient_id !== '0' ? detail.ingredient_id : null,
        ingredients: baseIngredients,
        modifications,
        syncedAt: new Date().toISOString()
      };
      synced++;

      // Expand each modifier into its own fully-specified techcard: base ingredients + the modifier's
      // delta, resolved all the way down to raw ingredients (through the prepack if the modifier points
      // to one). Matched by modifier NAME (not dish_modification_id) because dash.getProductsSales
      // reports a different, unrelated modification_id numbering than menu.getProduct's dish_modification_id.
      for (const m of modifications) {
        const expandedKey = `${p.product_id}_${normalizeModName(m.name)}`;
        let modifierLines;

        const prepack = prepacks[m.ingredient_id];
        if (prepack) {
          const ratio = prepack.out > 0 ? m.brutto / prepack.out : 1;
          modifierLines = prepack.ingredients.map(pi => ({
            ingredient_id: pi.ingredient_id,
            name: pi.name,
            brutto: Number((pi.brutto * ratio).toFixed(3)),
            netto: Number((pi.netto * ratio).toFixed(3)),
            unit: pi.unit,
            selfprice: Number((pi.selfprice * ratio).toFixed(2)),
            fromModifier: true,
            fromPrepack: prepack.name
          }));
        } else {
          modifierLines = [{
            ingredient_id: m.ingredient_id, name: m.ingredient_name,
            brutto: m.brutto, netto: m.brutto, unit: m.unit, selfprice: 0, fromModifier: true
          }];
        }

        techcards[expandedKey] = {
          product_id: p.product_id,
          base_product_id: p.product_id,
          modification_id: m.dish_modification_id,
          modifier_name: m.name,
          name: `${p.product_name.trim()} ${m.name}`.trim(),
          category_name: p.category_name,
          type: p.type,
          ingredient_id: null,
          ingredients: [...baseIngredients, ...modifierLines],
          modifications: [],
          isExpanded: true,
          syncedAt: new Date().toISOString()
        };
        expanded++;
      }

      await sleep(120);
    }

    await writeJSON('techcards.json', techcards);
    res.json({ success: true, synced, expanded, prepacksSynced: Object.keys(prepacks).length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/poster/techcards', async (req, res) => {
  res.json(Object.values(await readJSON('techcards.json', {})));
});

// ── INGREDIENTS ───────────────────────────────────────────────────
router.post('/poster/sync-ingredients', async (req, res) => {
  try {
    const list = await posterCall('menu.getIngredients');
    const ingredients = {};
    for (const i of list) {
      ingredients[i.ingredient_id] = {
        ingredient_id: i.ingredient_id,
        name: i.ingredient_name,
        unit: i.ingredient_unit,
        left: Number(i.ingredient_left),
        // Poster's raw prime_cost is in "kopecks x100", not plain kopecks — confirmed by cross-
        // checking against techcard structure_selfprice for several ingredients (e.g. tomatoes at
        // 19000/100=190 ₴/kg matches reality; 19000 ₴/kg plainly doesn't).
        prime_cost: Number(i.prime_cost) / 10000,
        syncedAt: new Date().toISOString()
      };
    }
    await writeJSON('posterIngredients.json', ingredients);
    res.json({ success: true, synced: list.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/poster/ingredients', async (req, res) => {
  res.json(Object.values(await readJSON('posterIngredients.json', {})));
});

// ── LEFTOVERS (live, not cached) ──────────────────────────────────
router.get('/poster/leftovers', async (req, res) => {
  try {
    const leftovers = await posterCall('storage.getStorageLeftovers', { storage_id: req.query.storage_id || 1 });
    res.json(leftovers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Free-text stock receipts reported by waiters via Telegram (routes/telegram.js) — written there,
// read-only here for the "Залишки" page's recent-receipts list.
router.get('/text-supplies', async (req, res) => {
  const log = await readJSON('textSupplies.json', []);
  res.json(log.slice(-20).reverse());
});

// ── FINANCE (ЗП та інші категорії, якщо колись з'являться) ────────
const FINANCE_CATEGORY_LABELS = {
  1: 'Переказ/інкасація', 2: 'Закриття касової зміни', 3: 'Постачання',
  4: 'Коригувальна транзакція', 5: 'Банківські послуги', 6: 'ЗП',
  7: 'Маркетинг', 8: 'Оренда', 9: 'Комунальні', 10: 'Електрика',
  11: 'Вода', 12: 'Вивіз сміття', 13: 'Господарські витрати', 14: 'Електронні кошельки'
};
// Categories that represent real operating costs for us — cash-shift closures (2), internal
// transfers (1) and correcting entries (4) are not expenses, they're bookkeeping noise.
const FINANCE_EXPENSE_CATEGORIES = [6, 7, 8, 9, 10, 11, 12, 13];

router.post('/poster/sync-finance', async (req, res) => {
  const { from, to } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  try {
    const response = await posterCall('finance.getTransactions', { dateFrom: ymd(from), dateTo: ymd(to) });
    const finance = await readJSON('posterFinance.json', {});

    // clear any existing entries inside this range before re-writing, so re-sync doesn't duplicate
    for (const date of Object.keys(finance)) {
      if (date >= from && date <= to) delete finance[date];
    }

    for (const t of response || []) {
      const date = t.date.slice(0, 10);
      const catId = Number(t.category_id);
      if (!FINANCE_EXPENSE_CATEGORIES.includes(catId)) continue;

      if (!finance[date]) finance[date] = [];
      finance[date].push({
        category_id: catId,
        category_name: FINANCE_CATEGORY_LABELS[catId] || `Категорія ${catId}`,
        amount: Math.abs(Number(t.amount)) / 100,
        comment: t.comment || ''
      });
    }

    await writeJSON('posterFinance.json', finance);
    res.json({ success: true, from, to });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/poster/finance', async (req, res) => {
  const { from, to } = req.query;
  const finance = await readJSON('posterFinance.json', {});
  const dates = Object.keys(finance).filter(d => (!from || d >= from) && (!to || d <= to));

  const byCategory = {};
  for (const date of dates) {
    for (const t of finance[date]) {
      byCategory[t.category_name] = (byCategory[t.category_name] || 0) + t.amount;
    }
  }

  const payroll = dates.reduce((s, d) => s + finance[d].filter(t => t.category_id === 6).reduce((s2, t) => s2 + t.amount, 0), 0);
  const total = Object.values(byCategory).reduce((s, v) => s + v, 0);

  res.json({ from, to, byCategory, payroll, total });
});

// ── CONSUMPTION (derived: sales x techcard, last N days) ──────────
async function computeConsumption(days) {
  const [sales, techcards, ingredientsRef] = await Promise.all([
    readJSON('posterSales.json', {}),
    readJSON('techcards.json', {}),
    readJSON('posterIngredients.json', {})
  ]);

  const today = new Date();
  const dates = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(localDateStr(d));
  }

  const qtyByKey = {};
  const datesUsed = [];
  for (const date of dates) {
    if (!sales[date]) continue;
    datesUsed.push(date);
    for (const item of sales[date]) {
      const key = item.modificator_name
        ? `${item.product_id}_${normalizeModName(item.modificator_name)}`
        : item.product_id;
      qtyByKey[key] = (qtyByKey[key] || 0) + item.qty;
    }
  }

  const consumption = {};
  function addConsumption(ingredient_id, amount, unit, name) {
    if (!consumption[ingredient_id]) {
      consumption[ingredient_id] = { ingredient_id, name, unit, amount: 0 };
    }
    consumption[ingredient_id].amount += amount;
  }

  for (const [key, qty] of Object.entries(qtyByKey)) {
    // prefer the fully-expanded modifier techcard; fall back to the base product if not synced yet
    const card = techcards[key] || techcards[key.split('_')[0]];
    if (!card) continue;

    if (card.ingredients && card.ingredients.length) {
      for (const ing of card.ingredients) {
        // For piece-counted ingredients (unit "p"), Poster's netto is a weight-equivalent (or 0),
        // not a piece count — brutto is the real "how many pieces" per sale. For weight/volume units
        // netto is correct (brutto minus prep loss).
        const perUnit = ing.unit === 'p' ? ing.brutto : ing.netto;
        addConsumption(ing.ingredient_id, perUnit * qty, ing.unit, ing.name);
      }
    } else if (card.ingredient_id) {
      const ref = ingredientsRef[card.ingredient_id];
      addConsumption(card.ingredient_id, qty, ref ? ref.unit : 'p', ref ? ref.name : card.name);
    }
  }

  return { datesUsed, byIngredient: consumption };
}

router.get('/poster/consumption', async (req, res) => {
  const days = Number(req.query.days) || 7;
  const { datesUsed, byIngredient } = await computeConsumption(days);
  const list = Object.values(byIngredient).sort((a, b) => b.amount - a.amount);
  res.json({ days, datesUsed, items: list });
});

// ── ORDER RECOMMENDATIONS ──────────────────────────────────────────
// Poster's own ingredient_left is often negative (supplies aren't logged consistently there), so
// it can't be trusted as "how much we have". When it's negative we fall back to average weekly
// consumption (from our own sales x techcard data) + 10% buffer instead of the leftover figure.
router.get('/poster/order-recommendations', async (req, res) => {
  const [ingredientsRef, productSuppliers, suppliers] = await Promise.all([
    readJSON('posterIngredients.json', {}),
    readJSON('productSuppliers.json', {}),
    readJSON('suppliers.json', [])
  ]);

  const { byIngredient } = await computeConsumption(28);

  // consumption amounts come back in the SUB-unit (ml/g); ingredient_left is in the ingredient's
  // own BASE unit (l/kg) — must convert to the same unit before comparing/subtracting them.
  function toBaseUnit(amount, fromUnit, baseUnit) {
    if ((fromUnit === 'ml' && baseUnit === 'l') || (fromUnit === 'g' && baseUnit === 'kg')) {
      return amount / 1000;
    }
    return amount;
  }

  const items = [];
  for (const ing of Object.values(ingredientsRef)) {
    const consumed = byIngredient[ing.ingredient_id];
    const avgWeeklyRaw = consumed ? consumed.amount / 4 : 0;
    const avgWeekly = toBaseUnit(avgWeeklyRaw, consumed ? consumed.unit : ing.unit, ing.unit);
    const leftover = Number(ing.left) || 0;
    const reliable = leftover >= 0;

    const recommendedQty = reliable
      ? Math.max(0, avgWeekly * 1.1 - leftover)
      : avgWeekly * 1.1;

    if (recommendedQty < 0.01) continue;

    const assignment = productSuppliers[ing.ingredient_id];
    const assignedSuppliers = (assignment && assignment.supplierIds || [])
      .map(id => suppliers.find(s => s.id === Number(id)))
      .filter(Boolean);

    // Suppliers sell whole packs (ящик/пачка/відро), not "2.37 kg" — when packSize is configured
    // (сторінка "Постачальники товарів"), round the raw recommendation UP to whole packs so the
    // number that reaches a supplier is actually orderable.
    const packSize = assignment && assignment.packSize;
    const packUnit = assignment && assignment.packUnit;
    const packsNeeded = packSize ? Math.ceil(recommendedQty / packSize) : null;

    const base = {
      ingredient_id: ing.ingredient_id,
      name: ing.name,
      unit: ing.unit,
      leftover,
      reliable,
      avgWeekly: Number(avgWeekly.toFixed(3)),
      recommendedQty: Number(recommendedQty.toFixed(3)),
      packSize: packSize || null,
      packUnit: packUnit || null,
      packsNeeded,
      note: assignment ? assignment.note : ''
    };

    // A товар assigned to several suppliers (multi-assignment, to be refined later) shows up
    // under each of them, so whichever supplier's order list you're preparing, it's there.
    if (assignedSuppliers.length) {
      for (const s of assignedSuppliers) {
        items.push({ ...base, supplierId: s.id, supplierName: s.name });
      }
    } else {
      items.push({ ...base, supplierId: null, supplierName: null });
    }
  }

  items.sort((a, b) => (a.supplierName || '￿').localeCompare(b.supplierName || '￿') || b.recommendedQty - a.recommendedQty);
  res.json({ items });
});

// ── CREATE A BRAND NEW PRODUCT ────────────────────────────────────
// Used by invoices.html's "Змінити відповідність" modal when the накладна line is something we've
// genuinely never bought before — no catalog entry fits because none exists yet. Creates it in
// BOTH places that need it: our own накладні catalog (products.json, plain name strings) and a real
// Poster ingredient (so stock/consumption tracking works going forward), then logs the qty/price
// from THIS накладна line as the ingredient's first-ever supply — Poster has no "set opening stock"
// field on the ingredient itself, it only derives stock/cost from real supply documents.
router.get('/poster/ingredient-categories', async (req, res) => {
  try {
    res.json(await posterCall('menu.getCategoriesIngredients'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// накладна items are stored internally in g/ml (not kg/l) — bitten by this exact mismatch once
// already this session (250g silently became 250kg): the new Poster ingredient's unit is kg/l, so
// a накладна item whose OWN unit is the finer-grained g/ml must have its qty divided by 1000 and
// price multiplied by 1000 before becoming a supply, or the stock comes out 1000x too high.
function toTargetUnitQtyPrice(sourceUnit, targetUnit, qty, price) {
  const scalesDown = (sourceUnit === 'g' && targetUnit === 'kg') || (sourceUnit === 'ml' && targetUnit === 'l');
  if (!scalesDown) return { qty, price };
  return { qty: qty / 1000, price: price * 1000 };
}

router.post('/products/create-new', async (req, res) => {
  const { name, categoryId, unit, weightIngredient, qty, price, invoiceSupplier, sourceUnit } = req.body;
  if (!name || !unit) return res.status(400).json({ error: 'name and unit required' });
  if (!['kg', 'l', 'p'].includes(unit)) return res.status(400).json({ error: 'unit must be kg, l or p' });

  const scaled = toTargetUnitQtyPrice(sourceUnit, unit, Number(qty) || 0, Number(price) || 0);

  try {
    let ingredientId;
    try {
      ingredientId = await createPosterIngredient({
        name, categoryId: Number(categoryId) || 5, unit, weightIngredient: Number(weightIngredient) || undefined
      });
    } catch (err) {
      // "ingredient_name is already exist" — Poster hands back the existing ingredient's id right
      // on the error (item_id), so this is just "use the one that's already there", not a failure.
      if (err.item_id) ingredientId = err.item_id;
      else throw err;
    }

    // Resolve a real Poster supplier for the opening supply — reuse one already linked to our
    // накладні supplier record, create it in Poster if that record exists but was never linked yet,
    // or fall back to the generic correction supplier when we genuinely can't tell.
    let posterSupplierId = FALLBACK_POSTER_SUPPLIER_ID;
    if (invoiceSupplier) {
      const suppliers = await readJSON('suppliers.json', []);
      const matched = findSupplier(suppliers, invoiceSupplier);
      if (matched) {
        if (matched.posterSupplierId) {
          posterSupplierId = matched.posterSupplierId;
        } else {
          const newId = await posterCallPost('storage.createSupplier', { supplier_name: matched.name });
          matched.posterSupplierId = newId;
          await writeJSON('suppliers.json', suppliers);
          posterSupplierId = newId;
        }
      }
    }

    if (scaled.qty > 0) {
      await createPosterSupply({
        date: posterDateTimeStr(), supplierId: posterSupplierId,
        items: [{ ingredientId, qty: scaled.qty, sum: scaled.price }]
      });
    }

    const products = await readJSON('products.json', []);
    if (!products.includes(name)) {
      products.push(name);
      await writeJSON('products.json', products);
    }

    // Keep our own live cache in sync too, so the newly-created product's unit is immediately
    // usable (e.g. invoices.html's product-reassignment unit lookup) without waiting for the next
    // /poster/sync-ingredients run.
    const cache = await readJSON('posterIngredients.json', {});
    cache[ingredientId] = { left: scaled.qty, name, unit, syncedAt: new Date().toISOString(), ingredient_id: ingredientId };
    await writeJSON('posterIngredients.json', cache);

    res.json({ name, unit, ingredientId });
  } catch (err) {
    console.error('create-new product failed:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
