const express = require('express');
const { pool } = require('../lib/db');
const { wrap, csrfOk, errorPage, readInt } = require('../lib/http');
const { requireAuth, requireAdmin, hashPassword } = require('../lib/auth');
const { ROLES, parseUser } = require('../lib/validate');

const router = express.Router();

router.use(requireAuth, requireAdmin);

async function activeAdminsExcept(client, exceptId) {
  const { rows } = await client.query(
    'SELECT COUNT(*)::int AS c FROM users WHERE role = $1 AND is_active AND id <> $2',
    ['admin', exceptId]
  );
  return rows[0].c;
}

async function renderUsers(req, res, extra, status) {
  const users = await pool.query(
    "SELECT id, username, role, is_active, created_at FROM users ORDER BY role DESC, username"
  );
  if (status) res.status(status);
  res.render('users', Object.assign({
    users: users.rows,
    roles: ROLES,
    error: null,
    flash: null
  }, extra));
}

router.get('/', wrap(async (req, res) => {
  await renderUsers(req, res, { flash: req.query.ok === 'created' ? 'Akun baru dibuat.' : null });
}));

router.post('/', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Akun, lalu isi form lagi.');

  const parsed = parseUser(req.body);
  if (parsed.errors) return renderUsers(req, res, { error: parsed.errors.join(' ') }, 400);

  const exists = await pool.query('SELECT 1 FROM users WHERE username = $1', [parsed.username]);
  if (exists.rows.length) {
    return renderUsers(req, res, { error: `Username ${parsed.username} sudah dipakai akun lain.` }, 409);
  }

  await pool.query(
    'INSERT INTO users (username, password_hash, role) VALUES ($1,$2,$3)',
    [parsed.username, await hashPassword(parsed.password), parsed.role]
  );
  res.redirect('/users?ok=created');
}));

router.post('/:id/role', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Akun, lalu coba lagi.');

  const id = readInt(String(req.params.id), 1);
  const role = ROLES.includes(req.body.role) ? req.body.role : null;
  if (id === null || !role) return errorPage(res, 400, 'Data tidak valid', 'Role harus admin atau kasir.');

  if (id === req.user.id) {
    return renderUsers(req, res, { error: 'Role sendiri tidak bisa diubah dari halaman ini. Mintah admin lain yang mengubah.' }, 400);
  }

  const target = await pool.query('SELECT id, role FROM users WHERE id = $1', [id]);
  if (!target.rows[0]) return errorPage(res, 404, 'Akun tidak ditemukan', 'Akun itu sudah tidak ada.');

  if (target.rows[0].role === 'admin' && role !== 'admin') {
    const remaining = await activeAdminsExcept(pool, id);
    if (remaining === 0) {
      return renderUsers(req, res, { error: 'Tidak ada admin lain yang aktif, jadi akun ini tetap harus admin.' }, 409);
    }
  }

  await pool.query('UPDATE users SET role = $1 WHERE id = $2', [role, id]);
  res.redirect('/users');
}));

router.post('/:id/password', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Akun, lalu coba lagi.');

  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID akun tidak valid', 'Alamat permintaan tidak benar.');

  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (password.length < 8) {
    return renderUsers(req, res, { error: 'Kata sandi baru minimal 8 karakter.' }, 400);
  }

  const target = await pool.query('SELECT id FROM users WHERE id = $1', [id]);
  if (!target.rows[0]) return errorPage(res, 404, 'Akun tidak ditemukan', 'Akun itu sudah tidak ada.');

  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(password), id]);
  await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.redirect('/users');
}));

router.post('/:id/toggle', wrap(async (req, res) => {
  if (!csrfOk(req)) return errorPage(res, 403, 'Token keamanan tidak cocok', 'Muat ulang halaman Akun, lalu coba lagi.');

  const id = readInt(String(req.params.id), 1);
  if (id === null) return errorPage(res, 400, 'ID akun tidak valid', 'Alamat permintaan tidak benar.');
  if (id === req.user.id) {
    return renderUsers(req, res, { error: 'Akun sendiri tidak bisa dinonaktifkan dari halaman ini.' }, 400);
  }

  const target = await pool.query('SELECT id, role, is_active FROM users WHERE id = $1', [id]);
  const user = target.rows[0];
  if (!user) return errorPage(res, 404, 'Akun tidak ditemukan', 'Akun itu sudah tidak ada.');

  if (user.is_active && user.role === 'admin') {
    const remaining = await activeAdminsExcept(pool, id);
    if (remaining === 0) {
      return renderUsers(req, res, { error: 'Ini admin terakhir yang aktif, jadi tidak boleh dinonaktifkan.' }, 409);
    }
  }

  await pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [id]);
  if (user.is_active) await pool.query('DELETE FROM sessions WHERE user_id = $1', [id]);
  res.redirect('/users');
}));

module.exports = router;
