// Standalone daily supplier stock digest — run via Windows Task Scheduler at 18:00, doesn't need
// the Express server running. For every registered Telegram recipient with role 'supplier', looks
// up which Poster ingredients are assigned to them (productSuppliers.json, the same assignment the
// "Постачальники товарів" page edits), pulls the LIVE current Poster leftover for just those
// ingredients, and sends a plain fact digest — not an order recommendation, just "this is what's
// currently on the shelf" so the supplier can judge what to bring.
//
// Each assignment can carry a `lowStockThreshold` (set directly in productSuppliers.json for now,
// no UI yet) — an ingredient is only included once its leftover drops below that number, and a
// supplier with nothing below threshold gets no message at all that day. No threshold set on an
// assignment means that ingredient is always included (old behaviour, unfiltered).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { posterCall } = require('../lib/poster');
const { readJSON } = require('../lib/store');

// Poster's raw unit codes mean nothing to an external supplier reading a Telegram message —
// everywhere else in the app shows these as-is (staff already know the codes), but this message
// goes to someone outside the system.
const UNIT_LABELS = { p: 'шт', kg: 'кг', l: 'л', g: 'г', ml: 'мл' };
function unitLabel(unit) { return UNIT_LABELS[unit] || unit; }

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

async function main() {
  const recipients = await readJSON('telegramRecipients.json', []);
  const supplierRecipients = recipients.filter(r => r.role === 'supplier' && r.supplierId);

  if (!supplierRecipients.length) {
    console.log('Немає зареєстрованих постачальників (role: "supplier") — дайджест не надіслано.');
    return;
  }

  const productSuppliers = await readJSON('productSuppliers.json', {});
  const ingredients = await posterCall('menu.getIngredients');

  for (const recipient of supplierRecipients) {
    const assignments = Object.entries(productSuppliers)
      .filter(([, a]) => (a.supplierIds || []).includes(recipient.supplierId))
      .map(([ingId, a]) => ({ id: Number(ingId), threshold: a.lowStockThreshold }));

    if (!assignments.length) {
      console.log(`${recipient.name}: немає прив'язаних інгредієнтів (сторінка "Постачальники товарів") — пропущено`);
      continue;
    }

    const lines = ['📦 <b>Поточні залишки:</b>'];
    for (const { id, threshold } of assignments) {
      const ing = ingredients.find(i => i.ingredient_id === id);
      if (!ing) continue;
      const left = Number(ing.ingredient_left);
      if (threshold !== undefined && left >= threshold) continue; // стабільний запас — не спамимо
      lines.push(`${ing.ingredient_name}: <b>${left.toFixed(0)} ${unitLabel(ing.ingredient_unit)}</b>`);
    }

    if (lines.length === 1) {
      console.log(`${recipient.name}: усе вище порогу — не надсилаємо сьогодні`);
      continue;
    }

    try {
      await sendTelegram(recipient.chatId, lines.join('\n'));
      console.log('Digest sent to', recipient.name);
    } catch (err) {
      console.error('Failed to send digest to', recipient.name, err.message);
    }
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Supplier stock digest failed:', err);
    process.exit(1);
  });
}
