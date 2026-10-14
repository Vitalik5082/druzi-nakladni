// Telegram webhook — waiters photograph накладні, bot OCRs them (same pipeline as the website's
// upload) and files a pending-review invoice, then asks (inline buttons) whether it was already
// paid. Mounted BEFORE the Supabase-auth middleware in index.js since Telegram can't send a
// Bearer token; authenticity is instead checked via the secret_token Telegram echoes back in a
// header (set once via setWebhook).
const express = require('express');
const { readJSON, writeJSON } = require('../lib/store');
const { normalize } = require('../lib/convert');
const { localDateStr } = require('../lib/poster');
const { recognizeInvoiceImage, recognizeReceiptImage } = require('./recognition');
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

async function markInvoicePaid(invoice, paidDate) {
  await updateInvoice(invoice.id, { paidAmount: invoice.total, paidDate: paidDate || localDateStr() });
}

// Broadcasts a payment-status change to admin+бухгалтер so they see it without checking the site —
// excludeChatId skips whoever's chat the action happened in (they already saw it via editMessageText).
async function notifyStatusChange(invoice, statusText, excludeChatId) {
  const recipients = await readJSON('telegramRecipients.json', []);
  const toNotify = recipients.filter(r =>
    ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== String(excludeChatId));
  for (const r of toNotify) {
    await reply(r.chatId,
      `🔄 Статус накладної змінено (${invoice.supplier}, ${invoice.date}, ${invoice.total.toFixed(2)} ₴):\n${statusText}`);
  }
}

async function handleCallback(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data || '';

  const payMatch = data.match(/^pay:(yes|no):(\d+)$/);
  const receiptMatch = data.match(/^recv:(\d+)$/);

  if (!payMatch && !receiptMatch) {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    return;
  }

  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(payMatch ? payMatch[2] : receiptMatch[1]));
  if (!invoice) {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Накладну не знайдено' });
    return;
  }

  if (receiptMatch) {
    await markInvoicePaid(invoice);
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Оплату прив\'язано' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `✅ Чек прив'язано до: ${invoice.supplier}, ${invoice.date}, ${invoice.total.toFixed(2)} ₴`
    });
    await notifyStatusChange(invoice, `✅ Оплачено (чек від бухгалтера, ${invoice.total.toFixed(2)} ₴)`, chatId);
    return;
  }

  const [, action] = payMatch;
  if (action === 'yes') {
    await markInvoicePaid(invoice);
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Позначено як оплачено' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `✅ Оплачено (${invoice.total.toFixed(2)} ₴, ${localDateStr()})`
    });
    await notifyStatusChange(invoice, `✅ Оплачено (${invoice.total.toFixed(2)} ₴)`, chatId);
  } else {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Записано як борг' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `📝 Записано як борг (${invoice.total.toFixed(2)} ₴)`
    });
    await notifyStatusChange(invoice, `📝 В борг (${invoice.total.toFixed(2)} ₴)`, chatId);
  }
}

// Бухгалтер drops a payment receipt photo — match it to outstanding debt by remaining balance
// (± 1 ₴, same tolerance the invoice-duplicate check uses) and, if the receipt shows a
// recognizable recipient, narrow further by supplier.
async function handleReceiptPhoto(chatId, base64) {
  const result = await recognizeReceiptImage(base64, 'image/jpeg');

  if (!result.amount) {
    await reply(chatId, '⚠️ Не вдалось розпізнати суму на чеку. Перевірте вручну на сайті.');
    return;
  }

  const invoices = await readJSON(FILE, []);
  const suppliers = await readJSON('suppliers.json', []);

  const outstanding = invoices
    .map(inv => ({ inv, balance: Number(((inv.total || 0) - (inv.paidAmount || 0)).toFixed(2)) }))
    .filter(x => x.balance > 0.01);

  let candidates = outstanding.filter(x => Math.abs(x.balance - result.amount) < 1);

  if (candidates.length > 1 && result.recipient) {
    const matchedSupplier = findSupplier(suppliers, result.recipient);
    if (matchedSupplier) {
      const narrowed = candidates.filter(x =>
        (x.inv.supplier || '').toLowerCase() === matchedSupplier.name.toLowerCase());
      if (narrowed.length) candidates = narrowed;
    }
  }

  if (!candidates.length) {
    await reply(chatId,
      `⚠️ Не знайшов накладної з боргом ${result.amount.toFixed(2)} ₴${result.recipient ? ' (отримувач: ' + result.recipient + ')' : ''}. ` +
      `Перевірте вручну на сайті в розділі "Накладні".`);
    return;
  }

  if (candidates.length === 1) {
    const { inv } = candidates[0];
    await markInvoicePaid(inv, result.date || undefined);
    await reply(chatId,
      `✅ Чек на ${result.amount.toFixed(2)} ₴ прив'язано до накладної:\n` +
      `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${inv.total.toFixed(2)} ₴`);
    await notifyStatusChange(inv, `✅ Оплачено (чек від бухгалтера, ${result.amount.toFixed(2)} ₴)`, chatId);
    return;
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text: `💳 Чек на ${result.amount.toFixed(2)} ₴ підходить до кількох накладних — оберіть потрібну:`,
    reply_markup: {
      inline_keyboard: candidates.slice(0, 8).map(({ inv }) => ([{
        text: `${inv.supplier} — ${inv.date} — ${inv.total.toFixed(2)} ₴`,
        callback_data: `recv:${inv.id}`
      }]))
    }
  });
}

// Обов'язковий щоденний Z-звіт (фіскальний чек з каси) — scripts/zreport-reminder.js (Windows Task
// Scheduler, 22:55) sets a same-day flag per waiter chat; the next photo from that chat is treated
// as the Z-report instead of an накладна, forwarded as-is (by file_id, no re-download needed) to
// admin+бухгалтер with the sender's name, and logged to zreports.json.
async function handleZReportPhoto(chatId, fileId, submittedByLabel, recipients) {
  const date = localDateStr();
  const log = await readJSON('zreports.json', []);
  log.push({ date, submittedBy: submittedByLabel, chatId, timestamp: new Date().toISOString() });
  await writeJSON('zreports.json', log);

  await reply(chatId, '✅ Z-звіт отримано, дякую! Гарного вечора.');

  const toNotify = recipients.filter(r =>
    ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== chatId);
  for (const r of toNotify) {
    try {
      await tg('sendPhoto', { chat_id: r.chatId, photo: fileId, caption: `📋 Z-звіт за ${date} від ${submittedByLabel}` });
    } catch (e) { console.error('Z-report forward failed:', e); }
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
      // No /getUpdates while the webhook is active (Telegram refuses — 409 conflict), so this is
      // the only way to discover a new person's chat_id to register them: log it here, admin reads
      // pendingAccess.json (or just asks for the chat_id) and adds them via telegramRecipients.json.
      const from = message.from || {};
      const label = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ') || 'невідомо';
      const pendingAccess = await readJSON('pendingAccess.json', []);
      if (!pendingAccess.some(p => p.chatId === chatId)) {
        pendingAccess.push({ chatId, label, firstSeen: new Date().toISOString() });
        await writeJSON('pendingAccess.json', pendingAccess);
      }
      await reply(chatId, 'У вас немає доступу до цього бота. Зверніться до адміністратора.');
      return res.sendStatus(200);
    }

    // The registered recipient name (e.g. "Віталій (адмін)") is our own label; admin specifically
    // wants to see the real Telegram handle of whoever sent the photo, visible both in the site's
    // pending-invoice badge and in the forwarded TG notification.
    const from = message.from || {};
    const tgHandle = from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
    const submittedByLabel = tgHandle ? `${sender.name} (${tgHandle})` : sender.name;

    if (!message.photo || !message.photo.length) {
      await reply(chatId, sender.role === 'accountant'
        ? 'Надішліть фото чека про оплату — я знайду відповідну накладну за сумою боргу.'
        : 'Надішліть фото накладної — я розпізнаю і додам її на перевірку.');
      return res.sendStatus(200);
    }

    const largest = message.photo[message.photo.length - 1];

    // Z-звіт takes priority over every other photo flow — only set for the rest of the evening
    // after scripts/zreport-reminder.js pings this chat at 22:55.
    const pendingZ = await readJSON('pendingZReport.json', {});
    if (pendingZ[chatId] === localDateStr()) {
      delete pendingZ[chatId];
      await writeJSON('pendingZReport.json', pendingZ);
      await handleZReportPhoto(chatId, largest.file_id, submittedByLabel, recipients);
      return res.sendStatus(200);
    }

    const base64 = await downloadPhotoBase64(largest.file_id);

    // бухгалтер sends payment receipts, not invoices — completely different document and flow.
    if (sender.role === 'accountant') {
      await reply(chatId, '📷 Отримав чек, шукаю відповідну накладну...');
      await handleReceiptPhoto(chatId, base64);
      return res.sendStatus(200);
    }

    await reply(chatId, '📷 Отримав, розпізнаю накладну...');
    const result = await recognizeInvoiceImage(base64, 'image/jpeg');

    const suppliers = await readJSON('suppliers.json', []);
    const matchedSupplier = findSupplier(suppliers, result.supplier);

    const created = await createInvoice({
      supplier: matchedSupplier ? matchedSupplier.name : (result.supplier || ''),
      date: result.date,
      items: result.items,
      source: 'telegram',
      submittedBy: submittedByLabel,
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

    // Every накладна goes to admin AND бухгалтер, always — visible sender + status, regardless of
    // supplier config (previously gated by telegramInvoicesAllowed, which caused silent misses).
    const toNotify = recipients.filter(r =>
      String(r.chatId) !== chatId && ['admin', 'accountant'].includes(r.role));

    for (const r of toNotify) {
      await reply(r.chatId,
        `🧾 Нова накладна від ${submittedByLabel} (через бот):\n` +
        `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${inv.total.toFixed(2)} ₴\n` +
        `Статус: на перевірці.\nПеревірте на сайті в розділі "Накладні".`);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err);
    await reply(chatId, '❌ Помилка обробки накладної: ' + (err.message || 'невідома помилка'));
    res.sendStatus(200);
  }
});

module.exports = router;
