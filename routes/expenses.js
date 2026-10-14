const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');
const { createPosterExpenseTransaction } = require('../lib/poster');

const router = express.Router();
const FILE = 'expenses.json';

// Keep in sync with the <option> list on public/expenses.html. Every expense category maps to a
// real Poster finance category_id so "Інші витрати" always matches between our DB and Poster —
// Податки/Інтернет/Підписки/Хімія/Пакування/Ремонт didn't exist in Poster and were created via
// finance.createCategory specifically for this. "Інше" falls back to Poster's generic household
// expenses bucket, since there's no sensible dedicated category for a catch-all.
const CATEGORY_TO_POSTER = {
  'Оренда': 8, 'Комуналка': 9, 'Інтернет': 16, 'Податки': 15, 'Сміття': 12,
  'Підписки': 17, 'Хімія': 18, 'Пакування': 19, 'Маркетинг': 7, 'Ремонт': 20, 'Інше': 13
};

// Shared by the website's POST /expenses, the recurring-expenses "apply" endpoint, and the
// Telegram bot's бухгалтер flow — one place that both writes expenses.json AND pushes the same
// amount to Poster, so the two never drift apart. A Poster failure never blocks recording the
// expense locally (that's the source of truth for our own dashboard) — it's just flagged on the
// record so a failed sync can be found and retried/entered manually later.
async function createExpenseRecord(expenses, { date, category, description, amount }) {
  const expense = {
    id: nextId(expenses),
    date,
    category,
    description: description || '',
    amount: Number(amount),
    postedToPoster: false
  };

  const categoryId = CATEGORY_TO_POSTER[category];
  if (categoryId) {
    try {
      const transactionId = await createPosterExpenseTransaction({
        categoryId, amount: expense.amount, date: `${date} 12:00:00`,
        comment: description || category
      });
      expense.postedToPoster = true;
      expense.posterTransactionId = transactionId;
    } catch (err) {
      console.error('Poster finance sync failed for expense:', err.message);
    }
  }

  expenses.push(expense);
  return expense;
}

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
  const expense = await createExpenseRecord(expenses, { date, category, description, amount });
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

  const { name, category, amount, note, autoApply } = req.body;
  if (name !== undefined) template.name = name;
  if (category !== undefined) template.category = category;
  if (amount !== undefined) template.amount = Number(amount);
  if (note !== undefined) template.note = note;
  if (autoApply !== undefined) template.autoApply = !!autoApply;

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

    const expense = await createExpenseRecord(expenses, {
      date, category: template.category, description: template.name,
      amount: Number(item.amount) || template.amount
    });
    created.push(expense);
  }

  await writeJSON(FILE, expenses);
  res.json({ success: true, created, skipped });
});

module.exports = router;
module.exports.createExpenseRecord = createExpenseRecord;
