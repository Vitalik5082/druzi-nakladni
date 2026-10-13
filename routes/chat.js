const express = require('express');
const OpenAI = require('openai');
const { readJSON } = require('../lib/store');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `Ти — асистент власника кафе/бару. Відповідай українською, коротко і по суті, конкретними цифрами з інструментів.
Якщо дані для відповіді відсутні (не синхронізовано), скажи прямо що саме треба синхронізувати (сторінки "Реалізація"/"Техкарти"/"Залишки"), не вигадуй цифри.
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
