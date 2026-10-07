const express = require('express');
const { pool } = require('./lib/db');
const { migrate } = require('./lib/migrate');
const { loadSession } = require('./lib/auth');
const { DomainError, errorPage, csrfToken } = require('./lib/http');

const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.locals.rp = (n) => 'Rp ' + Number(n).toLocaleString('id-ID');

app.use(loadSession);
app.use((req, res, next) => {
  res.locals.csrf = csrfToken(req, res);
  next();
});
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/dashboard'));
app.use('/products', require('./routes/products'));
app.use('/kasir', require('./routes/kasir'));
app.use('/sales', require('./routes/sales'));
app.use('/purchases', require('./routes/purchases'));
app.use('/suppliers', require('./routes/suppliers'));
app.use('/returns', require('./routes/returns'));
app.use('/decants', require('./routes/decants'));
app.use('/opnames', require('./routes/opnames'));
app.use('/users', require('./routes/users'));

app.use((req, res) => {
  errorPage(res, 404, 'Halaman tidak ditemukan', 'Alamat itu tidak ada di aplikasi ini.');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err instanceof DomainError) {
    return errorPage(res, err.status, err.heading, err.message);
  }
  console.error(err);
  if (err.code === '23503') {
    return errorPage(res, 409, 'Data masih dipakai data lain', 'Baris ini punya riwayat yang terhubung, jadi belum bisa dihapus.');
  }
  if (err.code === '23505') {
    return errorPage(res, 409, 'Nilai unik sudah dipakai', 'Sudah ada record dengan nilai yang sama. Pakai nilai lain.');
  }
  errorPage(res, 500, 'Permintaan gagal diproses', 'Server tidak bisa menyelesaikan permintaan ini. Coba lagi, atau cek log container parfume_app.');
});

pool.on('error', (err) => console.error('[pg]', err));

migrate()
  .then(() => {
    app.listen(3000, () => console.log('ERP parfum jalan di :3000'));
  })
  .catch((err) => {
    console.error('[startup] migrasi gagal:', err);
    process.exit(1);
  });
