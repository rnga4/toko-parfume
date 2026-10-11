const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, readInt, errorPage } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', wrap(async (req, res) => {
  const status = req.query.status === 'lunas' ? 'lunas' : 'belum';
  const filter = status === 'lunas' ? 'AND s.paid_at IS NOT NULL' : 'AND s.paid_at IS NULL';
  const { rows } = await pool.query(
    `SELECT s.id, s.invoice_no, s.total, s.created_at, s.due_date, s.paid_at, c.name AS customer, c.phone
       FROM sales s
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.payment_method = 'tempo' ${filter}
      ORDER BY s.created_at DESC
      LIMIT 200`
  );
  const { rows: totals } = await pool.query(
    `SELECT COALESCE(SUM(total),0)::bigint AS outstanding, COUNT(*)::int AS n
       FROM sales WHERE payment_method = 'tempo' AND paid_at IS NULL`
  );
  res.render('piutang', {
    piutang: rows,
    status,
    outstanding: Number(totals[0].outstanding),
    outstandingCount: totals[0].n,
    flash: req.query.ok === 'lunas' ? 'Pembayaran ditandai lunas.' : null
  });
}));

router.post('/:id/lunas', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Piutang, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID penjualan tidak valid', 'Alamat permintaan tidak benar.');
  const { rowCount } = await pool.query(
    "UPDATE sales SET paid_at = NOW() WHERE id = $1 AND payment_method = 'tempo' AND paid_at IS NULL",
    [id]
  );
  if (rowCount === 0) return errorPage(res, 409, 'Tidak ada yang diubah', 'Penjualan itu bukan piutang tempo yang belum lunas.');
  res.redirect('/piutang?ok=lunas');
}));

module.exports = router;
