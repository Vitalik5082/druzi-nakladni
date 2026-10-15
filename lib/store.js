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

module.exports = { readJSON, writeJSON, nextId };
