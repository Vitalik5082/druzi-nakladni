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
  const { supplier, date, items, dueDate, force } = req.body;
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'No items' });

  const total = items.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0);
  const invoiceDate = date || localDateStr();
  const invoiceSupplier = (supplier || '').trim();

  const invoices = await readJSON(FILE, []);

  if (!force) {
    const dup = findDuplicate(invoices, invoiceSupplier, invoiceDate, total);
    if (dup) {
      return res.status(409).json({
        error: 'duplicate',
        message: `Схожа накладна вже є: ${dup.supplier || '—'} від ${dup.date} на суму ${dup.total.toFixed(2)} ₴`,
        existing: { ...dup, status: deriveStatus(dup) }
      });
    }
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
    createdAt: new Date().toISOString()
  };

  invoices.push(invoice);
  await writeJSON(FILE, invoices);
  await ensureSupplier(invoice.supplier);
  await learnSupplierFromItems(items, invoice.supplier);

  res.json({ ...invoice, status: deriveStatus(invoice) });
});

router.patch('/invoices/:id', async (req, res) => {
  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(req.params.id));
  if (!invoice) return res.status(404).json({ error: 'Not found' });

  const { paidAmount, paidDate, dueDate, supplier, date } = req.body;
  if (paidAmount !== undefined) invoice.paidAmount = Number(paidAmount) || 0;
  if (paidDate !== undefined) invoice.paidDate = paidDate;
  if (dueDate !== undefined) invoice.dueDate = dueDate;
  if (supplier !== undefined) invoice.supplier = supplier;
  if (date !== undefined) invoice.date = date;

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
