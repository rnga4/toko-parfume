const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireRoles } = require('../lib/auth');
const { logActivity } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth, requireRoles(['admin', 'owner', 'qc']));

const FLASH = {
  ok: 'Hasil QC disimpan.'
};

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT pl.id, pl.qty, pl.batch_no, pl.qc_status, pl.qc_note, pl.created_at,
            to_char(pl.expiry_date, 'YYYY-MM-DD') AS expiry_str,
            p.sku, p.brand, p.name, p.size_ml, p.qc_required
       FROM product_lots pl
       JOIN products p ON p.id = pl.product_id
      WHERE pl.qc_status = 'pending'
      ORDER BY pl.created_at ASC`
  );
  res.render('qc', { lots: rows, flash: FLASH[req.query.ok] || null, error: null });
}));

router.post('/:id', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman QC, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  const status = req.body.status === 'reject' ? 'reject' : req.body.status === 'pass' ? 'pass' : null;
  if (id === null || !status) return errorPage(res, 400, 'Data tidak valid', 'Pilih hasil QC Pass atau Reject.');
  const note = req.body.note && req.body.note.trim() ? req.body.note.trim().slice(0, 500) : null;

  const { rows } = await pool.query('SELECT pl.*, p.brand, p.name FROM product_lots pl JOIN products p ON p.id = pl.product_id WHERE pl.id = $1', [id]);
  if (!rows[0]) return errorPage(res, 404, 'Lot tidak ditemukan', 'Lot itu tidak ada.');
  const lot = rows[0];
  if (lot.qc_status !== 'pending') return errorPage(res, 409, 'Lot sudah diperiksa', 'Lot ini sudah punya hasil QC.');

  await withTransaction(async (client) => {
    await client.query('UPDATE product_lots SET qc_status = $1, qc_note = $2 WHERE id = $3', [status, note, id]);
  });
  await logActivity(pool, req.user, `qc.${status}`, 'product_lot', id, `QC ${status} ${lot.brand} ${lot.name} batch ${lot.batch_no || '-'}`);
  res.redirect('/qc?ok=ok');
}));

module.exports = router;