const express = require('express');
const { pool } = require('../lib/db');
const { wrap, errorPage } = require('../lib/http');
const { requireAuth, requireAdmin } = require('../lib/auth');
const { parseDate } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

const JENIS = ['ringkasan', 'harian', 'bulanan', 'terlaris'];

function parseRange(query) {
  const dari = parseDate(query.dari);
  const sampai = parseDate(query.sampai);
  if (!dari.ok || !sampai.ok) return { bad: 'Format tanggal harus YYYY-MM-DD.' };
  const today = new Date().toISOString().slice(0, 10);
  const d = dari.value || today.slice(0, 8) + '01';
  const s = sampai.value || today;
  if (d > s) return { bad: 'Tanggal dari tidak boleh lewat tanggal sampai.' };
  return { d, s };
}

const PROFIT_SQL = `
  SELECT COALESCE(SUM((si.price - COALESCE(si.hpp, 0)) * si.qty), 0)::bigint AS v
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
   WHERE s.created_at::date BETWEEN $1 AND $2`;

const RETURN_PROFIT_SQL = `
  SELECT COALESCE(SUM((ri.price - COALESCE(si.hpp, p.cost_price, 0)) * ri.qty), 0)::bigint AS v
    FROM return_items ri
    JOIN returns r ON r.id = ri.return_id
    LEFT JOIN sale_items si ON si.sale_id = r.sale_id AND si.product_id = ri.product_id
    LEFT JOIN products p ON p.id = ri.product_id
   WHERE r.kind = 'return' AND r.created_at::date BETWEEN $1 AND $2`;

async function summaryData(d, s) {
  const [sales, returns, profit, retProfit] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS v
                  FROM sales WHERE created_at::date BETWEEN $1 AND $2`, [d, s]),
    pool.query(`SELECT COALESCE(SUM(subtotal_in),0)::bigint AS v
                  FROM returns WHERE kind = 'return' AND created_at::date BETWEEN $1 AND $2`, [d, s]),
    pool.query(PROFIT_SQL, [d, s]),
    pool.query(RETURN_PROFIT_SQL, [d, s])
  ]);
  const omzet = Number(sales.rows[0].v);
  const retur = Number(returns.rows[0].v);
  const laba = Number(profit.rows[0].v) - Number(retProfit.rows[0].v);
  return { transaksi: sales.rows[0].n, omzet, retur, omzetNet: omzet - retur, laba };
}

async function periodData(d, s, bucket) {
  const by = bucket === 'bulan'
    ? "to_char(date_trunc('month', created_at), 'YYYY-MM')"
    : "to_char(created_at::date, 'YYYY-MM-DD')";
  const [sales, returns, profit, retProfit] = await Promise.all([
    pool.query(`SELECT ${by} AS period, COUNT(*)::int AS n, COALESCE(SUM(total),0)::bigint AS omzet
                  FROM sales WHERE created_at::date BETWEEN $1 AND $2 GROUP BY 1 ORDER BY 1`, [d, s]),
    pool.query(`SELECT ${by} AS period, COALESCE(SUM(subtotal_in),0)::bigint AS retur
                  FROM returns WHERE kind = 'return' AND created_at::date BETWEEN $1 AND $2 GROUP BY 1`, [d, s]),
    pool.query(`SELECT to_char(s.created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM((si.price - COALESCE(si.hpp,0)) * si.qty),0)::bigint AS profit
                  FROM sale_items si JOIN sales s ON s.id = si.sale_id
                 WHERE s.created_at::date BETWEEN $1 AND $2 GROUP BY 1`, [d, s]),
    pool.query(`SELECT to_char(r.created_at::date, 'YYYY-MM-DD') AS day, COALESCE(SUM((ri.price - COALESCE(si.hpp, p.cost_price,0)) * ri.qty),0)::bigint AS profit
                  FROM return_items ri
                  JOIN returns r ON r.id = ri.return_id
                  LEFT JOIN sale_items si ON si.sale_id = r.sale_id AND si.product_id = ri.product_id
                  LEFT JOIN products p ON p.id = ri.product_id
                 WHERE r.kind = 'return' AND r.created_at::date BETWEEN $1 AND $2 GROUP BY 1`, [d, s])
  ]);
  const buckets = new Map();
  const ensure = (key) => {
    if (!buckets.has(key)) buckets.set(key, { period: key, n: 0, omzet: 0, retur: 0, laba: 0 });
    return buckets.get(key);
  };
  for (const row of sales.rows) {
    const b = ensure(row.period);
    b.n = row.n;
    b.omzet = Number(row.omzet);
  }
  for (const row of returns.rows) ensure(row.period).retur = Number(row.retur);
  const dayKey = (day) => (bucket === 'bulan' ? String(day).slice(0, 7) : String(day));
  for (const row of profit.rows) ensure(dayKey(row.day)).laba += Number(row.profit);
  for (const row of retProfit.rows) ensure(dayKey(row.day)).laba -= Number(row.profit);
  return [...buckets.values()]
    .map((b) => Object.assign(b, { omzetNet: b.omzet - b.retur }))
    .sort((a, b) => (a.period < b.period ? 1 : -1));
}

async function topProducts(d, s) {
  const { rows } = await pool.query(
    `SELECT p.sku, p.brand, p.name, p.size_ml,
            SUM(si.qty)::int AS qty, SUM(si.price * si.qty)::bigint AS omzet,
            SUM((si.price - COALESCE(si.hpp, 0)) * si.qty)::bigint AS laba
       FROM sale_items si
       JOIN sales s ON s.id = si.sale_id
       JOIN products p ON p.id = si.product_id
      WHERE s.created_at::date BETWEEN $1 AND $2
      GROUP BY p.id
      ORDER BY qty DESC, omzet DESC, p.name
      LIMIT 20`,
    [d, s]
  );
  return rows;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function sendCsv(res, filename, header, rows) {
  const body = ['﻿' + header.map(csvCell).join(',')]
    .concat(rows.map((r) => r.map(csvCell).join(',')))
    .join('\r\n') + '\r\n';
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

router.get('/', wrap(async (req, res) => {
  const range = parseRange(req.query);
  if (range.bad) return errorPage(res, 400, 'Rentang tanggal tidak valid', range.bad);
  const [summary, harian, bulanan, terlaris] = await Promise.all([
    summaryData(range.d, range.s),
    periodData(range.d, range.s, 'hari'),
    periodData(range.d, range.s, 'bulan'),
    topProducts(range.d, range.s)
  ]);
  res.render('laporan', {
    dari: range.d,
    sampai: range.s,
    summary,
    harian,
    bulanan,
    terlaris
  });
}));

router.get('/export', wrap(async (req, res) => {
  const range = parseRange(req.query);
  if (range.bad) return errorPage(res, 400, 'Rentang tanggal tidak valid', range.bad);
  const jenis = JENIS.includes(req.query.jenis) ? req.query.jenis : null;
  if (!jenis) return errorPage(res, 400, 'Jenis laporan tidak valid', 'Pilih jenis laporan yang mau diunduh.');
  const file = `laporan-${jenis}-${range.d}-${range.s}.csv`;

  if (jenis === 'ringkasan') {
    const row = await summaryData(range.d, range.s);
    return sendCsv(res, file,
      ['dari', 'sampai', 'transaksi', 'omzet', 'retur', 'omzet_bersih', 'laba_kotor'],
      [[range.d, range.s, row.transaksi, row.omzet, row.retur, row.omzetNet, row.laba]]);
  }
  if (jenis === 'harian' || jenis === 'bulanan') {
    const rows = await periodData(range.d, range.s, jenis === 'harian' ? 'hari' : 'bulan');
    return sendCsv(res, file,
      [jenis === 'harian' ? 'tanggal' : 'bulan', 'transaksi', 'omzet', 'retur', 'omzet_bersih', 'laba_kotor'],
      rows.map((r) => [r.period, r.n, r.omzet, r.retur, r.omzetNet, r.laba]));
  }
  const rows = await topProducts(range.d, range.s);
  return sendCsv(res, file,
    ['sku', 'produk', 'qty', 'omzet', 'laba_kotor'],
    rows.map((r) => [r.sku, `${r.brand} ${r.name} ${r.size_ml}ml`, r.qty, r.omzet, r.laba]));
}));

module.exports = router;
