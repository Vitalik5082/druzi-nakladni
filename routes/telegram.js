// Telegram webhook — waiters photograph накладні, bot OCRs them (same pipeline as the website's
// upload) and files a pending-review invoice, then asks (inline buttons) whether it was already
// paid. Mounted BEFORE the Supabase-auth middleware in index.js since Telegram can't send a
// Bearer token; authenticity is instead checked via the secret_token Telegram echoes back in a
// header (set once via setWebhook).
const express = require('express');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');
const { readJSON, writeJSON, nextId } = require('../lib/store');
const { normalize, findSupplier, includesWord } = require('../lib/convert');
const { localDateStr, posterCall } = require('../lib/poster');
const { recognizeInvoiceImage, recognizeReceiptImage, recognizeStockText, recognizeExpenseText } = require('./recognition');
const { createInvoice, updateInvoice } = require('./invoices');
const { createExpenseRecord } = require('./expenses');

const router = express.Router();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const FILE = 'invoices.json';
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

// Forwards бухгалтер's receipt photo itself (not just a text summary) to admin/бухгалтер, in
// parallel with markInvoicePaid — mirrors finalizeInvoiceCreation's накладна-photo forward.
// Deliberately runs regardless of invoice.pendingReview: a чек can settle a debt before admin has
// confirmed/pushed that накладна into Poster's приход (two independent steps), so admin is told
// explicitly here when that confirmation is still outstanding.
async function forwardReceiptPhoto(invoice, fileId, excludeChatId, amount) {
  const recipients = await readJSON('telegramRecipients.json', []);
  const toNotify = recipients.filter(r =>
    ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== String(excludeChatId));
  for (const r of toNotify) {
    try {
      await tg('sendPhoto', {
        chat_id: r.chatId,
        photo: fileId,
        caption: `✅ Чек оплати від бухгалтера (${amount.toFixed(2)} ₴) прив'язано до накладної:\n` +
          `Постачальник: ${invoice.supplier}\nДата: ${invoice.date}\nСума: ${grossTotalOf(invoice).toFixed(2)} ₴` +
          (invoice.pendingReview ? `\n⏳ Накладна ще не поставлена на приход в Poster — підтвердьте на сайті.` : '')
      });
    } catch (e) { console.error('Receipt photo forward failed:', e); }
  }
}

// No накладна matched by amount (wrong/stale balance, OCR misread the sum, or the накладна it
// pays simply isn't in the system yet) — something was still genuinely paid, so drop the photo
// silently and the payment just disappears. Forward it to admin instead; they attach it to the
// right накладна manually on the site (reєстр накладних → "Оплата") since the bot has nothing
// to go on here.
async function forwardUnmatchedReceiptPhoto(fileId, excludeChatId, amount, recipient, date) {
  const recipients = await readJSON('telegramRecipients.json', []);
  const toNotify = recipients.filter(r =>
    ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== String(excludeChatId));
  for (const r of toNotify) {
    try {
      await tg('sendPhoto', {
        chat_id: r.chatId,
        photo: fileId,
        caption: `⚠️ Чек на ${amount.toFixed(2)} ₴${recipient ? ' (отримувач: ' + recipient + ')' : ''}${date ? ', ' + date : ''} — ` +
          `не знайшов відповідної накладної автоматично.\nПеревірте вручну на сайті в розділі "Накладні" і позначте потрібну як оплачену.`
      });
    } catch (e) { console.error('Unmatched receipt photo forward failed:', e); }
  }
}

async function handleCallback(callbackQuery) {
  const chatId = String(callbackQuery.message.chat.id);
  const messageId = callbackQuery.message.message_id;
  const data = callbackQuery.data || '';

  const payMatch = data.match(/^pay:(yes|no):(\d+)$/);
  const receiptMatch = data.match(/^recv:(\d+)$/);
  const paytextMatch = data.match(/^paytext:(yes|no):(\d+)$/);

  if (!payMatch && !receiptMatch && !paytextMatch) {
    await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id });
    return;
  }

  const invoices = await readJSON(FILE, []);
  const invoiceId = Number(payMatch ? payMatch[2] : (receiptMatch ? receiptMatch[1] : paytextMatch[2]));
  const invoice = invoices.find(inv => inv.id === invoiceId);
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

    // Recover the receipt photo stashed by handleReceiptPhoto when it couldn't auto-pick between
    // several candidates (bухгалтер just resolved the ambiguity via this inline button) — forward
    // the actual photo if we still have it, falling back to a text-only notify otherwise.
    const pendingReceipt = await readJSON('pendingReceiptPhoto.json', {});
    const receiptEntry = pendingReceipt[chatId];
    if (receiptEntry) { delete pendingReceipt[chatId]; await writeJSON('pendingReceiptPhoto.json', pendingReceipt); }

    if (receiptEntry && receiptEntry.fileId) {
      await forwardReceiptPhoto(invoice, receiptEntry.fileId, chatId, receiptEntry.amount);
    } else {
      await notifyStatusChange(invoice, `✅ Оплачено (чек від бухгалтера, ${grossTotalOf(invoice).toFixed(2)} ₴)`, chatId);
    }
    return;
  }

  // Waiter-typed "Оплачено: X" confirmation (handlePaymentText) — unlike the receipt-photo and
  // pay:yes/no flows (which already name a specific SPECIFIC single накладна by context), this one
  // guessed the накладна purely from a typed amount, so "Ні" must NOT fall back to "borg" the way
  // pay:no does — the guess might just be the wrong накладна, not a real "not paid yet".
  if (paytextMatch) {
    const [, action] = paytextMatch;
    if (action === 'yes') {
      await markInvoicePaid(invoice);
      await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Позначено як оплачено' });
      await tg('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: `✅ Оплачено: ${invoice.supplier}, ${invoice.date}, ${grossTotalOf(invoice).toFixed(2)} ₴`
      });
      await notifyStatusChange(invoice, `✅ Оплачено (текстом від офіціанта, ${grossTotalOf(invoice).toFixed(2)} ₴)`, chatId);
    } else {
      await tg('answerCallbackQuery', { callback_query_id: callbackQuery.id, text: 'Скасовано' });
      await tg('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: `❌ Не та накладна — нічого не змінено. Напишіть точніше або позначте оплату вручну на сайті.`
      });
    }
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

// Matches outstanding (unpaid/partially-paid) накладні by remaining balance, ± tolerance — shared
// by handleReceiptPhoto (a real receipt's recognized amount) and handlePaymentText (a typed "Оплачено: X").
function findOutstandingByAmount(invoices, amount, tolerance = 1) {
  return invoices
    .map(inv => ({ inv, balance: Number((grossTotalOf(inv) - (inv.paidAmount || 0)).toFixed(2)) }))
    .filter(x => x.balance > 0.01 && Math.abs(x.balance - amount) < tolerance);
}

// Payment is usually confirmed by бухгалтер via a receipt photo (handleReceiptPhoto, auto-applied
// when there's exactly one balance match) — but a WAITER sometimes settles an old накладна in cash
// and just types "Оплачено: 5000" with no receipt to photograph. Unlike a real receipt, a typed
// number alone is too weak a signal to auto-apply — always ask for explicit confirmation naming the
// specific накладна (supplier + date) before marking it paid, so a coincidental amount match (or a
// typo) can't silently misattribute a payment.
async function handlePaymentText(chatId, amount) {
  const invoices = await readJSON(FILE, []);
  const candidates = findOutstandingByAmount(invoices, amount);

  if (!candidates.length) {
    await reply(chatId, `⚠️ Не знайшов накладної з боргом ${amount.toFixed(2)} ₴. Перевірте вручну на сайті в розділі "Накладні".`);
    return;
  }

  if (candidates.length > 1) {
    const lines = candidates.map(c => `• ${c.inv.supplier || '—'}, ${c.inv.date} — ${c.balance.toFixed(2)} ₴`).join('\n');
    await reply(chatId,
      `Знайшов кілька накладних з боргом ${amount.toFixed(2)} ₴:\n${lines}\n\n` +
      `Напишіть точніше (постачальника), або позначте оплату вручну на сайті.`);
    return;
  }

  const { inv, balance } = candidates[0];
  await tg('sendMessage', {
    chat_id: chatId,
    text: `💳 Ви підтверджуєте оплату накладної по ${inv.supplier || '—'} за ${inv.date} на суму ${balance.toFixed(2)} ₴?`,
    reply_markup: { inline_keyboard: [[
      { text: '✅ Так', callback_data: `paytext:yes:${inv.id}` },
      { text: '❌ Ні', callback_data: `paytext:no:${inv.id}` }
    ]] }
  });
}

// Shared tail of накладна creation (used both when the supplier was recognized immediately, and
// after a waiter resolves an unrecognized-supplier prompt) — creates the накладна, replies to the
// sender, asks payment status, and forwards the photo + AI self-check warning to admin/бухгалтер.
async function finalizeInvoiceCreation(chatId, supplierName, result, fileId, submittedByLabel, recipients) {
  const outcome = await appendOrCreateDailyInvoice({
    supplierName, date: result.date, items: result.items, source: 'telegram', submittedBy: submittedByLabel
  });

  if (!outcome.appended && outcome.created.duplicate) {
    await reply(chatId,
      `⚠️ Схожа накладна вже є в системі (${outcome.created.existing.supplier}, ${outcome.created.existing.date}, ` +
      `${(outcome.created.existing.total_with_vat || outcome.created.existing.total * 1.2).toFixed(2)} ₴). Не додав повторно.`);
    return;
  }

  const inv = outcome.appended ? outcome.invoice : outcome.created.invoice;
  const grossTotal = inv.total_with_vat || inv.total * 1.2;

  // Unrecognized items aren't resolved here in chat (that needs a full product search, which this
  // bot's text interface can't offer well) — flag them to the sender so it's not a silent gap, and
  // point at the website's own popup (invoices.html auto-prompts "перейменувати/додати новим" the
  // moment this накладна is opened there).
  const newItems = result.items.filter(i => i.isNewProduct && !i.skipped);
  const newItemsNote = newItems.length
    ? `\n\n❓ ${newItems.length === 1 ? 'Позиція' : 'Позиції'} не знайдена в довіднику Poster: ${newItems.map(i => i.name).join(', ')}. ` +
      `Адмін перейменує або підтвердить додавання на сайті.`
    : '';

  if (outcome.appended) {
    await reply(chatId,
      `✅ Додано до накладної Фортуни за ${inv.date} (тепер ${inv.items.filter(i => !i.skipped).length} позицій)!\n` +
      `Сума до сплати (з ПДВ): ${grossTotal.toFixed(2)} ₴${newItemsNote}`);
  } else {
    await reply(chatId,
      `✅ Накладну додано на перевірку!\nПостачальник: ${inv.supplier}\nДата: ${inv.date}\n` +
      `Сума до сплати (з ПДВ): ${grossTotal.toFixed(2)} ₴${result.warning ? '\n\n⚠️ ' + result.warning : ''}${newItemsNote}`);
  }

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
        photo: fileId,
        caption: (outcome.appended
          ? `🧾 Чек Фортуни від ${submittedByLabel} додано до накладної за ${inv.date}:\n`
          : `🧾 Нова накладна від ${submittedByLabel} (через бот):\n`) +
          `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума до сплати (з ПДВ): ${grossTotal.toFixed(2)} ₴\n` +
          `Статус: на перевірці.\nПеревірте на сайті в розділі "Накладні".` +
          // Previously shown only to the waiter who sent the photo (who can't act on it) — admin/
          // бухгалтер, who actually review накладні, never saw this AI self-check mismatch at all.
          (result.warning ? `\n\n⚠️ ${result.warning}` : '') + newItemsNote
      });
    } catch (e) { console.error('Invoice photo forward failed:', e); }
  }
}

// Бухгалтер drops a payment receipt photo — match it to outstanding debt by remaining balance
// (± 1 ₴, same tolerance the invoice-duplicate check uses) and, if the receipt shows a
// recognizable recipient, narrow further by supplier. Matching intentionally ignores
// invoice.pendingReview — a накладна admin hasn't yet confirmed/pushed to Poster's приход can
// still legitimately be paid (ex: supplier delivers on credit, бухгалтер settles the invoice
// before admin gets around to checking the item list) — those are two independent steps.
async function handleReceiptPhoto(chatId, base64, fileId) {
  const result = await recognizeReceiptImage(base64, 'image/jpeg');

  if (!result.amount) {
    await reply(chatId, '⚠️ Не вдалось розпізнати суму на чеку. Перевірте вручну на сайті.');
    return;
  }

  const invoices = await readJSON(FILE, []);
  const suppliers = await readJSON('suppliers.json', []);

  let candidates = findOutstandingByAmount(invoices, result.amount);

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
    if (fileId) await forwardUnmatchedReceiptPhoto(fileId, chatId, result.amount, result.recipient, result.date);
    return;
  }

  if (candidates.length === 1) {
    const { inv } = candidates[0];
    await markInvoicePaid(inv, result.date || undefined);
    await reply(chatId,
      `✅ Чек на ${result.amount.toFixed(2)} ₴ прив'язано до накладної:\n` +
      `Постачальник: ${inv.supplier}\nДата: ${inv.date}\nСума: ${grossTotalOf(inv).toFixed(2)} ₴`);
    if (fileId) await forwardReceiptPhoto(inv, fileId, chatId, result.amount);
    else await notifyStatusChange(inv, `✅ Оплачено (чек від бухгалтера, ${result.amount.toFixed(2)} ₴)`, chatId);
    return;
  }

  // Can't auto-forward the photo yet (don't know which накладна it belongs to) — stash fileId so
  // handleCallback's receiptMatch branch can forward it once бухгалтер picks one below.
  if (fileId) {
    const pendingReceipt = await readJSON('pendingReceiptPhoto.json', {});
    pendingReceipt[chatId] = { fileId, amount: result.amount, timestamp: new Date().toISOString() };
    await writeJSON('pendingReceiptPhoto.json', pendingReceipt);
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

function loadPcsAsGramsRules() {
  try {
    const portions = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'portions.json'), 'utf-8'));
    return portions.pcs_as_grams || [];
  } catch (e) { return []; }
}

// Converts a waiter's stated unit to the matched ingredient's own base unit (kg/l/p in Poster) —
// г/грам(и)/g → kg, мл/ml → l, divided by 1000. A count-type word (шт/штук...) against a weight-
// tracked base (kg/l) is only safe to pass through unchanged for ingredients genuinely sold AND
// stocked by weight-equivalent count; for ones bought by the piece but stocked by weight (e.g.
// avocado: 1шт = 200г per public/portions.json's pcs_as_grams), passing "1шт" straight through as
// "1" silently recorded it as 1 KG (200x too much) instead of 0.2kg. Any nameText matching a
// pcs_as_grams rule converts via that rule's g_per_pcs first; everything else keeps the old
// behaviour (ящик, пачка, упаковка... with no such rule pass through unchanged).
function convertToIngredientUnit(qty, statedUnit, baseUnit, nameTexts) {
  const u = (statedUnit || '').toLowerCase().trim();
  if (baseUnit === 'kg' && /^г(рам(а|ів)?)?$|^g$/.test(u)) return qty / 1000;
  if (baseUnit === 'l' && /^мл$|^ml$/.test(u)) return qty / 1000;

  const isPieceUnit = /^шт\.?$|^штук(а|и)?$|^pcs$/i.test(u);
  if (isPieceUnit && (baseUnit === 'kg' || baseUnit === 'l')) {
    const rule = loadPcsAsGramsRules().find(r => (nameTexts || []).some(t => includesWord(t.toUpperCase(), r.key)));
    if (rule) return (qty * rule.g_per_pcs) / 1000;
  }
  return qty;
}

// Poster's own ingredient_unit is a bare code ('p'/'kg'/'l') — fine for internal qty math, but
// showing it raw to a waiter/admin in a Telegram message ("Булочка 50 p") is confusing. Display-only.
const UNIT_DISPLAY = { p: 'шт', kg: 'кг', l: 'л' };
function unitLabel(u) { return UNIT_DISPLAY[u] || u; }

// Фортуна has no formal накладна — each delivery is reported piecemeal through the bot over the
// day (a чек photo, or a few items typed in text), unlike every other supplier whose накладна photo
// is one complete document. Without this, every separate report became its own invoice (10 items
// reported one at a time in a day = 10 накладні) instead of one накладна per day listing them all.
function isFortunaSupplier(name) { return (name || '').toLowerCase().includes('фортуна'); }

// ОлегКруасан (bread/buns) text-прихід reports are simple and reliable enough (almost always one
// item, e.g. "булочок 56 шт") that the user wants them pushed into Poster stock immediately instead
// of sitting pendingReview until someone opens the реєстр накладних and clicks "✓ Підтвердити" -
// unlike every other text-прихід supplier, where a human should eyeball the AI-matched items first
// before they hit real stock/cost. A накладна from this supplier (2026-10-24, 56 Булочка Бріош)
// sat unreviewed for 5 days and never reached Poster's залишки until confirmed by hand - this is
// the fix so it doesn't happen again for this specific supplier.
function isOlegCroissantSupplier(name) { return (name || '').toLowerCase().includes('олегкруасан'); }

// Shared by finalizeInvoiceCreation (photo чек) and handleStockAmountReply (text прихід) — once the
// supplier is known to be Фортуна, append newItems to today's still-pendingReview Фортуна накладна
// instead of creating a new one; any other supplier keeps the old one-document-per-submission
// behaviour untouched.
async function appendOrCreateDailyInvoice({ supplierName, date, items, source, submittedBy }) {
  if (!isFortunaSupplier(supplierName)) {
    const autoConfirm = isOlegCroissantSupplier(supplierName);
    return { appended: false, created: await createInvoice({ supplier: supplierName, date, items, source, submittedBy, pendingReview: !autoConfirm }) };
  }

  const invoices = await readJSON(FILE, []);
  const existing = invoices.find(inv =>
    inv.date === date && isFortunaSupplier(inv.supplier) && inv.pendingReview === true);

  if (!existing) {
    return { appended: false, created: await createInvoice({ supplier: supplierName, date, items, source, submittedBy, pendingReview: true }) };
  }

  // Fresh ids continuing past whatever's already on the invoice — the website's edit/match-modal
  // UI keys each row by item.id, so a collision with an existing item would corrupt that row.
  const maxId = existing.items.reduce((m, i) => Math.max(m, Number(i.id) || 0), -1);
  const newItems = items.map((item, idx) => ({ ...item, id: maxId + 1 + idx }));
  const updated = await updateInvoice(existing.id, { items: [...existing.items, ...newItems] });
  return { appended: true, invoice: updated, addedItems: newItems };
}

// Free-text goods-receipt report from a waiter ("Круасан 8 шт, Булочки 50шт") — no fixed format,
// no photo. AI extracts {name, qty, unit} triples, each matched against the LIVE Poster ingredient
// catalog (exact normalized match, then fuzzy via Fuse.js). Matching alone has no price — the sum
// is asked as a follow-up question (handleStockAmountReply) so this can become a real накладна
// (debt/payment tracking, same "оплачено?" buttons as a photographed накладна), not just a
// quantity-only stock bump.
async function handleStockText(chatId, text, submittedByLabel) {
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
    // A waiter's unit word (г/грам, мл) doesn't always match the ingredient's own base unit
    // (kg/l) — without converting, "Салямі 250 грам" silently became 250 KG in Poster once
    // (1000x). Count-type units (шт, ящик, пачка...) pass through unchanged against a 'p' base.
    const qty = convertToIngredientUnit(item.qty, item.unit, ing.ingredient_unit, [item.name, ing.ingredient_name]);
    matched.push({ ingredientId: ing.ingredient_id, name: ing.ingredient_name, unit: ing.ingredient_unit, qty, rawName: item.name });
  }

  if (!matched.length) {
    await reply(chatId,
      `⚠️ Жодну позицію не впізнав у довіднику Poster: ${parsed.items.map(i => i.name).join(', ')}. Перевірте назви вручну на сайті.`);
    return;
  }

  // handleStockAmountReply splits one ₴ total proportionally by qty across ALL matched items —
  // valid only when they share a unit. "Борошно 5 кг, Олія 2 л" summing to "7" and splitting by
  // that is dimensionally meaningless (kg + l isn't a real quantity), and was silently happening
  // before this check: a real prihid/Poster supply got written with made-up per-unit prices.
  const distinctUnits = new Set(matched.map(i => i.unit));
  if (distinctUnits.size > 1) {
    await reply(chatId,
      `⚠️ Тут одразу декілька одиниць виміру (${[...distinctUnits].join(', ')}) — суму на все не розділю коректно. ` +
      `Надішліть, будь ласка, одним повідомленням лише товари з однаковою одиницею виміру (наприклад, спершу всі "кг", потім окремо "л"/"шт").`);
    return;
  }

  const pending = await readJSON('pendingStockAmount.json', {});
  pending[chatId] = { items: matched, unmatched, rawText: text, submittedBy: submittedByLabel, timestamp: new Date().toISOString() };
  await writeJSON('pendingStockAmount.json', pending);

  const lines = ['Розпізнав:'];
  matched.forEach(i => lines.push(`• ${i.name}: ${i.qty} ${unitLabel(i.unit)}`));
  if (unmatched.length) {
    lines.push('', '❓ Не впізнав (не увійде в накладну):');
    unmatched.forEach(i => lines.push(`• ${i.name} ${i.qty} ${i.unit}`));
  }
  lines.push('', '💰 На яку суму (всього), ₴? Напишіть, будь ласка, число.');
  await reply(chatId, lines.join('\n'));
}

// Follow-up to handleStockText — the waiter's reply is expected to be just a number (total ₴ paid
// or owed). No per-item pricing exists for a text-reported прихід, so price is split evenly by
// quantity across the matched items (qty_i / totalQty × amount) — an approximation, correctable
// later via the накладна's own "Редагувати" on the website, same as any OCR'd накладна.
async function handleStockAmountReply(chatId, text, pendingEntry, recipients) {
  const amount = parseFloat((text || '').replace(',', '.').replace(/[^\d.]/g, ''));
  if (!amount || amount <= 0) {
    await reply(chatId, '⚠️ Не зрозумів суму. Напишіть, будь ласка, просто число, наприклад: 1200');
    return false; // keep the pending entry — let them try again
  }

  const { items, unmatched, submittedBy, rawText } = pendingEntry;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const unitPrice = amount / totalQty;

  const invoiceItems = items.map((i, idx) => ({
    id: idx, name: i.name, original_name: i.rawName, qty: i.qty, unit: i.unit,
    price: Number(unitPrice.toFixed(4)), total: Number((i.qty * unitPrice).toFixed(2)),
    matched: true, isNewProduct: false, skipped: false
  }));

  const productSuppliers = await readJSON('productSuppliers.json', {});
  const suppliers = await readJSON('suppliers.json', []);

  // Supplier for the накладна record: only when every matched ingredient agrees on exactly one.
  const supplierIdSets = items.map(i => (productSuppliers[i.ingredientId]?.supplierIds) || []);
  const firstSet = supplierIdSets[0] || [];
  const sameSupplierEverywhere = firstSet.length === 1 && supplierIdSets.every(s => s.length === 1 && s[0] === firstSet[0]);
  const supplierRecord = sameSupplierEverywhere ? suppliers.find(s => s.id === firstSet[0]) : null;

  const outcome = await appendOrCreateDailyInvoice({
    supplierName: supplierRecord ? supplierRecord.name : '',
    date: localDateStr(), items: invoiceItems, source: 'telegram-text', submittedBy
  });

  if (!outcome.appended && outcome.created.duplicate) {
    await reply(chatId,
      `⚠️ Схожа накладна вже є в системі (${outcome.created.existing.supplier}, ${outcome.created.existing.date}, ` +
      `${(outcome.created.existing.total_with_vat || outcome.created.existing.total * 1.2).toFixed(2)} ₴). Не додав повторно.`);
    return true;
  }
  const inv = outcome.appended ? outcome.invoice : outcome.created.invoice;

  // No Poster push here for most suppliers — the накладна is pendingReview:true (set inside
  // appendOrCreateDailyInvoice/createInvoice), same as any OCR'd накладна from a photo. It only
  // reaches Poster once an admin reviews and confirms it from the реєстр накладних
  // (routes/invoices.js's updateInvoice() does the push, triggered by pendingReview flipping to
  // false), exactly like the photo-OCR flow. Nobody but the waiter has looked at this yet — pushing
  // it into Poster's real stock/cost immediately, before any review, was the original design flaw -
  // except ОлегКруасан (see isOlegCroissantSupplier), which skips the review gate on purpose.
  const log = await readJSON('textSupplies.json', []);
  log.push({
    id: nextId(log), date: localDateStr(), timestamp: new Date().toISOString(), submittedBy,
    rawText, amount, invoiceId: inv.id,
    matched: items.map(i => ({ name: i.name, rawName: i.rawName, qty: i.qty, unit: i.unit })),
    unmatched
  });
  await writeJSON('textSupplies.json', log);

  const grossTotal = inv.total_with_vat || inv.total * 1.2;
  const lines = outcome.appended
    ? [`✅ Додано до накладної Фортуни за ${inv.date} (тепер ${inv.items.filter(i => !i.skipped).length} позицій), сума зараз ${grossTotal.toFixed(2)} ₴:`]
    : [`✅ Прихід записано як накладна на ${grossTotal.toFixed(2)} ₴ (очікує підтвердження в реєстрі накладних):`];
  items.forEach(i => lines.push(`• ${i.name}: ${i.qty} ${unitLabel(i.unit)}`));
  await reply(chatId, lines.join('\n'));

  await askPaymentStatus(chatId, inv.id);

  const toNotify = recipients.filter(r => ['admin', 'accountant'].includes(r.role) && String(r.chatId) !== chatId);
  for (const r of toNotify) {
    await reply(r.chatId,
      `📦 Прихід текстом від ${submittedBy} (${grossTotal.toFixed(2)} ₴):\n${items.map(i => `${i.name}: ${i.qty} ${unitLabel(i.unit)}`).join('\n')}`);
  }
  return true;
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
    const expense = await createExpenseRecord(expenses, {
      date, category: item.category, description: `Звіт бухгалтера за ${month} (через бот)`, amount: item.amount
    });
    created.push(expense);
  }
  await writeJSON('expenses.json', expenses);

  await reply(chatId,
    `✅ Записано за ${month}:\n${created.map(e =>
      `${e.category}: ${e.amount.toFixed(2)} ₴${e.postedToPoster ? '' : ' (⚠️ не вдалось синхронізувати з Poster)'}`).join('\n')}`);

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

    // Resolves the "не впізнав постачальника" prompt below — "так" keeps the AI's original guess,
    // anything else is treated as the corrected supplier name (re-matched against suppliers.json
    // in case they typed an existing one; otherwise used as-is for a genuinely new supplier). Takes
    // priority over the payment-text check right below — someone answering this prompt is mid-flow,
    // not reporting a payment, even if their reply happened to contain a number.
    if (!message.photo?.length && message.text && message.text.trim()) {
      const pendingSupplier = await readJSON('pendingSupplierConfirm.json', {});
      const supplierEntry = pendingSupplier[chatId];
      if (supplierEntry && (Date.now() - new Date(supplierEntry.timestamp).getTime()) < 6 * 60 * 60 * 1000) {
        delete pendingSupplier[chatId];
        await writeJSON('pendingSupplierConfirm.json', pendingSupplier);

        const reply_text = message.text.trim();
        let resolvedName = supplierEntry.result.supplier;
        if (!/^(так|да|ок|ok|yes)$/i.test(reply_text)) {
          const suppliersNow = await readJSON('suppliers.json', []);
          const rematch = findSupplier(suppliersNow, reply_text);
          resolvedName = rematch ? rematch.name : reply_text;
        }

        await finalizeInvoiceCreation(chatId, resolvedName, supplierEntry.result, supplierEntry.fileId, supplierEntry.submittedByLabel, recipients);
        return res.sendStatus(200);
      }
      if (supplierEntry) { delete pendingSupplier[chatId]; await writeJSON('pendingSupplierConfirm.json', pendingSupplier); }
    }

    // "Оплачено: 5000" (or "оплата 5000", "заплатили 5000") — any sender, not just бухгалтер.
    // Checked before the role-specific text branches below: a distinctive enough keyword+amount
    // that it won't collide with handleStockText's "Круасан 8 шт" or a pendingStockAmount bare-
    // number reply, both of which have no "оплат"/"заплат" keyword in them.
    if (!message.photo?.length && message.text) {
      const paymentMatch = message.text.trim().match(/(?:оплачен|оплат|заплат)\w*\D*(\d+(?:[.,]\d+)?)/i);
      if (paymentMatch) {
        await handlePaymentText(chatId, parseFloat(paymentMatch[1].replace(',', '.')));
        return res.sendStatus(200);
      }
    }

    if (!message.photo || !message.photo.length) {
      if (sender.role === 'waiter' && message.text && message.text.trim() && !message.text.startsWith('/')) {
        const pendingStock = await readJSON('pendingStockAmount.json', {});
        const stockEntry = pendingStock[chatId];
        // No expiry used to mean a reply to a LONG-forgotten prihid (waiter never answered "на яку
        // суму?") could hijack an unrelated later message that happens to contain a number —
        // e.g. "Борошно 10кг" read as the answer "10" to a stale Круасан entry from days ago, and
        // the real Борошно delivery silently never recorded. 6h covers "got busy, answered later
        // same shift" without reaching into an unrelated future report.
        if (stockEntry && (Date.now() - new Date(stockEntry.timestamp).getTime()) < 6 * 60 * 60 * 1000) {
          const resolved = await handleStockAmountReply(chatId, message.text.trim(), stockEntry, recipients);
          if (resolved) {
            delete pendingStock[chatId];
            await writeJSON('pendingStockAmount.json', pendingStock);
          }
          return res.sendStatus(200);
        }
        if (stockEntry) { delete pendingStock[chatId]; await writeJSON('pendingStockAmount.json', pendingStock); }
        await handleStockText(chatId, message.text.trim(), submittedByLabel);
        return res.sendStatus(200);
      }
      if (sender.role === 'accountant' && message.text && message.text.trim() && !message.text.startsWith('/')) {
        const pendingReport = await readJSON('pendingAccountantReport.json', {});
        const reportEntry = pendingReport[chatId];
        // Same reasoning as pendingStockAmount above — without an expiry, бухгалтер ignoring one
        // monthly reminder means ANY later message containing recognizable amounts (even about
        // something unrelated) gets silently attributed to that stale month's tax/utility report.
        const reportFresh = reportEntry && (Date.now() - new Date(reportEntry.timestamp).getTime()) < 10 * 24 * 60 * 60 * 1000;
        if (reportFresh) {
          delete pendingReport[chatId];
          await writeJSON('pendingAccountantReport.json', pendingReport);
          await handleAccountantExpenseText(chatId, message.text.trim(), reportEntry.month);
          return res.sendStatus(200);
        }
        if (reportEntry) { delete pendingReport[chatId]; await writeJSON('pendingAccountantReport.json', pendingReport); }
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
      await handleReceiptPhoto(chatId, base64, largest.file_id);
      return res.sendStatus(200);
    }

    await reply(chatId, '📷 Отримав, розпізнаю накладну...');
    const result = await recognizeInvoiceImage(base64, 'image/jpeg');

    // Catches a Z-звіт even when the scheduled 22:30 reminder never fired (so pendingZReport was
    // never set) — content beats timing. Same handler as the flag-based path.
    if (result.documentType === 'zreport') {
      await handleZReportPhoto(chatId, largest.file_id, submittedByLabel, recipients);
      return res.sendStatus(200);
    }

    const suppliers = await readJSON('suppliers.json', []);
    const matchedSupplier = findSupplier(suppliers, result.supplier);

    // Unrecognized supplier name (not just "AI found nothing" — AI DID read something off the
    // document, it just doesn't match anyone in suppliers.json) used to fall straight into
    // ensureSupplier() creating a brand-new supplier silently — confirmed live: an OCR misread of
    // "СервісПако" as "СервісПакЮ" created a duplicate AND skipped that supplier's
    // isChemistrySupplier flag, running the whole накладна through food-catalog matching again.
    // Asking the waiter is cheap and catches this at the source instead of guessing. Also asks when
    // the AI read NO supplier at all (e.g. an informal market чек with no printed name) — a Фортуна
    // чек commonly has none, and without a resolved "Фортуна" name here, appendOrCreateDailyInvoice
    // has nothing to group same-day submissions by.
    if (!matchedSupplier) {
      const pendingSupplier = await readJSON('pendingSupplierConfirm.json', {});
      pendingSupplier[chatId] = { result, fileId: largest.file_id, submittedByLabel, timestamp: new Date().toISOString() };
      await writeJSON('pendingSupplierConfirm.json', pendingSupplier);
      await reply(chatId, result.supplier
        ? `⚠️ Не впізнав постачальника на фото: "${result.supplier}".\n\n` +
          `Якщо назва правильна — напишіть "так". Якщо ні — напишіть правильну назву постачальника.`
        : `⚠️ Не визначив постачальника на фото (наприклад, чек без назви). Напишіть, будь ласка, назву постачальника (наприклад: Фортуна).`);
      return res.sendStatus(200);
    }

    await finalizeInvoiceCreation(chatId, matchedSupplier ? matchedSupplier.name : (result.supplier || ''), result, largest.file_id, submittedByLabel, recipients);
    res.sendStatus(200);
  } catch (err) {
    console.error('Telegram webhook error:', err);
    // One catch wraps накладна OCR, Z-звіт, прихід текстом, чек оплати, і звіт бухгалтера — always
    // blaming "накладна" was misleading whoever's debugging a failure report from any other flow.
    await reply(chatId, '❌ Помилка обробки повідомлення: ' + (err.message || 'невідома помилка'));
    res.sendStatus(200);
  }
});

module.exports = router;
