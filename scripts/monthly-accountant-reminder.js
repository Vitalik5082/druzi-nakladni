// Standalone monthly accountant reminder + static-expense auto-fill — run via Windows Task
// Scheduler on the 15th of every month, doesn't need the Express server running.
//
// Two unrelated jobs share this one 15th-of-month run:
// 1) Ask бухгалтер to report taxes + utilities paid for the PREVIOUS calendar month (figures that
//    genuinely vary and can't be guessed), setting a pendingAccountantReport flag (keyed by her
//    chat_id, holding the target 'YYYY-MM') so the webhook (routes/telegram.js) knows which month
//    her next free-text reply is about, no matter how many hours/days later she actually answers.
// 2) Auto-apply recurring-expense templates flagged `autoApply: true` (сторінка "Витрати" →
//    "Регулярні") for the CURRENT month — fixed costs (rent, internet, SMM salary, subscriptions)
//    that don't need re-typing every month and don't need бухгалтер's input at all. Uses the same
//    createExpenseRecord() the website and the Telegram bot use, so these also sync to Poster.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { readJSON, writeJSON } = require('../lib/store');
const { createExpenseRecord } = require('../routes/expenses');

const MONTH_NAMES = [
  'січень', 'лютий', 'березень', 'квітень', 'травень', 'червень',
  'липень', 'серпень', 'вересень', 'жовтень', 'листопад', 'грудень'
];

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

function buildMessage(monthLabel) {
  return `Доброго дня! Настав час зафіксувати податки та комуналку за ${monthLabel}.\n\n` +
    `Якщо податки і комуналка були вже оплачені, надішліть мені будь ласка в форматі ` +
    `"Податки: 10грн, Комуналка: 10грн". Якщо платежі ще не було оплачено, надішліть, будь ласка, ` +
    `одразу після оплати. Дякую!`;
}

// Skips a template already applied this month (same guard /recurring-expenses/apply uses), so
// re-running this script by hand for testing never double-books a fixed cost.
async function applyStaticExpenses() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const date = `${month}-15`;

  const templates = (await readJSON('recurringExpenses.json', [])).filter(t => t.autoApply);
  if (!templates.length) {
    console.log('Немає шаблонів з autoApply — статичні витрати не застосовано.');
    return [];
  }

  const expenses = await readJSON('expenses.json', []);
  const created = [];

  for (const template of templates) {
    const alreadyApplied = expenses.some(e =>
      e.date.slice(0, 7) === month && e.category === template.category && e.description === template.name);
    if (alreadyApplied) { console.log(template.name, '— вже застосовано за', month); continue; }

    const expense = await createExpenseRecord(expenses, {
      date, category: template.category, description: template.name, amount: template.amount
    });
    created.push(expense);
    console.log('Applied:', template.name, template.amount, '₴', expense.postedToPoster ? '(synced to Poster)' : '(Poster sync FAILED)');
  }

  if (created.length) await writeJSON('expenses.json', expenses);
  return created;
}

async function main() {
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const targetMonth = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const monthLabel = `${MONTH_NAMES[prevMonthDate.getMonth()]} ${prevMonthDate.getFullYear()}`;

  const recipients = await readJSON('telegramRecipients.json', []);
  const accountants = recipients.filter(r => r.role === 'accountant');
  const admins = recipients.filter(r => r.role === 'admin');

  if (!accountants.length) {
    console.log('Немає зареєстрованого бухгалтера (role: "accountant") — нагадування не надіслано.');
  } else {
    const pending = await readJSON('pendingAccountantReport.json', {});
    const text = buildMessage(monthLabel);

    for (const r of accountants) {
      try {
        await sendTelegram(r.chatId, text);
        pending[String(r.chatId)] = targetMonth;
        console.log('Reminder sent to', r.name, 'for month', targetMonth);
      } catch (err) {
        console.error('Failed to send reminder to', r.name, err.message);
      }
    }

    await writeJSON('pendingAccountantReport.json', pending);
  }

  const created = await applyStaticExpenses();
  if (created.length && admins.length) {
    const summary = `🧾 Автоматично застосовано статичні витрати за цей місяць:\n` +
      created.map(e => `${e.description}: ${e.amount.toFixed(2)} ₴${e.postedToPoster ? '' : ' (⚠️ не синхронізовано з Poster)'}`).join('\n');
    for (const admin of admins) await sendTelegram(admin.chatId, summary);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Monthly accountant reminder failed:', err);
    process.exit(1);
  });
}
