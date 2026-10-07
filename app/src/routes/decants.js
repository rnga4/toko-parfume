const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, DomainError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { parseDecant } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const FLASH = {
  created: 'Decant dibuat. Stok botol induk berkurang dan stok decant bertambah.'
};

async function renderDecants(req, res, extra, status) {
  const [parents, children, history] = await Promise.all([
    pool.query(
      `SELECT id, brand, name, size_ml, stock, ml_used, (stock * size_ml - ml_used) AS ml_left
         FROM products
        WHERE is_active AND category <> 'Decant' AND stock * size_ml - ml_used > 0
        ORDER BY brand, name`
    ),
    pool.query(
      `SELECT c.id, c.brand, c.name, c.size_ml, c.stock, p.id AS parent_id, p.brand AS parent_brand, p.name AS parent_name
         FROM products c
         LEFT JOIN products p ON p.id = c.parent_product_id
        WHERE c.is_active AND c.category = 'Decant'
        ORDER BY c.brand, c.name`
    ),
    pool.query(
      `SELECT d.qty, d.ml_each, d.ml_total, d.bottles_consumed, d.created_at, u.username,
              pa.brand AS parent_brand, pa.name AS parent_name, pa.size_ml AS parent_size,
              ca.sku AS child_sku, ca.brand AS child_brand, ca.name AS child_name, ca.size_ml AS child_ml
         FROM decants d
         JOIN products pa ON pa.id = d.parent_product_id
         JOIN products ca ON ca.id = d.child_product_id
         LEFT JOIN users u ON u.id = d.user_id
        ORDER BY d.created_at DESC
        LIMIT 50`
    )
  ]);
  if (status) res.status(status);
  res.render('decants', Object.assign({
    parents: parents.rows,
    children: children.rows,
    history: history.rows,
    flash: null,
    error: null
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  await renderDecants(req, res, { flash: FLASH[req.query.ok] || null });
}));

router.post('/', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Decant, lalu coba lagi.');

  const parsed = parseDecant(req.body);
  if (parsed.errors) {
    return renderDecants(req, res, { error: parsed.errors.join(' ') }, 400);
  }

  const child = await pool.query(
    'SELECT id, brand, name, size_ml, stock, parent_product_id, is_active, category FROM products WHERE id = $1',
    [parsed.childId]
  );
  const childRow = child.rows[0];
  if (!childRow || !childRow.is_active || childRow.category !== 'Decant') {
    return renderDecants(req, res, { error: 'Produk decant itu tidak ditemukan, nonaktif, atau bukan kategori Decant.' }, 400);
  }
  if (childRow.parent_product_id !== parsed.parentId) {
    return renderDecants(req, res, {
      error: `${childRow.brand} ${childRow.name} belum ditautkan ke produk induk itu. Buka Produk, tekan Ubah pada produk decant ini, lalu pilih induknya.`
    }, 409);
  }

  const mlTotal = parsed.qty * childRow.size_ml;

  try {
    const created = await withTransaction(async (client) => {
      const parent = await client.query(
        `SELECT id, brand, name, size_ml, stock, ml_used, is_active, category
           FROM products WHERE id = $1 FOR UPDATE`,
        [parsed.parentId]
      );
      const parentRow = parent.rows[0];
      if (!parentRow || !parentRow.is_active || parentRow.category === 'Decant') {
        throw new DomainError(400, 'Produk induk tidak valid', 'Produk induk itu tidak ditemukan, nonaktif, atau bukan induk yang benar.');
      }

      const mlLeft = parentRow.stock * parentRow.size_ml - parentRow.ml_used;
      if (mlTotal > mlLeft) {
        throw new DomainError(409, 'Sisa isi tidak cukup',
          `Sisa isi ${parentRow.brand} ${parentRow.name} tinggal ${mlLeft} ml, sedangkan decant ini butuh ${mlTotal} ml. Tambah stok atau kurangi jumlah decantnya.`);
      }

      await client.query('SELECT id FROM products WHERE id = $1 FOR UPDATE', [childRow.id]);

      let mlUsed = parentRow.ml_used + mlTotal;
      let stock = parentRow.stock;
      let consumed = 0;
      while (mlUsed >= parentRow.size_ml) {
        mlUsed -= parentRow.size_ml;
        stock -= 1;
        consumed += 1;
      }

      await client.query('UPDATE products SET stock = $1, ml_used = $2 WHERE id = $3', [stock, mlUsed, parentRow.id]);
      await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [parsed.qty, childRow.id]);

      const { rows: inserted } = await client.query(
        `INSERT INTO decants (parent_product_id, child_product_id, qty, ml_each, ml_total, bottles_consumed, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [parentRow.id, childRow.id, parsed.qty, childRow.size_ml, mlTotal, consumed, req.user.id]
      );
      const decantId = inserted[0].id;

      if (consumed > 0) {
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'decant',$3)",
          [parentRow.id, -consumed, decantId]
        );
      }
      await client.query(
        "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'decant',$3)",
        [childRow.id, parsed.qty, decantId]
      );

      return { consumed, mlLeft: mlLeft - mlTotal };
    });

    res.redirect('/decants?ok=created');
  } catch (err) {
    if (err instanceof DomainError) {
      return renderDecants(req, res, { error: err.message }, err.status);
    }
    throw err;
  }
}));

module.exports = router;
