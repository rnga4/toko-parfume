const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { parseSupplier } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

async function renderSuppliers(req, res, extra, status) {
  const { rows } = await pool.query('SELECT * FROM suppliers ORDER BY is_active DESC, name');
  if (status) res.status(status);
  res.render('suppliers', Object.assign({
    suppliers: rows,
    error: null,
    form: {}
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  await renderSuppliers(req, res, {});
}));

router.post('/', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Supplier, lalu isi form lagi.');
  const parsed = parseSupplier(req.body);
  if (parsed.errors) {
    return renderSuppliers(req, res, { error: parsed.errors.join(' '), form: req.body }, 400);
  }
  await pool.query(
    'INSERT INTO suppliers (name, phone, address) VALUES ($1,$2,$3)',
    parsed.values
  );
  res.redirect('/suppliers');
}));

router.post('/:id/delete', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Supplier, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID supplier tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query('UPDATE suppliers SET is_active = false WHERE id = $1', [id]);
  res.redirect('/suppliers');
}));

router.post('/:id/restore', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Supplier, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID supplier tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query('UPDATE suppliers SET is_active = true WHERE id = $1', [id]);
  res.redirect('/suppliers');
}));

module.exports = router;
