const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// A network hiccup or a non-2xx from Supabase must NEVER look like "this key legitimately doesn't
// exist yet" — every caller does readJSON(key, fallback) then writes a MODIFIED version of
// whatever came back. If a transient failure silently returned `fallback` here, the caller would
// happily append to an empty array and write that back, and writeJSON's merge-duplicates REPLACES
// the whole stored value for that key — a brief Supabase blip could wipe months of real data.
// Only an actually-empty result set (res.ok, zero rows) means "genuinely not there yet".
async function readJSON(key, fallback) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}&select=value`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`readJSON(${key}): Supabase returned ${res.status}`);
  const rows = await res.json();
  return rows.length ? rows[0].value : fallback;
}

async function writeJSON(key, data) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key, value: data, updated_at: new Date().toISOString() })
  });
  // Previously unchecked — a failed write (bad payload, auth hiccup, rate limit) looked identical
  // to a successful one: the caller showed "✓ Збережено" / sent a Telegram confirmation while
  // nothing was actually persisted, and the next read would look like "that data never existed".
  if (!res.ok) throw new Error(`writeJSON(${key}): Supabase returned ${res.status}`);
}

// kv_store is a single JSONB blob per key, not a relational table — there's no atomic "give me
// the next id" primitive available via PostgREST, so two concurrent requests (e.g. two Telegram
// photos arriving close together) can both read the same max id and both compute the same
// "next" one, then both write back a full array containing their own same-id item; whichever
// write lands second silently overwrites the first — not just a duplicate id, a vanished record.
// A real fix needs a Postgres-side atomic sequence/RPC; this at least makes the SPECIFIC
// same-id-collision impossible by deriving the id from the current timestamp (always distinct
// across requests in practice) instead of a sequential counter two readers can agree on.
function nextId(list) {
  const maxExisting = list.reduce((max, item) => Math.max(max, item.id || 0), 0);
  return Math.max(maxExisting, Date.now());
}

// A true atomic "claim" (unlike readJSON-then-writeJSON, which is check-then-act and can race):
// a plain INSERT with no Prefer: resolution=merge-duplicates fails with 409 if `key` already
// exists, because kv_store.key is the table's primary key — Postgres itself serializes two
// concurrent INSERTs of the same key, so exactly one caller gets 201/true. Used by routes/cron.js
// to stop two cron pingers (cron-job.org + GitHub Actions, both hitting /cron/tick as backups for
// each other) from both winning a "not run today" check and double-sending a report/reminder —
// confirmed happening live (Oleg and the daily report both got sent twice) with the old
// read-then-write cronLastRun.json approach, which only shrank the race window, never closed it.
async function claimOnce(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ key, value: true, updated_at: new Date().toISOString() })
  });
  if (res.status === 201) return true;
  if (res.status === 409) return false;
  throw new Error(`claimOnce(${key}): Supabase returned ${res.status}`);
}

// Releases a claim so a failed job can be retried within the same day/window instead of being
// permanently skipped until tomorrow.
async function releaseClaim(key) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store?key=eq.${encodeURIComponent(key)}`, {
    method: 'DELETE',
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` }
  });
  if (!res.ok) throw new Error(`releaseClaim(${key}): Supabase returned ${res.status}`);
}

module.exports = { readJSON, writeJSON, nextId, claimOnce, releaseClaim };
