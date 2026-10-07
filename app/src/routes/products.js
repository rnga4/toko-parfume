const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { CATEGORIES, parseProduct, parseProductEdit } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth);

async function parentChoices(selfId) {
  const { rows } = await pool.query(
    `SELECT id, brand, name, size_ml FROM products
      WHERE is_active AND category <> 'Decant' AND id <> COALESCE($1, 0)
      ORDER BY brand, name`,
    [selfId]
  );
  return rows;
}

async function renderProducts(req, res, extra, status) {
  const admin = req.user.role === 'admin';
  const { rows } = await pool.query(
    admin
      ? "SELECT *, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_str, (stock * size_ml - ml_used) AS ml_left FROM products ORDER BY is_active DESC, brand, name"
      : "SELECT *, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_str, (stock * size_ml - ml_used) AS ml_left FROM products WHERE is_active ORDER BY brand, name"
  );
  if (status) res.status(status);
  res.render('products', Object.assign({
    products: rows,
    categories: CATEGORIES,
    parents: await parentChoices(null),
    today: new Date().toLocaleDateString('sv-SE'),
    error: null,
    form: {},
    canManage: admin
  }, extra));
}

async function checkParent(parentId, selfId, category, errors) {
  if (parentId === null) return;
  const { rows } = await pool.query('SELECT id, category FROM products WHERE id = $1', [parentId]);
  if (!rows[0]) errors.push('Produk induk itu tidak ditemukan.');
  else if (rows[0].category === 'Decant') errors.push('Produk induk tidak boleh berupa Decant.');
  else if (selfId && rows[0].id === selfId) errors.push('Produk tidak bisa menjadi induk dirinya sendiri.');
}

router.get('/', wrap(async (req, res) => {
  await renderProducts(req, res, {});
}));

router.post('/', requireAdmin, wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produk, lalu isi form lagi.');
  }
  const parsed = parseProduct(req.body);
  if (parsed.errors) {
    await renderProducts(req, res, { error: parsed.errors.join(' '), form: req.body }, 400);
    return;
  }
  const parentIdx = 11;
  const parentId = parsed.values[parentIdx];
  const errors = [];
  await checkParent(parentId, null, parsed.values[3], errors);
  if (errors.length) {
    await renderProducts(req, res, { error: errors.join(' '), form: req.body }, 400);
    return;
  }
  await pool.query(
    `INSERT INTO products (sku, brand, name, category, size_ml, cost_price, sell_price, stock, min_stock, batch_no, expiry_date, parent_product_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    parsed.values
  );
  res.redirect('/products');
}));

router.get('/:id/edit', requireAdmin, wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID produk tidak valid', 'Alamat permintaan tidak benar.');
  const { rows } = await pool.query(
    "SELECT *, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_str FROM products WHERE id = $1",
    [id]
  );
  if (!rows[0]) return errorPage(res, 404, 'Produk tidak ditemukan', 'Produk itu tidak ada.');
  res.render('product-edit', {
    product: rows[0],
    categories: CATEGORIES,
    parents: await parentChoices(id),
    error: null
  });
}));

router.post('/:id/edit', requireAdmin, wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produk, lalu coba lagi.');
  }
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID produk tidak valid', 'Alamat permintaan tidak benar.');
  const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [id]);
  if (!rows[0]) return errorPage(res, 404, 'Produk tidak ditemukan', 'Produk itu tidak ada.');

  const parsed = parseProductEdit(req.body);
  const errors = parsed.errors ? parsed.errors.slice() : [];
  if (!parsed.errors) await checkParent(parsed.values[10], id, parsed.values[3], errors);

  if (errors.length) {
    res.status(400);
    return res.render('product-edit', {
      product: Object.assign({}, rows[0], req.body),
      categories: CATEGORIES,
      parents: await parentChoices(id),
      error: errors.join(' ')
    });
  }

  await pool.query(
    `UPDATE products SET sku = $1, brand = $2, name = $3, category = $4, size_ml = $5,
            cost_price = $6, sell_price = $7, min_stock = $8, batch_no = $9, expiry_date = $10,
            parent_product_id = $11
      WHERE id = $12`,
    parsed.values.concat([id])
  );
  res.redirect('/products');
}));

router.post('/:id/delete', requireAdmin, wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produk, lalu coba lagi.');
  }
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID produk tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query('UPDATE products SET is_active = false WHERE id = $1', [id]);
  res.redirect('/products');
}));

router.post('/:id/restore', requireAdmin, wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produk, lalu coba lagi.');
  }
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID produk tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query('UPDATE products SET is_active = true WHERE id = $1', [id]);
  res.redirect('/products');
}));

module.exports = router;
