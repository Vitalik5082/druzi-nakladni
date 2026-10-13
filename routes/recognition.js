const OpenAI = require('openai');
const fs = require('fs');
const Fuse = require('fuse.js');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { convertItem, normalize } = require('../lib/convert');
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
let loaded = false;

function rebuildProductIndex() {
  normalizedProducts = yourProducts.map(p => normalize(p));
  normalizedProductsSet = new Set(normalizedProducts);
  fuse = new Fuse(normalizedProducts, { includeScore: true, threshold: 0.28 });
}

async function ensureLoaded() {
  if (loaded) return;
  yourProducts = await readJSON('products.json', []);
  learnedMatches = await readJSON('matches.json', {});
  rebuildProductIndex();
  loaded = true;
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

  const words = key.split(' ').filter(w => w.length > 2);
  let bestMatch = null;
  let bestScore = 0;

  for (let i = 0; i < yourProducts.length; i++) {
    const pNorm = normalize(yourProducts[i]);
    let score = 0;
    for (let w of words) if (pNorm.includes(w)) score++;
    if (score > bestScore) { bestScore = score; bestMatch = yourProducts[i]; }
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

// =====================
// UPLOAD + AI PARSING
// =====================
router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    await ensureLoaded();

    const imageBase64 = req.file.buffer.toString('base64');
    const ext = req.file.originalname?.split('.').pop()?.toLowerCase() || 'jpeg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';

    console.log('Sending image to OpenAI...');

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Extract invoice data from this Ukrainian invoice (накладна) image.
Return ONLY a valid JSON object, no markdown, no explanation.
Format: {
  "supplier": "supplier/vendor name as printed on the invoice letterhead, or empty string if not visible",
  "date": "invoice date in YYYY-MM-DD format, or empty string if not visible",
  "invoiceTotal": number (the printed grand total of the invoice, "Всього"/"Разом"/"Сума", without VAT if that's what's printed; 0 if not visible),
  "items": [ { "name": "product name", "qty": number, "unit": "kg|g|pcs|l|ml", "price": number } ]
}

Rules for items:
- Keep product names EXACTLY as written in the invoice, including ALL weight/volume info AND container type (бут/банка/кега/бочка) if shown
- unit = unit from "Кількість" column: "кг"→"kg", "г"→"g", "шт"→"pcs", "л"→"l", "мл"→"ml", "уп"→"pcs"
- price = price per unit from "Ціна" column
- qty = number from "Кількість" column (do NOT multiply by weight)
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
3. "Брутто" only if no net column exists`
            },
            {
              type: "image_url",
              image_url: {
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: "high"
              }
            }
          ]
        }
      ]
    });

    const rawText = response.choices?.[0]?.message?.content || '';
    console.log('AI raw response:', rawText.substring(0, 200));

    const cleaned = rawText
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/g, '')
      .trim();

    let parsedData;
    try {
      parsedData = JSON.parse(cleaned);
    } catch (e) {
      console.error('JSON parse error. Raw:', rawText);
      return res.status(500).json({ error: 'AI returned invalid JSON', raw: rawText });
    }

    // Backward-compatible: accept either {supplier,date,invoiceTotal,items} or a bare array
    const parsedItems = Array.isArray(parsedData) ? parsedData : parsedData.items;
    const aiSupplier = Array.isArray(parsedData) ? '' : (parsedData.supplier || '').trim();
    const aiDate = Array.isArray(parsedData) ? '' : (parsedData.date || '').trim();
    const aiInvoiceTotal = Array.isArray(parsedData) ? 0 : (Number(parsedData.invoiceTotal) || 0);

    if (!Array.isArray(parsedItems)) {
      return res.status(500).json({ error: 'AI response has no items array', raw: rawText });
    }

    let portionRules = {};
    try {
      portionRules = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'portions.json'), 'utf-8'));
    } catch (e) { console.warn('portions.json not found'); }

    const unitOverrides = await readJSON('unitOverrides.json', {});

    const mapped = parsedItems.map((item, idx) => {
      const mappedName = findBestMatch(item.name);
      const converted = convertItem(item, mappedName, portionRules, unitOverrides, idx);
      return { ...converted, isNewProduct: isUnrecognizedProduct(item.name, mappedName) };
    });

    // Sum-check: AI-reported items vs AI-reported invoice grand total
    const itemsSum = mapped.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0);
    let warning = null;
    if (aiInvoiceTotal > 0 && Math.abs(itemsSum - aiInvoiceTotal) > 1) {
      warning = `Сума розпізнаних позицій (${itemsSum.toFixed(2)} ₴) не збігається з сумою накладної (${aiInvoiceTotal.toFixed(2)} ₴) — перевір вручну, AI міг пропустити рядок або помилитись.`;
    }

    const supplier = aiSupplier || (await suggestSupplier(mapped)) || '';

    res.json({ success: true, items: mapped, count: mapped.length, supplier, date: aiDate, warning });

  } catch (err) {
    console.error('Upload error:', err);

    if (err.status === 401) return res.status(401).json({ error: 'Invalid OpenAI API key' });
    if (err.status === 429) return res.status(429).json({ error: 'OpenAI rate limit exceeded' });

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
