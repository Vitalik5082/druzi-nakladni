// Telegram webhook — waiters photograph накладні, bot OCRs them (same pipeline as the website's
// upload) and files a pending-review invoice. Mounted BEFORE the Supabase-auth middleware in
// index.js since Telegram can't send a Bearer token; authenticity is instead checked via the
// secret_token Telegram echoes back in a header (set once via setWebhook).
const express = require('express');
const { readJSON } = require('../lib/store');
const { normalize } = require('../lib/convert');
const { recognizeInvoiceImage } = require('./recognition');
const { createInvoice } = require('./invoices');

const router = express.Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

async function reply(chatId, text) {
  try { await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }); }
  catch (e) { console.error('Telegram reply failed:', e); }
}

async function downloadPhotoBase64(fileId) {
  const fileInfo = await tg('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('Telegram getFile failed: ' + JSON.stringify(fileInfo));
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

// Fuzzy-ish: exact normalized match first, then substring either direction (OCR'd supplier names
// rarely match the saved name byte-for-byte — extra legal-entity suffixes, abbreviations, etc).
function findAllowedSupplier(suppliers, guessName) {
  if (!guessName) return null;
  const key = normalize(guessName);
  const allowed = suppliers.filter(s => s.telegramInvoicesAllowed);
  let match = allowed.find(s => normalize(s.name) === key);
  if (!match) match = allowed.find(s => key.includes(normalize(s.name)) || normalize(s.name).includes(key));
  return match || null;
}

router.post('/telegram/webhook', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  const message = req.body && req.body.message;
  if (!message) return res.sendStatus(200);

  const chatId = String(message.chat.id);

  try {
    const recipients = await readJSON('telegramRecipients.json', []);
    const sender = recipients.find(r => String(r.chatId) === chatId);

    if (!sender) {
      await reply(chatId, 'У вас немає доступу до цього бота. Зверніться до адміністратора.');
      return res.sendStatus(200);
    }

    if (!message.photo || !message.photo.length) {
      await reply(chatId, 'Надішліть фото накладної — я розпізнаю і додам її на перевірку.');
      return res.sendStatus(200);
    }

    await reply(chatId, '📷 Отримав, розпізнаю накладну...');

    const largest = message.photo[message.photo.length - 1];
    const base64 = await downloadPhotoBase64(largest.file_id);
    const result = await recognizeInvoiceImage(base64, 'image/jpeg');

    const suppliers = await readJSON('suppliers.json', []);
    const matchedSupplier = findAllowedSupplier(suppliers, result.supplier);

    if (!matchedSupplier) {
      await reply(chatId,
        `⚠️ Постачальника "${result.supplier || 'не розпізнано'}" не підключено для прийому через бота.\n` +
        `Розпізнано ${result.count} позицій. Передайте накладну адміну вручну.`);
      const admins = recipients.filter(r => r.role === 'admin' && String(r.chatId) !== chatId);
      for (const a of admins) {
        await reply(a.chatId,
          `⚠️ ${sender.name} надіслав(ла) через бот накладну від постачальника "${result.supplier || '—'}", ` +
          `якого не підключено (${result.count} позицій). Потрібна ручна обробка.`);
      }
      return res.sendStatus(200);
    }

    const created = await createInvoice({
      supplier: matchedSupplier.name,
      date: result.date,
      items: result.items,
      source: 'telegram',
      submittedBy: sender.name,
      pendingReview: true
    });

    if (created.duplicate) {
      await reply(chatId,
        `⚠️ Схожа накладна вже є в системі (${created.existing.supplier}, ${created.existing.date}, ` +
        `${created.existing.total.toFixed(2)} ₴). Не додав повторно.`);
      return res.sendStatus(200);
    }

    const inv = created.invoice;
    await reply(chatId,
      `✅ Накладну додано на перевірку!\nПостачальник: ${inv.supplier}\nДата: ${inv.date}\n` +
      `Сума: ${inv.total.toFixed(2)} ₴${result.warning ? '\n\n⚠️ ' + result.warning : ''}`);

    const others = recipients.filter(r => String(r.chatId) !== chatId);
    for (const r of others) {
      await reply(r.chatId,
        `🧾 Нова накладна від ${sender.name} (через бот):\n` +
        `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${inv.total.toFixed(2)} ₴\n` +
        `Статус: на перевірці. Перевірте на сайті в розділі "Накладні".`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err);
    await reply(chatId, '❌ Помилка обробки накладної: ' + (err.message || 'невідома помилка'));
    res.sendStatus(200);
  }
});

module.exports = router;
