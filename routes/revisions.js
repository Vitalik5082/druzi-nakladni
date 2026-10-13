const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'revisions.json';

router.get('/revisions', async (req, res) => {
  const revisions = await readJSON(FILE, []);
  revisions.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  res.json(revisions);
});

router.get('/revisions/:id', async (req, res) => {
  const revisions = await readJSON(FILE, []);
  const revision = revisions.find(r => r.id === Number(req.params.id));
  if (!revision) return res.status(404).json({ error: 'Not found' });
  res.json(revision);
});

router.post('/revisions', async (req, res) => {
  const { date, items, note } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });

  const processedItems = items.map(item => {
    const theoretical = Number(item.theoretical) || 0;
    const actual = Number(item.actual) || 0;
    const unitPrice = Number(item.unitPrice) || 0;
    const diff = Number((actual - theoretical).toFixed(3));
    const diffValue = Number((diff * unitPrice).toFixed(2));
    return { name: item.name, theoretical, actual, unitPrice, diff, diffValue };
  });

  const totalLossValue = Number(processedItems.reduce((s, i) => s + i.diffValue, 0).toFixed(2));

  const revisions = await readJSON(FILE, []);
  const revision = {
    id: nextId(revisions),
    date,
    items: processedItems,
    totalLossValue,
    note: note || '',
    createdAt: new Date().toISOString()
  };
  revisions.push(revision);
  await writeJSON(FILE, revisions);
  res.json(revision);
});

router.delete('/revisions/:id', async (req, res) => {
  const revisions = await readJSON(FILE, []);
  const filtered = revisions.filter(r => r.id !== Number(req.params.id));
  if (filtered.length === revisions.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
