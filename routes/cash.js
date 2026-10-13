const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'cashdays.json';

router.get('/cash-days', async (req, res) => {
  const { from, to } = req.query;
  let days = await readJSON(FILE, []);
  if (from) days = days.filter(d => d.date >= from);
  if (to) days = days.filter(d => d.date <= to);
  days.sort((a, b) => b.date.localeCompare(a.date));
  res.json(days);
});

// manual upsert by date — always marks the day as edited, overriding whatever Poster synced
router.post('/cash-days', async (req, res) => {
  const { date, revenue, note } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  if (revenue === undefined || isNaN(Number(revenue))) return res.status(400).json({ error: 'Revenue required' });

  const days = await readJSON(FILE, []);
  let day = days.find(d => d.date === date);
  if (day) {
    day.revenue = Number(revenue);
    day.note = note || '';
    day.source = 'manual';
    day.edited = true;
  } else {
    day = { id: nextId(days), date, revenue: Number(revenue), note: note || '', source: 'manual', edited: true };
    days.push(day);
  }

  await writeJSON(FILE, days);
  res.json(day);
});

router.delete('/cash-days/:id', async (req, res) => {
  const days = await readJSON(FILE, []);
  const filtered = days.filter(d => d.id !== Number(req.params.id));
  if (filtered.length === days.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
