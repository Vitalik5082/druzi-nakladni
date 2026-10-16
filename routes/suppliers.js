const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'suppliers.json';

router.get('/suppliers', async (req, res) => {
  res.json(await readJSON(FILE, []));
});

router.post('/suppliers', async (req, res) => {
  const { name, contact, terms } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });

  const suppliers = await readJSON(FILE, []);
  const existing = suppliers.find(s => s.name.toLowerCase() === name.trim().toLowerCase());
  if (existing) return res.json(existing);

  const supplier = { id: nextId(suppliers), name: name.trim(), contact: contact || '', terms: terms || '' };
  suppliers.push(supplier);
  await writeJSON(FILE, suppliers);
  res.json(supplier);
});

router.patch('/suppliers/:id', async (req, res) => {
  const suppliers = await readJSON(FILE, []);
  const supplier = suppliers.find(s => s.id === Number(req.params.id));
  if (!supplier) return res.status(404).json({ error: 'Not found' });

  const { name, contact, terms, orderDays, telegramInvoicesAllowed, pricesIncludeVat, isChemistrySupplier } = req.body;
  if (name !== undefined) supplier.name = name;
  if (contact !== undefined) supplier.contact = contact;
  if (terms !== undefined) supplier.terms = terms;
  if (orderDays !== undefined) supplier.orderDays = Array.isArray(orderDays) ? orderDays.map(Number) : [];
  if (telegramInvoicesAllowed !== undefined) supplier.telegramInvoicesAllowed = !!telegramInvoicesAllowed;
  if (pricesIncludeVat !== undefined) supplier.pricesIncludeVat = !!pricesIncludeVat;
  if (isChemistrySupplier !== undefined) supplier.isChemistrySupplier = !!isChemistrySupplier;

  await writeJSON(FILE, suppliers);
  res.json(supplier);
});

router.post('/suppliers/batch', async (req, res) => {
  const { rows } = req.body; // [{ id, orderDays, contact, terms }]
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows required' });

  const suppliers = await readJSON(FILE, []);
  for (const row of rows) {
    const supplier = suppliers.find(s => s.id === Number(row.id));
    if (!supplier) continue;
    if (row.orderDays !== undefined) supplier.orderDays = Array.isArray(row.orderDays) ? row.orderDays.map(Number) : [];
    if (row.contact !== undefined) supplier.contact = row.contact;
    if (row.terms !== undefined) supplier.terms = row.terms;
    if (row.telegramInvoicesAllowed !== undefined) supplier.telegramInvoicesAllowed = !!row.telegramInvoicesAllowed;
    if (row.pricesIncludeVat !== undefined) supplier.pricesIncludeVat = !!row.pricesIncludeVat;
    if (row.isChemistrySupplier !== undefined) supplier.isChemistrySupplier = !!row.isChemistrySupplier;
  }
  await writeJSON(FILE, suppliers);
  res.json({ success: true, saved: rows.length });
});

router.delete('/suppliers/:id', async (req, res) => {
  const suppliers = await readJSON(FILE, []);
  const filtered = suppliers.filter(s => s.id !== Number(req.params.id));
  if (filtered.length === suppliers.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
