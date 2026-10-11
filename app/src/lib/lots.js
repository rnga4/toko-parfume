const { DomainError } = require('./http');

async function syncProductStock(client, productId) {
  await client.query(
    `UPDATE products SET stock = (SELECT COALESCE(SUM(qty), 0)::int FROM product_lots WHERE product_id = $1)
      WHERE id = $1`,
    [productId]
  );
}

async function addLot(client, productId, qty, batchNo, expiry, opts) {
  const qcStatus = (opts && opts.qcStatus) || 'pending';
  const { rows } = await client.query(
    `INSERT INTO product_lots (product_id, batch_no, expiry_date, qty, qc_status)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [productId, batchNo || null, expiry || null, qty, qcStatus]
  );
  await syncProductStock(client, productId);
  return rows[0].id;
}

function lotEligibility(product) {
  return `(pl.expiry_date IS NULL OR pl.expiry_date >= CURRENT_DATE) AND pl.qc_status <> 'reject'
     AND (${!product || !product.qc_required ? true : "pl.qc_status = 'pass'"})`;
}

async function productSellableMap(client, productIds) {
  const ids = Array.from(new Set((productIds || []).filter((v) => Number.isInteger(v) && v > 0)));
  const map = new Map();
  if (!ids.length) return map;
  const { rows } = await client.query(
    `SELECT p.id AS product_id,
            COALESCE(SUM(CASE WHEN (pl.expiry_date IS NULL OR pl.expiry_date >= CURRENT_DATE)
                AND pl.qc_status <> 'reject' AND (NOT p.qc_required OR pl.qc_status='pass')
              THEN pl.qty ELSE 0 END), 0)::int AS sellable
       FROM products p
       LEFT JOIN product_lots pl ON pl.product_id = p.id
      WHERE p.id = ANY($1)
      GROUP BY p.id`,
    [ids]
  );
  for (const row of rows) map.set(row.product_id, Number(row.sellable));
  for (const id of ids) if (!map.has(id)) map.set(id, 0);
  return map;
}

async function consumeLots(client, productId, qty, opts) {
  const { rows: ps } = await client.query(
    'SELECT id, qc_required FROM products WHERE id = $1 FOR UPDATE',
    [productId]
  );
  const product = ps[0];
  if (!product) throw new DomainError(400, 'Produk tidak ditemukan', 'Produk itu sudah tidak ada.');

  const base = "(pl.expiry_date IS NULL OR pl.expiry_date >= CURRENT_DATE) AND pl.qc_status <> 'reject'";
  const scope = product.qc_required ? `${base} AND pl.qc_status = 'pass'` : base;
  const { rows: lots } = await client.query(
    `SELECT id, qty, batch_no, expiry_date FROM product_lots pl
      WHERE pl.product_id = $1 AND ${scope}
      ORDER BY CASE WHEN pl.expiry_date IS NULL THEN 1 ELSE 0 END, pl.expiry_date, pl.id
      FOR UPDATE`,
    [productId]
  );

  let need = qty;
  const alloc = [];
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.qty, need);
    if (take <= 0) continue;
    need -= take;
    alloc.push({ lot_id: lot.id, qty: take, batch_no: lot.batch_no, expiry_date: lot.expiry_date });
  }
  if (need > 0) {
    const available = qty - need;
    throw new DomainError(409, 'Stok tidak cukup',
      `Stok layak jual tinggal ${available}, sedangkan yang diminta ${qty}. Cek lot dan tanggal kedaluwarsa.`);
  }

  for (const a of alloc) {
    await client.query('UPDATE product_lots SET qty = qty - $1 WHERE id = $2 AND qty >= $1', [a.qty, a.lot_id]);
  }
  await syncProductStock(client, productId);
  return alloc;
}

async function consumeIncludingExpired(client, productId, qty) {
  const { rows: lots } = await client.query(
    `SELECT id, qty, batch_no, expiry_date FROM product_lots
      WHERE product_id = $1 AND qty > 0
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id
      FOR UPDATE`,
    [productId]
  );
  let need = qty;
  const alloc = [];
  for (const lot of lots) {
    if (need <= 0) break;
    const take = Math.min(lot.qty, need);
    if (take <= 0) continue;
    need -= take;
    alloc.push({ lot_id: lot.id, qty: take, batch_no: lot.batch_no, expiry_date: lot.expiry_date });
  }
  if (need > 0) {
    throw new DomainError(409, 'Stok tidak cukup',
      `Total stok tinggal ${qty - need}, sedangkan yang diminta ${qty}.`);
  }
  for (const a of alloc) {
    await client.query('UPDATE product_lots SET qty = qty - $1 WHERE id = $2 AND qty >= $1', [a.qty, a.lot_id]);
  }
  await syncProductStock(client, productId);
  return alloc;
}

async function primaryLot(client, productId) {
  const { rows } = await client.query(
    `SELECT id, batch_no, expiry_date FROM product_lots
      WHERE product_id = $1 AND qty > 0
      ORDER BY CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END, expiry_date, id
      LIMIT 1`,
    [productId]
  );
  return rows[0] || null;
}

async function refundLots(client, allocations) {
  const touched = new Set();
  for (const a of allocations || []) {
    if (!a || !a.lot_id || !(a.qty > 0)) continue;
    await client.query('UPDATE product_lots SET qty = qty + $1 WHERE id = $2', [a.qty, a.lot_id]);
    if (a.product_id) touched.add(a.product_id);
  }
  for (const productId of touched) await syncProductStock(client, productId);
  return touched;
}

module.exports = {
  syncProductStock,
  addLot,
  productSellableMap,
  consumeLots,
  consumeIncludingExpired,
  refundLots,
  primaryLot,
  lotEligibility
};