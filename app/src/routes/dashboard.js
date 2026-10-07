const express = require('express');
const { pool } = require('../lib/db');
const { wrap } = require('../lib/http');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

router.use(requireAuth);

router.get('/', wrap(async (req, res) => {
  const [p, low, s, exp] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS c FROM products WHERE is_active'),
    pool.query('SELECT * FROM products WHERE is_active AND stock <= min_stock ORDER BY stock'),
    pool.query("SELECT COALESCE(SUM(total),0)::bigint AS t FROM sales WHERE created_at::date = CURRENT_DATE"),
    pool.query(
      `SELECT sku, brand, name, size_ml, stock, to_char(expiry_date, 'YYYY-MM-DD') AS expiry_str,
              (expiry_date <= CURRENT_DATE) AS is_expired
         FROM products
        WHERE is_active AND expiry_date IS NOT NULL AND expiry_date <= CURRENT_DATE + 30
        ORDER BY expiry_date, brand, name`
    )
  ]);
  res.render('dashboard', {
    totalProduk: p.rows[0].c,
    lowStock: low.rows,
    omzet: s.rows[0].t,
    expiring: exp.rows
  });
}));

module.exports = router;
