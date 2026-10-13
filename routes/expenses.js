const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'expenses.json';

router.get('/expenses', async (req, res) => {
  const { category, from, to } = req.query;
  let expenses = await readJSON(FILE, []);
  if (category) expenses = expenses.filter(e => e.category === category);
  if (from) expenses = expenses.filter(e => e.date >= from);
  if (to) expenses = expenses.filter(e => e.date <= to);
  expenses.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  res.json(expenses);
});

router.post('/expenses', async (req, res) => {
  const { date, category, description, amount } = req.body;
  if (!date) return res.status(400).json({ error: 'Date required' });
  if (!category) return res.status(400).json({ error: 'Category required' });
  if (amount === undefined || isNaN(Number(amount))) return res.status(400).json({ error: 'Amount required' });

  const expenses = await readJSON(FILE, []);
  const expense = {
    id: nextId(expenses),
    date,
    category,
    description: description || '',
    amount: Number(amount)
  };
  expenses.push(expense);
  await writeJSON(FILE, expenses);
  res.json(expense);
});

router.delete('/expenses/:id', async (req, res) => {
  const expenses = await readJSON(FILE, []);
  const filtered = expenses.filter(e => e.id !== Number(req.params.id));
  if (filtered.length === expenses.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

// ── RECURRING EXPENSES (регулярні щомісячні витрати) ───────────────
const RECURRING_FILE = 'recurringExpenses.json';

router.get('/recurring-expenses', async (req, res) => {
  res.json(await readJSON(RECURRING_FILE, []));
});

router.post('/recurring-expenses', async (req, res) => {
  const { name, category, amount, note } = req.body;
  if (!name || !category) return res.status(400).json({ error: 'name and category required' });
  if (amount === undefined || isNaN(Number(amount))) return res.status(400).json({ error: 'amount required' });

  const templates = await readJSON(RECURRING_FILE, []);
  const template = { id: nextId(templates), name, category, amount: Number(amount), note: note || '' };
  templates.push(template);
  await writeJSON(RECURRING_FILE, templates);
  res.json(template);
});

router.patch('/recurring-expenses/:id', async (req, res) => {
  const templates = await readJSON(RECURRING_FILE, []);
  const template = templates.find(t => t.id === Number(req.params.id));
  if (!template) return res.status(404).json({ error: 'Not found' });

  const { name, category, amount, note } = req.body;
  if (name !== undefined) template.name = name;
  if (category !== undefined) template.category = category;
  if (amount !== undefined) template.amount = Number(amount);
  if (note !== undefined) template.note = note;

  await writeJSON(RECURRING_FILE, templates);
  res.json(template);
});

router.delete('/recurring-expenses/:id', async (req, res) => {
  const templates = await readJSON(RECURRING_FILE, []);
  const filtered = templates.filter(t => t.id !== Number(req.params.id));
  if (filtered.length === templates.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(RECURRING_FILE, filtered);
  res.json({ success: true });
});

// Create one expense entry per selected template for a given month. Skips a template if an
// expense with the same name+category already exists that month, so clicking "apply" twice
// for the same month doesn't duplicate entries.
router.post('/recurring-expenses/apply', async (req, res) => {
  const { month, items } = req.body; // month: 'YYYY-MM', items: [{ id, amount }]
  if (!month || !Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'month and items required' });
  }

  const templates = await readJSON(RECURRING_FILE, []);
  const expenses = await readJSON(FILE, []);
  const date = `${month}-01`;
  const created = [];
  const skipped = [];

  for (const item of items) {
    const template = templates.find(t => t.id === Number(item.id));
    if (!template) continue;

    const alreadyApplied = expenses.some(e =>
      e.date.slice(0, 7) === month && e.category === template.category && e.description === template.name);
    if (alreadyApplied) { skipped.push(template.name); continue; }

    const expense = {
      id: nextId(expenses),
      date,
      category: template.category,
      description: template.name,
      amount: Number(item.amount) || template.amount
    };
    expenses.push(expense);
    created.push(expense);
  }

  await writeJSON(FILE, expenses);
  res.json({ success: true, created, skipped });
});

module.exports = router;
