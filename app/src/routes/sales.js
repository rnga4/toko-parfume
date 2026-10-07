const express = require('express');
const { pool } = require('../lib/db');
const { wrap, readInt, errorPage } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { PAYMENT_LABEL, parseDate } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth);

const FLASH = {
  sale: (req) => {
    const invoice = typeof req.query.invoice === 'string' ? req.query.invoice.slice(0, 30) : '';
    return invoice ? `Penjualan ${invoice} tersimpan dan stok sudah berkurang.` : 'Penjualan tersimpan.';
  }
};

router.get('/', wrap(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const conditions = [];
  const values = [];

  if (!isAdmin) {
    values.push(req.user.id);
    conditions.push(`s.user_id = $${values.length}`);
  }

  const userRaw = String(req.query.u || '');
  const userFilter = /^\d+$/.test(userRaw) ? Number(userRaw) : null;
  if (isAdmin && userFilter) {
    values.push(userFilter);
    conditions.push(`s.user_id = $${values.length}`);
  }

  const date = parseDate(req.query.d);
  if (!date.ok) {
    return errorPage(res, 400, 'Tanggal tidak valid', 'Format tanggal harus YYYY-MM-DD.');
  }
  if (date.value) {
    values.push(date.value);
    conditions.push(`s.created_at::date = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [sales, users] = await Promise.all([
    pool.query(
      `SELECT s.id, s.invoice_no, s.subtotal, s.discount, s.total, s.payment_method, s.created_at,
              u.username,
              (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         ${where}
        ORDER BY s.created_at DESC
        LIMIT 200`,
      values
    ),
    isAdmin
      ? pool.query('SELECT id, username FROM users ORDER BY username')
      : Promise.resolve({ rows: [] })
  ]);

  res.render('sales', {
    sales: sales.rows,
    users: users.rows,
    isAdmin,
    filterUser: userFilter || '',
    filterDate: date.value || '',
    flash: FLASH[req.query.ok] ? FLASH[req.query.ok](req) : null,
    paymentLabel: PAYMENT_LABEL
  });
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID penjualan tidak valid', 'Alamat penjualan tidak benar.');

  const { rows } = await pool.query(
    `SELECT s.*, u.username FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [id]
  );
  const sale = rows[0];
  if (!sale) return errorPage(res, 404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');
  if (req.user.role !== 'admin' && sale.user_id !== req.user.id) {
    return errorPage(res, 403, 'Akses ditolak', 'Penjualan ini milik kasir lain.');
  }

  const items = await pool.query(
    `SELECT si.qty, si.price, p.brand, p.name, p.size_ml, p.sku,
            COALESCE((SELECT SUM(ri.qty)
                        FROM return_items ri
                        JOIN returns r ON r.id = ri.return_id
                       WHERE r.sale_id = $1 AND ri.product_id = si.product_id AND ri.direction = 'in'
                     ), 0)::int AS returned
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY p.brand, p.name`,
    [id]
  );

  res.render('sale-detail', {
    sale,
    items: items.rows,
    isAdmin: req.user.role === 'admin',
    paymentLabel: PAYMENT_LABEL[sale.payment_method] || sale.payment_method
  });
}));

module.exports = router;
