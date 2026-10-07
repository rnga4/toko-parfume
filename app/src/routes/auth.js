const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, errorPage } = require('../lib/http');
const { verifyPassword, createSession, destroySession } = require('../lib/auth');

const router = express.Router();

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map();

function throttled(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, list);
  return list.length >= MAX_ATTEMPTS;
}

function recordFailure(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  attempts.set(key, list);
}

router.get('/login', wrap(async (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { error: null, username: '' });
}));

router.post('/login', wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman masuk, lalu isi form lagi.');
  }
  const username = typeof req.body.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const ip = req.ip || 'unknown';
  const key = `${ip}|${username.toLowerCase()}`;

  const retry = () => res.render('login', {
    error: 'Username atau kata sandi salah.',
    username
  });

  if (throttled(key)) {
    return res.status(429).render('login', {
      error: 'Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit.',
      username
    });
  }

  const { rows } = await pool.query(
    'SELECT id, password_hash, is_active FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  const ok = user && user.is_active && await verifyPassword(password, user.password_hash);

  if (!ok) {
    recordFailure(key);
    return retry();
  }

  attempts.delete(key);
  await createSession(req, res, user.id);
  res.redirect('/');
}));

router.post('/logout', wrap(async (req, res) => {
  if (!csrfOk(req)) {
    return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman, lalu coba keluar lagi.');
  }
  await destroySession(req, res);
  res.redirect('/login');
}));

module.exports = router;
