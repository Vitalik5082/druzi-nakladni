const express = require('express');
const { readJSON, writeJSON } = require('../lib/store');

const router = express.Router();
const FILE = 'productSuppliers.json';

router.get('/product-suppliers', async (req, res) => {
  res.json(await readJSON(FILE, {}));
});

// packSize/packUnit let order recommendations round up to whole orderable units (ящик/пачка/відро
// etc.) instead of raw kg/l/p — suppliers don't sell "2.37 kg", they sell whole packs.
// lowStockThreshold is the same per-ingredient field scripts/supplier-stock-digest.js reads to
// decide whether to bother messaging a supplier that day at all.
function buildAssignment({ supplierIds, note, packSize, packUnit, lowStockThreshold }) {
  const ids = Array.isArray(supplierIds) ? supplierIds.map(Number).filter(Boolean) : [];
  const assignment = { supplierIds: ids, note: note || '' };
  if (packSize !== undefined && packSize !== null && packSize !== '') assignment.packSize = Number(packSize);
  if (packUnit) assignment.packUnit = packUnit;
  if (lowStockThreshold !== undefined && lowStockThreshold !== null && lowStockThreshold !== '') {
    assignment.lowStockThreshold = Number(lowStockThreshold);
  }
  // Missed packUnit — a request setting ONLY packUnit (no supplierIds/note/packSize/threshold)
  // still judged "empty" and got silently deleted (delete map[ingredientId]) instead of saved.
  const isEmpty = !assignment.supplierIds.length && !assignment.note && !assignment.packSize
    && !assignment.packUnit && assignment.lowStockThreshold === undefined;
  return isEmpty ? null : assignment;
}

router.post('/product-suppliers', async (req, res) => {
  const { ingredientId } = req.body;
  if (!ingredientId) return res.status(400).json({ error: 'ingredientId required' });

  const map = await readJSON(FILE, {});
  const assignment = buildAssignment(req.body);
  if (!assignment) delete map[ingredientId];
  else map[ingredientId] = assignment;

  await writeJSON(FILE, map);
  res.json({ success: true });
});

router.post('/product-suppliers/batch', async (req, res) => {
  const { rows } = req.body; // [{ ingredientId, supplierIds, note, packSize, packUnit, lowStockThreshold }]
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

  const map = await readJSON(FILE, {});
  for (const row of rows) {
    if (!row.ingredientId) continue;
    const assignment = buildAssignment(row);
    if (!assignment) delete map[row.ingredientId];
    else map[row.ingredientId] = assignment;
  }
  await writeJSON(FILE, map);
  res.json({ success: true, saved: rows.length });
});

module.exports = router;
