const { readStr, readInt } = require('./http');

const CATEGORIES = ['EDP', 'EDT', 'Parfum', 'Body Mist', 'Decant'];
const PAYMENTS = ['cash', 'qris', 'transfer'];
const PAYMENT_LABEL = { cash: 'Tunai', qris: 'QRIS', transfer: 'Transfer' };
const ROLES = ['admin', 'kasir'];
const USERNAME = /^[a-z0-9._-]{3,50}$/i;

function parseProduct(b) {
  const errors = [];
  const sku = readStr(b.sku, 50);
  if (!sku) errors.push('SKU wajib diisi, maksimal 50 karakter.');
  const brand = readStr(b.brand, 100);
  if (!brand) errors.push('Brand wajib diisi, maksimal 100 karakter.');
  const name = readStr(b.name, 150);
  if (!name) errors.push('Nama wajib diisi, maksimal 150 karakter.');
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) errors.push('Kategori harus salah satu dari ' + CATEGORIES.join(', ') + '.');
  const size_ml = readInt(b.size_ml, 1);
  if (size_ml === null) errors.push('Ukuran harus bilangan bulat minimal 1 ml.');
  const cost_price = readInt(b.cost_price, 0);
  if (cost_price === null) errors.push('Harga beli harus bilangan bulat nol atau lebih.');
  const sell_price = readInt(b.sell_price, 0);
  if (sell_price === null) errors.push('Harga jual harus bilangan bulat nol atau lebih.');
  const stock = b.stock === undefined || b.stock === '' ? 0 : readInt(b.stock, 0);
  if (stock === null) errors.push('Stok harus bilangan bulat nol atau lebih.');
  const min_stock = b.min_stock === undefined || b.min_stock === '' ? 3 : readInt(b.min_stock, 0);
  if (min_stock === null) errors.push('Stok minimum harus bilangan bulat nol atau lebih.');
  const extra = parseProductFields(b, category, errors);
  if (errors.length) return { errors };
  return { values: [sku, brand, name, category, size_ml, cost_price, sell_price, stock, min_stock, extra.batchNo, extra.expiry, extra.parentId] };
}

function parseProductEdit(b) {
  const errors = [];
  const sku = readStr(b.sku, 50);
  if (!sku) errors.push('SKU wajib diisi, maksimal 50 karakter.');
  const brand = readStr(b.brand, 100);
  if (!brand) errors.push('Brand wajib diisi, maksimal 100 karakter.');
  const name = readStr(b.name, 150);
  if (!name) errors.push('Nama wajib diisi, maksimal 150 karakter.');
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!category) errors.push('Kategori harus salah satu dari ' + CATEGORIES.join(', ') + '.');
  const size_ml = readInt(b.size_ml, 1);
  if (size_ml === null) errors.push('Ukuran harus bilangan bulat minimal 1 ml.');
  const cost_price = readInt(b.cost_price, 0);
  if (cost_price === null) errors.push('Harga beli harus bilangan bulat nol atau lebih.');
  const sell_price = readInt(b.sell_price, 0);
  if (sell_price === null) errors.push('Harga jual harus bilangan bulat nol atau lebih.');
  const min_stock = b.min_stock === undefined || b.min_stock === '' ? 3 : readInt(b.min_stock, 0);
  if (min_stock === null) errors.push('Stok minimum harus bilangan bulat nol atau lebih.');
  const extra = parseProductFields(b, category, errors);
  if (errors.length) return { errors };
  return { values: [sku, brand, name, category, size_ml, cost_price, sell_price, min_stock, extra.batchNo, extra.expiry, extra.parentId] };
}

function parseProductFields(b, category, errors) {
  const batchNo = b.batch_no === undefined || b.batch_no === '' ? null : readStr(b.batch_no, 50);
  if (b.batch_no && b.batch_no.trim() && batchNo === null) errors.push('Nomor batch maksimal 50 karakter.');
  const expiry = parseDate(b.expiry_date);
  if (!expiry.ok) errors.push('Kedaluwarsa harus berformat YYYY-MM-DD.');
  let parentId = null;
  if (b.parent_product_id !== undefined && b.parent_product_id !== '') {
    parentId = readInt(b.parent_product_id, 1);
    if (parentId === null) errors.push('Produk induk harus dipilih dari daftar.');
    else if (category !== 'Decant') errors.push('Hanya produk kategori Decant yang boleh punya produk induk.');
  } else if (category === 'Decant') {
    errors.push('Produk kategori Decant wajib menautkan diri ke produk induknya.');
  }
  return { batchNo, expiry: expiry.value, parentId };
}

function parseDecant(b) {
  const errors = [];
  const parentId = readInt(String(b.parent_id || ''), 1);
  if (parentId === null) errors.push('Produk induk harus dipilih dari daftar.');
  const childId = readInt(String(b.child_id || ''), 1);
  if (childId === null) errors.push('Produk decant harus dipilih dari daftar.');
  const qty = parseQty(b.qty);
  if (qty === null) errors.push('Jumlah decant harus bilangan bulat minimal 1.');
  if (errors.length) return { errors };
  return { parentId, childId, qty };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === '') return [];
  return [value];
}

function parseOpnote(b) {
  return b.note === undefined || b.note === '' ? null : readStr(b.note, 500);
}

function parseSupplier(b) {
  const errors = [];
  const name = readStr(b.name, 150);
  if (!name) errors.push('Nama supplier wajib diisi, maksimal 150 karakter.');
  const phone = readStr(b.phone || '', 30);
  if (b.phone && b.phone.trim() && phone === null) errors.push('Telepon maksimal 30 karakter.');
  const address = readStr(b.address || '', 500);
  if (b.address && b.address.trim() && address === null) errors.push('Alamat maksimal 500 karakter.');
  if (errors.length) return { errors };
  return { values: [name, phone, address] };
}

function parseUser(b) {
  const errors = [];
  const usernameRaw = typeof b.username === 'string' ? b.username.trim() : '';
  if (!USERNAME.test(usernameRaw)) {
    errors.push('Username harus 3 sampai 50 karakter dan hanya boleh berisi huruf, angka, titik, strip, atau garis bawah.');
  }
  const password = typeof b.password === 'string' ? b.password : '';
  if (password.length < 8) errors.push('Kata sandi minimal 8 karakter.');
  const role = ROLES.includes(b.role) ? b.role : null;
  if (!role) errors.push('Role harus admin atau kasir.');
  if (errors.length) return { errors };
  return { username: usernameRaw, password, role };
}

function parseCheckout(b, subtotal) {
  const errors = [];
  const discount = b.discount === undefined || b.discount === '' ? 0 : readInt(b.discount, 0);
  if (discount === null) errors.push('Diskon harus bilangan bulat rupiah nol atau lebih.');
  else if (discount > subtotal) errors.push('Diskon tidak boleh melebihi subtotal.');
  const payment = PAYMENTS.includes(b.payment) ? b.payment : null;
  if (!payment) errors.push('Metode bayar harus tunai, QRIS, atau transfer.');
  if (errors.length) return { errors };
  return { discount, payment };
}

function parseQty(value) {
  return readInt(value, 1);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) return { ok: true, value: null };
  if (!DATE.test(s)) return { ok: false };
  return { ok: true, value: s };
}

module.exports = {
  CATEGORIES,
  PAYMENTS,
  PAYMENT_LABEL,
  ROLES,
  parseProduct,
  parseProductEdit,
  parseDecant,
  parseOpnote,
  asArray,
  parseSupplier,
  parseUser,
  parseCheckout,
  parseQty,
  parseDate
};
