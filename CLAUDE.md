# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Business-management web app for a cafe/bar (Druzi): invoice OCR (via накладна photo → OpenAI vision), cash register, payroll, expenses, a P&L dashboard, inventory revisions, a Poster POS integration (sales/techcards/order recommendations), an AI chat over the business data, and Telegram reports. Built incrementally in one long session — there is no test suite and no build step.

## Commands

- `npm install` — install deps
- `node index.js` — run locally at http://localhost:3000 (reads `.env`)
- No lint/test/build scripts exist (`npm test` is the default unconfigured stub).
- To verify a change end-to-end, prefer hitting the relevant endpoint with `curl`/`node -e "fetch(...)"` over guessing — most bugs found in this codebase (timezone off-by-one, Poster's kopeck scaling, brutto/netto unit mixing) were only caught by comparing live Poster responses against the derived numbers.

## Deployment — two copies, manual sync

This folder (`C:\Users\User\Desktop\Nakladni`) is the **local dev copy**. The deployed copy lives in a **separate sibling folder/repo**: `C:\Users\User\Desktop\Site\Друзі-Бар-Накладні`, pushed to `github.com/Vitalik5082/druzi-nakladni`, auto-deployed by Vercel to `https://druzi-nakladni.vercel.app`. There is no CI/sync script — after changing code here, **copy the changed files into the deploy folder, commit, and push** to actually ship them. `scripts/`, `data/*.json` (legacy, unused now) and `.env` are not part of the deploy copy's intent — only `index.js`, `lib/`, `routes/`, `public/`, `package.json`, `vercel.json` need to stay mirrored.

`vercel.json` routes every request through `index.js` as one serverless function (`@vercel/node`). `index.js` exports `app` and only calls `app.listen()` when `process.env.VERCEL` is unset, so the same file works both locally and on Vercel.

The companion public menu site (`druzi-menu`, a separate single-file static repo/Vercel project, no relation to this app's code) links to this app from its hidden `#admin` panel, and **shares the same Supabase project** — see Auth/Data below for why that's safe.

## Data layer: Supabase as a key-value store, not a relational schema

There is **no local JSON file storage anymore** (that was the original design; data/*.json in this repo are stale leftovers from before the Supabase migration — don't read them as current state). All persistence goes through `lib/store.js`'s `readJSON(key, fallback)` / `writeJSON(key, value)`, which are **async** and talk to a single Supabase table `kv_store (key text primary key, value jsonb)` via raw `fetch` to the PostgREST API (service-role key, bypasses RLS — this is a trusted backend, never exposed to the browser). Each former JSON filename is one row's key (e.g. `'invoices.json'`, `'techcards.json'`, `'products.json'`). Every route handler that touches a store must be `async` and `await` these calls — this is a common source of bugs if a new handler forgets the `await`.

This was a deliberate choice over a real relational schema: data volume is tiny (sub-1MB total), and all the business logic already assumed in-memory JS array/object manipulation on a full blob — keeping that shape avoided a full rewrite. `routes/recognition.js` additionally lazy-loads `products.json`/`matches.json` into module-level in-memory caches (`ensureLoaded()`, memoized) because the fuzzy-match index (`Fuse.js`) needs them synchronously inside a hot loop; every route handler in that file calls `await ensureLoaded()` first.

`public/portions.json` is the one exception — read-only reference data (alcohol/draft-beer/food-portion rules), edited by hand, loaded via plain `fs.readFileSync` at request time since it's bundled with the deploy and never written by the app.

## Auth: Supabase Auth, no custom session

There's no backend `/login` route. The browser authenticates **directly against Supabase** (`public/login.html` POSTs to `${SUPABASE_URL}/auth/v1/token?grant_type=password`, same raw-fetch pattern the druzi-menu site already used), stores the JWT in `localStorage` (`public/auth.js`), and every protected page calls `requireAuth()` (client-side redirect-if-missing, UX only) and wraps every API call in `authFetch()` (attaches `Authorization: Bearer`). The **real** protection is server-side: `index.js` serves `public/` statically with no gate (so pages/assets always 200), and everything that isn't a static file (every route in `routes/`) sits behind a middleware that verifies the Bearer token against `${SUPABASE_URL}/auth/v1/user` and 401s otherwise. If you add a new page, it needs `<script src="auth.js"></script>` + `requireAuth()` in its init script, and its `fetch()` calls need to be `authFetch()` or they'll silently 401.

Known gotcha already hit once: `express.static('public')` (relative path) works locally but **silently serves nothing on Vercel** (different cwd in the serverless runtime) — must be `express.static(path.join(__dirname, 'public'))`.

The admin Supabase Auth user is `avkvitala@gmail.com`, created via the Admin API in the same Supabase project the `druzi-menu` site uses — intentionally, so the same login also works on that site's hidden `#admin`. `kv_store` has RLS enabled with **no policies**, meaning only the service-role key (used server-side here) can touch it — druzi-menu's public anon key, hardcoded client-side in its own `index.html`, has zero access to this app's tables.

## The накладна (invoice) OCR pipeline

`routes/recognition.js`'s `/upload` sends the photo to GPT-4o asking for `{ supplier, date, invoiceTotal, items[] }` (not a bare array — handled with a backward-compat branch). Each item goes through `findBestMatch()` (word-overlap then `Fuse.js` fuzzy match against the product catalog, with a learned-mapping override) and then `lib/convert.js`'s `convertItem()`, which is the trickiest part of the codebase:

- Classification order matters: container keywords (БУТ/БАНКА → piece-counted "bottled"; КЕГ/БОЧКА → "draft_beer") are checked **before** brand-keyword rules from `public/portions.json`, specifically because a brand can appear in both a bottled SKU and a keg SKU (this was a real bug: "Стелла Артуа 0.5л Бут" was being classified as draft beer because "СТЕЛЛА" matched a keg brand rule).
- For piece-counted ingredients (`unit === 'p'`), Poster's `netto` is a weight-equivalent (or 0), **not** a piece count — `brutto` is the real count. This trips up anything that sums consumption/cost across ingredient lines.
- Modifier lines (`group_modifications`) don't carry their own unit — their numeric amount is always in the ingredient's **sub-unit** (ml for a litre-tracked ingredient, g for a kg-tracked one), never the base unit; `modifierSubUnit()` in `routes/poster.js` encodes this.
- A modifier's `ingredient_id` sometimes points into a **separate "prepack" (напівфабрикат) table** (`menu.getPrepacks`/`menu.getPrepack`), not the raw ingredient table — resolve prepacks first and expand their own ingredient lines (scaled by `modifier.brutto / prepack.out`) before falling back to treating it as a raw ingredient.
- `unitOverrides.json` (learned, per normalized product name) lets a manual correction in the UI override the heuristic permanently; `reclassify.js`'s `/api/reclassify` recomputes a single item live when the user changes its unit dropdown, reusing the same `convertItem()`.

## Poster POS integration (`lib/poster.js`, `routes/poster.js`)

Raw `fetch` wrapper (`posterCall(method, params)`) against `https://joinposter.com/api/{method}`, token from `POSTER_TOKEN` env var. Hard-won facts about Poster's own API, not guessable from its docs:

- **Dates**: `localDateStr()` exists specifically because `Date#toISOString()` converts to UTC first — for Kyiv (UTC+2/3) that silently rolls local midnight back a day. Never use `.toISOString().slice(0,10)` anywhere date math touches Poster sync ranges; it already corrupted a month of synced data once.
- **`prime_cost` from `menu.getIngredients`** is in "kopecks × 100", not plain kopecks — divide the raw value by `10000`, not `100`, to get ₴. Confirmed by cross-checking against `structure_selfprice` on techcard ingredient lines for several ingredients.
- **`dash.getProductsSales`'s `modification_id`** does **not** correspond to `menu.getProduct`'s `dish_modification_id` — they're different numbering spaces. Match sales to techcards by **normalized modifier name** instead (`normalizeModName()`), not by ID.
- `routes/poster.js`'s `computeConsumption()` (sales × techcard, last N days) is the shared basis for the "Залишки" consumption view, order recommendations, and the AI chat's profitability/worst-seller tools — `routes/chat.js` deliberately re-implements a trimmed copy rather than importing it, to keep the chat tool functions self-contained.
- Order recommendations fall back to average-weekly-consumption×1.1 instead of Poster's own `ingredient_left` whenever that leftover is negative, because supplies aren't logged consistently in Poster — a negative/untrustworthy leftover is common, not an edge case.

## Telegram (standalone scripts, not part of the Express app)

`scripts/daily-report.js` and `scripts/monthly-report.js` are run via **Windows Task Scheduler** on the local machine (`Druzi-DailyReport` at 11:00, `Druzi-MonthlyReport` on the 1st) — they do **not** run on Vercel. They read/write the same Supabase `kv_store` directly (duplicating small bits of `routes/poster.js`'s logic rather than importing it, since they're meant to run standalone without booting the Express app). `data/telegramRecipients.json` (→ `kv_store` key `telegramRecipients.json`) holds `{name, chatId, role}`; `role: 'admin'` gets the full report, every other role gets only the order-reminder section. Adding a recipient requires them to message the bot once first (so `getUpdates` can reveal their `chat.id`).

A Telegram **webhook**-based bot (waiters photographing накладні → bot OCRs and notifies an accountant + creates a pending invoice here) was discussed and deliberately deferred until after this app was properly deployed with a stable public HTTPS URL — it isn't built yet.
