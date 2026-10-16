const OpenAI = require('openai');
const fs = require('fs');
const Fuse = require('fuse.js');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { convertItem, passthroughChemistryItem, normalize, findSupplier } = require('../lib/convert');
const { readJSON, writeJSON } = require('../lib/store');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const router = express.Router();
// memoryStorage: serverless filesystems don't persist a written file between invocations (and
// often aren't writable at all outside /tmp) — we only ever need the bytes in memory anyway.
const upload = multer({ storage: multer.memoryStorage() });

// =====================
// LOAD DATA (lazy, memoized — Supabase-backed, so it's async; everything below awaits ensureLoaded())
// =====================
let yourProducts = [];
let learnedMatches = {};
let normalizedProducts = [];
let normalizedProductsSet = new Set();
let fuse = new Fuse([], { includeScore: true, threshold: 0.28 });
function rebuildProductIndex() {
  normalizedProducts = yourProducts.map(p => normalize(p));
  normalizedProductsSet = new Set(normalizedProducts);
  fuse = new Fuse(normalizedProducts, { includeScore: true, threshold: 0.28 });
}

// Always re-reads from Supabase (no "loaded once" cache) — a warm serverless instance must see
// product/learned-match corrections made via another instance, the admin's local machine, or a
// direct data fix, not just whatever it happened to load on its first request.
async function ensureLoaded() {
  yourProducts = await readJSON('products.json', []);
  learnedMatches = await readJSON('matches.json', {});
  rebuildProductIndex();
}

// =====================
// MATCH (product name -> internal catalog name)
// =====================

// True only when nothing — not even a fuzzy match — was found, i.e. findBestMatch gave up and
// returned the name unchanged. A name that happens to already equal a catalog entry verbatim is
// NOT "new" even though matched() would also read false for it.
function isUnrecognizedProduct(originalName, mappedName) {
  if (originalName !== mappedName) return false;
  return !normalizedProductsSet.has(normalize(originalName));
}

function findBestMatch(name) {
  if (!yourProducts.length) return name;

  const key = normalize(name);
  if (learnedMatches[key]) return learnedMatches[key];

  // Exact match first. Without this, a generic catalog entry ("Соус Бальзамічний") and the real
  // match ("Соус Теріякі") could tie on word-overlap score (both share "соус") and whichever sat
  // earlier in products.json silently won regardless of which was actually right — a real,
  // hand-fixed mismatch this session. An exact normalized match should never lose to a fuzzier one.
  const exactIdx = normalizedProducts.indexOf(key);
  if (exactIdx !== -1) return yourProducts[exactIdx];

  const words = key.split(' ').filter(w => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;
  let bestLen = -1;

  for (let i = 0; i < yourProducts.length; i++) {
    const pNorm = normalize(yourProducts[i]);
    let score = 0;
    for (let w of words) if (pNorm.includes(w)) score++;
    // On a tied score, prefer the more specific (longer) catalog name — "Сир" and "Сир
    // Моцарелла" both score 1 against an OCR'd "Сир Моцарелла" line; the longer one is the
    // better match, not whichever happened to come first in the list.
    if (score > bestScore || (score > 0 && score === bestScore && pNorm.length > bestLen)) {
      bestScore = score; bestMatch = yourProducts[i]; bestLen = pNorm.length;
    }
  }

  if (bestMatch && bestScore > 0) return bestMatch;

  const result = fuse.search(key);
  if (result.length && result[0].score < 0.4) return yourProducts[result[0].refIndex];

  return name;
}

// =====================
// LEARN (product name mapping)
// =====================
router.post('/learn', async (req, res) => {
  await ensureLoaded();
  const { original, selected } = req.body;
  const key = normalize(original);
  learnedMatches[key] = selected;
  await writeJSON('matches.json', learnedMatches);
  res.json({ success: true });
});

// =====================
// ADD NEW PRODUCT TO CATALOG
// =====================
router.post('/add-product', async (req, res) => {
  await ensureLoaded();
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const trimmed = name.trim();
  if (normalizedProductsSet.has(normalize(trimmed))) {
    return res.json({ success: true, alreadyExists: true });
  }

  yourProducts.push(trimmed);
  await writeJSON('products.json', yourProducts);
  rebuildProductIndex();

  res.json({ success: true });
});

// =====================
// PRODUCTS LIST
// =====================
router.get('/products', async (req, res) => {
  await ensureLoaded();
  res.json(yourProducts);
});

// =====================
// SUPPLIER SUGGESTION FROM LEARNED ITEM->SUPPLIER VOTES
// =====================
async function suggestSupplier(items) {
  const learn = await readJSON('supplierLearn.json', {});
  const votes = {};
  for (const item of items) {
    const key = normalize(item.name);
    const entry = learn[key];
    if (entry && entry.supplier) votes[entry.supplier] = (votes[entry.supplier] || 0) + (entry.count || 1);
  }
  let best = null, bestVotes = 0;
  for (const [supplier, count] of Object.entries(votes)) {
    if (count > bestVotes) { bestVotes = count; best = supplier; }
  }
  return best;
}

const INVOICE_PROMPT = `Extract invoice data from this Ukrainian invoice (накладна) image.

FIRST check what kind of document this actually is — a waiter sometimes photographs the wrong thing,
most commonly a cash register's Z-звіт (fiscal end-of-shift report) instead of a supplier's накладна.
A Z-звіт/X-звіт contains phrases like "Z-звіт", "Фіскальний звіт", "Звіт нульовано", "Фіскальний звіт
дійсний" — if you see any of those (or it's clearly a cash-register receipt with sales totals, not a
supplier invoice with line items and prices), set documentType to "zreport" and leave items empty.

Return ONLY a valid JSON object, no markdown, no explanation.
Format: {
  "documentType": "invoice" | "zreport" | "other",
  "supplier": "supplier/vendor name as printed on the invoice letterhead (see supplier-identification rules below), or empty string if not visible",
  "date": "invoice date in YYYY-MM-DD format, or empty string if not visible",
  "invoiceTotal": number (the printed grand total of the invoice, "Всього"/"Разом"/"Сума", without VAT if that's what's printed; 0 if not visible),
  "items": [ { "name": "product name", "qty": number, "unit": "kg|g|pcs|l|ml", "price": number, "total": number } ]
}

Rules for items:
- Keep product names EXACTLY as written in the invoice, including ALL weight/volume info AND container type (бут/банка/кега/бочка) if shown
- unit = unit from "Кількість" column: "кг"→"kg", "г"→"g", "шт"→"pcs", "л"→"l", "мл"→"ml", "уп"→"pcs"
- price = price per unit from "Ціна" column
- qty = number from "Кількість" column (do NOT multiply by weight)
- total = the row's own printed "Сума" column — read it directly, do NOT compute it as qty×price (it's used as a sanity check and, for a хімія/пакування invoice, as the authoritative figure instead of qty×price)
- Do not skip any rows

CRITICAL — for "шт" products WITH weight/volume in the name, keep unit as "pcs" but KEEP the weight in the name:
  ✅ { "name": "Рис для суші YOSHI 25 кг", "qty": 1, "unit": "pcs", "price": 1680 }
  ✅ { "name": "Сухарі Панко 1 кг", "qty": 1, "unit": "pcs", "price": 105 }
  ✅ { "name": "Імбир рожевий 1кг", "qty": 2, "unit": "pcs", "price": 78 }
  ✅ { "name": "Вершки рослинні 1 л", "qty": 12, "unit": "pcs", "price": 130 }
  ✅ { "name": "Стелла Артуа 0.5л Бут", "qty": 40, "unit": "pcs", "price": 48.65 }
  ❌ { "name": "Рис для суші YOSHI", "qty": 1, "unit": "pcs" }  — WRONG, missing weight

CRITICAL — for qty, use this priority:
1. "Вага ч" / "Нетто" / "Net" column if exists → use that
2. "Кількість" / "К-сть" column
3. "Брутто" only if no net column exists

CRITICAL — packs containing a stated number of individual pieces: if the invoice's "Кількість" column
is a number of PACKS/CASES (пачок/уп/ящ) and there's a separate note of how many individual pieces are
in one pack (e.g. "50шт в пач", "50 шт/уп", "х50"), qty MUST be the TOTAL individual piece count
(packs × pieces-per-pack), not the pack count — and price MUST be the price per ONE individual piece
(printed line total ÷ total pieces), not the price per pack:
  Invoice shows: "Норі, 8 пач (50шт в пач), ціна за пач 420 грн" → sum = 8×420 = 3360
  ✅ { "name": "Норі", "qty": 400, "unit": "pcs", "price": 8.4 }   (400 = 8×50, 8.4 = 3360/400)
  ❌ { "name": "Норі", "qty": 8, "unit": "pcs", "price": 420 }     — WRONG, that's pack count/pack price

Rules for identifying the supplier when there's no clear letterhead/company name printed:
- If the document contains the phrase "Бланк Замовлення" anywhere, the supplier is "Кока-Кола"`;

// Shared by the website's /upload AND the Telegram bot — one OCR+classification pipeline.
async function recognizeInvoiceImage(imageBase64, mimeType) {
  await ensureLoaded();

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2000,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: INVOICE_PROMPT },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: "high" } }
        ]
      }
    ]
  });

  const rawText = response.choices?.[0]?.message?.content || '';
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsedData;
  try {
    parsedData = JSON.parse(cleaned);
  } catch (e) {
    const err = new Error('AI returned invalid JSON');
    err.raw = rawText;
    throw err;
  }

  // A waiter sometimes photographs the cash register's Z-звіт instead of a supplier's накладна —
  // routes/telegram.js checks this BEFORE trying to create an invoice from it, so it can divert to
  // the Z-report flow even when the scheduled 22:30 reminder never set the pendingZReport flag.
  if (!Array.isArray(parsedData) && parsedData.documentType === 'zreport') {
    return { documentType: 'zreport', items: [], count: 0, supplier: '', date: '', warning: null };
  }

  // Backward-compatible: accept either {supplier,date,invoiceTotal,items} or a bare array
  const parsedItems = Array.isArray(parsedData) ? parsedData : parsedData.items;
  const aiSupplier = Array.isArray(parsedData) ? '' : (parsedData.supplier || '').trim();
  const aiDate = Array.isArray(parsedData) ? '' : (parsedData.date || '').trim();
  const aiInvoiceTotal = Array.isArray(parsedData) ? 0 : (Number(parsedData.invoiceTotal) || 0);

  if (!Array.isArray(parsedItems)) {
    const err = new Error('AI response has no items array');
    err.raw = rawText;
    throw err;
  }

  let portionRules = {};
  try {
    portionRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'portions.json'), 'utf-8'));
  } catch (e) { console.warn('portions.json not found'); }

  const unitOverrides = await readJSON('unitOverrides.json', {});

  // A накладна from a хімія/пакування supplier (cleaning supplies, disposables, packaging) never
  // matches anything real in products.json (the FOOD/drink catalog) — forcing it through
  // findBestMatch()+convertItem() anyway was exactly what mismatched a trash bag to "Картопля Фрі"
  // and inflated a real 8336₴ invoice to 21553₴. Skip both for a flagged supplier's накладна.
  const suppliersList = await readJSON('suppliers.json', []);
  const matchedSupplier = findSupplier(suppliersList, aiSupplier);
  const isChemistrySupplier = !!matchedSupplier?.isChemistrySupplier;

  const mapped = parsedItems.map((item, idx) => {
    if (isChemistrySupplier) return { ...passthroughChemistryItem(item, idx), isNewProduct: false };
    const mappedName = findBestMatch(item.name);
    const converted = convertItem(item, mappedName, portionRules, unitOverrides, idx);
    return { ...converted, isNewProduct: isUnrecognizedProduct(item.name, mappedName) };
  });

  const itemsSum = mapped.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0);
  let warning = null;
  if (aiInvoiceTotal > 0 && Math.abs(itemsSum - aiInvoiceTotal) > 1) {
    warning = `Сума розпізнаних позицій (${itemsSum.toFixed(2)} ₴) не збігається з сумою накладної (${aiInvoiceTotal.toFixed(2)} ₴) — перевір вручну, AI міг пропустити рядок або помилитись.`;
  }

  let supplier = aiSupplier || (await suggestSupplier(mapped)) || '';

  // The AI reads whatever legal name is printed on the invoice verbatim ("ФОП Проценко Олена
  // Михайлівна") — snap it to an existing saved supplier first, or every full-legal-name variant
  // of the same real supplier silently creates a new duplicate (createInvoice()'s ensureSupplier()
  // has no way to know they're the same business once the raw string reaches it).
  if (supplier) {
    const suppliers = await readJSON('suppliers.json', []);
    const matched = findSupplier(suppliers, supplier);
    if (matched) supplier = matched.name;
  }

  return { documentType: 'invoice', items: mapped, count: mapped.length, supplier, date: aiDate, warning };
}

// Free-text stock receipt report ("Круасан 8 шт, Булочки 50шт") — a waiter typing what just got
// delivered, with no fixed format. Extracts {name, qty, unit} triples; name stays whatever the
// waiter typed (singular/plural, abbreviated) — matching it against the real Poster ingredient
// catalog is the caller's job (routes/telegram.js), since this function has no catalog to match
// against and shouldn't guess at ingredient_ids.
async function recognizeStockText(text) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: `A waiter at a bar is reporting goods just received, in free-form Ukrainian text, no
fixed format. Extract every (item name, quantity, unit) triple you can find.
Examples of input: "Круасан 8 шт, Булочки 50шт" / "Привезли 2 ящики пива і 10кг картоплі" / "булка бріош 50".
Unit defaults to "шт" (pieces) if not stated. Normalize the unit to exactly one of: "шт", "кг", "г", "л", "мл"
(convert count-type words like "ящик"/"пачка"/"уп" to "шт" with their multiplier folded into qty if a per-pack
size is obvious, otherwise leave qty as the stated pack count and unit "шт"). Never leave qty in grams/ml when
the waiter wrote a decimal kg/l amount, and never leave it in kg/l when they clearly wrote grams/ml — e.g.
"250 грам" is qty 250, unit "г" (NOT qty 0.25, unit "кг" — do the unit conversion arithmetic yourself only when
converting words like "ящик" to counts, never silently relabel a gram amount as kilos or vice versa).
Keep the item name as close to the original Ukrainian wording as possible (don't translate or heavily
normalize it) — just strip obvious filler words.
Return ONLY a valid JSON object, no markdown, no explanation.
Format: { "items": [ { "name": string, "qty": number, "unit": string } ] }
Message: """${text}"""`
    }]
  });

  const rawText = response.choices?.[0]?.message?.content || '';
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    const err = new Error('AI returned invalid JSON');
    err.raw = rawText;
    throw err;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    items: items
      .map(i => ({ name: (i.name || '').trim(), qty: Number(i.qty) || 0, unit: (i.unit || 'шт').trim() }))
      .filter(i => i.name && i.qty > 0)
  };
}

// Бухгалтер's monthly reply to the 15th-of-month reminder ("Податки: 10грн, Комуналка: 10грн") —
// extracts {category, amount} pairs, snapping category to one of OUR known expense categories
// (routes/expenses.js's fixed list) so the result slots straight into expenses.json without
// creating stray new category strings from a typo or reworded label.
async function recognizeExpenseText(text, categories) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 300,
    messages: [{
      role: "user",
      content: `A bookkeeper is reporting expense amounts paid, in free-form Ukrainian text, no fixed format.
Extract every (category, amount) pair you can find. Match each item's category to the CLOSEST one from this
exact list (use the exact spelling from the list, never invent a new category): ${categories.join(', ')}.
If an item clearly doesn't match any category in the list, still extract it with your best-guess name.
Return ONLY a valid JSON object, no markdown, no explanation.
Format: { "items": [ { "category": string, "amount": number } ] }
Message: """${text}"""`
    }]
  });

  const rawText = response.choices?.[0]?.message?.content || '';
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    const err = new Error('AI returned invalid JSON');
    err.raw = rawText;
    throw err;
  }

  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return {
    items: items
      .map(i => ({ category: (i.category || '').trim(), amount: Number(i.amount) || 0 }))
      .filter(i => i.category && i.amount > 0)
  };
}

// Payment receipt (чек/квитанція про оплату) — a completely different document shape from an
// invoice: just an amount, a date, and who it was paid to. Used by the Telegram bot's
// бухгалтер-role flow to match a receipt against outstanding invoice debt.
async function recognizeReceiptImage(imageBase64, mimeType) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 500,
    messages: [{
      role: "user",
      content: [
        {
          type: "text",
          text: `Extract payment confirmation data from this receipt/квитанція (bank transfer receipt, cash receipt, or similar) image.
Return ONLY a valid JSON object, no markdown, no explanation.
Format: { "amount": number (the paid amount, 0 if not visible), "date": "YYYY-MM-DD or empty string if not visible", "recipient": "name of the recipient/payee (supplier/company being paid), or empty string if not visible" }`
        },
        { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}`, detail: "high" } }
      ]
    }]
  });

  const rawText = response.choices?.[0]?.message?.content || '';
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    const err = new Error('AI returned invalid JSON');
    err.raw = rawText;
    throw err;
  }

  return {
    amount: Number(parsed.amount) || 0,
    date: (parsed.date || '').trim(),
    recipient: (parsed.recipient || '').trim()
  };
}

// =====================
// UPLOAD + AI PARSING
// =====================
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const imageBase64 = req.file.buffer.toString('base64');
    const ext = req.file.originalname?.split('.').pop()?.toLowerCase() || 'jpeg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    console.log('Sending image to OpenAI...');
    const result = await recognizeInvoiceImage(imageBase64, mimeType);

    res.json({ success: true, ...result });

  } catch (err) {
    console.error('Upload error:', err);

    if (err.status === 401) return res.status(401).json({ error: 'Invalid OpenAI API key' });
    if (err.status === 429) return res.status(429).json({ error: 'OpenAI rate limit exceeded' });
    if (err.raw) return res.status(500).json({ error: err.message, raw: err.raw });

    res.status(500).json({ error: err.message || 'Upload failed' });
  }
});

// =====================
// EXPORT — xlsx у форматі прикладу (Назва | Штрихкод | Кількість | Ціна | Роздрібна ціна)
// =====================
router.post('/export', async (req, res) => {
  const { items } = req.body;
  if (!items?.length) return res.status(400).json({ error: 'No items' });

  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');

    const headers = ['Назва', 'Штрихкод', 'Кількість', 'Ціна', 'Роздрібна ціна'];
    ws.addRow(headers);

    const headerRow = ws.getRow(1);
    headerRow.eachCell(cell => {
      cell.font = { bold: true, name: 'Arial', size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E1F2' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = {
        top:    { style: 'thin' },
        bottom: { style: 'thin' },
        left:   { style: 'thin' },
        right:  { style: 'thin' }
      };
    });
    headerRow.height = 20;

    const active = items.filter(i => !i.skipped);
    active.forEach(item => {
      let price = item.price || 0;
      if ((item.unit === 'g' || item.unit === 'portion') && item.price_per_g > 0) {
        price = item.price_per_g;
      }

      const row = ws.addRow([
        item.name,
        '',
        item.qty,
        price,
        ''
      ]);

      row.eachCell((cell, colNum) => {
        cell.font = { name: 'Arial', size: 10 };
        cell.border = {
          top:    { style: 'thin' },
          bottom: { style: 'thin' },
          left:   { style: 'thin' },
          right:  { style: 'thin' }
        };
        if (colNum === 3 || colNum === 4) {
          cell.alignment = { horizontal: 'right' };
          cell.numFmt = '#,##0.0000';
        }
      });
    });

    ws.getColumn(1).width = 35;
    ws.getColumn(2).width = 18;
    ws.getColumn(3).width = 12;
    ws.getColumn(4).width = 14;
    ws.getColumn(5).width = 16;

    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const filename = `incoming_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await wb.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('Export error:', err);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

module.exports = router;
module.exports.recognizeInvoiceImage = recognizeInvoiceImage;
module.exports.recognizeReceiptImage = recognizeReceiptImage;
module.exports.recognizeStockText = recognizeStockText;
module.exports.recognizeExpenseText = recognizeExpenseText;
