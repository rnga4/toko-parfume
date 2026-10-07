const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { parseQty } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const DRAFT_FLASH = {
  added: 'Baris masuk daftar pembelian.',
  updated: 'Jumlah diperbarui.',
  price: 'Harga beli diperbarui.',
  removed: 'Baris dihapus.',
  cleared: 'Daftar pembelian dikosongkan.'
};

const LIST_FLASH = {
  committed: (req) => {
    const invoice = typeof req.query.invoice === 'string' ? req.query.invoice.slice(0, 30) : '';
    return invoice
      ? `Pembelian ${invoice} tersimpan. Stok naik dan harga beli produk ikut diperbarui.`
      : 'Pembelian tersimpan. Stok dan harga beli diperbarui.';
  }
};

async function renderDraft(req, res, extra, status) {
  const [products, suppliers, items] = await Promise.all([
    pool.query('SELECT id, sku, brand, name, size_ml, cost_price FROM products WHERE is_active ORDER BY brand, name'),
    pool.query('SELECT id, name FROM suppliers WHERE is_active ORDER BY name'),
    pool.query(
      `SELECT d.id, d.qty, d.unit_price, d.product_id, p.brand, p.name, p.size_ml, p.sku
         FROM draft_items d
         JOIN products p ON p.id = d.product_id
        WHERE d.user_id = $1 AND d.kind = 'purchase'
        ORDER BY p.brand, p.name`,
      [req.user.id]
    )
  ]);
  const total = items.rows.reduce((sum, row) => sum + row.qty * row.unit_price, 0);
  if (status) res.status(status);
  res.render('purchase-new', Object.assign({
    products: products.rows,
    suppliers: suppliers.rows,
    items: items.rows,
    total,
    flash: null,
    error: null
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT p.id, p.invoice_no, p.total, p.created_at, s.name AS supplier, u.username,
            (SELECT COUNT(*)::int FROM purchase_items pi WHERE pi.purchase_id = p.id) AS items
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.user_id
      ORDER BY p.created_at DESC
      LIMIT 200`
  );
  res.render('purchases', { purchases: rows, flash: LIST_FLASH[req.query.ok] ? LIST_FLASH[req.query.ok](req) : null });
}));

router.get('/new', wrap(async (req, res) => {
  await renderDraft(req, res, { flash: DRAFT_FLASH[req.query.ok] || null });
}));

router.post('/item/add', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');

  const productId = readInt(String(req.body.product_id || ''), 1);
  const qty = parseQty(req.body.qty);
  const cost = req.body.cost === undefined || req.body.cost === '' ? null : readInt(req.body.cost, 0);
  if (productId === null || qty === null) {
    return renderDraft(req, res, { error: 'Produk dan jumlah harus diisi dengan angka yang benar.' }, 400);
  }
  if (cost === null) {
    return renderDraft(req, res, { error: 'Harga beli wajib diisi dengan angka rupiah nol atau lebih.' }, 400);
  }

  const { rows } = await pool.query('SELECT id, brand, name, is_active FROM products WHERE id = $1', [productId]);
  if (!rows[0] || !rows[0].is_active) {
    return renderDraft(req, res, { error: 'Produk itu tidak ditemukan atau sedang nonaktif.' }, 400);
  }

  await pool.query(
    `INSERT INTO draft_items (user_id, kind, product_id, qty, unit_price)
     VALUES ($1, 'purchase', $2, $3, $4)
     ON CONFLICT (user_id, kind, product_id)
     DO UPDATE SET qty = EXCLUDED.qty, unit_price = EXCLUDED.unit_price`,
    [req.user.id, productId, qty, cost]
  );
  res.redirect('/purchases/new?ok=added');
}));

router.post('/item/qty', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');
  const itemId = readInt(String(req.body.item_id || ''), 1);
  const qty = readInt(String(req.body.qty || ''), 0);
  if (itemId === null || qty === null) {
    return renderDraft(req, res, { error: 'Jumlah harus bilangan bulat nol atau lebih.' }, 400);
  }
  const found = await pool.query(
    "SELECT id FROM draft_items WHERE id = $1 AND user_id = $2 AND kind = 'purchase'",
    [itemId, req.user.id]
  );
  if (!found.rows[0]) return renderDraft(req, res, { error: 'Baris pembelian tidak ditemukan.' }, 404);

  if (qty === 0) {
    await pool.query('DELETE FROM draft_items WHERE id = $1 AND user_id = $2', [itemId, req.user.id]);
    return res.redirect('/purchases/new?ok=removed');
  }
  await pool.query('UPDATE draft_items SET qty = $1 WHERE id = $2 AND user_id = $3', [qty, itemId, req.user.id]);
  res.redirect('/purchases/new?ok=updated');
}));

router.post('/item/price', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');
  const itemId = readInt(String(req.body.item_id || ''), 1);
  const cost = readInt(String(req.body.cost || ''), 0);
  if (itemId === null || cost === null) {
    return renderDraft(req, res, { error: 'Harga beli harus bilangan bulat rupiah nol atau lebih.' }, 400);
  }
  const updated = await pool.query(
    "UPDATE draft_items SET unit_price = $1 WHERE id = $2 AND user_id = $3 AND kind = 'purchase'",
    [cost, itemId, req.user.id]
  );
  if (updated.rowCount === 0) return renderDraft(req, res, { error: 'Baris pembelian tidak ditemukan.' }, 404);
  res.redirect('/purchases/new?ok=price');
}));

router.post('/item/remove', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');
  const itemId = readInt(String(req.body.item_id || ''), 1);
  if (itemId === null) return errorPage(res, 400, 'ID baris tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query("DELETE FROM draft_items WHERE id = $1 AND user_id = $2 AND kind = 'purchase'", [itemId, req.user.id]);
  res.redirect('/purchases/new?ok=removed');
}));

router.post('/item/clear', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');
  await pool.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'purchase'", [req.user.id]);
  res.redirect('/purchases/new?ok=cleared');
}));

router.post('/commit', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Pembelian, lalu coba lagi.');

  try {
    const result = await withTransaction(async (client) => {
      const items = await client.query(
        `SELECT d.product_id, d.qty, d.unit_price, p.brand, p.name, p.is_active
           FROM draft_items d
           JOIN products p ON p.id = d.product_id
          WHERE d.user_id = $1 AND d.kind = 'purchase'
          ORDER BY d.product_id`,
        [req.user.id]
      );
      if (!items.rows.length) {
        throw new DomainError(400, 'Daftar pembelian kosong', 'Tambahkan minimal satu produk beserta jumlah dan harganya.');
      }

      const supplierId = readInt(String(req.body.supplier_id || ''), 1);
      if (supplierId === null) throw new DomainError(400, 'Supplier belum dipilih', 'Pilih supplier yang menjadi sumber pembelian ini.');

      const supplier = await client.query('SELECT id FROM suppliers WHERE id = $1 AND is_active', [supplierId]);
      if (!supplier.rows[0]) throw new DomainError(400, 'Supplier tidak ditemukan', 'Supplier itu sudah tidak aktif. Pilih supplier lain.');

      const ids = items.rows.map((i) => i.product_id);
      const locked = await client.query('SELECT id, is_active FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE', [ids]);
      const live = new Map(locked.rows.map((r) => [r.id, r]));
      for (const item of items.rows) {
        const p = live.get(item.product_id);
        if (!p || !p.is_active) {
          throw new DomainError(409, 'Produk sudah tidak aktif', `${item.brand} ${item.name} sudah dinonaktifkan. Aktifkan lagi atau hapus baris ini.`);
        }
      }

      const { rows: seq } = await client.query("SELECT nextval('purchases_id_seq') AS id");
      const purchaseId = seq[0].id;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const invoice = `PO-${today}-${String(purchaseId).padStart(6, '0')}`;
      const total = items.rows.reduce((sum, i) => sum + i.qty * i.unit_price, 0);

      await client.query(
        'INSERT INTO purchases (id, invoice_no, supplier_id, user_id, total) VALUES ($1,$2,$3,$4,$5)',
        [purchaseId, invoice, supplierId, req.user.id, total]
      );

      for (const item of items.rows) {
        await client.query(
          'INSERT INTO purchase_items (purchase_id, product_id, qty, cost) VALUES ($1,$2,$3,$4)',
          [purchaseId, item.product_id, item.qty, item.unit_price]
        );
        await client.query(
          'UPDATE products SET stock = stock + $1, cost_price = $2 WHERE id = $3',
          [item.qty, item.unit_price, item.product_id]
        );
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'purchase',$3)",
          [item.product_id, item.qty, purchaseId]
        );
      }

      await client.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'purchase'", [req.user.id]);
      return { invoice, total };
    });

    res.redirect(`/purchases?ok=committed&invoice=${encodeURIComponent(result.invoice)}`);
  } catch (err) {
    if (err instanceof DomainError) {
      return renderDraft(req, res, { error: err.message }, err.status);
    }
    throw err;
  }
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID pembelian tidak valid', 'Alamat pembelian tidak benar.');

  const { rows } = await pool.query(
    `SELECT p.*, s.name AS supplier, u.username
       FROM purchases p
       LEFT JOIN suppliers s ON s.id = p.supplier_id
       LEFT JOIN users u ON u.id = p.user_id
      WHERE p.id = $1`,
    [id]
  );
  const purchase = rows[0];
  if (!purchase) return errorPage(res, 404, 'Pembelian tidak ditemukan', 'Nomor pembelian itu tidak ada.');

  const items = await pool.query(
    `SELECT pi.qty, pi.cost, p.brand, p.name, p.size_ml, p.sku
       FROM purchase_items pi
       JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = $1
      ORDER BY p.brand, p.name`,
    [id]
  );

  res.render('purchase-detail', { purchase, items: items.rows });
}));

module.exports = router;
