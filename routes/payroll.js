const express = require('express');
const { readJSON, writeJSON, nextId } = require('../lib/store');

const router = express.Router();
const FILE = 'payroll.json';
const EMPLOYEES_FILE = 'employees.json';
const CASHDAYS_FILE = 'cashdays.json';

router.get('/payroll', async (req, res) => {
  const { employeeId, from, to } = req.query;
  let entries = await readJSON(FILE, []);
  if (employeeId) entries = entries.filter(e => e.employeeId === Number(employeeId));
  if (from) entries = entries.filter(e => e.date >= from);
  if (to) entries = entries.filter(e => e.date <= to);
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  res.json(entries);
});

router.get('/payroll/suggest', async (req, res) => {
  const { employeeId, from, to } = req.query;
  if (!employeeId || !from || !to) return res.status(400).json({ error: 'employeeId, from, to required' });

  const employees = await readJSON(EMPLOYEES_FILE, []);
  const employee = employees.find(e => e.id === Number(employeeId));
  if (!employee) return res.status(404).json({ error: 'Employee not found' });
  if (employee.payType !== 'percent_of_revenue') {
    return res.status(400).json({ error: 'Employee is not percent-based' });
  }

  const allDays = await readJSON(CASHDAYS_FILE, []);
  const days = allDays.filter(d => d.date >= from && d.date <= to);
  const revenue = days.reduce((s, d) => s + (d.revenue || 0), 0);
  const amount = Number((revenue * (employee.percent / 100)).toFixed(2));

  res.json({ revenue, percent: employee.percent, amount, days: days.length });
});

router.post('/payroll', async (req, res) => {
  const { employeeId, date, type, amount, note } = req.body;
  if (!employeeId) return res.status(400).json({ error: 'employeeId required' });
  if (!date) return res.status(400).json({ error: 'date required' });
  if (amount === undefined || isNaN(Number(amount))) return res.status(400).json({ error: 'amount required' });

  const employees = await readJSON(EMPLOYEES_FILE, []);
  const employee = employees.find(e => e.id === Number(employeeId));
  if (!employee) return res.status(404).json({ error: 'Employee not found' });

  const entries = await readJSON(FILE, []);
  const entry = {
    id: nextId(entries),
    employeeId: Number(employeeId),
    employeeName: employee.name,
    date,
    type: ['salary', 'advance', 'bonus', 'fine'].includes(type) ? type : 'salary',
    amount: Number(amount),
    note: note || ''
  };
  entries.push(entry);
  await writeJSON(FILE, entries);
  res.json(entry);
});

router.delete('/payroll/:id', async (req, res) => {
  const entries = await readJSON(FILE, []);
  const filtered = entries.filter(e => e.id !== Number(req.params.id));
  if (filtered.length === entries.length) return res.status(404).json({ error: 'Not found' });
  await writeJSON(FILE, filtered);
  res.json({ success: true });
});

module.exports = router;
