const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireRoles } = require('../lib/auth');
const { parseLot } = require('../lib/validate');
const { syncProductStock } = require('../lib/lots');
const { logActivity } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth);

const MANAGE = requireRoles(['admin', 'owner', 'gudang']);

const FLASH = {
  added: 'Lot baru dicatat dan stok produk disesuaikan.',
  updated: 'Lot diperbarui dan stok produk disesuaikan.'
};

const FILTERS = {
  all: '1=1',
  expiring: 'pl.expiry_date IS NOT NULL AND pl.expiry_date >= CURRENT_DATE AND pl.expiry_date <= CURRENT_DATE + 30',
  expired: 'pl.expiry_date IS NOT NULL AND pl.expiry_date < CURRENT_DATE',
  ok: '(pl.expiry_date IS NULL OR pl.expiry_date > CURRENT_DATE + 30)'
};

async function renderLots(req, res, extra, status) {
  const filterKey = FILTERS[req.query.f] ? req.query.f : 'all';
  const productFilter = readInt(String(req.query.product || ''), 1);
  const conditions = [FILTERS[filterKey]];
  const values = [];
  if (productFilter !== null) {
    values.push(productFilter);
    conditions.push(`pl.product_id = $${values.length}`);
  }

  const [lots, products] = await Promise.all([
    pool.query(
      `SELECT pl.id, pl.qty, pl.batch_no, pl.qc_status, pl.created_at,
              to_char(pl.expiry_date, 'YYYY-MM-DD') AS expiry_str, pl.expiry_date,
              p.id AS product_id, p.sku, p.brand, p.name, p.size_ml, p.category, p.stock
         FROM product_lots pl
         JOIN products p ON p.id = pl.product_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY (pl.expiry_date IS NULL), pl.expiry_date, p.brand, p.name, pl.id`,
      values
    ),
    pool.query('SELECT id, sku, brand, name, size_ml FROM products WHERE is_active ORDER BY brand, name')
  ]);

  const today = new Date().toISOString().slice(0, 10);
  const rowsOut = lots.rows.map((row) => {
    let state = 'ok';
    if (row.expiry_date && row.expiry_str < today) state = 'expired';
    else if (row.expiry_date && row.expiry_str <= addDays(today, 30)) state = 'soon';
    return Object.assign({}, row, { state });
  });
  const summary = {
    expired: rowsOut.filter((r) => r.state === 'expired').reduce((n, r) => n + r.qty, 0),
    soon: rowsOut.filter((r) => r.state === 'soon').reduce((n, r) => n + r.qty, 0)
  };

  if (status) res.status(status);
  res.render('lots', Object.assign({
    lots: rowsOut,
    products: products.rows,
    filterKey,
    productFilter: productFilter || '',
    summary,
    canManage: ['admin', 'owner', 'gudang'].includes(req.user.role),
    flash: FLASH[req.query.ok] || null,
    error: null,
    form: {}
  }, extra));
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

router.get('/', wrap(async (req, res) => {
  await renderLots(req, res, {});
}));

router.post('/', MANAGE, wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Lot, lalu coba lagi.');
  const parsed = parseLot(req.body);
  if (parsed.errors) {
    return renderLots(req, res, { error: parsed.errors.join(' '), form: req.body }, 400);
  }
  const product = await pool.query('SELECT id, brand, name FROM products WHERE id = $1', [parsed.productId]);
  if (!product.rows[0]) {
    return renderLots(req, res, { error: 'Produk itu tidak ditemukan.', form: req.body }, 400);
  }
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO product_lots (product_id, batch_no, expiry_date, qty) VALUES ($1,$2,$3,$4)`,
      [parsed.productId, parsed.batchNo, parsed.expiry, parsed.qty]
    );
    await syncProductStock(client, parsed.productId);
  });
  await logActivity(pool, req.user, 'lot.add', 'product_lot', parsed.productId,
    `Lot manual ${product.rows[0].brand} ${product.rows[0].name} qty ${parsed.qty} batch ${parsed.batchNo || '-'}`);
  res.redirect('/lots?ok=added');
}));

router.post('/:id', MANAGE, wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Lot, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID lot tidak valid', 'Alamat permintaan tidak benar.');

  const { rows } = await pool.query('SELECT * FROM product_lots WHERE id = $1', [id]);
  const lot = rows[0];
  if (!lot) return errorPage(res, 404, 'Lot tidak ditemukan', 'Lot itu sudah tidak ada.');

  const qty = req.body.qty === undefined || req.body.qty === '' ? lot.qty : readInt(String(req.body.qty), 0);
  if (qty === null) return renderLots(req, res, { error: 'Jumlah lot harus bilangan bulat nol atau lebih.' }, 400);
  const batchNo = req.body.batch_no === undefined ? lot.batch_no : (req.body.batch_no.trim() || null);
  const expiryRaw = req.body.expiry_date === undefined ? (lot.expiry_date ? String(lot.expiry_date).slice(0, 10) : '') : req.body.expiry_date.trim();
  const expiry = expiryRaw === '' ? null : expiryRaw;
  if (expiry !== null && !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
    return renderLots(req, res, { error: 'Kedaluwarsa harus berformat YYYY-MM-DD.' }, 400);
  }

  await withTransaction(async (client) => {
    await client.query(
      'UPDATE product_lots SET qty = $1, batch_no = $2, expiry_date = $3 WHERE id = $4',
      [qty, batchNo, expiry, id]
    );
    await syncProductStock(client, lot.product_id);
  });
  await logActivity(pool, req.user, 'lot.update', 'product_lot', id, `Lot #${id} jadi qty ${qty}`);
  res.redirect('/lots?ok=updated');
}));

module.exports = router;