// Monthly profit report — run via Windows Task Scheduler on the 1st of each month.
// Admin-only (mirrors routes/dashboard.js's calculation, standalone so it doesn't need Express).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { readJSON } = require('../lib/store');

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN не задано в .env');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
  });
  const data = await res.json();
  if (!data.ok) throw new Error('Telegram: ' + JSON.stringify(data));
}

function previousMonthRange() {
  const today = new Date();
  const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const lastOfPrevMonth = new Date(firstOfThisMonth - 1);
  const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
  const fmt = d => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  return { from: fmt(firstOfPrevMonth), to: fmt(lastOfPrevMonth) };
}

function computeDashboard(from, to) {
  const cashDays = readJSON('cashdays.json', []).filter(d => d.date >= from && d.date <= to);
  const invoices = readJSON('invoices.json', []).filter(i => i.date >= from && i.date <= to);
  const expenses = readJSON('expenses.json', []).filter(e => e.date >= from && e.date <= to);
  const payroll = readJSON('payroll.json', []).filter(p => p.date >= from && p.date <= to);

  const posterFinance = readJSON('posterFinance.json', {});
  const financeDates = Object.keys(posterFinance).filter(d => d >= from && d <= to);
  let payrollFromPoster = 0, otherExpensesFromPoster = 0;
  for (const date of financeDates) {
    for (const t of posterFinance[date]) {
      if (t.category_id === 6) payrollFromPoster += t.amount;
      else otherExpensesFromPoster += t.amount;
    }
  }

  const revenue = cashDays.reduce((s, d) => s + (d.revenue || 0), 0);
  const goods = invoices.reduce((s, i) => s + (i.total || 0), 0);
  const otherExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0) + otherExpensesFromPoster;
  const payrollTotal = payroll.reduce((s, p) => s + (p.amount || 0), 0) + payrollFromPoster;
  const profit = revenue - goods - otherExpenses - payrollTotal;
  const foodCostPct = revenue > 0 ? (goods / revenue * 100) : null;

  return { revenue, goods, otherExpenses, payroll: payrollTotal, profit, foodCostPct };
}

async function main() {
  const { from, to } = previousMonthRange();
  const d = computeDashboard(from, to);

  const lines = [
    `📅 <b>Місячний звіт: ${from} — ${to}</b>`, '',
    `💰 Виручка: <b>${d.revenue.toFixed(2)} ₴</b>`,
    `📦 Товари (накладні): ${d.goods.toFixed(2)} ₴`,
    `🧾 Інші витрати: ${d.otherExpenses.toFixed(2)} ₴`,
    `👷 ЗП: ${d.payroll.toFixed(2)} ₴`,
    `📊 Фудкост: ${d.foodCostPct !== null ? d.foodCostPct.toFixed(1) + '%' : '—'}`,
    '',
    `${d.profit >= 0 ? '✅' : '⚠️'} <b>Чистий прибуток: ${d.profit.toFixed(2)} ₴</b>`
  ];

  const recipients = readJSON('telegramRecipients.json', []).filter(r => r.role === 'admin');
  for (const r of recipients) {
    await sendTelegram(r.chatId, lines.join('\n'));
    console.log('Monthly report sent to', r.name);
  }
}

main().catch(err => {
  console.error('Monthly report failed:', err);
  process.exit(1);
});
