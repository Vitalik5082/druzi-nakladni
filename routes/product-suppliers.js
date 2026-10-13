const express = require('express');
const { readJSON, writeJSON } = require('../lib/store');

const router = express.Router();
const FILE = 'productSuppliers.json';

router.get('/product-suppliers', async (req, res) => {
  res.json(await readJSON(FILE, {}));
});

router.post('/product-suppliers', async (req, res) => {
  const { ingredientId, supplierIds, note } = req.body;
  if (!ingredientId) return res.status(400).json({ error: 'ingredientId required' });

  const map = await readJSON(FILE, {});
  const ids = Array.isArray(supplierIds) ? supplierIds.map(Number).filter(Boolean) : [];

  if (!ids.length && !note) {
    delete map[ingredientId];
  } else {
    map[ingredientId] = { supplierIds: ids, note: note || '' };
  }
  await writeJSON(FILE, map);
  res.json({ success: true });
});

router.post('/product-suppliers/batch', async (req, res) => {
  const { rows } = req.body; // [{ ingredientId, supplierIds, note }]
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

  const map = await readJSON(FILE, {});
  for (const row of rows) {
    if (!row.ingredientId) continue;
    const ids = Array.isArray(row.supplierIds) ? row.supplierIds.map(Number).filter(Boolean) : [];
    if (!ids.length && !row.note) {
      delete map[row.ingredientId];
    } else {
      map[row.ingredientId] = { supplierIds: ids, note: row.note || '' };
    }
  }
  await writeJSON(FILE, map);
  res.json({ success: true, saved: rows.length });
});

module.exports = router;
