const express = require('express');
const { convertItem, normalize } = require('../lib/convert');
const { readJSON, writeJSON } = require('../lib/store');
const fs = require('fs');
const path = require('path');

const router = express.Router();

function loadPortionRules() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'portions.json'), 'utf-8'));
  } catch (e) {
    return {};
  }
}

// Recompute qty/price/total for an item after the user manually changes its unit
router.post('/reclassify', (req, res) => {
  const { original_name, mapped_name, unit, qty, price } = req.body;
  if (!original_name || qty === undefined || price === undefined) {
    return res.status(400).json({ error: 'original_name, qty, price required' });
  }

  const mappedName = mapped_name || original_name;
  const portionRules = loadPortionRules();

  // Apply the requested unit as a one-off override (without persisting it)
  const tempOverrides = { [normalize(original_name)]: { unit } };

  const result = convertItem(
    { name: original_name, qty: Number(qty), unit, price: Number(price) },
    mappedName,
    portionRules,
    tempOverrides,
    0
  );

  res.json(result);
});

// Persist a learned unit override for a product name
router.post('/unit-overrides', async (req, res) => {
  const { name, unit } = req.body;
  if (!name || !unit) return res.status(400).json({ error: 'name and unit required' });

  const overrides = await readJSON('unitOverrides.json', {});
  overrides[normalize(name)] = { unit };
  await writeJSON('unitOverrides.json', overrides);

  res.json({ success: true });
});

module.exports = router;
