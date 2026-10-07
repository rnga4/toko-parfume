const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { asArray, parseQty } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const FLASH = {
  created: (req) => {
    const no = typeof req.query.no === 'string' ? req.query.no.slice(0, 30) : '';
    return no ? `Retur ${no} tersimpan dan stok sudah menyesuaikan.` : 'Retur tersimpan.';
  }
};

const KIND_LABEL = { return: 'Retur uang', exchange: 'Tukar barang' };

async function exchangeDraft(userId) {
  const { rows } = await pool.query(
    `SELECT d.id, d.qty, d.unit_price, d.product_id, p.brand, p.name, p.size_ml, p.sku, p.stock, p.ml_used, p.is_active
       FROM draft_items d
       JOIN products p ON p.id = d.product_id
      WHERE d.user_id = $1 AND d.kind = 'exchange'
      ORDER BY p.brand, p.name`,
    [userId]
  );
  return rows;
}

function sellable(row) {
  return row.stock - (row.ml_used > 0 ? 1 : 0);
}

async function exchangeProducts() {
  const { rows } = await pool.query(
    `SELECT id, sku, brand, name, size_ml, stock, ml_used
       FROM products
      WHERE is_active AND (stock - CASE WHEN ml_used > 0 THEN 1 ELSE 0 END) > 0
      ORDER BY brand, name`
  );
  return rows;
}

async function saleItems(saleId) {
  const { rows } = await pool.query(
    `SELECT si.product_id, si.qty, si.price, p.brand, p.name, p.size_ml, p.sku, p.is_active,
            COALESCE((SELECT SUM(ri.qty)
                        FROM return_items ri
                        JOIN returns r ON r.id = ri.return_id
                       WHERE r.sale_id = $1 AND ri.product_id = si.product_id AND ri.direction = 'in'
                     ), 0)::int AS returned
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY p.brand, p.name`,
    [saleId]
  );
  return rows;
}

router.get('/', wrap(async (req, res) => {
  const [returns, sales] = await Promise.all([
    pool.query(
      `SELECT r.id, r.return_no, r.kind, r.net_amount, r.created_at, s.invoice_no, u.username,
              (SELECT COUNT(*)::int FROM return_items ri WHERE ri.return_id = r.id AND ri.direction = 'in') AS items_in,
              (SELECT COUNT(*)::int FROM return_items ri WHERE ri.return_id = r.id AND ri.direction = 'out') AS items_out
         FROM returns r
         JOIN sales s ON s.id = r.sale_id
         LEFT JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC
        LIMIT 200`
    ),
    pool.query('SELECT id, invoice_no FROM sales ORDER BY created_at DESC LIMIT 200')
  ]);
  res.render('returns', {
    returns: returns.rows,
    sales: sales.rows,
    kindLabel: KIND_LABEL,
    flash: FLASH[req.query.ok] ? FLASH[req.query.ok](req) : null
  });
}));

router.get('/new', wrap(async (req, res) => {
  const saleId = readInt(String(req.query.sale || ''), 1);
  if (saleId === null) return errorPage(res, 400, 'Penjualan tidak valid', 'Pilih penjualan dari daftar Riwayat atau daftar Retur.');

  await pool.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'exchange'", [req.user.id]);

  const { rows: sales } = await pool.query(
    `SELECT s.*, u.username FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1`,
    [saleId]
  );
  const sale = sales[0];
  if (!sale) return errorPage(res, 404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');

  res.render('return-form', {
    sale,
    items: await saleItems(saleId),
    exchange: [],
    products: await exchangeProducts(),
    error: null
  });
}));

async function renderForm(req, res, saleId, error, status) {
  const { rows } = await pool.query(
    'SELECT s.*, u.username FROM sales s LEFT JOIN users u ON u.id = s.user_id WHERE s.id = $1',
    [saleId]
  );
  if (!rows[0]) return errorPage(res, 404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');
  if (status) res.status(status);
  return res.render('return-form', {
    sale: rows[0],
    items: await saleItems(saleId),
    exchange: await exchangeDraft(req.user.id),
    products: await exchangeProducts(),
    error
  });
}

router.post('/exchange/add', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman retur, lalu coba lagi.');
  const saleId = readInt(String(req.body.sale_id || ''), 1);
  const productId = readInt(String(req.body.product_id || ''), 1);
  const qty = parseQty(req.body.qty);
  if (saleId === null) return errorPage(res, 400, 'Isian tidak valid', 'Alamat permintaan tidak benar.');
  if (productId === null || qty === null) {
    return renderForm(req, res, saleId, 'Produk dan jumlah pengganti harus angka yang benar.', 400);
  }

  const { rows } = await pool.query('SELECT id, brand, name, stock, ml_used, is_active FROM products WHERE id = $1', [productId]);
  const product = rows[0];
  if (!product || !product.is_active) {
    return renderForm(req, res, saleId, 'Produk pengganti itu tidak ditemukan atau sudah nonaktif.', 400);
  }

  const draft = await exchangeDraft(req.user.id);
  const inCart = draft.find((d) => d.product_id === productId);
  const wanted = (inCart ? inCart.qty : 0) + qty;
  if (wanted > sellable(product)) {
    return renderForm(req, res, saleId,
      `Stok ${product.brand} ${product.name} tinggal ${sellable(product)}, jadi jumlah pengganti tidak boleh melebihi itu.`, 409);
  }

  await pool.query(
    `INSERT INTO draft_items (user_id, kind, product_id, qty, unit_price)
     VALUES ($1, 'exchange', $2, $3, (SELECT sell_price FROM products WHERE id = $2))
     ON CONFLICT (user_id, kind, product_id)
     DO UPDATE SET qty = draft_items.qty + EXCLUDED.qty, unit_price = EXCLUDED.unit_price`,
    [req.user.id, productId, qty]
  );
  res.redirect(`/returns/new?sale=${saleId}`);
}));

router.post('/exchange/qty', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman retur, lalu coba lagi.');
  const saleId = readInt(String(req.body.sale_id || ''), 1);
  const itemId = readInt(String(req.body.item_id || ''), 1);
  const qty = readInt(String(req.body.qty || ''), 0);
  if (saleId === null) return errorPage(res, 400, 'Penjualan tidak valid', 'Alamat permintaan tidak benar.');
  if (itemId === null || qty === null) {
    return renderForm(req, res, saleId, 'Jumlah harus bilangan bulat nol atau lebih.', 400);
  }

  const found = await pool.query(
    "SELECT d.product_id FROM draft_items d WHERE d.id = $1 AND d.user_id = $2 AND d.kind = 'exchange'",
    [itemId, req.user.id]
  );
  if (!found.rows[0]) return renderForm(req, res, saleId, 'Barang pengganti itu tidak ada di daftar.', 404);

  if (qty === 0) {
    await pool.query('DELETE FROM draft_items WHERE id = $1 AND user_id = $2', [itemId, req.user.id]);
    return res.redirect(`/returns/new?sale=${saleId}`);
  }

  const { rows } = await pool.query('SELECT stock, ml_used FROM products WHERE id = $1', [found.rows[0].product_id]);
  if (qty > sellable(rows[0])) {
    return renderForm(req, res, saleId, `Stok barang pengganti tinggal ${sellable(rows[0])}.`, 409);
  }

  await pool.query('UPDATE draft_items SET qty = $1 WHERE id = $2 AND user_id = $3', [qty, itemId, req.user.id]);
  res.redirect(`/returns/new?sale=${saleId}`);
}));

router.post('/exchange/remove', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman retur, lalu coba lagi.');
  const saleId = readInt(String(req.body.sale_id || ''), 1);
  const itemId = readInt(String(req.body.item_id || ''), 1);
  if (saleId === null || itemId === null) return errorPage(res, 400, 'ID baris tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query("DELETE FROM draft_items WHERE id = $1 AND user_id = $2 AND kind = 'exchange'", [itemId, req.user.id]);
  res.redirect(`/returns/new?sale=${saleId}`);
}));

router.post('/exchange/clear', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman retur, lalu coba lagi.');
  const saleId = readInt(String(req.body.sale_id || ''), 1);
  if (saleId === null) return errorPage(res, 400, 'Penjualan tidak valid', 'Alamat permintaan tidak benar.');
  await pool.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'exchange'", [req.user.id]);
  res.redirect(`/returns/new?sale=${saleId}`);
}));

router.post('/commit', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman retur, lalu coba lagi.');

  const kind = req.body.kind === 'exchange' ? 'exchange' : req.body.kind === 'return' ? 'return' : null;
  const saleId = readInt(String(req.body.sale_id || ''), 1);
  if (!kind) return errorPage(res, 400, 'Jenis retur belum dipilih', 'Tekan salah satu tombol simpan di bawah daftar item.');
  if (saleId === null) return errorPage(res, 400, 'Penjualan tidak valid', 'Alamat permintaan tidak benar.');

  const productIds = asArray(req.body.ret_product);
  const qtyValues = asArray(req.body.ret_qty);
  if (productIds.length !== qtyValues.length) {
    return errorPage(res, 400, 'Isian tidak cocok', 'Muat ulang halaman retur, lalu isi lagi jumlahnya.');
  }

  const wanted = [];
  const seen = new Set();
  for (let i = 0; i < productIds.length; i++) {
    const productId = readInt(String(productIds[i]), 1);
    const raw = String(qtyValues[i]).trim();
    const qty = raw === '' ? 0 : readInt(raw, 0);
    if (productId === null || qty === null) {
      return errorPage(res, 400, 'Jumlah tidak valid', 'Setiap jumlah retur harus bilangan bulat nol atau lebih.');
    }
    if (qty === 0) continue;
    if (seen.has(productId)) {
      return errorPage(res, 400, 'Item ganda', 'Ada produk yang muncul dua kali di daftar retur.');
    }
    seen.add(productId);
    wanted.push({ productId, qty });
  }
  if (!wanted.length) {
    return errorPage(res, 400, 'Belum ada yang diretur', 'Isi jumlah lebih dari nol pada minimal satu item penjualan.');
  }

  try {
    const result = await withTransaction(async (client) => {
      const { rows: sales } = await client.query('SELECT * FROM sales WHERE id = $1 FOR UPDATE', [saleId]);
      const sale = sales[0];
      if (!sale) throw new DomainError(404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');

      const { rows: sold } = await client.query(
        `SELECT si.product_id, si.qty, si.price,
                COALESCE((SELECT SUM(ri.qty)
                            FROM return_items ri
                            JOIN returns r ON r.id = ri.return_id
                           WHERE r.sale_id = $1 AND ri.product_id = si.product_id AND ri.direction = 'in'
                         ), 0)::int AS returned
           FROM sale_items si
          WHERE si.sale_id = $1
          FOR UPDATE`,
        [saleId]
      );
      const soldByProduct = new Map(sold.map((r) => [r.product_id, r]));

      for (const item of wanted) {
        const row = soldByProduct.get(item.productId);
        if (!row) throw new DomainError(400, 'Item bukan bagian penjualan ini', 'Muat ulang halaman retur, lalu coba lagi.');
        const remaining = row.qty - row.returned;
        if (item.qty > remaining) {
          throw new DomainError(409, 'Jumlah melebihi yang terjual',
            `Penjualan ini tinggal ${remaining} unit yang belum diretur untuk produk itu. Muat ulang halaman lalu isi angka yang benar.`);
        }
      }

      const draft = await exchangeDraft(req.user.id);
      if (kind === 'return' && draft.length) {
        throw new DomainError(400, 'Ada barang pengganti',
          'Daftar barang pengganti masih terisi. Simpan sebagai tukar barang, atau kosongkan daftarnya dulu.');
      }
      if (kind === 'exchange' && !draft.length) {
        throw new DomainError(400, 'Barang pengganti kosong', 'Tambahkan minimal satu barang pengganti sebelum menyimpan sebagai tukar barang.');
      }

      const lockIds = wanted.map((w) => w.productId).concat(draft.map((d) => d.product_id));
      const { rows: locked } = await client.query(
        'SELECT id, stock, ml_used, is_active FROM products WHERE id = ANY($1) ORDER BY id FOR UPDATE',
        [lockIds]
      );
      const live = new Map(locked.map((r) => [r.id, r]));

      for (const item of draft) {
        const p = live.get(item.product_id);
        if (!p || !p.is_active) {
          throw new DomainError(409, 'Produk sudah tidak aktif', `${item.brand} ${item.name} sudah dinonaktifkan dan tidak bisa dikeluarkan.`);
        }
        if (sellable(p) < item.qty) {
          throw new DomainError(409, 'Stok tidak cukup', `Stok ${item.brand} ${item.name} tinggal ${sellable(p)}, sedangkan daftar pengganti minta ${item.qty}. Kurangi jumlahnya lalu simpan lagi.`);
        }
      }

      let subtotalIn = 0;
      const saleSubtotal = Number(sale.subtotal);
      const saleDiscount = Number(sale.discount);
      for (const item of wanted) {
        const row = soldByProduct.get(item.productId);
        const share = saleSubtotal > 0
          ? Math.floor(saleDiscount * (Number(row.price) * item.qty) / saleSubtotal)
          : 0;
        subtotalIn += Number(row.price) * item.qty - share;
      }
      const subtotalOut = draft.reduce((sum, d) => sum + d.qty * Number(d.unit_price), 0);
      const net = subtotalIn - subtotalOut;

      const { rows: seq } = await client.query("SELECT nextval('returns_id_seq') AS id");
      const returnId = seq[0].id;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const returnNo = `RET-${today}-${String(returnId).padStart(6, '0')}`;

      await client.query(
        `INSERT INTO returns (id, return_no, sale_id, user_id, kind, subtotal_in, subtotal_out, net_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [returnId, returnNo, saleId, req.user.id, kind, subtotalIn, subtotalOut, net]
      );

      for (const item of wanted) {
        const row = soldByProduct.get(item.productId);
        await client.query(
          "INSERT INTO return_items (return_id, product_id, qty, price, direction) VALUES ($1,$2,$3,$4,'in')",
          [returnId, item.productId, item.qty, row.price]
        );
        await client.query('UPDATE products SET stock = stock + $1 WHERE id = $2', [item.qty, item.productId]);
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'return',$3)",
          [item.productId, item.qty, returnId]
        );
      }

      for (const item of draft) {
        await client.query(
          "INSERT INTO return_items (return_id, product_id, qty, price, direction) VALUES ($1,$2,$3,$4,'out')",
          [returnId, item.product_id, item.qty, item.unit_price]
        );
        const updated = await client.query(
          `UPDATE products SET stock = stock - $1
            WHERE id = $2 AND (stock - CASE WHEN ml_used > 0 THEN 1 ELSE 0 END) >= $1`,
          [item.qty, item.product_id]
        );
        if (updated.rowCount === 0) {
          throw new DomainError(409, 'Stok tidak cukup', `Stok ${item.brand} ${item.name} berubah saat menyimpan retur. Muat ulang halaman ini lalu coba lagi.`);
        }
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'exchange',$3)",
          [item.product_id, -item.qty, returnId]
        );
      }

      await client.query("DELETE FROM draft_items WHERE user_id = $1 AND kind = 'exchange'", [req.user.id]);
      return { returnNo };
    });

    res.redirect(`/returns?ok=created&no=${encodeURIComponent(result.returnNo)}`);
  } catch (err) {
    if (err instanceof DomainError) {
      return renderForm(req, res, saleId, err.message, err.status);
    }
    throw err;
  }
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID retur tidak valid', 'Alamat permintaan tidak benar.');

  const { rows } = await pool.query(
    `SELECT r.*, s.invoice_no, s.subtotal AS sale_subtotal, s.discount AS sale_discount, u.username
       FROM returns r
       JOIN sales s ON s.id = r.sale_id
       LEFT JOIN users u ON u.id = r.user_id
      WHERE r.id = $1`,
    [id]
  );
  const ret = rows[0];
  if (!ret) return errorPage(res, 404, 'Retur tidak ditemukan', 'Nomor retur itu tidak ada.');

  const items = await pool.query(
    `SELECT ri.qty, ri.price, ri.direction, p.brand, p.name, p.size_ml, p.sku
       FROM return_items ri
       JOIN products p ON p.id = ri.product_id
      WHERE ri.return_id = $1
      ORDER BY ri.direction, p.brand, p.name`,
    [id]
  );

  res.render('return-detail', { ret, items: items.rows, kindLabel: KIND_LABEL });
}));

module.exports = router;
