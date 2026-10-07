const crypto = require('crypto');
const { promisify } = require('util');
const { pool } = require('./db');
const { parseCookies, errorPage } = require('./http');

const scrypt = promisify(crypto.scrypt);
const SESSION_HOURS = 12;
const COOKIE = 'sid';

async function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(plain, salt, 64);
  return `${salt}:${derived.toString('hex')}`;
}

async function verifyPassword(plain, stored) {
  if (typeof stored !== 'string') return false;
  const i = stored.indexOf(':');
  if (i < 0) return false;
  const salt = stored.slice(0, i);
  const expected = Buffer.from(stored.slice(i + 1), 'hex');
  const derived = await scrypt(plain, salt, 64);
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const maxAge = SESSION_HOURS * 60 * 60 * 1000;
  await pool.query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, NOW() + ($3 || \' hours\')::interval)',
    [sha256(token), userId, SESSION_HOURS]
  );
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: req.secure,
    maxAge
  });
}

async function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'strict', path: '/' });
}

async function loadSession(req, res, next) {
  res.locals.user = null;
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return next();
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.username, u.role
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.is_active`,
      [sha256(token)]
    );
    if (rows[0]) {
      req.user = rows[0];
      res.locals.user = rows[0];
    }
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return errorPage(res, 403, 'Akses ditolak', 'Halaman ini hanya untuk akun admin.');
  }
  next();
}

module.exports = {
  SESSION_HOURS,
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  loadSession,
  requireAuth,
  requireAdmin
};
