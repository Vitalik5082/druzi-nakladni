// Standalone daily nag for Комуналка (utilities) specifically — run via Windows Task Scheduler
// every day, doesn't need the Express server running.
//
// monthly-accountant-reminder.js asks бухгалтер on the 15th for BOTH taxes and komunalka for the
// previous month. This script is the enforcement half for komunalka alone: starting the day after
// DEADLINE_DAY (the 20th), it nags бухгалтер daily until a 'Комуналка' expenses.json entry exists
// for the month in question, and tells admin every day she's still late. The moment the entry
// appears, this script just sees it and goes quiet again — no separate "вона внесла" message is
// sent here because routes/telegram.js's handleAccountantExpenseText already notifies admin the
// instant she submits ("💸 Бухгалтер записала витрати за ...").
//
// Looks back up to 6 months (not just "last month") and nags about the OLDEST still-missing one,
// so a month that slips past the next 1st (новий місяць почався, а вона й досі не внесла стару
// комуналку) doesn't get silently dropped just because a newer month became "the current target".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { readJSON, writeJSON } = require('../lib/store');

const DEADLINE_DAY = 20; // day of the CURRENT month by which the PREVIOUS month's komunalka should be in
const LOOKBACK_MONTHS = 6;

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

function monthKeyAndLabel(date) {
  return {
    key: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`,
    label: `${MONTH_NAMES[date.getMonth()]} ${date.getFullYear()}`
  };
}

// Oldest month (within the lookback window) that has no 'Комуналка' expense yet, plus how many
// months back it is — 1 means "last month" (still inside its grace period until DEADLINE_DAY).
// Never looks earlier than the earliest expense record that exists at all, so a month that
// predates when expense tracking even started isn't mistaken for a missed komunalka.
function findOldestMissingMonth(now, expenses) {
  const earliestMonth = expenses.length
    ? expenses.map(e => e.date.slice(0, 7)).sort()[0]
    : monthKeyAndLabel(now).key;

  for (let n = LOOKBACK_MONTHS; n >= 1; n--) {
    const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
    const { key, label } = monthKeyAndLabel(d);
    if (key < earliestMonth) continue;
    const has = expenses.some(e => e.category === 'Комуналка' && e.date.slice(0, 7) === key);
    if (!has) return { key, label, monthsBack: n };
  }
  return null;
}

async function main() {
  const now = new Date();
  const expenses = await readJSON('expenses.json', []);

  const target = findOldestMissingMonth(now, expenses);
  if (!target) {
    console.log('Комуналка внесена за всі останні місяці — нагадування не потрібні.');
    return;
  }

  if (target.monthsBack === 1 && now.getDate() <= DEADLINE_DAY) {
    console.log(`${target.label}: дедлайн (${DEADLINE_DAY}-е число) ще не настав — нагадування не потрібні.`);
    return;
  }

  const recipients = await readJSON('telegramRecipients.json', []);
  const accountants = recipients.filter(r => r.role === 'accountant');
  const admins = recipients.filter(r => r.role === 'admin');

  if (accountants.length) {
    // Refresh pendingAccountantReport so a late reply still gets attributed to the right month —
    // the 15th-of-month flag's own 10-day freshness window (routes/telegram.js) may have already
    // expired by the time she actually answers one of these daily nags.
    const pending = await readJSON('pendingAccountantReport.json', {});
    const text = `⚠️ Нагадування: комуналку за ${target.label} ще не внесено. ` +
      `Будь ласка, надішліть суму у форматі "Комуналка: 7200грн".`;
    for (const r of accountants) {
      try {
        await sendTelegram(r.chatId, text);
        pending[String(r.chatId)] = { month: target.key, timestamp: new Date().toISOString() };
        console.log('Komunalka reminder sent to', r.name, 'for', target.key);
      } catch (err) {
        console.error('Failed to send komunalka reminder to', r.name, err.message);
      }
    }
    await writeJSON('pendingAccountantReport.json', pending);
  }

  if (admins.length) {
    const daysLate = Math.max(1, now.getDate() - DEADLINE_DAY) + (target.monthsBack - 1) * 30;
    const text = `⚠️ Бухгалтер ще не внесла комуналку за ${target.label} ` +
      `(вже ${daysLate} ${daysLate === 1 ? 'день' : 'дні'} після дедлайну ${DEADLINE_DAY}-го числа).`;
    for (const admin of admins) {
      try { await sendTelegram(admin.chatId, text); }
      catch (err) { console.error('Failed to notify admin', admin.name, err.message); }
    }
  }
}

module.exports = { main, findOldestMissingMonth };

if (require.main === module) {
  main().catch(err => {
    console.error('Komunalka reminder failed:', err);
    process.exit(1);
  });
}
