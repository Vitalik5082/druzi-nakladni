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

// Vercel's build statically scans for `require("literal string")` to decide which files belong in
// the serverless bundle — a dynamic `require(someVariable)` isn't analyzable, so scripts/*.js
// silently never made it into the deployed function. Worked locally (every file is on disk), 200
// OK'd in production too (per-job errors are caught below, never failing the HTTP response) while
// actually throwing "Cannot find module" internally every single tick. Literal requires fix that.
const jobModules = {
  dailyReport: require('../scripts/daily-report'),
  supplierStockDigest: require('../scripts/supplier-stock-digest'),
  zreportReminder: require('../scripts/zreport-reminder'),
  accountantMonthly: require('../scripts/monthly-accountant-reminder'),
  monthlyReport: require('../scripts/monthly-report')
};

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
  { key: 'dailyReport', targetHM: '11:00' },
  { key: 'supplierStockDigest', targetHM: '18:00' },
  { key: 'zreportReminder', targetHM: '22:30' },
  { key: 'accountantMonthly', targetHM: '10:00', onlyOnDay: 15 },
  { key: 'monthlyReport', targetHM: '11:00', onlyOnDay: 1 }
];

router.all('/cron/tick', async (req, res) => {
  // Accept the secret via header (GitHub Actions) OR a query param (?secret=...) — some free
  // cron-ping services (cron-job.org etc.) make custom headers awkward to configure, but every
  // one of them can hit a plain URL.
  const provided = req.headers['x-cron-secret']
    || (req.headers.authorization || '').replace(/^Bearer /, '')
    || req.query.secret;
  if (!process.env.CRON_SECRET || provided !== process.env.CRON_SECRET) {
    return res.sendStatus(401);
  }

  const now = kyivNow();
  const results = [];

  for (const job of JOBS) {
    if (job.onlyOnDay && now.day !== job.onlyOnDay) continue;
    if (!withinWindow(now.minutesSinceMidnight, job.targetHM)) continue;

    // Both cron-job.org and GitHub Actions are kept running against this same endpoint (one as a
    // backup for the other) — two ticks landing close together inside the same 20-min window used
    // to both read "not run today" before either wrote back, so Oleg/waiters/admin got some
    // reminders twice. Re-reading fresh and claiming (writing the date) BEFORE running the job,
    // instead of once at the very end, shrinks that race window from "however long the whole tick
    // takes" down to just this one read+write — not a true atomic lock (kv_store has none to offer),
    // but good enough for two schedulers 15 minutes apart.
    const lastRun = await readJSON('cronLastRun.json', {});
    if (lastRun[job.key] === now.date) continue; // already claimed/ran today
    lastRun[job.key] = now.date;
    await writeJSON('cronLastRun.json', lastRun);

    try {
      await jobModules[job.key].main();
      results.push({ job: job.key, status: 'ok' });
    } catch (err) {
      console.error(`cron job ${job.key} failed:`, err);
      results.push({ job: job.key, status: 'error', message: err.message });
      // Release the claim so a retry within the same window is still possible instead of silently
      // skipping the job for the rest of the day.
      const rollback = await readJSON('cronLastRun.json', {});
      delete rollback[job.key];
      await writeJSON('cronLastRun.json', rollback);
    }
  }

  res.json({ ok: true, kyivDate: now.date, kyivMinutes: now.minutesSinceMidnight, ran: results });
});

module.exports = router;
