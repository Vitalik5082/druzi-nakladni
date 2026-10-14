// Standalone Z-звіт reminder — run via Windows Task Scheduler at 22:30, doesn't need the Express
// server running. Pings every registered waiter (role: 'waiter') and flags their chat in
// pendingZReport.json so the webhook (routes/telegram.js) treats their NEXT photo as the Z-report
// instead of an накладна, for the rest of that calendar day.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const { readJSON, writeJSON } = require('../lib/store');
const { localDateStr } = require('../lib/poster');

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
  const today = localDateStr();
  const recipients = await readJSON('telegramRecipients.json', []);
  const waiters = recipients.filter(r => r.role === 'waiter');

  if (!waiters.length) {
    console.log('Немає зареєстрованих офіціантів (role: "waiter") — нагадування не надіслано.');
    return;
  }

  const pending = await readJSON('pendingZReport.json', {});

  for (const w of waiters) {
    try {
      await sendTelegram(w.chatId,
        '🧾 Час закривати зміну!\n\nНадішліть, будь ласка, фото Z-звіту (фіскальний чек) з каси — ' +
        'наступне фото від вас я зарахую як Z-звіт і перешлю адміну та бухгалтеру.');
      pending[String(w.chatId)] = today;
      console.log('Z-report reminder sent to', w.name);
    } catch (err) {
      console.error('Failed to remind', w.name, err.message);
    }
  }

  await writeJSON('pendingZReport.json', pending);
}

module.exports = { main };

if (require.main === module) {
  main().catch(err => {
    console.error('Z-report reminder failed:', err);
    process.exit(1);
  });
}
