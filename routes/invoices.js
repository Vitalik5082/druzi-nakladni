const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');
const { normalize, VAT_RATE } = require('../lib/convert');
const { localDateStr } = require('../lib/poster');

const router = express.Router();
const FILE = 'invoices.json';
const SUPPLIERS_FILE = 'suppliers.json';
const SUPPLIER_LEARN_FILE = 'supplierLearn.json';

function deriveStatus(invoice) {
  // paidAmount is real cash handed to the supplier — compared against the GROSS (з ПДВ) total,
  // not the net accounting baseline. A платіжна інструкція/receipt always shows the з ПДВ figure,
  // so matching against net total here would make every fully-paid invoice look underpaid by the
  // VAT amount.
  const paid = invoice.paidAmount || 0;
  const payable = invoice.total_with_vat || invoice.total || 0;
  if (paid <= 0) return 'unpaid';
  if (paid >= payable - 0.01) return 'paid';
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

// Some suppliers (e.g. Проценко/Плахотнік, Поділля Фуд) print line prices that are ALREADY
// gross (with ПДВ) rather than net — unlike most suppliers (Ольга-Торг, Пшеничний, Метро,
// Буковина-Трек, Баядера), who print net prices and only add 20% as one lump sum at the very
// end. convertItem()/withVat() always assumes the net-price case (price → price*1.2 "with
// vat"), so for a pricesIncludeVat supplier that math is backwards and needs reversing: the
// AI-extracted price/total IS the gross figure, and net = gross / VAT_RATE.
function reverseVatDirection(items) {
  return items.map(item => {
    if (item.skipped) return item;
    const grossPrice = item.price || 0;
    const grossTotal = item.total || 0;
    const fixed = {
      ...item,
      price: Number((grossPrice / VAT_RATE).toFixed(6)),
      price_with_vat: grossPrice,
      total: Number((grossTotal / VAT_RATE).toFixed(2)),
      total_with_vat: grossTotal
    };
    if (item.price_per_g) {
      fixed.price_per_g_with_vat = item.price_per_g;
      fixed.price_per_g = Number((item.price_per_g / VAT_RATE).toFixed(6));
    }
    return fixed;
  });
}

// Shared by the website's POST /invoices AND the Telegram bot. Returns either
// { duplicate: true, existing } or { invoice }.
async function createInvoice({ supplier, date, items, dueDate, force, source, submittedBy, pendingReview }) {
  if (!Array.isArray(items) || !items.length) {
    const err = new Error('No items');
    err.status = 400;
    throw err;
  }

  const invoiceDate = date || localDateStr();
  const invoiceSupplier = (supplier || '').trim();

  const suppliersList = await readJSON(SUPPLIERS_FILE, []);
  const supplierRecord = suppliersList.find(s => s.name.toLowerCase() === invoiceSupplier.toLowerCase());
  if (supplierRecord && supplierRecord.pricesIncludeVat) {
    items = reverseVatDirection(items);
  }

  const total = items.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0);

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

// Shared by the website's PATCH /invoices/:id AND the Telegram bot's payment-status buttons.
async function updateInvoice(id, { paidAmount, paidDate, dueDate, supplier, date, pendingReview, items }) {
  const invoices = await readJSON(FILE, []);
  const invoice = invoices.find(inv => inv.id === Number(id));
  if (!invoice) return null;

  // Changing the supplier on an EXISTING invoice never re-derives the VAT direction — createInvoice()
  // only applies reverseVatDirection() once, at creation time, based on whichever supplier matched
  // then. If the invoice was created unmatched (so prices were assumed net) and later reassigned to
  // a pricesIncludeVat supplier (or the other way), the totals stay silently wrong by ~20% — exactly
  // the Кока-Кола bug fixed twice by hand this session, just via the rename path instead of OCR.
  // Auto-recalculating here is unsafe once an item may have already been manually edited (no
  // reliable "original raw price" to re-derive from) — surface it as a warning instead of guessing.
  let vatWarning = null;
  if (supplier !== undefined && supplier !== invoice.supplier) {
    const suppliers = await readJSON(SUPPLIERS_FILE, []);
    const newSupplierRecord = suppliers.find(s => s.name === supplier);
    if (newSupplierRecord && newSupplierRecord.pricesIncludeVat) {
      vatWarning = `Постачальник "${supplier}" позначений "ціна з ПДВ" — перевірте вручну, чи суми в накладній правильні (можливо, потрібно перерахувати через "Редагувати").`;
    }
  }

  if (paidAmount !== undefined) invoice.paidAmount = Number(paidAmount) || 0;
  if (paidDate !== undefined) invoice.paidDate = paidDate;
  if (dueDate !== undefined) invoice.dueDate = dueDate;
  if (supplier !== undefined) invoice.supplier = supplier;
  if (date !== undefined) invoice.date = date;
  if (pendingReview !== undefined) invoice.pendingReview = !!pendingReview;

  // Manual qty/price correction (reєстр накладних): qty and price (excl. VAT) are the editable
  // source of truth, everything else (total, with-VAT figures) is derived — same price/price_with_vat
  // direction the invoice was originally created with, just recomputed off the corrected numbers.
  if (Array.isArray(items)) {
    invoice.items = items.map(item => {
      if (item.skipped) return item;
      const qty = Number(item.qty) || 0;
      const price = Number(item.price) || 0;
      const total = Number((qty * price).toFixed(2));
      return {
        ...item, qty, price, total,
        price_with_vat: Number((price * VAT_RATE).toFixed(6)),
        total_with_vat: Number((total * VAT_RATE).toFixed(2))
      };
    });
    invoice.total = Number(invoice.items.filter(i => !i.skipped).reduce((s, i) => s + (i.total || 0), 0).toFixed(2));
    invoice.total_with_vat = Number((invoice.total * VAT_RATE).toFixed(2));
  }

  await writeJSON(FILE, invoices);
  if (supplier) await ensureSupplier(supplier);

  return { ...invoice, status: deriveStatus(invoice), vatWarning };
}

router.patch('/invoices/:id', async (req, res) => {
  const updated = await updateInvoice(req.params.id, req.body);
  if (!updated) return res.status(404).json({ error: 'Not found' });
  res.json(updated);
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
module.exports.updateInvoice = updateInvoice;
