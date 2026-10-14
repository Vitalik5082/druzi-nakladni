// Single endpoint that an external scheduler (GitHub Actions — see .github/workflows/cron.yml in
// the deploy repo) pings every ~15 minutes. Vercel's own Cron Jobs are capped at 2-per-project and
// once-per-day on the Hobby plan, nowhere near enough for our 5 differently-timed jobs — this one
// endpoint, hit often, decides for itself (by real Kyiv wall-clock time) which job(s) are due, so
// it never needs touching for DST and needs no paid plan.
//
// Mounted BEFORE the Supabase-auth middleware (same reason as routes/telegram.js — the caller here
// is GitHub Actions, not a logged-in browser) and gated by its own shared secret instead.
const express = require('express');
const { readJSON, writeJSON } = require('../lib/store');

const router = express.Router();

function kyivNow() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const get = type => parts.find(p => p.type === type).value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    minutesSinceMidnight: Number(get('hour')) * 60 + Number(get('minute')),
    day: Number(get('day'))
  };
}

function hmToMinutes(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

// True for a 20-minute window starting at targetHM — wide enough that a scheduler tick running a
// few minutes late (GitHub Actions doesn't guarantee the exact minute) still catches it, while
// cronLastRun.json's per-day guard (below) stops it firing more than once even if ticks land
// inside the window repeatedly.
function withinWindow(nowMinutes, targetHM) {
  const target = hmToMinutes(targetHM);
  return nowMinutes >= target && nowMinutes < target + 20;
}

const JOBS = [
  { key: 'dailyReport', targetHM: '11:00', module: '../scripts/daily-report' },
  { key: 'supplierStockDigest', targetHM: '18:00', module: '../scripts/supplier-stock-digest' },
  { key: 'zreportReminder', targetHM: '22:30', module: '../scripts/zreport-reminder' },
  { key: 'accountantMonthly', targetHM: '10:00', module: '../scripts/monthly-accountant-reminder', onlyOnDay: 15 },
  { key: 'monthlyReport', targetHM: '11:00', module: '../scripts/monthly-report', onlyOnDay: 1 }
];

router.all('/cron/tick', async (req, res) => {
  const provided = (req.headers['x-cron-secret'] || (req.headers.authorization || '').replace(/^Bearer /, ''));
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.sendStatus(401);
  }

  const now = kyivNow();
  const lastRun = await readJSON('cronLastRun.json', {});
  const results = [];

  for (const job of JOBS) {
    if (job.onlyOnDay && now.day !== job.onlyOnDay) continue;
    if (!withinWindow(now.minutesSinceMidnight, job.targetHM)) continue;
    if (lastRun[job.key] === now.date) continue; // already ran today

    try {
      await require(job.module).main();
      lastRun[job.key] = now.date;
      results.push({ job: job.key, status: 'ok' });
    } catch (err) {
      console.error(`cron job ${job.key} failed:`, err);
      results.push({ job: job.key, status: 'error', message: err.message });
      // Deliberately NOT recording lastRun on failure, so the next tick (within the same 20-min
      // window) retries instead of silently skipping the job for the whole day.
    }
  }

  await writeJSON('cronLastRun.json', lastRun);
  res.json({ ok: true, kyivDate: now.date, kyivMinutes: now.minutesSinceMidnight, ran: results });
});

module.exports = router;
