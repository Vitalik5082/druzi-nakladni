const express = require('express');
const OpenAI = require('openai');
const { readJSON } = require('../lib/store');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ти — асистент власника кафе/бару. Відповідай українською, коротко і по суті, конкретними цифрами з інструментів.
Для будь-якого питання про виручку, собівартість, витрати, ЗП, прибуток, рентабельність чи точку беззбитковості — ЗАВЖДИ викликай get_financial_summary, а не рахуй і не вигадуй цифри сам.
Якщо дані для відповіді відсутні (не синхронізовано), скажи прямо що саме треба синхронізувати (сторінки "Каса"/"Реалізація"/"Техкарти"/"Залишки"), не вигадуй цифри.
Сьогоднішня дата: ${new Date().toISOString().slice(0, 10)}.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_sales_for_product',
      description: 'Скільки продано конкретного товару (і на яку суму) за дату або період. Назва товару шукається нечітко (підрядок, без врахування регістру) по назві товару і назві модифікатора разом.',
      parameters: {
        type: 'object',
        properties: {
          productQuery: { type: 'string', description: 'Назва товару або товар+модифікатор, напр. "бургер класичний" або "кола"' },
          date: { type: 'string', description: 'Конкретна дата YYYY-MM-DD' },
          dateFrom: { type: 'string', description: 'Початок періоду YYYY-MM-DD (якщо не одна дата)' },
          dateTo: { type: 'string', description: 'Кінець періоду YYYY-MM-DD' }
        },
        required: ['productQuery']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_order_recommendations',
      description: 'Що рекомендовано замовити постачальникам зараз, на основі залишків і середньотижневої витрати. Можна фільтрувати по постачальнику.',
      parameters: {
        type: 'object',
        properties: {
          supplierQuery: { type: 'string', description: 'Назва постачальника (нечіткий пошук), напр. "Два Шефа". Якщо не вказано — всі.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_profitability',
      description: 'Маржинальність (прибуток на одиницю) по товарах меню за період — на основі ціни продажу з Poster і собівартості інгредієнтів з техкарт. Повертає як найменш, так і найбільш прибуткові.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'За скільки останніх днів рахувати (за замовчуванням 30)' },
          limit: { type: 'number', description: 'Скільки позицій повернути з кожного краю (за замовчуванням 10)' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_financial_summary',
      description: 'Фінансовий підсумок за період: виручка (каса), собівартість проданого (COGS, з Poster), інші витрати (оренда/комуналка/податки/хімія тощо — манулальні + з Poster), ЗП (ручна + з Poster), ЗП адміна (% від виручки), прибуток до і після ЗП адміна, фудкост %, і розрахована середньоденна точка беззбитковості (виручка за день, нижче якої день стає збитковим). Використовуй для БУДЬ-ЯКОГО питання про прибуток, витрати, ЗП, рентабельність чи беззбитковість — ніколи не рахуй ці цифри сам.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'За скільки останніх днів (за замовчуванням 30)' },
          dateFrom: { type: 'string', description: 'Початок періоду YYYY-MM-DD (альтернатива days)' },
          dateTo: { type: 'string', description: 'Кінець періоду YYYY-MM-DD' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_worst_sellers',
      description: 'Які товари найгірше (і найкраще) продаються за кількістю проданих одиниць за період.',
      parameters: {
        type: 'object',
        properties: {
          days: { type: 'number', description: 'За скільки останніх днів (за замовчуванням 30)' },
          limit: { type: 'number', description: 'Скільки позицій повернути (за замовчуванням 10)' }
        }
      }
    }
  }
];

function lastNDates(days) {
  const dates = [];
  const today = new Date();
  for (let i = 0; i <= days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${day}`);
  }
  return dates;
}

async function aggregateSales(dates) {
  const sales = await readJSON('posterSales.json', {});
  const byKey = {};
  for (const date of dates) {
    if (!sales[date]) continue;
    for (const item of sales[date]) {
      const key = item.product_id + '_' + (item.modificator_name || '');
      if (!byKey[key]) {
        byKey[key] = { product_id: item.product_id, product_name: item.product_name,
          modificator_name: item.modificator_name, qty: 0, grossSum: 0 };
      }
      byKey[key].qty += item.qty;
      byKey[key].grossSum += item.grossSum;
    }
  }
  return Object.values(byKey);
}

function techcardCostPerUnit(card, ingredientsRef) {
  if (!card) return null;
  if (card.ingredients && card.ingredients.length) {
    let cost = 0;
    for (const ing of card.ingredients) {
      const ref = ingredientsRef[ing.ingredient_id];
      if (!ref) continue;
      const qty = ing.unit === 'p' ? ing.brutto : ing.netto;
      const qtyInBaseUnit = (ing.unit === 'g' || ing.unit === 'ml') ? qty / 1000 : qty;
      cost += qtyInBaseUnit * ref.prime_cost;
    }
    return cost;
  }
  if (card.ingredient_id) {
    const ref = ingredientsRef[card.ingredient_id];
    return ref ? ref.prime_cost : null;
  }
  return null;
}

async function executeTool(name, args) {
  if (name === 'get_sales_for_product') {
    const dates = args.date ? [args.date] : (args.dateFrom && args.dateTo
      ? (() => { const out = []; let d = new Date(args.dateFrom + 'T00:00:00'); const end = new Date(args.dateTo + 'T00:00:00');
          while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); } return out; })()
      : lastNDates(30));

    const q = (args.productQuery || '').toLowerCase();
    const sales = await aggregateSales(dates);
    const matches = sales.filter(i =>
      (i.product_name + ' ' + (i.modificator_name || '')).toLowerCase().includes(q) ||
      q.split(' ').every(w => (i.product_name + ' ' + (i.modificator_name || '')).toLowerCase().includes(w))
    );
    return { dates, matches };
  }

  if (name === 'get_order_recommendations') {
    const [ingredientsRef, productSuppliers, suppliers, sales, techcards] = await Promise.all([
      readJSON('posterIngredients.json', {}),
      readJSON('productSuppliers.json', {}),
      readJSON('suppliers.json', []),
      readJSON('posterSales.json', {}),
      readJSON('techcards.json', {})
    ]);

    // mirror of computeConsumption/order-recommendations logic in routes/poster.js
    const dates = lastNDates(28);
    const qtyByKey = {};
    for (const date of dates) {
      if (!sales[date]) continue;
      for (const item of sales[date]) {
        const key = item.modificator_name ? `${item.product_id}_${(item.modificator_name || '').toLowerCase().trim()}` : item.product_id;
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
          if (!consumption[ing.ingredient_id]) consumption[ing.ingredient_id] = 0;
          consumption[ing.ingredient_id] += perUnit * qty;
        }
      } else if (card.ingredient_id) {
        if (!consumption[card.ingredient_id]) consumption[card.ingredient_id] = 0;
        consumption[card.ingredient_id] += qty;
      }
    }

    const items = [];
    for (const ing of Object.values(ingredientsRef)) {
      const consumedRaw = consumption[ing.ingredient_id] || 0;
      const avgWeeklyRaw = consumedRaw / 4;
      const avgWeekly = (ing.unit === 'l' || ing.unit === 'kg') ? avgWeeklyRaw / 1000 : avgWeeklyRaw;
      const leftover = Number(ing.left) || 0;
      const reliable = leftover >= 0;
      const recommendedQty = reliable ? Math.max(0, avgWeekly * 1.1 - leftover) : avgWeekly * 1.1;
      if (recommendedQty < 0.01) continue;

      const assignment = productSuppliers[ing.ingredient_id];
      const assignedSuppliers = (assignment && assignment.supplierIds || [])
        .map(id => suppliers.find(s => s.id === Number(id))).filter(Boolean);

      if (args.supplierQuery) {
        const q = args.supplierQuery.toLowerCase();
        if (!assignedSuppliers.some(s => s.name.toLowerCase().includes(q))) continue;
      }

      items.push({
        name: ing.name, unit: ing.unit, recommendedQty: Number(recommendedQty.toFixed(2)),
        suppliers: assignedSuppliers.map(s => s.name)
      });
    }
    items.sort((a, b) => b.recommendedQty - a.recommendedQty);
    return { items: items.slice(0, 40) };
  }

  if (name === 'get_profitability') {
    const days = args.days || 30;
    const limit = args.limit || 10;
    const [ingredientsRef, techcards] = await Promise.all([
      readJSON('posterIngredients.json', {}),
      readJSON('techcards.json', {})
    ]);

    const rawSales = await aggregateSales(lastNDates(days));
    const sales = rawSales.filter(i => i.qty > 0);
    const results = sales.map(s => {
      const key = s.modificator_name ? `${s.product_id}_${s.modificator_name.toLowerCase().trim()}` : s.product_id;
      const card = techcards[key] || techcards[s.product_id];
      const cost = techcardCostPerUnit(card, ingredientsRef);
      const avgPrice = s.grossSum / s.qty;
      const margin = cost !== null ? avgPrice - cost : null;
      return {
        name: s.product_name + (s.modificator_name ? ' ' + s.modificator_name : ''),
        qtySold: Number(s.qty.toFixed(1)),
        avgPrice: Number(avgPrice.toFixed(2)),
        costPerUnit: cost !== null ? Number(cost.toFixed(2)) : null,
        marginPerUnit: margin !== null ? Number(margin.toFixed(2)) : null
      };
    }).filter(r => r.marginPerUnit !== null);

    results.sort((a, b) => a.marginPerUnit - b.marginPerUnit);
    return {
      leastProfitable: results.slice(0, limit),
      mostProfitable: results.slice(-limit).reverse(),
      note: 'Собівартість рахується з техкарт і поточних цін інгредієнтів Poster — може не відображати найсвіжіші закупівельні ціни.'
    };
  }

  if (name === 'get_financial_summary') {
    let from, to;
    if (args.dateFrom && args.dateTo) {
      from = args.dateFrom; to = args.dateTo;
    } else {
      const dates = lastNDates(args.days || 30);
      to = dates[0];
      from = dates[dates.length - 1];
    }

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
    if (!cashDays.length) {
      return { from, to, error: 'Немає даних каси (виручки) за цей період — потрібно внести дні в розділі "Каса".' };
    }

    const invoices = invoicesAll.filter(i => i.date >= from && i.date <= to);
    const expenses = expensesAll.filter(e => e.date >= from && e.date <= to);
    const payroll = payrollAll.filter(p => p.date >= from && p.date <= to);

    // mirror of routes/dashboard.js — kept as a self-contained copy rather than imported, same as
    // the other chat tools above
    const financeDates = Object.keys(posterFinance).filter(d => d >= from && d <= to);
    let payrollFromPoster = 0, otherExpensesFromPoster = 0;
    for (const date of financeDates) {
      for (const t of posterFinance[date]) {
        if (t.category_id === 6) payrollFromPoster += t.amount;
        else otherExpensesFromPoster += t.amount;
      }
    }

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

    let chemistryCost = 0;
    for (const inv of invoices) {
      for (const item of inv.items || []) {
        if (!item.skipped && item.isChemistry) chemistryCost += item.total || 0;
      }
    }

    const otherExpensesManual = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const payrollManual = payroll.reduce((s, p) => s + (p.amount || 0), 0);
    const otherExpenses = Number((otherExpensesManual + otherExpensesFromPoster + chemistryCost).toFixed(2));
    const payrollTotal = payrollManual + payrollFromPoster;

    const adminPct = employees.filter(e => e.payType === 'percent_of_revenue').reduce((s, e) => s + (Number(e.percent) || 0), 0);
    const adminSalary = Number((revenue * adminPct / 100).toFixed(2));

    const profitBeforeAdmin = Number((revenue - cogs - otherExpenses - payrollTotal).toFixed(2));
    const profitAfterAdmin = Number((profitBeforeAdmin - adminSalary).toFixed(2));
    const foodCostPct = revenue > 0 ? Number((cogs / revenue * 100).toFixed(1)) : null;

    // Break-even: COGS and admin salary scale with revenue (both are ~% of revenue), everything
    // else (payroll, rent, utilities, taxes, chemistry...) is treated as fixed per day, averaged
    // over the period. profit(R) = R*(1 - foodCost% - adminPct%) - fixedPerDay = 0 solved for R.
    const daysCount = cashDays.length;
    const avgRevenuePerDay = Number((revenue / daysCount).toFixed(2));
    const avgFixedCostPerDay = Number(((otherExpenses + payrollTotal) / daysCount).toFixed(2));
    const variableRateFraction = (foodCostPct || 0) / 100 + adminPct / 100;
    const breakevenRevenuePerDay = variableRateFraction < 1
      ? Number((avgFixedCostPerDay / (1 - variableRateFraction)).toFixed(2))
      : null;

    return {
      from, to, daysWithCashData: daysCount,
      revenue, cogs, foodCostPct, otherExpenses, payroll: payrollTotal,
      adminPct, adminSalary, profitBeforeAdmin, profitAfterAdmin,
      avgRevenuePerDay, avgFixedCostPerDay, breakevenRevenuePerDay,
      note: breakevenRevenuePerDay === null
        ? 'Неможливо порахувати точку беззбитковості: собівартість% + ЗП адміна% від виручки разом ≥100%.'
        : `Точка беззбитковості ≈ ${breakevenRevenuePerDay} ₴ виручки/день: середні фіксовані щоденні витрати (ЗП персоналу + оренда/комуналка/податки/хімія/інше) за цей період — ${avgFixedCostPerDay} ₴/день, а собівартість (${foodCostPct}% виручки) і ЗП адміна (${adminPct}% виручки) масштабуються з виручкою. Нижче цієї виручки за день — збиток.`
    };
  }

  if (name === 'get_worst_sellers') {
    const days = args.days || 30;
    const limit = args.limit || 10;
    const sales = await aggregateSales(lastNDates(days));
    const sorted = sales.map(s => ({
      name: s.product_name + (s.modificator_name ? ' ' + s.modificator_name : ''),
      qtySold: Number(s.qty.toFixed(1)),
      grossSum: Number(s.grossSum.toFixed(2))
    })).sort((a, b) => a.qtySold - b.qtySold);
    return { worstSellers: sorted.slice(0, limit), bestSellers: sorted.slice(-limit).reverse() };
  }

  return { error: 'unknown tool' };
}

router.post('/chat', async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'messages required' });

  try {
    let convo = [{ role: 'system', content: SYSTEM_PROMPT }, ...messages];
    let finalAnswer = null;
    const toolLog = [];

    for (let i = 0; i < 5 && finalAnswer === null; i++) {
      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: convo,
        tools: TOOLS,
        tool_choice: 'auto'
      });
      const msg = response.choices[0].message;

      if (msg.tool_calls && msg.tool_calls.length) {
        convo.push(msg);
        for (const tc of msg.tool_calls) {
          let args = {};
          try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
          const result = await executeTool(tc.function.name, args);
          toolLog.push({ name: tc.function.name, args });
          convo.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result) });
        }
      } else {
        finalAnswer = msg.content;
      }
    }

    res.json({ answer: finalAnswer || 'Не вдалося отримати відповідь за 5 кроків.', toolLog });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
