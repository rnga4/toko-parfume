const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, readInt, errorPage } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', wrap(async (req, res) => {
  const status = req.query.status === 'lunas' ? 'lunas' : 'belum';
  const filter = status === 'lunas' ? 'AND p.paid_at IS NOT NULL' : 'AND p.paid_at IS NULL';
  const { rows } = await pool.query(
    `SELECT p.id, p.invoice_no, p.total, p.created_at, p.due_date, p.paid_at, s.name AS supplier, s.phone
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.payment_method = 'tempo' ${filter}
      ORDER BY p.created_at DESC
      LIMIT 200`
  );
  const { rows: totals } = await pool.query(
    `SELECT COALESCE(SUM(total),0)::bigint AS outstanding, COUNT(*)::int AS n
       FROM purchases WHERE payment_method = 'tempo' AND paid_at IS NULL`
  );
  res.render('hutang', {
    hutang: rows,
    status,
    outstanding: Number(totals[0].outstanding),
    outstandingCount: totals[0].n,
    flash: req.query.ok === 'lunas' ? 'Hutang ditandai lunas.' : null
  });
}));

router.post('/:id/lunas', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Hutang, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID pembelian tidak valid', 'Alamat permintaan tidak benar.');
  const { rowCount } = await pool.query(
    "UPDATE purchases SET paid_at = NOW() WHERE id = $1 AND payment_method = 'tempo' AND paid_at IS NULL",
    [id]
  );
  if (rowCount === 0) return errorPage(res, 409, 'Tidak ada yang diubah', 'Pembelian itu bukan hutang tempo yang belum lunas.');
  res.redirect('/hutang?ok=lunas');
}));

module.exports = router;
