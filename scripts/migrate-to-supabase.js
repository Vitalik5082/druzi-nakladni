// One-off: push existing local JSON files into Supabase kv_store, preserving all data
// accumulated so far (invoices, suppliers, techcards, Poster sales history, etc.)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function upsert(key, value) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/kv_store`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() })
  });
  if (!res.ok) throw new Error(`${key}: ${res.status} ${await res.text()}`);
}

async function main() {
  const dataDir = path.join(__dirname, '..', 'data');
  const dataFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.json'));

  for (const file of dataFiles) {
    const content = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf-8'));
    await upsert(file, content);
    console.log('migrated', file);
  }

  const extras = [
    ['products.json', path.join(__dirname, '..', 'public', 'products.json')],
    ['matches.json', path.join(__dirname, '..', 'public', 'matches.json')]
  ];
  for (const [key, filePath] of extras) {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    await upsert(key, content);
    console.log('migrated', key);
  }

  console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
