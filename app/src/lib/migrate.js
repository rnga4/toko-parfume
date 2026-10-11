const { pool } = require('./db');
const { hashPassword } = require('./auth');

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     username VARCHAR(50) UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     role VARCHAR(20) NOT NULL CHECK (role IN ('admin','kasir')),
     is_active BOOLEAN NOT NULL DEFAULT true,
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     id SERIAL PRIMARY KEY,
     token_hash TEXT UNIQUE NOT NULL,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMP NOT NULL,
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS draft_items (
     id SERIAL PRIMARY KEY,
     user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     kind VARCHAR(10) NOT NULL CHECK (kind IN ('sale','purchase')),
     product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
     qty INT NOT NULL,
     unit_price BIGINT NOT NULL DEFAULT 0,
     UNIQUE (user_id, kind, product_id)
   )`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS subtotal BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS discount BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id)`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS user_id INT REFERENCES users(id)`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS invoice_no VARCHAR(30) UNIQUE`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS parent_product_id INT REFERENCES products(id)`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS price_reseller BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS price_agen BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS price_grosir BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS qc_required BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS ml_used INT NOT NULL DEFAULT 0`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS batch_no VARCHAR(50)`,
  `ALTER TABLE products ADD COLUMN IF NOT EXISTS expiry_date DATE`,
  `ALTER TABLE draft_items DROP CONSTRAINT IF EXISTS draft_items_kind_check`,
  `ALTER TABLE draft_items ADD CONSTRAINT draft_items_kind_check CHECK (kind IN ('sale','purchase','exchange'))`,
  `CREATE TABLE IF NOT EXISTS decants (
     id SERIAL PRIMARY KEY,
     parent_product_id INT NOT NULL REFERENCES products(id),
     child_product_id INT NOT NULL REFERENCES products(id),
     qty INT NOT NULL,
     ml_each INT NOT NULL,
     ml_total INT NOT NULL,
     bottles_consumed INT NOT NULL DEFAULT 0,
     user_id INT REFERENCES users(id),
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS returns (
     id SERIAL PRIMARY KEY,
     return_no VARCHAR(30) UNIQUE NOT NULL,
     sale_id INT NOT NULL REFERENCES sales(id),
     user_id INT REFERENCES users(id),
     kind VARCHAR(20) NOT NULL CHECK (kind IN ('return','exchange')),
     subtotal_in BIGINT NOT NULL DEFAULT 0,
     subtotal_out BIGINT NOT NULL DEFAULT 0,
     net_amount BIGINT NOT NULL DEFAULT 0,
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS return_items (
     id SERIAL PRIMARY KEY,
     return_id INT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
     product_id INT NOT NULL REFERENCES products(id),
     qty INT NOT NULL,
     price BIGINT NOT NULL,
     direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out'))
   )`,
  `CREATE TABLE IF NOT EXISTS stock_opnames (
     id SERIAL PRIMARY KEY,
     opname_no VARCHAR(30) UNIQUE NOT NULL,
     note TEXT,
     user_id INT REFERENCES users(id),
     status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
     created_at TIMESTAMP DEFAULT NOW(),
     finished_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS stock_opname_items (
     id SERIAL PRIMARY KEY,
     opname_id INT NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
     product_id INT NOT NULL REFERENCES products(id),
     system_qty INT NOT NULL DEFAULT 0,
     counted_qty INT,
     UNIQUE (opname_id, product_id)
   )`,
  `ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS hpp BIGINT`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_id INT REFERENCES customers(id)`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS due_date DATE`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS payment_method VARCHAR(30) NOT NULL DEFAULT 'cash'`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS due_date DATE`,
  `ALTER TABLE purchases ADD COLUMN IF NOT EXISTS paid_at TIMESTAMP`,
  `UPDATE sale_items si SET hpp = p.cost_price FROM products p WHERE p.id = si.product_id AND si.hpp IS NULL`,
  `UPDATE sales SET paid_at = created_at WHERE paid_at IS NULL AND payment_method <> 'tempo'`,
  `UPDATE purchases SET paid_at = created_at WHERE paid_at IS NULL AND payment_method <> 'tempo'`,
  `CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_draft_items_owner ON draft_items (user_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements (product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns (sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decants_parent ON decants (parent_product_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_opnames_one_open ON stock_opnames (status) WHERE status = 'open'`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
  `ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin','kasir','gudang','produksi','qc','sales','finance','owner'))`,
  `ALTER TABLE draft_items ADD COLUMN IF NOT EXISTS batch_no VARCHAR(50)`,
  `ALTER TABLE draft_items ADD COLUMN IF NOT EXISTS expiry_date DATE`,
  `ALTER TABLE sales ADD COLUMN IF NOT EXISTS tier VARCHAR(20) NOT NULL DEFAULT 'retail'`,
  `CREATE TABLE IF NOT EXISTS product_lots (
     id SERIAL PRIMARY KEY,
     product_id INT NOT NULL REFERENCES products(id),
     batch_no VARCHAR(50),
     expiry_date DATE,
     qty INT NOT NULL DEFAULT 0,
     qc_status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (qc_status IN ('pending','pass','reject')),
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_product_lots_product ON product_lots (product_id)`,
  `ALTER TABLE product_lots ADD COLUMN IF NOT EXISTS qc_note TEXT`,
  `CREATE TABLE IF NOT EXISTS sale_item_lots (
     id SERIAL PRIMARY KEY,
     sale_item_id INT NOT NULL REFERENCES sale_items(id) ON DELETE CASCADE,
     lot_id INT NOT NULL REFERENCES product_lots(id),
     qty INT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sale_item_lots_item ON sale_item_lots (sale_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sale_item_lots_lot ON sale_item_lots (lot_id)`,
  `CREATE TABLE IF NOT EXISTS formulas (
     id SERIAL PRIMARY KEY,
     name VARCHAR(150) NOT NULL,
     target_product_id INT NOT NULL REFERENCES products(id),
     version INT NOT NULL DEFAULT 1,
     is_active BOOLEAN NOT NULL DEFAULT true,
     notes TEXT,
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE TABLE IF NOT EXISTS formula_items (
     id SERIAL PRIMARY KEY,
     formula_id INT NOT NULL REFERENCES formulas(id) ON DELETE CASCADE,
     material_id INT NOT NULL REFERENCES products(id),
     pct NUMERIC(6,3) NOT NULL CHECK (pct > 0),
     UNIQUE (formula_id, material_id)
   )`,
  `CREATE TABLE IF NOT EXISTS work_orders (
     id SERIAL PRIMARY KEY,
     wo_no VARCHAR(30) UNIQUE NOT NULL,
     formula_id INT NOT NULL REFERENCES formulas(id),
     target_qty INT NOT NULL CHECK (target_qty > 0),
     status VARCHAR(20) NOT NULL DEFAULT 'draft'
       CHECK (status IN ('draft','racik','maserasi','filling','done','batal')),
     output_batch VARCHAR(50),
     output_expiry DATE,
     maserasi_start DATE,
     maserasi_end_est DATE,
     note TEXT,
     user_id INT REFERENCES users(id),
     created_at TIMESTAMP DEFAULT NOW(),
     updated_at TIMESTAMP DEFAULT NOW(),
     finished_at TIMESTAMP
   )`,
  `CREATE TABLE IF NOT EXISTS work_order_materials (
     id SERIAL PRIMARY KEY,
     work_order_id INT NOT NULL REFERENCES work_orders(id) ON DELETE CASCADE,
     material_id INT NOT NULL REFERENCES products(id),
     required_qty INT NOT NULL DEFAULT 0,
     consumed_qty INT NOT NULL DEFAULT 0,
     lots_used JSONB
   )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
     id SERIAL PRIMARY KEY,
     user_id INT REFERENCES users(id),
     action VARCHAR(50) NOT NULL,
     entity VARCHAR(50) NOT NULL,
     entity_id INT,
     detail TEXT,
     created_at TIMESTAMP DEFAULT NOW()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log (created_at DESC)`,
  `INSERT INTO product_lots (product_id, batch_no, expiry_date, qty)
   SELECT p.id, p.batch_no, p.expiry_date, p.stock FROM products p
    WHERE p.stock > 0 AND NOT EXISTS (SELECT 1 FROM product_lots pl WHERE pl.product_id = p.id)`
];

const DEFAULT_ADMIN = { username: 'admin', password: 'admin123' };

async function migrate() {
  for (const sql of DDL) await pool.query(sql);

  await pool.query('DELETE FROM sessions WHERE expires_at < NOW()');

  const { rows } = await pool.query('SELECT COUNT(*)::int AS c FROM users');
  if (rows[0].c === 0) {
    await pool.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'admin')`,
      [DEFAULT_ADMIN.username, await hashPassword(DEFAULT_ADMIN.password)]
    );
    console.warn(`[migrate] dibuat akun admin awal: ${DEFAULT_ADMIN.username} / ${DEFAULT_ADMIN.password}. Ganti kata sandinya sesegera mungkin.`);
  }

  console.log('[migrate] skema siap');
}

module.exports = { migrate };
