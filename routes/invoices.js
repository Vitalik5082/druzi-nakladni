const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');
const { normalize, VAT_RATE } = require('../lib/convert');
const { localDateStr } = require('../lib/poster');

const router = express.Router();
const FILE = 'invoices.json';
const SUPPLIERS_FILE = 'suppliers.json';
const SUPPLIER_LEARN_FILE = 'supplierLearn.json';

function deriveStatus(invoice) {
  const paid = invoice.paidAmount || 0;
  if (paid <= 0) return 'unpaid';
  if (paid >= invoice.total) return 'paid';
  return 'partial';
}

async function ensureSupplier(name) {
  if (!name || !name.trim()) return;
  const suppliers = await readJSON(SUPPLIERS_FILE, []);
  const exists = suppliers.some(s => s.name.toLowerCase() === name.trim().toLowerCase());
  if (!exists) {
    suppliers.push({ id: nextId(suppliers), name: name.trim(), contact: '', terms: '' });
    await writeJSON(SUPPLIERS_FILE, suppliers);
  }
}

async function learnSupplierFromItems(items, supplier) {
  if (!supplier) return;
  const learn = await readJSON(SUPPLIER_LEARN_FILE, {});
  for (const item of items) {
    if (item.skipped) continue;
    const key = normalize(item.original_name || item.name);
    learn[key] = { supplier, count: ((learn[key] && learn[key].count) || 0) + 1 };
  }
  await writeJSON(SUPPLIER_LEARN_FILE, learn);
}

function findDuplicate(invoices, supplier, date, total) {
  const supplierKey = (supplier || '').trim().toLowerCase();
  return invoices.find(inv =>
    (inv.supplier || '').trim().toLowerCase() === supplierKey &&
    inv.date === date &&
    Math.abs((inv.total || 0) - total) < 0.01
  );
}

// Shared by the website's POST /invoices AND the Telegram bot. Returns either
// { duplicate: true, existing } or { invoice }.
async function createInvoice({ supplier, date, items, dueDate, force, source, submittedBy, pendingReview }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('No items');
    err.status = 400;
    throw err;
  }

  const total = items.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0);
  const invoiceDate = date || localDateStr();
  const invoiceSupplier = (supplier || '').trim();

  const invoices = await readJSON(FILE, []);

  if (!force) {
    const dup = findDuplicate(invoices, invoiceSupplier, invoiceDate, total);
    if (dup) return { duplicate: true, existing: { ...dup, status: deriveStatus(dup) } };
  }

  const invoice = {
    id: nextId(invoices),
    date: invoiceDate,
    supplier: invoiceSupplier,
    items,
    total,
    total_with_vat: Number((total * VAT_RATE).toFixed(2)),
    paidAmount: 0,
    paidDate: null,
    dueDate: dueDate || null,
    source: source || 'web',
    submittedBy: submittedBy || null,
    pendingReview: !!pendingReview,
    createdAt: new Date().toISOString()
  };

  invoices.push(invoice);
  await writeJSON(FILE, invoices);
  await ensureSupplier(invoice.supplier);
  await learnSupplierFromItems(items, invoice.supplier);

  return { invoice: { ...invoice, status: deriveStatus(invoice) } };
}

router.get('/invoices', async (req, res) => {
  const { status, supplier, from, to } = req.query;
  const raw = await readJSON(FILE, []);
  let invoices = raw.map(inv => ({ ...inv, status: deriveStatus(inv) }));

  if (status) invoices = invoices.filter(inv => inv.status === status);
  if (supplier) invoices = invoices.filter(inv => (inv.supplier || '').toLowerCase().includes(supplier.toLowerCase()));
  if (from) invoices = invoices.filter(inv => inv.date >= from);
  if (to) invoices = invoices.filter(inv => inv.date <= to);

  invoices.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.id - a.id);
  res.json(invoices);
});

router.get('/invoices/:id', async (req, res) => {
  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(req.params.id));
  if (!invoice) return res.status(404).json({ error: 'Not found' });
  res.json({ ...invoice, status: deriveStatus(invoice) });
});

router.post('/invoices', async (req, res) => {
  try {
    const result = await createInvoice(req.body);
    if (result.duplicate) {
      return res.status(409).json({
        error: 'duplicate',
        message: `Схожа накладна вже є: ${result.existing.supplier || '—'} від ${result.existing.date} на суму ${result.existing.total.toFixed(2)} ₴`,
        existing: result.existing
      });
    }
    res.json(result.invoice);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.patch('/invoices/:id', async (req, res) => {
  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(req.params.id));
  if (!invoice) return res.status(404).json({ error: 'Not found' });

  const { paidAmount, paidDate, dueDate, supplier, date, pendingReview } = req.body;
  if (paidAmount !== undefined) invoice.paidAmount = Number(paidAmount) || 0;
  if (paidDate !== undefined) invoice.paidDate = paidDate;
  if (dueDate !== undefined) invoice.dueDate = dueDate;
  if (supplier !== undefined) invoice.supplier = supplier;
  if (date !== undefined) invoice.date = date;
  if (pendingReview !== undefined) invoice.pendingReview = !!pendingReview;

  await writeJSON(FILE, invoices);
  if (supplier) await ensureSupplier(supplier);

  res.json({ ...invoice, status: deriveStatus(invoice) });
});

router.delete('/invoices/:id', async (req, res) => {
  const invoices = await readJSON(FILE, []);
  const filtered = invoices.filter(inv => inv.id !== Number(req.params.id));
  if (filtered.length === invoices.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
module.exports.createInvoice = createInvoice;
