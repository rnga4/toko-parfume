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
  `CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_draft_items_owner ON draft_items (user_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements (product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_returns_sale ON returns (sale_id)`,
  `CREATE INDEX IF NOT EXISTS idx_decants_parent ON decants (parent_product_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_stock_opnames_one_open ON stock_opnames (status) WHERE status = 'open'`
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
