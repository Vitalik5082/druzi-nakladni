// Standalone daily report — run via Windows Task Scheduler, doesn't need the Express server
// running. Reads local data files directly and calls Poster API directly.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const { posterCall, ymd, localDateStr, sleep, normalizeModName } = require('../lib/poster');
const { readJSON, writeJSON, nextId } = require('../lib/store');

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

async function getRecipients(role) {
  const all = await readJSON('telegramRecipients.json', []);
  return role ? all.filter(r => r.role === role) : all;
}

function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return localDateStr(d);
}

async function getYesterdayRevenue(date) {
  const response = await posterCall('dash.getProductsSales', { dateFrom: ymd(date), dateTo: ymd(date) });
  const items = (response || []).map(p => ({
    product_id: p.product_id, product_name: p.product_name,
    modificator_name: p.modificator_name || null,
    modification_id: p.modification_id && p.modification_id !== '0' ? p.modification_id : null,
    qty: Number(p.count) || 0, grossSum: Number(p.product_sum) / 100, profit: Number(p.product_profit) / 100
  }));

  // cache it too, same as the server's sync-sales, so the website stays in sync
  const sales = await readJSON('posterSales.json', {});
  sales[date] = items;
  await writeJSON('posterSales.json', sales);

  const revenue = Number(items.reduce((s, i) => s + i.grossSum, 0).toFixed(2));

  // "Каса" (cashdays.json) used to need a SEPARATE manual sync (the "Каса" page's own button) —
  // if nobody ever clicked it, the dashboard just silently had no revenue for that day forever.
  // Push it here too, same upsert rule as routes/poster.js's /poster/sync-cash: never touch a day
  // someone manually edited (edited: true).
  const cashDays = await readJSON('cashdays.json', []);
  let day = cashDays.find(d => d.date === date);
  if (day && !day.edited) {
    day.revenue = revenue;
    day.source = 'poster';
  } else if (!day) {
    cashDays.push({ id: nextId(cashDays), date, revenue, note: '', source: 'poster', edited: false });
  }
  await writeJSON('cashdays.json', cashDays);

  return revenue;
}

async function getYesterdayPayroll(date) {
  const response = await posterCall('finance.getTransactions', { dateFrom: ymd(date), dateTo: ymd(date) });
  return (response || [])
    .filter(t => Number(t.category_id) === 6)
    .reduce((s, t) => s + Math.abs(Number(t.amount)) / 100, 0);
}

// Real debt is the GROSS (з ПДВ) balance — paidAmount is recorded in з ПДВ terms (what actually
// gets paid to a supplier), so comparing it against the net total would understate debt by 20%.
function grossOf(inv) { return inv.total_with_vat || (inv.total || 0) * 1.2; }

async function getSupplierDebt() {
  const invoices = await readJSON('invoices.json', []);
  return invoices.reduce((s, inv) => s + Math.max(0, grossOf(inv) - (inv.paidAmount || 0)), 0);
}

async function computeOrderRecommendations() {
  const ingredientsRef = await readJSON('posterIngredients.json', {});
  const productSuppliers = await readJSON('productSuppliers.json', {});
  const sales = await readJSON('posterSales.json', {});
  const techcards = await readJSON('techcards.json', {});

  const dates = [];
  const today = new Date();
  for (let i = 1; i <= 28; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    dates.push(localDateStr(d));
  }

  const qtyByKey = {};
  for (const date of dates) {
    if (!sales[date]) continue;
    for (const item of sales[date]) {
      const key = item.modificator_name ? `${item.product_id}_${normalizeModName(item.modificator_name)}` : item.product_id;
      qtyByKey[key] = (qtyByKey[key] || 0) + item.qty;
    }
  }

  const consumption = {};
  for (const [key, qty] of Object.entries(qtyByKey)) {
    const card = techcards[key] || techcards[key.split('_')[0]];
    if (!card) continue;
    if (card.ingredients && card.ingredients.length) {
      for (const ing of card.ingredients) {
        const perUnit = ing.unit === 'p' ? ing.brutto : ing.netto;
        consumption[ing.ingredient_id] = (consumption[ing.ingredient_id] || 0) + perUnit * qty;
      }
    } else if (card.ingredient_id) {
      consumption[card.ingredient_id] = (consumption[card.ingredient_id] || 0) + qty;
    }
  }

  const items = [];
  for (const ing of Object.values(ingredientsRef)) {
    const raw = consumption[ing.ingredient_id] || 0;
    const avgWeeklyRaw = raw / 4;
    const avgWeekly = (ing.unit === 'l' || ing.unit === 'kg') ? avgWeeklyRaw / 1000 : avgWeeklyRaw;
    const leftover = Number(ing.left) || 0;
    const reliable = leftover >= 0;
    const recommendedQty = reliable ? Math.max(0, avgWeekly * 1.1 - leftover) : avgWeekly * 1.1;
    if (recommendedQty < 0.01) continue;
    const assignment = productSuppliers[ing.ingredient_id];
    const packSize = assignment && assignment.packSize;
    const packUnit = assignment && assignment.packUnit;
    items.push({
      name: ing.name, unit: ing.unit, recommendedQty,
      packSize: packSize || null, packUnit: packUnit || null,
      packsNeeded: packSize ? Math.ceil(recommendedQty / packSize) : null,
      supplierIds: (assignment && assignment.supplierIds) || []
    });
  }
  items.sort((a, b) => b.recommendedQty - a.recommendedQty);
  return items;
}

async function getTopOrderRecommendations(limit) {
  return (await computeOrderRecommendations()).slice(0, limit);
}

async function getSuppliersOrderingToday() {
  const suppliers = await readJSON('suppliers.json', []);
  const invoices = await readJSON('invoices.json', []);
  const allRecs = await computeOrderRecommendations();
  const todayWeekday = new Date().getDay(); // 0=Sun..6=Sat, matches orderDays convention

  return suppliers
    .filter(s => (s.orderDays || []).includes(todayWeekday))
    .map(s => {
      const items = allRecs.filter(i => i.supplierIds.includes(s.id));
      const debt = invoices
        .filter(inv => (inv.supplier || '').toLowerCase() === s.name.toLowerCase())
        .reduce((sum, inv) => sum + Math.max(0, grossOf(inv) - (inv.paidAmount || 0)), 0);
      return { name: s.name, contact: s.contact || '', items, debt };
    })
    .filter(s => s.items.length || s.debt > 0);
}

async function main() {
  const date = yesterday();

  // ── order-day section — the only thing non-admin roles (e.g. бармен) get ──
  const orderLines = [];
  let todaySuppliers = [];
  try {
    todaySuppliers = await getSuppliersOrderingToday();
    if (todaySuppliers.length) {
      orderLines.push('📦 <b>Сьогодні день замовлення:</b>');
      todaySuppliers.forEach(s => {
        orderLines.push(`\n<b>${s.name}</b>${s.debt > 0 ? ` — борг ${s.debt.toFixed(2)} ₴` : ''}`);
        if (s.contact) orderLines.push(`📞 ${s.contact}`);
        s.items.slice(0, 10).forEach(i => orderLines.push(`• ${i.name}: ${i.recommendedQty.toFixed(1)} ${i.unit}`));
        if (!s.items.length) orderLines.push('(немає конкретних рекомендацій — признач товари цьому постачальнику на сторінці "Постачальники товарів")');
      });
    }
  } catch (err) {
    orderLines.push(`📦 Нагадування про замовлення: помилка (${err.message})`);
  }

  try {
    const top = await getTopOrderRecommendations(5);
    if (top.length) {
      orderLines.push('', '🛒 <b>Загальний топ-5 на замовлення:</b>');
      top.forEach(i => orderLines.push(`• ${i.name}: ${i.recommendedQty.toFixed(1)} ${i.unit}`));
    }
  } catch (err) {
    orderLines.push(`🛒 Рекомендації: помилка (${err.message})`);
  }

  // ── full section — admin only: everything above, plus the financials ──
  const fullLines = [`📊 <b>Звіт за ${date}</b>`, ''];

  try {
    const revenue = await getYesterdayRevenue(date);
    fullLines.push(`💰 Виручка: <b>${revenue.toFixed(2)} ₴</b>`);
  } catch (err) {
    fullLines.push(`💰 Виручка: помилка (${err.message})`);
  }

  try {
    const payroll = await getYesterdayPayroll(date);
    fullLines.push(`👷 ЗП (з Poster): <b>${payroll.toFixed(2)} ₴</b>`);
  } catch (err) {
    fullLines.push(`👷 ЗП: помилка (${err.message})`);
  }

  try {
    const debt = await getSupplierDebt();
    fullLines.push(`📄 Борг постачальникам: <b>${debt.toFixed(2)} ₴</b>`);
  } catch (err) {
    fullLines.push(`📄 Борг: помилка (${err.message})`);
  }

  fullLines.push('', ...orderLines);

  const admins = await getRecipients('admin');
  // Бухгалтер (accountant) and постачальник (supplier) have no use for "who's ordering today" —
  // only waiters actually place the orders.
  const others = await getRecipients('waiter');

  for (const r of admins) {
    await sendTelegram(r.chatId, fullLines.join('\n'));
    console.log('Full report sent to', r.name);
  }
  for (const r of others) {
    if (!orderLines.length) continue;
    await sendTelegram(r.chatId, orderLines.join('\n'));
    console.log('Order-only report sent to', r.name);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Daily report failed:', err);
    process.exit(1);
  });
}
