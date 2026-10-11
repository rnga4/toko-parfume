const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { parseCustomer } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

async function renderCustomers(req, res, extra, status) {
  const { rows } = await pool.query(
    `SELECT c.*, (SELECT COUNT(*)::int FROM sales s WHERE s.customer_id = c.id) AS sales
       FROM customers c
      ORDER BY c.name`
  );
  if (status) res.status(status);
  res.render('customers', Object.assign({
    customers: rows,
    edit: null,
    error: null,
    form: {}
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  await renderCustomers(req, res, {});
}));

router.post('/', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pelanggan, lalu isi form lagi.');
  const parsed = parseCustomer(req.body);
  if (parsed.errors) {
    return renderCustomers(req, res, { error: parsed.errors.join(' '), form: req.body }, 400);
  }
  await pool.query('INSERT INTO customers (name, phone, address) VALUES ($1,$2,$3)', parsed.values);
  res.redirect('/customers');
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID pelanggan tidak valid', 'Alamat permintaan tidak benar.');
  const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
  if (!rows[0]) return errorPage(res, 404, 'Pelanggan tidak ditemukan', 'Pelanggan itu tidak ada.');
  await renderCustomers(req, res, {
    edit: rows[0],
    form: { name: rows[0].name, phone: rows[0].phone || '', address: rows[0].address || '' }
  });
}));

router.post('/:id', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pelanggan, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID pelanggan tidak valid', 'Alamat permintaan tidak benar.');
  const parsed = parseCustomer(req.body);
  if (parsed.errors) {
    const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [id]);
    return renderCustomers(req, res, {
      edit: rows[0] || null,
      error: parsed.errors.join(' '),
      form: req.body
    }, 400);
  }
  const { rowCount } = await pool.query(
    'UPDATE customers SET name = $1, phone = $2, address = $3 WHERE id = $4',
    [...parsed.values, id]
  );
  if (rowCount === 0) return errorPage(res, 404, 'Pelanggan tidak ditemukan', 'Pelanggan itu tidak ada.');
  res.redirect('/customers');
}));

module.exports = router;
