const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { PAYMENTS, PAYMENT_LABEL, parseCheckout, parseQty } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth);

const FLASH = {
  added: 'Produk masuk keranjang.',
  updated: 'Jumlah di keranjang diperbarui.',
  removed: 'Produk dihapus dari keranjang.',
  cleared: 'Keranjang dikosongkan.',
  sale: 'Penjualan tersimpan.'
};

async function renderKasir(req, res, extra, status) {
  const [products, cart] = await Promise.all([
    pool.query(
      `SELECT id, sku, brand, name, size_ml, stock, ml_used,
              (stock - CASE WHEN ml_used > 0 THEN 1 ELSE 0 END) AS sellable
         FROM products WHERE is_active ORDER BY brand, name`
    ),
    pool.query(
      `SELECT d.id, d.qty, d.unit_price, d.product_id, p.brand, p.name, p.size_ml, p.stock, p.ml_used,
              (p.stock - CASE WHEN p.ml_used > 0 THEN 1 ELSE 0 END) AS sellable
         FROM draft_items d
         JOIN products p ON p.id = d.product_id
        WHERE d.user_id = $1 AND d.kind = 'sale'
        ORDER BY p.brand, p.name`,
      [req.user.id]
    )
  ]);
  const subtotal = cart.rows.reduce((sum, row) => sum + row.qty * row.unit_price, 0);
  const requested = extra.discount !== undefined ? extra.discount : 0;
  const discount = Math.max(0, Math.min(requested, subtotal));
  const total = subtotal - discount;
  if (status) res.status(status);
  res.render('kasir', Object.assign({
    products: products.rows,
    cart: cart.rows,
    subtotal,
    discount,
    total,
    payment: 'cash',
    payments: PAYMENTS.map((code) => ({ code, label: PAYMENT_LABEL[code] })),
    flash: null,
    error: null
  }, extra));
}

function ownItem(client, id, userId) {
  return client.query(
    'SELECT id, product_id, qty FROM draft_items WHERE id = $1 AND user_id = $2 AND kind = $3',
    [id, userId, 'sale']
  );
}

router.get('/', wrap(async (req, res) => {
  const flash = FLASH[req.query.ok] || null;
  await renderKasir(req, res, { flash });
}));

router.post('/cart/add', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');

  const productId = readInt(String(req.body.product_id || ''), 1);
  const qty = parseQty(req.body.qty);
  if (productId === null || qty === null) {
    return renderKasir(req, res, { error: 'Produk dan jumlah harus diisi dengan angka yang benar.' }, 400);
  }

  const { rows } = await pool.query(
    'SELECT id, brand, name, stock, ml_used, is_active FROM products WHERE id = $1',
    [productId]
  );
  const product = rows[0];
  if (!product || !product.is_active) {
    return renderKasir(req, res, { error: 'Produk itu tidak ditemukan atau sudah tidak aktif.' }, 400);
  }
  const sellableQty = product.stock - (product.ml_used > 0 ? 1 : 0);

  const inCart = await pool.query(
    'SELECT qty FROM draft_items WHERE user_id = $1 AND kind = $2 AND product_id = $3',
    [req.user.id, 'sale', productId]
  );
  const wanted = (inCart.rows[0] ? inCart.rows[0].qty : 0) + qty;

  if (wanted > sellableQty) {
    return renderKasir(req, res, {
      error: `Stok ${product.brand} ${product.name} tinggal ${sellableQty}, jadi keranjang tidak boleh melebihi itu.`
    }, 409);
  }

  await pool.query(
    `INSERT INTO draft_items (user_id, kind, product_id, qty, unit_price)
     VALUES ($1, 'sale', $2, $3, (SELECT sell_price FROM products WHERE id = $2))
     ON CONFLICT (user_id, kind, product_id)
     DO UPDATE SET qty = draft_items.qty + EXCLUDED.qty, unit_price = EXCLUDED.unit_price`,
    [req.user.id, productId, qty]
  );
  res.redirect('/kasir?ok=added');
}));

router.post('/cart/qty', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');

  const itemId = readInt(String(req.body.item_id || ''), 1);
  const qty = readInt(String(req.body.qty || ''), 0);
  if (itemId === null || qty === null) {
    return renderKasir(req, res, { error: 'Jumlah harus bilangan bulat nol atau lebih.' }, 400);
  }

  const found = await ownItem(pool, itemId, req.user.id);
  const item = found.rows[0];
  if (!item) return renderKasir(req, res, { error: 'Baris keranjang tidak ditemukan.' }, 404);

  if (qty === 0) {
    await pool.query('DELETE FROM draft_items WHERE id = $1 AND user_id = $2', [itemId, req.user.id]);
    return res.redirect('/kasir?ok=removed');
  }

  const { rows } = await pool.query('SELECT brand, name, stock, ml_used FROM products WHERE id = $1', [item.product_id]);
  const product = rows[0];
  const sellableQty = product.stock - (product.ml_used > 0 ? 1 : 0);
  if (qty > sellableQty) {
    return renderKasir(req, res, {
      error: `Stok ${product.brand} ${product.name} tinggal ${sellableQty}.`
    }, 409);
  }

  await pool.query('UPDATE draft_items SET qty = $1 WHERE id = $2 AND user_id = $3', [qty, itemId, req.user.id]);
  res.redirect('/kasir?ok=updated');
}));

router.post('/cart/remove', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');
  const itemId = readInt(String(req.body.item_id || ''), 1);
  if (itemId === null) return errorPage(res, 400, 'ID baris tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query('DELETE FROM draft_items WHERE id = $1 AND user_id = $2 AND kind = $3', [itemId, req.user.id, 'sale']);
  res.redirect('/kasir?ok=removed');
}));

router.post('/cart/clear', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');
  await pool.query('DELETE FROM draft_items WHERE user_id = $1 AND kind = $2', [req.user.id, 'sale']);
  res.redirect('/kasir?ok=cleared');
}));

router.post('/preview', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(qty * unit_price),0)::bigint AS s FROM draft_items WHERE user_id = $1 AND kind = $2',
    [req.user.id, 'sale']
  );
  const subtotal = Number(rows[0].s);
  const parsed = parseCheckout(req.body, subtotal);
  if (parsed.errors) {
    return renderKasir(req, res, {
      error: parsed.errors.join(' '),
      discount: Number(req.body.discount) || 0,
      payment: req.body.payment || 'cash'
    }, 400);
  }
  await renderKasir(req, res, {
    discount: parsed.discount,
    payment: parsed.payment,
    flash: 'Total dihitung ulang dari isi keranjang.'
  });
}));

router.post('/checkout', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Kasir, lalu coba lagi.');

  try {
    const sale = await withTransaction(async (client) => {
      const { rows: items } = await client.query(
        `SELECT d.product_id, d.qty, d.unit_price, p.brand, p.name, p.stock, p.ml_used, p.is_active
           FROM draft_items d
           JOIN products p ON p.id = d.product_id
          WHERE d.user_id = $1 AND d.kind = 'sale'
          ORDER BY d.product_id`,
        [req.user.id]
      );
      if (!items.length) throw new DomainError(400, 'Keranjang kosong', 'Belum ada produk di keranjang, jadi belum ada yang bisa dibayar.');

      const ids = items.map((i) => i.product_id);
      const { rows: locked } = await client.query(
        'SELECT id, stock, ml_used, is_active FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [ids]
      );
      const stockById = new Map(locked.map((r) => [r.id, r]));

      for (const item of items) {
        const live = stockById.get(item.product_id);
        if (!live || !live.is_active) {
          throw new DomainError(409, 'Produk sudah tidak aktif', `${item.brand} ${item.name} sudah dinonaktifkan dan tidak bisa dijual.`);
        }
        const sellableQty = live.stock - (live.ml_used > 0 ? 1 : 0);
        if (sellableQty < item.qty) {
          throw new DomainError(409, 'Stok tidak cukup', `Stok ${item.brand} ${item.name} tinggal ${sellableQty}, sedangkan keranjang minta ${item.qty}. Kurangi jumlah lalu bayar lagi.`);
        }
      }

      const subtotal = items.reduce((sum, i) => sum + i.qty * i.unit_price, 0);
      const parsed = parseCheckout(req.body, subtotal);
      if (parsed.errors) throw new DomainError(400, 'Data pembayaran tidak valid', parsed.errors.join(' '));

      const { rows: seq } = await client.query("SELECT nextval('sales_id_seq') AS id");
      const saleId = seq[0].id;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const invoice = `INV-${today}-${String(saleId).padStart(6, '0')}`;
      const total = subtotal - parsed.discount;

      await client.query(
        `INSERT INTO sales (id, invoice_no, user_id, subtotal, discount, total, payment_method)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [saleId, invoice, req.user.id, subtotal, parsed.discount, total, parsed.payment]
      );

      for (const item of items) {
        await client.query(
          'INSERT INTO sale_items (sale_id, product_id, qty, price) VALUES ($1,$2,$3,$4)',
          [saleId, item.product_id, item.qty, item.unit_price]
        );
        const updated = await client.query(
          `UPDATE products SET stock = stock - $1
            WHERE id = $2 AND (stock - CASE WHEN ml_used > 0 THEN 1 ELSE 0 END) >= $1`,
          [item.qty, item.product_id]
        );
        if (updated.rowCount === 0) {
          throw new DomainError(409, 'Stok tidak cukup', `Stok ${item.brand} ${item.name} berubah saat proses bayar. Periksa keranjang lagi.`);
        }
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'sale',$3)",
          [item.product_id, -item.qty, saleId]
        );
      }

      await client.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'sale'", [req.user.id]);
      return { invoice, total };
    });

    res.redirect(`/sales?ok=sale&invoice=${encodeURIComponent(sale.invoice)}`);
  } catch (err) {
    if (err instanceof DomainError) {
      return renderKasir(req, res, { error: err.message, discount: Number(req.body.discount) || 0, payment: req.body.payment || 'cash' }, err.status);
    }
    throw err;
  }
}));

module.exports = router;
