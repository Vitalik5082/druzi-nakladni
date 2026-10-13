const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'employees.json';

router.get('/employees', async (req, res) => {
  res.json(await readJSON(FILE, []));
});

router.post('/employees', async (req, res) => {
  const { name, role, payType, percent } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  if (payType === 'percent_of_revenue' && (percent === undefined || isNaN(Number(percent)))) {
    return res.status(400).json({ error: 'Percent required for percent_of_revenue pay type' });
  }

  const employees = await readJSON(FILE, []);
  const employee = {
    id: nextId(employees),
    name: name.trim(),
    role: role || '',
    payType: payType === 'percent_of_revenue' ? 'percent_of_revenue' : 'manual',
    percent: payType === 'percent_of_revenue' ? Number(percent) : null
  };
  employees.push(employee);
  await writeJSON(FILE, employees);
  res.json(employee);
});

router.patch('/employees/:id', async (req, res) => {
  const employees = await readJSON(FILE, []);
  const employee = employees.find(e => e.id === Number(req.params.id));
  if (!employee) return res.status(404).json({ error: 'Not found' });

  const { name, role, payType, percent } = req.body;
  if (name !== undefined) employee.name = name;
  if (role !== undefined) employee.role = role;
  if (payType !== undefined) employee.payType = payType === 'percent_of_revenue' ? 'percent_of_revenue' : 'manual';
  if (percent !== undefined) employee.percent = employee.payType === 'percent_of_revenue' ? Number(percent) : null;

  await writeJSON(FILE, employees);
  res.json(employee);
});

router.delete('/employees/:id', async (req, res) => {
  const employees = await readJSON(FILE, []);
  const filtered = employees.filter(e => e.id !== Number(req.params.id));
  if (filtered.length === employees.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
