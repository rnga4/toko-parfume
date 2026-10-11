const express = require('express');
const { pool } = require('../lib/db');
const { wrap, readInt, errorPage } = require('../lib/http');
const { requireAuth } = require('../lib/auth');
const { PAYMENT_LABEL, parseDate } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth);

const FLASH = {
  sale: (req) => {
    const invoice = typeof req.query.invoice === 'string' ? req.query.invoice.slice(0, 30) : '';
    return invoice ? `Penjualan ${invoice} tersimpan dan stok sudah berkurang.` : 'Penjualan tersimpan.';
  }
};

function waPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('0')) return '62' + digits.slice(1);
  if (digits.startsWith('8')) return '62' + digits;
  if (digits.startsWith('62')) return digits;
  return null;
}

function waText(sale, items, customer) {
  const lines = [
    'Terima kasih sudah berbelanja di Toko Parfum.',
    `No. invoice: ${sale.invoice_no}`,
    `Tanggal: ${new Date(sale.created_at).toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })}`,
    '',
    'Rincian:'
  ];
  for (const i of items) {
    lines.push(`- ${i.brand} ${i.name} ${i.size_ml}ml x${i.qty} = Rp${(i.price * i.qty).toLocaleString('id-ID')}`);
  }
  lines.push(`Subtotal: Rp${sale.subtotal.toLocaleString('id-ID')}`);
  if (sale.discount) lines.push(`Diskon: Rp${sale.discount.toLocaleString('id-ID')}`);
  lines.push(`Total: Rp${sale.total.toLocaleString('id-ID')}`);
  lines.push(`Metode bayar: ${PAYMENT_LABEL[sale.payment_method] || sale.payment_method}`);
  if (sale.payment_method === 'tempo') {
    lines.push(sale.paid_at ? 'Status: lunas' : `Status: belum bayar${sale.due_date ? `, jatuh tempo ${sale.due_date}` : ''}`);
  }
  if (customer) lines.push(`Pelanggan: ${customer.name}`);
  return lines.join('\n');
}

router.get('/', wrap(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  const conditions = [];
  const values = [];

  if (!isAdmin) {
    values.push(req.user.id);
    conditions.push(`s.user_id = $${values.length}`);
  }

  const userRaw = String(req.query.u || '');
  const userFilter = /^\d+$/.test(userRaw) ? Number(userRaw) : null;
  if (isAdmin && userFilter) {
    values.push(userFilter);
    conditions.push(`s.user_id = $${values.length}`);
  }

  const date = parseDate(req.query.d);
  if (!date.ok) {
    return errorPage(res, 400, 'Tanggal tidak valid', 'Format tanggal harus YYYY-MM-DD.');
  }
  if (date.value) {
    values.push(date.value);
    conditions.push(`s.created_at::date = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const [sales, users] = await Promise.all([
    pool.query(
      `SELECT s.id, s.invoice_no, s.subtotal, s.discount, s.total, s.payment_method, s.created_at, s.paid_at,
              u.username, c.name AS customer,
              (SELECT COUNT(*)::int FROM sale_items si WHERE si.sale_id = s.id) AS items
         FROM sales s
         LEFT JOIN users u ON u.id = s.user_id
         LEFT JOIN customers c ON c.id = s.customer_id
         ${where}
        ORDER BY s.created_at DESC
        LIMIT 200`,
      values
    ),
    isAdmin
      ? pool.query('SELECT id, username FROM users ORDER BY username')
      : Promise.resolve({ rows: [] })
  ]);

  res.render('sales', {
    sales: sales.rows,
    users: users.rows,
    isAdmin,
    filterUser: userFilter || '',
    filterDate: date.value || '',
    flash: FLASH[req.query.ok] ? FLASH[req.query.ok](req) : null,
    paymentLabel: PAYMENT_LABEL
  });
}));

async function loadSale(id, user) {
  const { rows } = await pool.query(
    `SELECT s.*, u.username, c.name AS customer, c.phone AS customer_phone
       FROM sales s
       LEFT JOIN users u ON u.id = s.user_id
       LEFT JOIN customers c ON c.id = s.customer_id
      WHERE s.id = $1`,
    [id]
  );
  const sale = rows[0];
  if (!sale) return { notFound: true };
  if (user.role !== 'admin' && sale.user_id !== user.id) return { forbidden: true };
  const items = await pool.query(
    `SELECT si.qty, si.price, p.brand, p.name, p.size_ml, p.sku,
            COALESCE((SELECT SUM(ri.qty)
                        FROM return_items ri
                        JOIN returns r ON r.id = ri.return_id
                       WHERE r.sale_id = $1 AND ri.product_id = si.product_id AND ri.direction = 'in'
                     ), 0)::int AS returned
       FROM sale_items si
       JOIN products p ON p.id = si.product_id
      WHERE si.sale_id = $1
      ORDER BY p.brand, p.name`,
    [id]
  );
  return { sale, items: items.rows };
}

router.get('/:id/struk', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID penjualan tidak valid', 'Alamat penjualan tidak benar.');
  const loaded = await loadSale(id, req.user);
  if (loaded.notFound) return errorPage(res, 404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');
  if (loaded.forbidden) return errorPage(res, 403, 'Akses ditolak', 'Penjualan ini milik kasir lain.');

  const phone = waPhone(loaded.sale.customer_phone);
  res.render('struk', {
    sale: loaded.sale,
    items: loaded.items,
    paymentLabel: PAYMENT_LABEL[loaded.sale.payment_method] || loaded.sale.payment_method,
    waHref: phone ? `https://wa.me/${phone}?text=${encodeURIComponent(waText(loaded.sale, loaded.items, { name: loaded.sale.customer }))}` : null
  });
}));

router.get('/:id', wrap(async (req, res) => {
  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID penjualan tidak valid', 'Alamat penjualan tidak benar.');
  const loaded = await loadSale(id, req.user);
  if (loaded.notFound) return errorPage(res, 404, 'Penjualan tidak ditemukan', 'Nomor penjualan itu tidak ada.');
  if (loaded.forbidden) return errorPage(res, 403, 'Akses ditolak', 'Penjualan ini milik kasir lain.');

  res.render('sale-detail', {
    sale: loaded.sale,
    items: loaded.items,
    isAdmin: req.user.role === 'admin',
    paymentLabel: PAYMENT_LABEL[loaded.sale.payment_method] || loaded.sale.payment_method
  });
}));

module.exports = router;
