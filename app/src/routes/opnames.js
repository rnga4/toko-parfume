const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { asArray, parseOpnote } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const FLASH = {
  counted: 'Hitungan fisik tersimpan.',
  done: 'Sesi opname selesai dan stok menyesuaikan dengan hitungan fisik.',
  cancelled: 'Sesi opname dibatalkan tanpa mengubah stok.'
};

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT o.id, o.opname_no, o.note, o.status, o.created_at, o.finished_at, u.username,
            (SELECT COUNT(*)::int FROM stock_opname_items oi WHERE oi.opname_id = o.id) AS products,
            (SELECT COUNT(*)::int FROM stock_opname_items oi WHERE oi.opname_id = o.id AND oi.counted_qty IS NOT NULL) AS counted
       FROM stock_opnames o
       LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
      LIMIT 100`
  );
  const open = rows.find((r) => r.status === 'open');
  res.render('opnames', {
    opnames: rows,
    open,
    flash: FLASH[req.query.ok] || null,
    error: typeof req.query.err === 'string' ? req.query.err.slice(0, 300) : null
  });
}));

router.post('/open', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Opname, lalu coba lagi.');
  const note = parseOpnote(req.body);

  try {
    const { rows: seq } = await pool.query("SELECT nextval('stock_opnames_id_seq') AS id");
    const opnameId = seq[0].id;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const opnameNo = `OPN-${today}-${String(opnameId).padStart(6, '0')}`;

    await pool.query(
      `INSERT INTO stock_opnames (id, opname_no, note, user_id) VALUES ($1,$2,$3,$4)`,
      [opnameId, opnameNo, note, req.user.id]
    );
    await pool.query(
      `INSERT INTO stock_opname_items (opname_id, product_id, system_qty)
       SELECT $1, id, stock FROM products WHERE is_active`,
      [opnameId]
    );
    res.redirect(`/opnames/${opnameId}`);
  } catch (err) {
    if (err.code === '23505') {
      return res.redirect('/opnames?err=' + encodeURIComponent('Masih ada sesi opname yang belum selesai. Selesaikan atau batalkan sesi itu dulu.'));
    }
    throw err;
  }
}));

async function saveCounts(client, opnameId, req) {
  const ids = asArray(req.body.prod_id);
  const qtys = asArray(req.body.count);
  if (ids.length !== qtys.length) {
    throw new DomainError(400, 'Isian tidak cocok', 'Muat ulang halaman opname lalu isi ulang hitungannya.');
  }
  let saved = 0;
  for (let i = 0; i < ids.length; i++) {
    const productId = readInt(String(ids[i]), 1);
    const raw = String(qtys[i]).trim();
    const qty = raw === '' ? null : readInt(raw, 0);
    if (productId === null || qty === null) {
      throw new DomainError(400, 'Hitungan tidak valid', 'Hitungan fisik harus bilangan bulat nol atau lebih, atau dikosongkan untuk baris yang belum dihitung.');
    }
    const updated = await client.query(
      'UPDATE stock_opname_items SET counted_qty = $1 WHERE opname_id = $2 AND product_id = $3',
      [qty, opnameId, productId]
    );
    if (updated.rowCount === 0) {
      throw new DomainError(400, 'Baris opname tidak ditemukan', 'Muat ulang halaman opname, lalu isi lagi hitungannya.');
    }
    saved++;
  }
  return saved;
}

router.post('/:id/count', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Opname, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID opname tidak valid', 'Alamat permintaan tidak benar.');

  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query("SELECT id, status FROM stock_opnames WHERE id = $1 FOR UPDATE", [id]);
      if (!rows[0]) throw new DomainError(404, 'Sesi opname tidak ditemukan', 'Sesi itu tidak ada.');
      if (rows[0].status !== 'open') throw new DomainError(409, 'Sesi sudah selesai', 'Sesi opname ini sudah diselesaikan, jadi hitungannya tidak bisa diubah lagi.');
      await saveCounts(client, id, req);
    });
    res.redirect(`/opnames/${id}?ok=counted`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

router.post('/:id/finish', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Opname, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID opname tidak valid', 'Alamat permintaan tidak benar.');

  try {
    await withTransaction(async (client) => {
      const { rows: sessions } = await client.query("SELECT * FROM stock_opnames WHERE id = $1 FOR UPDATE", [id]);
      const opname = sessions[0];
      if (!opname) throw new DomainError(404, 'Sesi opname tidak ditemukan', 'Sesi itu tidak ada.');
      if (opname.status !== 'open') throw new DomainError(409, 'Sesi sudah selesai', 'Sesi opname ini sudah diselesaikan.');

      await saveCounts(client, id, req);

      const { rows: items } = await client.query(
        `SELECT oi.product_id, oi.counted_qty, p.stock, p.ml_used, p.brand, p.name
           FROM stock_opname_items oi
           JOIN products p ON p.id = oi.product_id
          WHERE oi.opname_id = $1
          ORDER BY oi.product_id
          FOR UPDATE OF p`,
        [id]
      );
      const counted = items.filter((i) => i.counted_qty !== null);
      if (!counted.length) {
        throw new DomainError(400, 'Belum ada yang dihitung',
          'Sesi ini belum punya satu pun hitungan fisik. Isi minimal satu baris, baru tekan Selesaikan lagi.');
      }

      await client.query(
        `UPDATE stock_opname_items SET system_qty = p.stock
           FROM products p WHERE p.id = stock_opname_items.product_id AND stock_opname_items.opname_id = $1`,
        [id]
      );

      for (const item of counted) {
        if (item.counted_qty === 0 && item.ml_used > 0) {
          throw new DomainError(409, 'Botol terbuka masih tercatat',
            `${item.brand} ${item.name} masih punya sisa isi ${item.ml_used} ml padahal hitungan fisiknya nol. Catat dulu pemakaian lewat Decant atau pastikan hitungannya benar.`);
        }
        const diff = item.counted_qty - item.stock;
        if (diff !== 0) {
          await client.query('UPDATE products SET stock = $1 WHERE id = $2', [item.counted_qty, item.product_id]);
          await client.query(
            "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'opname',$3)",
            [item.product_id, diff, id]
          );
        }
      }
      await client.query("UPDATE stock_opnames SET status = 'done', finished_at = NOW() WHERE id = $1", [id]);
    });
    res.redirect(`/opnames/${id}?ok=done`);
  } catch (err) {
    if (err instanceof DomainError) {
      return errorPage(res, err.status, err.heading, err.message);
    }
    throw err;
  }
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Opname, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID opname tidak valid', 'Alamat permintaan tidak benar.');
  const { rowCount } = await pool.query("DELETE FROM stock_opnames WHERE id = $1 AND status = 'open'", [id]);
  if (rowCount === 0) return errorPage(res, 409, 'Sesi tidak bisa dibatalkan', 'Sesi itu tidak ada atau sudah selesai, jadi stoknya tidak bisa dikembalikan.');
  res.redirect('/opnames?ok=cancelled');
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID opname tidak valid', 'Alamat permintaan tidak benar.');

  const { rows } = await pool.query(
    `SELECT o.*, u.username FROM stock_opnames o LEFT JOIN users u ON u.id = o.user_id WHERE o.id = $1`,
    [id]
  );
  const opname = rows[0];
  if (!opname) return errorPage(res, 404, 'Sesi opname tidak ditemukan', 'Sesi itu tidak ada.');

  const items = await pool.query(
    `SELECT oi.product_id, oi.system_qty, oi.counted_qty, p.sku, p.brand, p.name, p.size_ml, p.stock, p.ml_used, p.is_active
       FROM stock_opname_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.opname_id = $1
      ORDER BY p.is_active DESC, p.brand, p.name`,
    [id]
  );

  res.render('opname', {
    opname,
    items: items.rows,
    flash: FLASH[req.query.ok] || null
  });
}));

module.exports = router;
