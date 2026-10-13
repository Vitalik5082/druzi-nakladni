const express = require('express');
const { readJSON } = require('../lib/store');

const router = express.Router();

router.get('/dashboard', async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to required' });

  const [cashDaysAll, invoicesAll, expensesAll, payrollAll, posterFinance, employees, posterSales] = await Promise.all([
    readJSON('cashdays.json', []),
    readJSON('invoices.json', []),
    readJSON('expenses.json', []),
    readJSON('payroll.json', []),
    readJSON('posterFinance.json', {}),
    readJSON('employees.json', []),
    readJSON('posterSales.json', {})
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

  // Собівартість проданих товарів — так само, як рахує сам Poster: кожен проданий рядок вже
  // несе product_profit (= product_sum мінус собівартість за техкартою на момент продажу), тож
  // cogs = sum(grossSum) - sum(profit). Це НЕ те саме, що "goods" (сума накладних за період) —
  // накладні відображають закупівлю (кеш-відтік постачальникам), а не собівартість того, що
  // реально продано цього періоду; раніше прибуток віднімав лише накладні, через що за місяці
  // без заведених накладних (вересень/жовтень) прибуток виглядав сильно завищеним.
  const salesDates = Object.keys(posterSales).filter(d => d >= from && d <= to);
  let salesGross = 0, salesProfit = 0;
  for (const date of salesDates) {
    for (const item of posterSales[date] || []) {
      salesGross += item.grossSum || 0;
      salesProfit += item.profit || 0;
    }
  }
  const cogs = Number((salesGross - salesProfit).toFixed(2));

  const revenue = cashDays.reduce((s, d) => s + (d.revenue || 0), 0);
  const goods = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const otherExpensesManual = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const payrollManual = payroll.reduce((s, p) => s + (p.amount || 0), 0);

  const otherExpenses = otherExpensesManual + otherExpensesFromPoster;
  const payrollTotal = payrollManual + payrollFromPoster;

  // Адмін отримує % від виручки — рахується окремо від іншої ЗП, щоб завжди бути видимим,
  // а не загубленим серед "інших витрат" (нараховується щойно, не через payroll.json/Poster).
  const adminPct = employees
    .filter(e => e.payType === 'percent_of_revenue')
    .reduce((s, e) => s + (Number(e.percent) || 0), 0);
  const adminSalary = Number((revenue * adminPct / 100).toFixed(2));

  const profitBeforeAdmin = Number((revenue - cogs - otherExpenses - payrollTotal).toFixed(2));
  const profitAfterAdmin = Number((profitBeforeAdmin - adminSalary).toFixed(2));
  const foodCostPct = revenue > 0 ? Number((cogs / revenue * 100).toFixed(1)) : null;

  res.json({
    from, to,
    revenue, cogs, goods, otherExpenses, payroll: payrollTotal,
    profit: profitBeforeAdmin, foodCostPct,
    adminSalary, adminPct, profitBeforeAdmin, profitAfterAdmin,
    payrollManual, payrollFromPoster, otherExpensesManual, otherExpensesFromPoster,
    cashDaysCount: cashDays.length, invoicesCount: invoices.length,
    expensesCount: expenses.length, payrollEntriesCount: payroll.length,
    salesDaysCount: salesDates.length
  });
});

module.exports = router;
