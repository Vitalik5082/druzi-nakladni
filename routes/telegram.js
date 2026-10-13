// Telegram webhook — waiters photograph накладні, bot OCRs them (same pipeline as the website's
// upload) and files a pending-review invoice, then asks (inline buttons) whether it was already
// paid. Mounted BEFORE the Supabase-auth middleware in index.js since Telegram can't send a
// Bearer token; authenticity is instead checked via the secret_token Telegram echoes back in a
// header (set once via setWebhook).
const express = require('express');
const { readJSON } = require('../lib/store');
const { normalize } = require('../lib/convert');
const { localDateStr } = require('../lib/poster');
const { recognizeInvoiceImage } = require('./recognition');
const { createInvoice, updateInvoice } = require('./invoices');

const router = express.Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FILE = 'invoices.json';

async function tg(method, params) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  return res.json();
}

async function reply(chatId, text) {
  try { return await tg('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML' }); }
  catch (e) { console.error('Telegram reply failed:', e); }
}

async function downloadPhotoBase64(fileId) {
  const fileInfo = await tg('getFile', { file_id: fileId });
  if (!fileInfo.ok) throw new Error('Telegram getFile failed: ' + JSON.stringify(fileInfo));
  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${fileInfo.result.file_path}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.toString('base64');
}

async function askPaymentStatus(chatId, invoiceId) {
  try {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '💳 Ця накладна вже оплачена?',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Так, оплачено', callback_data: `pay:yes:${invoiceId}` },
        { text: '❌ Ні, в борг', callback_data: `pay:no:${invoiceId}` }
      ]] }
    });
  } catch (e) { console.error('Telegram reply failed:', e); }
}

// Fuzzy-ish: exact normalized match first, then substring either direction (OCR'd supplier names
// rarely match the saved name byte-for-byte — extra legal-entity suffixes, abbreviations, etc).
// Matches against ALL suppliers, not just telegramInvoicesAllowed ones — the server accepts every
// накладна regardless; that flag only decides who gets notified (see webhook handler below).
function findSupplier(suppliers, guessName) {
  if (!guessName) return null;
  const key = normalize(guessName);
  let match = suppliers.find(s => normalize(s.name) === key);
  if (!match) match = suppliers.find(s => key.includes(normalize(s.name)) || normalize(s.name).includes(key));
  return match || null;
}

async function handleCallback(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data || '';
  const [, action, idStr] = data.match(/^pay:(yes|no):(\d+)$/) || [];

  if (!action) { await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id }); return; }

  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(idStr));
  if (!invoice) {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Накладну не знайдено' });
    return;
  }

  if (action === 'yes') {
    await updateInvoice(invoice.id, { paidAmount: invoice.total, paidDate: localDateStr() });
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Позначено як оплачено' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `✅ Оплачено (${invoice.total.toFixed(2)} ₴, ${localDateStr()})`
    });
  } else {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Записано як борг' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `📝 Записано як борг (${invoice.total.toFixed(2)} ₴)`
    });
  }
}

router.post('/telegram/webhook', async (req, res) => {
  const secret = req.headers['x-telegram-bot-api-secret-token'];
  if (process.env.TELEGRAM_WEBHOOK_SECRET && secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    return res.sendStatus(401);
  }

  if (req.body && req.body.callback_query) {
    try { await handleCallback(req.body.callback_query); }
    catch (err) { console.error('Telegram callback error:', err); }
    return res.sendStatus(200);
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
    const matchedSupplier = findSupplier(suppliers, result.supplier);
    const forwardToAccountant = !!(matchedSupplier && matchedSupplier.telegramInvoicesAllowed);

    const created = await createInvoice({
      supplier: matchedSupplier ? matchedSupplier.name : (result.supplier || ''),
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

    await askPaymentStatus(chatId, inv.id);

    // telegramInvoicesAllowed on the matched supplier decides who else gets notified right away:
    // checked → everyone (incl. бухгалтер); unchecked/unmatched → admins only, for manual triage.
    const notifyRoles = forwardToAccountant ? null : ['admin'];
    const toNotify = recipients.filter(r =>
      String(r.chatId) !== chatId && (!notifyRoles || notifyRoles.includes(r.role)));

    for (const r of toNotify) {
      await reply(r.chatId,
        `🧾 Нова накладна від ${sender.name} (через бот):\n` +
        `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${inv.total.toFixed(2)} ₴\n` +
        `Статус: на перевірці.${forwardToAccountant ? '' : ' Постачальника не позначено для автопересилки — перевірте вручну.'}\n` +
        `Перевірте на сайті в розділі "Накладні".`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err);
    await reply(chatId, '❌ Помилка обробки накладної: ' + (err.message || 'невідома помилка'));
    res.sendStatus(200);
  }
});

module.exports = router;
