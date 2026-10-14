// Telegram webhook — waiters photograph накладні, bot OCRs them (same pipeline as the website's
// upload) and files a pending-review invoice, then asks (inline buttons) whether it was already
// paid. Mounted BEFORE the Supabase-auth middleware in index.js since Telegram can't send a
// Bearer token; authenticity is instead checked via the secret_token Telegram echoes back in a
// header (set once via setWebhook).
const express = require('express');
const Fuse = require('fuse.js');
const { readJSON, writeJSON, nextId } = require('../lib/store');
const { normalize } = require('../lib/convert');
const { localDateStr, posterCall, createPosterSupply, posterDateTimeStr } = require('../lib/poster');
const { recognizeInvoiceImage, recognizeReceiptImage, recognizeStockText, recognizeExpenseText } = require('./recognition');
const { createInvoice, updateInvoice } = require('./invoices');

const router = express.Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FILE = 'invoices.json';
// Poster supplier created once via storage.createSupplier specifically for text-reported receipts
// whose ingredient has no (or an ambiguous) supplier assignment in "Постачальники товарів" —
// supplier_id 4 in this Poster account ("Telegram-прихід (без визначеного постачальника)").
const FALLBACK_SUPPLIER_ID = 4;
// Keep in sync with public/expenses.html's category <option> list.
const EXPENSE_CATEGORIES = [
  'Оренда', 'Комуналка', 'Інтернет', 'Податки', 'Сміття', 'Підписки',
  'Хімія', 'Пакування', 'Маркетинг', 'Ремонт', 'Інше'
];

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

// paidAmount tracks real cash handed to the supplier, which is always the GROSS (з ПДВ) figure —
// a платіжна інструкція/receipt shows that amount, never the net accounting baseline.
function grossTotalOf(invoice) {
  return invoice.total_with_vat || (invoice.total || 0) * 1.2;
}

async function markInvoicePaid(invoice, paidDate) {
  await updateInvoice(invoice.id, { paidAmount: grossTotalOf(invoice), paidDate: paidDate || localDateStr() });
}

// Broadcasts a payment-status change to admin+бухгалтер so they see it without checking the site —
// excludeChatId skips whoever's chat the action happened in (they already saw it via editMessageText).
async function notifyStatusChange(invoice, statusText, excludeChatId) {
  const recipients = await readJSON('telegramRecipients.json', []);
  const toNotify = recipients.filter(r =>
    ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== String(excludeChatId));
  for (const r of toNotify) {
    await reply(r.chatId,
      `🔄 Статус накладної змінено (${invoice.supplier}, ${invoice.date}, ${grossTotalOf(invoice).toFixed(2)} ₴):\n${statusText}`);
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
      text: `✅ Чек прив'язано до: ${invoice.supplier}, ${invoice.date}, ${grossTotalOf(invoice).toFixed(2)} ₴`
    });
    await notifyStatusChange(invoice, `✅ Оплачено (чек від бухгалтера, ${grossTotalOf(invoice).toFixed(2)} ₴)`, chatId);
    return;
  }

  const [, action] = payMatch;
  if (action === 'yes') {
    await markInvoicePaid(invoice);
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Позначено як оплачено' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `✅ Оплачено (${grossTotalOf(invoice).toFixed(2)} ₴, ${localDateStr()})`
    });
    await notifyStatusChange(invoice, `✅ Оплачено (${grossTotalOf(invoice).toFixed(2)} ₴)`, chatId);
  } else {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Записано як борг' });
    await tg('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: `📝 Записано як борг (${grossTotalOf(invoice).toFixed(2)} ₴)`
    });
    await notifyStatusChange(invoice, `📝 В борг (${grossTotalOf(invoice).toFixed(2)} ₴)`, chatId);
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
    .map(inv => ({ inv, balance: Number((grossTotalOf(inv) - (inv.paidAmount || 0)).toFixed(2)) }))
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
      `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${grossTotalOf(inv).toFixed(2)} ₴`);
    await notifyStatusChange(inv, `✅ Оплачено (чек від бухгалтера, ${result.amount.toFixed(2)} ₴)`, chatId);
    return;
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text: `💳 Чек на ${result.amount.toFixed(2)} ₴ підходить до кількох накладних — оберіть потрібну:`,
    reply_markup: {
      inline_keyboard: candidates.slice(0, 8).map(({ inv }) => ([{
        text: `${inv.supplier} — ${inv.date} — ${grossTotalOf(inv).toFixed(2)} ₴`,
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

// Free-text goods-receipt report from a waiter ("Круасан 8 шт, Булочки 50шт") — no fixed format,
// no photo. AI extracts {name, qty, unit} triples, each matched against the LIVE Poster ingredient
// catalog (exact normalized match, then fuzzy via Fuse.js). Matched items are grouped by whichever
// supplier is assigned to that ingredient on "Постачальники товарів" (productSuppliers.json) and
// pushed to Poster as a real supply document per supplier group — ambiguous/unassigned ingredients
// fall back to FALLBACK_SUPPLIER_ID so the stock still updates, flagged in the log for manual fixup.
async function handleStockText(chatId, text, submittedByLabel, recipients) {
  await reply(chatId, '📝 Розпізнаю прихід...');

  let parsed;
  try {
    parsed = await recognizeStockText(text);
  } catch (e) {
    await reply(chatId, '⚠️ Не вдалось розпізнати текст. Спробуйте, наприклад: "Круасан 8 шт, Булочки 50 шт".');
    return;
  }

  if (!parsed.items.length) {
    await reply(chatId, '⚠️ Не знайшов жодної позиції з кількістю у повідомленні. Спробуйте, наприклад: "Круасан 8 шт".');
    return;
  }

  const ingredients = await posterCall('menu.getIngredients');
  const normalizedNames = ingredients.map(i => normalize(i.ingredient_name));
  const fuse = new Fuse(normalizedNames, { includeScore: true, threshold: 0.35 });

  const matched = [];
  const unmatched = [];
  for (const item of parsed.items) {
    const key = normalize(item.name);
    let idx = normalizedNames.indexOf(key);
    if (idx === -1) {
      const results = fuse.search(key);
      if (results.length && results[0].score < 0.4) idx = results[0].refIndex;
    }
    if (idx === -1) { unmatched.push(item); continue; }
    const ing = ingredients[idx];
    matched.push({ ingredientId: ing.ingredient_id, name: ing.ingredient_name, unit: ing.ingredient_unit, qty: item.qty, rawName: item.name });
  }

  if (!matched.length) {
    await reply(chatId,
      `⚠️ Жодну позицію не впізнав у довіднику Poster: ${parsed.items.map(i => i.name).join(', ')}. Перевірте назви вручну на сайті.`);
    return;
  }

  const productSuppliers = await readJSON('productSuppliers.json', {});
  const suppliers = await readJSON('suppliers.json', []);

  const groups = new Map(); // posterSupplierId -> { supplierName, items: [] }
  for (const item of matched) {
    const assignment = productSuppliers[item.ingredientId];
    const supplierIds = (assignment && assignment.supplierIds) || [];
    const supplierRecord = supplierIds.length === 1 ? suppliers.find(s => s.id === supplierIds[0]) : null;
    const posterSupplierId = (supplierRecord && supplierRecord.posterSupplierId) || FALLBACK_SUPPLIER_ID;
    if (!groups.has(posterSupplierId)) groups.set(posterSupplierId, { supplierName: supplierRecord ? supplierRecord.name : null, items: [] });
    groups.get(posterSupplierId).items.push(item);
  }

  const date = posterDateTimeStr();
  const createdGroups = [];
  const failedGroups = [];
  for (const [posterSupplierId, group] of groups) {
    try {
      const supplyId = await createPosterSupply({
        date, supplierId: posterSupplierId,
        items: group.items.map(i => ({ ingredientId: i.ingredientId, qty: i.qty, sum: 0 }))
      });
      createdGroups.push({ posterSupplierId, supplyId, ...group });
    } catch (e) {
      console.error('createPosterSupply failed:', e);
      failedGroups.push({ posterSupplierId, ...group });
    }
  }

  const log = await readJSON('textSupplies.json', []);
  const entry = {
    id: nextId(log),
    date: localDateStr(),
    timestamp: new Date().toISOString(),
    submittedBy: submittedByLabel,
    rawText: text,
    matched: matched.map(i => ({ name: i.name, rawName: i.rawName, qty: i.qty, unit: i.unit })),
    unmatched,
    failed: failedGroups.length > 0
  };
  log.push(entry);
  await writeJSON('textSupplies.json', log);

  const lines = ['✅ Прихід записано:'];
  for (const g of createdGroups) {
    for (const i of g.items) {
      lines.push(`• ${i.name}: ${i.qty} ${i.unit}${g.supplierName ? '' : ' (постачальник не визначений — перевірте "Постачальники товарів")'}`);
    }
  }
  for (const g of failedGroups) {
    for (const i of g.items) lines.push(`⚠️ ${i.name}: ${i.qty} ${i.unit} — НЕ вдалось записати в Poster`);
  }
  if (unmatched.length) {
    lines.push('', '❓ Не впізнав:');
    unmatched.forEach(i => lines.push(`• ${i.name} ${i.qty} ${i.unit}`));
  }
  await reply(chatId, lines.join('\n'));

  const toNotify = recipients.filter(r => ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== chatId);
  for (const r of toNotify) {
    await reply(r.chatId,
      `📦 Прихід текстом від ${submittedByLabel}:\n${matched.map(i => `${i.name}: ${i.qty} ${i.unit}`).join('\n')}`);
  }
}

// Бухгалтер's reply to the 15th-of-month reminder (scripts/monthly-accountant-reminder.js) —
// "Податки: 10грн, Комуналка: 10грн" or similar free text. The target month was fixed by that
// reminder (pendingAccountantReport.json), not derived from whenever she actually replies, since
// she might answer hours or days later. Creates one expenses.json entry per recognized category.
async function handleAccountantExpenseText(chatId, text, month) {
  await reply(chatId, '📝 Записую витрати...');

  let parsed;
  try {
    parsed = await recognizeExpenseText(text, EXPENSE_CATEGORIES);
  } catch (e) {
    await reply(chatId, '⚠️ Не вдалось розпізнати текст. Спробуйте, наприклад: "Податки: 10000грн, Комуналка: 8000грн".');
    return;
  }

  if (!parsed.items.length) {
    await reply(chatId, '⚠️ Не знайшов жодної суми у повідомленні. Спробуйте, наприклад: "Податки: 10000грн".');
    return;
  }

  const date = `${month}-01`;
  const expenses = await readJSON('expenses.json', []);
  const created = [];
  for (const item of parsed.items) {
    const expense = {
      id: nextId(expenses),
      date,
      category: item.category,
      description: `Звіт бухгалтера за ${month} (через бот)`,
      amount: item.amount
    };
    expenses.push(expense);
    created.push(expense);
  }
  await writeJSON('expenses.json', expenses);

  await reply(chatId,
    `✅ Записано за ${month}:\n${created.map(e => `${e.category}: ${e.amount.toFixed(2)} ₴`).join('\n')}`);

  const recipients = await readJSON('telegramRecipients.json', []);
  const toNotify = recipients.filter(r => r.role === 'admin' && String(r.chatId) !== chatId);
  for (const r of toNotify) {
    await reply(r.chatId,
      `💸 Бухгалтер записала витрати за ${month}:\n${created.map(e => `${e.category}: ${e.amount.toFixed(2)} ₴`).join('\n')}`);
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
      if (sender.role === 'waiter' && message.text && message.text.trim() && !message.text.startsWith('/')) {
        await handleStockText(chatId, message.text.trim(), submittedByLabel, recipients);
        return res.sendStatus(200);
      }
      if (sender.role === 'accountant' && message.text && message.text.trim() && !message.text.startsWith('/')) {
        const pendingReport = await readJSON('pendingAccountantReport.json', {});
        const month = pendingReport[chatId];
        if (month) {
          delete pendingReport[chatId];
          await writeJSON('pendingAccountantReport.json', pendingReport);
          await handleAccountantExpenseText(chatId, message.text.trim(), month);
          return res.sendStatus(200);
        }
      }
      await reply(chatId, sender.role === 'accountant'
        ? 'Надішліть фото чека про оплату — я знайду відповідну накладну за сумою боргу.'
        : 'Надішліть фото накладної — я розпізнаю і додам її на перевірку, або просто напишіть текстом, що привезли (наприклад: "Круасан 8 шт").');
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
        `${(created.existing.total_with_vat || created.existing.total * 1.2).toFixed(2)} ₴). Не додав повторно.`);
      return res.sendStatus(200);
    }

    const inv = created.invoice;
    const grossTotal = inv.total_with_vat || inv.total * 1.2;
    await reply(chatId,
      `✅ Накладну додано на перевірку!\nПостачальник: ${inv.supplier}\nДата: ${inv.date}\n` +
      `Сума до сплати (з ПДВ): ${grossTotal.toFixed(2)} ₴${result.warning ? '\n\n⚠️ ' + result.warning : ''}`);

    await askPaymentStatus(chatId, inv.id);

    // Every накладна goes to admin AND бухгалтер, always — visible sender + status, regardless of
    // supplier config (previously gated by telegramInvoicesAllowed, which caused silent misses).
    // Forward the actual photo (by file_id, no re-download), not just the AI-extracted text — the
    // бухгалтер needs to see the real document, not a summary, especially to double-check the AI.
    const toNotify = recipients.filter(r =>
      String(r.chatId) !== chatId && ['admin', 'accountant'].includes(r.role));

    for (const r of toNotify) {
      try {
        await tg('sendPhoto', {
          chat_id: r.chatId,
          photo: largest.file_id,
          caption: `🧾 Нова накладна від ${submittedByLabel} (через бот):\n` +
            `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума до сплати (з ПДВ): ${grossTotal.toFixed(2)} ₴\n` +
            `Статус: на перевірці.\nПеревірте на сайті в розділі "Накладні".`
        });
      } catch (e) { console.error('Invoice photo forward failed:', e); }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err);
    await reply(chatId, '❌ Помилка обробки накладної: ' + (err.message || 'невідома помилка'));
    res.sendStatus(200);
  }
});

module.exports = router;
