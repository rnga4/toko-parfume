const express = require('express');
const { pool, withTransaction } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt, DomainError } = require('../lib/http');
const { requireAuth, requireRoles } = require('../lib/auth');
const { parseFormula, parseWorkOrder, parseQty, parseDate } = require('../lib/validate');
const { addLot, consumeLots, refundLots } = require('../lib/lots');
const { logActivity } = require('../lib/audit');

const router = express.Router();

router.use(requireAuth, requireRoles(['admin', 'owner', 'produksi']));

const FLASH = {
  formula: 'Racikan baru tersimpan.',
  activated: 'Racikan itu jadi versi aktif.',
  wo: 'Work order dibuat.',
  racik: 'Bahan sudah dikurangi dari gudang. Produksi masuk tahap racik.',
  maserasi: 'Work order masuk masa maserasi.',
  filling: 'Work order siap filling.',
  done: 'Produksi selesai. Hasil jadi masuk stok sebagai lot baru.',
  batal: 'Work order dibatalkan dan bahan dikembalikan ke gudang.'
};

const STATUS_LABEL = {
  draft: 'Draft',
  racik: 'Racik',
  maserasi: 'Maserasi',
  filling: 'Filling',
  done: 'Selesai',
  batal: 'Batal'
};

const ORDER = ['draft', 'racik', 'maserasi', 'filling', 'done', 'batal'];

function requiredQtyFor(pct, targetQty, targetSizeMl, materialSizeMl) {
  const ml = targetQty * targetSizeMl * Number(pct) / 100;
  return Math.max(1, Math.ceil(ml / materialSizeMl));
}

async function formulaDetail(client, id) {
  const { rows } = await client.query(
    `SELECT f.*, p.brand AS target_brand, p.name AS target_name, p.size_ml AS target_size, p.sku AS target_sku
       FROM formulas f JOIN products p ON p.id = f.target_product_id
      WHERE f.id = $1`,
    [id]
  );
  const formula = rows[0];
  if (!formula) return null;
  const items = await client.query(
    `SELECT fi.id, fi.pct, m.id AS material_id, m.sku, m.brand, m.name, m.size_ml, m.stock, m.category
       FROM formula_items fi JOIN products m ON m.id = fi.material_id
      WHERE fi.formula_id = $1
      ORDER BY m.brand, m.name`,
    [id]
  );
  return { formula, items: items.rows };
}

async function renderProduction(req, res, extra, status) {
  const [formulas, orders, products] = await Promise.all([
    pool.query(
      `SELECT f.id, f.name, f.version, f.is_active, f.created_at,
              p.brand AS target_brand, p.name AS target_name, p.size_ml AS target_size,
              (SELECT COUNT(*)::int FROM formula_items fi WHERE fi.formula_id = f.id) AS materials
         FROM formulas f JOIN products p ON p.id = f.target_product_id
        ORDER BY f.is_active DESC, f.updated_at DESC`
    ),
    pool.query(
      `SELECT w.id, w.wo_no, w.status, w.target_qty, w.created_at, w.maserasi_start,
              to_char(w.maserasi_end_est, 'YYYY-MM-DD') AS maserasi_est,
              f.name AS formula_name, p.brand AS target_brand, p.name AS target_name, p.size_ml AS target_size,
              u.username
         FROM work_orders w
         JOIN formulas f ON f.id = w.formula_id
         JOIN products p ON p.id = f.target_product_id
         LEFT JOIN users u ON u.id = w.user_id
        ORDER BY w.created_at DESC
        LIMIT 100`
    ),
    pool.query("SELECT id, sku, brand, name, size_ml, category FROM products WHERE is_active AND category <> 'Decant' ORDER BY brand, name")
  ]);

  const groups = ORDER.map((key) => ({ key, label: STATUS_LABEL[key], orders: orders.rows.filter((o) => o.status === key) }));
  if (status) res.status(status);
  res.render('production', Object.assign({
    formulas: formulas.rows,
    groups,
    activeFormulas: formulas.rows.filter((f) => f.is_active),
    products: products.rows,
    statusLabel: STATUS_LABEL,
    flash: null,
    error: null
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  await renderProduction(req, res, { flash: FLASH[req.query.ok] || null });
}));

router.post('/formulas', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const parsed = parseFormula(req.body);
  if (parsed.errors) {
    return renderProduction(req, res, { error: parsed.errors.join(' ') }, 400);
  }

  try {
    await withTransaction(async (client) => {
      const target = await client.query('SELECT id, size_ml FROM products WHERE id = $1', [parsed.targetId]);
      if (!target.rows[0]) throw new DomainError(400, 'Produk jadi tidak valid', 'Produk jadi yang dipilih tidak ada.');
      for (const item of parsed.items) {
        if (item.materialId === parsed.targetId) throw new DomainError(400, 'Bahan tidak boleh sama dengan produk jadi', 'Produk jadi tidak bisa menjadi bahannya sendiri.');
        const m = await client.query('SELECT id FROM products WHERE id = $1', [item.materialId]);
        if (!m.rows[0]) throw new DomainError(400, 'Bahan tidak valid', 'Ada bahan yang tidak ditemukan.');
      }
      const { rows: ver } = await client.query(
        'SELECT COALESCE(MAX(version), 0) + 1 AS v FROM formulas WHERE target_product_id = $1',
        [parsed.targetId]
      );
      const { rows: inserted } = await client.query(
        `INSERT INTO formulas (name, target_product_id, version, notes) VALUES ($1,$2,$3,$4) RETURNING id`,
        [parsed.name, parsed.targetId, ver[0].v, parsed.notes]
      );
      const formulaId = inserted[0].id;
      for (const item of parsed.items) {
        await client.query('INSERT INTO formula_items (formula_id, material_id, pct) VALUES ($1,$2,$3)', [formulaId, item.materialId, item.pct]);
      }
    });
    await logActivity(pool, req.user, 'formula.create', 'formula', null, `Racikan ${parsed.name}`);
    res.redirect('/production?ok=formula');
  } catch (err) {
    if (err instanceof DomainError) return renderProduction(req, res, { error: err.message }, err.status);
    throw err;
  }
}));

router.post('/formulas/:id/activate', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID racikan tidak valid', 'Alamat permintaan tidak benar.');
  await withTransaction(async (client) => {
    const { rows } = await client.query('SELECT id, target_product_id FROM formulas WHERE id = $1 FOR UPDATE', [id]);
    if (!rows[0]) throw new DomainError(404, 'Racikan tidak ditemukan', 'Racikan itu tidak ada.');
    await client.query('UPDATE formulas SET is_active = false WHERE target_product_id = $1', [rows[0].target_product_id]);
    await client.query('UPDATE formulas SET is_active = true, updated_at = NOW() WHERE id = $1', [id]);
  });
  await logActivity(pool, req.user, 'formula.activate', 'formula', id, 'Racikan dijadikan versi aktif');
  res.redirect('/production?ok=activated');
}));

router.get('/work-orders/new', wrap(async (req, res) => {
  const formulaId = readInt(String(req.query.formula || ''), 1);
  const formula = formulaId !== null ? await formulaDetail(pool, formulaId) : null;
  if (formulaId !== null && !formula) return errorPage(res, 404, 'Racikan tidak ditemukan', 'Racikan itu tidak ada.');
  res.render('production-new', {
    formulas: (await pool.query('SELECT id, name, version, is_active FROM formulas ORDER BY is_active DESC, name')).rows,
    formula,
    targetQty: 1,
    note: '',
    error: null
  });
}));

router.post('/work-orders', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const parsed = parseWorkOrder(req.body);
  if (parsed.errors) {
    const formula = parsed.formulaId ? await formulaDetail(pool, parsed.formulaId) : null;
    return res.status(400).render('production-new', {
      formulas: (await pool.query('SELECT id, name, version, is_active FROM formulas ORDER BY is_active DESC, name')).rows,
      formula,
      targetQty: Number(req.body.target_qty) || 1,
      note: req.body.note || '',
      error: parsed.errors.join(' ')
    });
  }

  try {
    const wo = await withTransaction(async (client) => {
      const detail = await formulaDetail(client, parsed.formulaId);
      if (!detail) throw new DomainError(400, 'Racikan tidak valid', 'Racikan itu tidak ditemukan.');
      if (!detail.formula.is_active) throw new DomainError(409, 'Racikan belum aktif', 'Aktifkan dulu racikan ini sebelum membuat work order.');
      if (!detail.items.length) throw new DomainError(400, 'Racikan kosong', 'Racikan itu belum punya bahan.');

      const { rows: seq } = await client.query("SELECT nextval('work_orders_id_seq') AS id");
      const woId = seq[0].id;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const woNo = `WO-${today}-${String(woId).padStart(6, '0')}`;

      await client.query(
        `INSERT INTO work_orders (id, wo_no, formula_id, target_qty, note, user_id) VALUES ($1,$2,$3,$4,$5,$6)`,
        [woId, woNo, parsed.formulaId, parsed.targetQty, parsed.note, req.user.id]
      );
      for (const item of detail.items) {
        const reqQty = requiredQtyFor(item.pct, parsed.targetQty, detail.formula.target_size, item.size_ml);
        await client.query(
          'INSERT INTO work_order_materials (work_order_id, material_id, required_qty) VALUES ($1,$2,$3)',
          [woId, item.material_id, reqQty]
        );
      }
      return { woId, woNo };
    });
    await logActivity(pool, req.user, 'wo.create', 'work_order', wo.woId, `WO ${wo.woNo} target ${parsed.targetQty} botol`);
    res.redirect(`/production/work-orders/${wo.woId}?ok=wo`);
  } catch (err) {
    if (err instanceof DomainError) {
      const formula = await formulaDetail(pool, parsed.formulaId);
      return res.status(err.status).render('production-new', {
        formulas: (await pool.query('SELECT id, name, version, is_active FROM formulas ORDER BY is_active DESC, name')).rows,
        formula,
        targetQty: parsed.targetQty,
        note: parsed.note || '',
        error: err.message
      });
    }
    throw err;
  }
}));

router.get('/work-orders/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  const wo = await loadWorkOrder(id);
  if (!wo) return errorPage(res, 404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
  res.render('work-order', {
    wo,
    materials: wo.materials,
    statusLabel: STATUS_LABEL,
    flash: FLASH[req.query.ok] || null,
    error: null,
    today: new Date().toISOString().slice(0, 10)
  });
}));

async function loadWorkOrder(id) {
  const { rows } = await pool.query(
    `SELECT w.*, f.name AS formula_name, f.version, f.notes,
            p.brand AS target_brand, p.name AS target_name, p.size_ml AS target_size, p.sku AS target_sku,
            u.username
       FROM work_orders w
       JOIN formulas f ON f.id = w.formula_id
       JOIN products p ON p.id = f.target_product_id
       LEFT JOIN users u ON u.id = w.user_id
      WHERE w.id = $1`,
    [id]
  );
  const wo = rows[0];
  if (!wo) return null;
  const materials = await pool.query(
    `SELECT wm.id, wm.required_qty, wm.consumed_qty, m.id AS material_id, m.sku, m.brand, m.name, m.size_ml, m.stock
       FROM work_order_materials wm JOIN products m ON m.id = wm.material_id
      WHERE wm.work_order_id = $1
      ORDER BY m.brand, m.name`,
    [id]
  );
  wo.materials = materials.rows;
  return wo;
}

function assertStatus(wo, expected) {
  if (wo.status !== expected) {
    throw new DomainError(409, 'Tahap tidak cocok', `Work order ini sedang di tahap ${STATUS_LABEL[wo.status]}, bukan ${STATUS_LABEL[expected]}.`);
  }
}

router.post('/work-orders/:id/start', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id]);
      const wo = rows[0];
      if (!wo) throw new DomainError(404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
      assertStatus(wo, 'draft');
      const { rows: mats } = await client.query(
        `SELECT wm.id, wm.required_qty, m.id AS material_id, m.brand, m.name
           FROM work_order_materials wm JOIN products m ON m.id = wm.material_id
          WHERE wm.work_order_id = $1`,
        [id]
      );
      for (const m of mats) {
        let alloc;
        try {
          alloc = await consumeLots(client, m.material_id, m.required_qty);
        } catch (err) {
          if (err instanceof DomainError) {
            throw new DomainError(409, 'Bahan kurang', `Bahan ${m.brand} ${m.name} tidak cukup. ${err.message}`);
          }
          throw err;
        }
        const tagged = alloc.map((a) => Object.assign({}, a, { product_id: m.material_id }));
        await client.query('UPDATE work_order_materials SET consumed_qty = $1, lots_used = $2 WHERE id = $3',
          [m.required_qty, JSON.stringify(tagged), m.id]);
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'produksi',$3)",
          [m.material_id, -m.required_qty, id]
        );
      }
      await client.query("UPDATE work_orders SET status = 'racik', updated_at = NOW() WHERE id = $1", [id]);
    });
    await logActivity(pool, req.user, 'wo.start', 'work_order', id, 'Bahan dikonsumsi untuk racik');
    res.redirect(`/production/work-orders/${id}?ok=racik`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

router.post('/work-orders/:id/maserasi', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  const start = parseDate(req.body.maserasi_start);
  const est = parseDate(req.body.maserasi_end_est);
  if (!start.ok || !est.ok) return errorPage(res, 400, 'Tanggal tidak valid', 'Format tanggal harus YYYY-MM-DD.');
  if (!start.value) return errorPage(res, 400, 'Tanggal mulai kosong', 'Isi tanggal mulai maserasi.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id]);
      const wo = rows[0];
      if (!wo) throw new DomainError(404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
      assertStatus(wo, 'racik');
      await client.query(
        "UPDATE work_orders SET status = 'maserasi', maserasi_start = $1, maserasi_end_est = $2, updated_at = NOW() WHERE id = $3",
        [start.value, est.value, id]
      );
    });
    res.redirect(`/production/work-orders/${id}?ok=maserasi`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

router.post('/work-orders/:id/filling', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  const batch = req.body.output_batch && req.body.output_batch.trim() ? req.body.output_batch.trim().slice(0, 50) : null;
  const expiry = parseDate(req.body.output_expiry);
  if (!expiry.ok) return errorPage(res, 400, 'Tanggal tidak valid', 'Format kedaluwarsa harus YYYY-MM-DD.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id]);
      const wo = rows[0];
      if (!wo) throw new DomainError(404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
      assertStatus(wo, 'maserasi');
      await client.query(
        "UPDATE work_orders SET status = 'filling', output_batch = $1, output_expiry = $2, updated_at = NOW() WHERE id = $3",
        [batch, expiry.value, id]
      );
    });
    res.redirect(`/production/work-orders/${id}?ok=filling`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

router.post('/work-orders/:id/finish', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query(
        `SELECT w.*, f.target_product_id FROM work_orders w JOIN formulas f ON f.id = w.formula_id
          WHERE w.id = $1 FOR UPDATE`,
        [id]
      );
      const wo = rows[0];
      if (!wo) throw new DomainError(404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
      assertStatus(wo, 'filling');

      const batch = wo.output_batch || wo.wo_no;
      await addLot(client, wo.target_product_id, wo.target_qty, batch, wo.output_expiry ? String(wo.output_expiry).slice(0, 10) : null);

      const { rows: costRows } = await client.query(
        `SELECT COALESCE(SUM(wm.consumed_qty * m.cost_price), 0)::bigint AS c
           FROM work_order_materials wm JOIN products m ON m.id = wm.material_id
          WHERE wm.work_order_id = $1`,
        [id]
      );
      const unitCost = Math.round(Number(costRows[0].c) / wo.target_qty);
      if (unitCost > 0) {
        await client.query('UPDATE products SET cost_price = $1 WHERE id = $2', [unitCost, wo.target_product_id]);
      }
      await client.query(
        "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'produksi',$3)",
        [wo.target_product_id, wo.target_qty, id]
      );
      await client.query("UPDATE work_orders SET status = 'done', finished_at = NOW(), updated_at = NOW() WHERE id = $1", [id]);
    });
    await logActivity(pool, req.user, 'wo.finish', 'work_order', id, 'Hasil produksi masuk stok');
    res.redirect(`/production/work-orders/${id}?ok=done`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

router.post('/work-orders/:id/cancel', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Produksi, lalu coba lagi.');
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID work order tidak valid', 'Alamat permintaan tidak benar.');
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM work_orders WHERE id = $1 FOR UPDATE', [id]);
      const wo = rows[0];
      if (!wo) throw new DomainError(404, 'Work order tidak ditemukan', 'Work order itu tidak ada.');
      if (wo.status === 'done') throw new DomainError(409, 'Sudah selesai', 'Work order yang sudah selesai tidak bisa dibatalkan.');
      if (wo.status === 'batal') throw new DomainError(409, 'Sudah batal', 'Work order ini sudah dibatalkan.');

      const { rows: mats } = await client.query(
        'SELECT id, material_id, consumed_qty, lots_used FROM work_order_materials WHERE work_order_id = $1',
        [id]
      );
      for (const m of mats) {
        if (!m.consumed_qty) continue;
        const alloc = Array.isArray(m.lots_used) ? m.lots_used : [];
        await refundLots(client, alloc);
        await client.query('UPDATE work_order_materials SET consumed_qty = 0, lots_used = NULL WHERE id = $1', [m.id]);
        await client.query(
          "INSERT INTO stock_movements (product_id, change, reason, ref_id) VALUES ($1,$2,'produksi-batal',$3)",
          [m.material_id, m.consumed_qty, id]
        );
      }
      await client.query("UPDATE work_orders SET status = 'batal', updated_at = NOW() WHERE id = $1", [id]);
    });
    await logActivity(pool, req.user, 'wo.cancel', 'work_order', id, 'Work order dibatalkan, bahan dikembalikan');
    res.redirect(`/production/work-orders/${id}?ok=batal`);
  } catch (err) {
    if (err instanceof DomainError) return errorPage(res, err.status, err.heading, err.message);
    throw err;
  }
}));

module.exports = router;