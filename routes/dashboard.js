const express = require('express');
const { readJSON } = require('../lib/store');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const [cashDaysAll, invoicesAll, expensesAll, payrollAll, posterFinance] = await Promise.all([
    readJSON('cashdays.json', []),
    readJSON('invoices.json', []),
    readJSON('expenses.json', []),
    readJSON('payroll.json', []),
    readJSON('posterFinance.json', {})
  ]);

  const cashDays = cashDaysAll.filter(d => d.date >= from && d.date <= to);
  const invoices = invoicesAll.filter(i => i.date >= from && i.date <= to);
  const expenses = expensesAll.filter(e => e.date >= from && e.date <= to);
  const payroll = payrollAll.filter(p => p.date >= from && p.date <= to);

  const financeDates = Object.keys(posterFinance).filter(d => d >= from && d <= to);
  let payrollFromPoster = 0;
  let otherExpensesFromPoster = 0;
  for (const date of financeDates) {
    for (const t of posterFinance[date]) {
      if (t.category_id === 6) payrollFromPoster += t.amount;
      else otherExpensesFromPoster += t.amount;
    }
  }

  const revenue = cashDays.reduce((s, d) => s + (d.revenue || 0), 0);
  const goods = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const otherExpensesManual = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const payrollManual = payroll.reduce((s, p) => s + (p.amount || 0), 0);

  const otherExpenses = otherExpensesManual + otherExpensesFromPoster;
  const payrollTotal = payrollManual + payrollFromPoster;
  const profit = revenue - goods - otherExpenses - payrollTotal;
  const foodCostPct = revenue > 0 ? Number((goods / revenue * 100).toFixed(1)) : null;

  res.json({
    from, to,
    revenue, goods, otherExpenses, payroll: payrollTotal, profit, foodCostPct,
    payrollManual, payrollFromPoster, otherExpensesManual, otherExpensesFromPoster,
    cashDaysCount: cashDays.length, invoicesCount: invoices.length,
    expensesCount: expenses.length, payrollEntriesCount: payroll.length
  });
});

module.exports = router;
