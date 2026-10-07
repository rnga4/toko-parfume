const crypto = require('crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class DomainError extends Error {
  constructor(status, heading, message) {
    super(message);
    this.status = status;
    this.heading = heading;
  }
}

const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const key = part.slice(0, i).trim();
    if (key) out[key] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function csrfToken(req, res) {
  const existing = parseCookies(req.headers.cookie).csrf;
  if (existing && UUID.test(existing)) return existing;
  const token = crypto.randomUUID();
  res.cookie('csrf', token, { httpOnly: true, sameSite: 'strict', path: '/', secure: req.secure });
  return token;
}

function csrfOk(req) {
  const body = req.body && req.body._csrf;
  const cookie = parseCookies(req.headers.cookie).csrf;
  if (typeof body !== 'string' || typeof cookie !== 'string') return false;
  if (body.length !== cookie.length) return false;
  return crypto.timingSafeEqual(Buffer.from(body), Buffer.from(cookie));
}

function errorPage(res, status, heading, message) {
  const signedIn = Boolean(res.req && res.req.user);
  const path = res.req.path;
  let href = path === '/' ? '/products' : '/';
  let action = href === '/' ? 'Ke Dashboard' : 'Ke Daftar Produk';
  if (!signedIn) {
    href = '/login';
    action = 'Ke Halaman Masuk';
  }
  if (res.headersSent) return res.end();
  return res.status(status).render('error', { heading, message, href, action });
}

function readStr(value, max) {
  const s = typeof value === 'string' ? value.trim() : '';
  return s && s.length <= max ? s : null;
}

function readInt(value, min) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= min ? n : null;
}

module.exports = { UUID, DomainError, wrap, parseCookies, csrfToken, csrfOk, errorPage, readStr, readInt };
