require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

// Static pages/assets are always servable — page-level protection is client-side (public/auth.js),
// same pattern druzi-menu already uses. Only requests that fall through here (no matching static
// file — i.e. every API/action endpoint) reach the token check below.
app.use(express.static('public'));

async function verifySupabaseToken(token) {
  try {
    const res = await fetch(`${process.env.SUPABASE_URL}/auth/v1/user`, {
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`
      }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

app.use(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  const user = await verifySupabaseToken(token);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  req.user = user;
  next();
});

app.use(require('./routes/recognition'));
app.use('/api', require('./routes/suppliers'));
app.use('/api', require('./routes/invoices'));
app.use('/api', require('./routes/reclassify'));
app.use('/api', require('./routes/cash'));
app.use('/api', require('./routes/expenses'));
app.use('/api', require('./routes/employees'));
app.use('/api', require('./routes/payroll'));
app.use('/api', require('./routes/dashboard'));
app.use('/api', require('./routes/revisions'));
app.use('/api', require('./routes/poster'));
app.use('/api', require('./routes/product-suppliers'));
app.use('/api', require('./routes/chat'));

if (!process.env.VERCEL) {
  app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
}

module.exports = app;
