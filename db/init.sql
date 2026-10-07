CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin','kasir')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sessions (
  id SERIAL PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(50) UNIQUE NOT NULL,
  brand VARCHAR(100) NOT NULL,
  name VARCHAR(150) NOT NULL,
  category VARCHAR(50) DEFAULT 'EDP',
  size_ml INT NOT NULL,
  cost_price BIGINT NOT NULL DEFAULT 0,
  sell_price BIGINT NOT NULL DEFAULT 0,
  stock INT NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT true,
  parent_product_id INT REFERENCES products(id),
  ml_used INT NOT NULL DEFAULT 0,
  batch_no VARCHAR(50),
  expiry_date DATE,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30),
  address TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name VARCHAR(150) NOT NULL,
  phone VARCHAR(30),
  address TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(30) UNIQUE NOT NULL,
  customer_id INT REFERENCES customers(id),
  user_id INT REFERENCES users(id),
  subtotal BIGINT NOT NULL DEFAULT 0,
  discount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  payment_method VARCHAR(30) DEFAULT 'cash',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE sale_items (
  id SERIAL PRIMARY KEY,
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty INT NOT NULL,
  price BIGINT NOT NULL
);

CREATE TABLE purchases (
  id SERIAL PRIMARY KEY,
  invoice_no VARCHAR(30) UNIQUE,
  supplier_id INT REFERENCES suppliers(id),
  user_id INT REFERENCES users(id),
  total BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE purchase_items (
  id SERIAL PRIMARY KEY,
  purchase_id INT NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty INT NOT NULL,
  cost BIGINT NOT NULL
);

CREATE TABLE stock_movements (
  id SERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  change INT NOT NULL,
  reason VARCHAR(50) NOT NULL,
  ref_id INT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE draft_items (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind VARCHAR(10) NOT NULL CHECK (kind IN ('sale','purchase')),
  product_id INT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  qty INT NOT NULL,
  unit_price BIGINT NOT NULL DEFAULT 0,
  UNIQUE (user_id, kind, product_id)
);

CREATE TABLE decants (
  id SERIAL PRIMARY KEY,
  parent_product_id INT NOT NULL REFERENCES products(id),
  child_product_id INT NOT NULL REFERENCES products(id),
  qty INT NOT NULL,
  ml_each INT NOT NULL,
  ml_total INT NOT NULL,
  bottles_consumed INT NOT NULL DEFAULT 0,
  user_id INT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE returns (
  id SERIAL PRIMARY KEY,
  return_no VARCHAR(30) UNIQUE NOT NULL,
  sale_id INT NOT NULL REFERENCES sales(id),
  user_id INT REFERENCES users(id),
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('return','exchange')),
  subtotal_in BIGINT NOT NULL DEFAULT 0,
  subtotal_out BIGINT NOT NULL DEFAULT 0,
  net_amount BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE return_items (
  id SERIAL PRIMARY KEY,
  return_id INT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty INT NOT NULL,
  price BIGINT NOT NULL,
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in','out'))
);

CREATE TABLE stock_opnames (
  id SERIAL PRIMARY KEY,
  opname_no VARCHAR(30) UNIQUE NOT NULL,
  note TEXT,
  user_id INT REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  created_at TIMESTAMP DEFAULT NOW(),
  finished_at TIMESTAMP
);

CREATE TABLE stock_opname_items (
  id SERIAL PRIMARY KEY,
  opname_id INT NOT NULL REFERENCES stock_opnames(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  system_qty INT NOT NULL DEFAULT 0,
  counted_qty INT,
  UNIQUE (opname_id, product_id)
);

CREATE INDEX idx_sales_created_at ON sales (created_at);
CREATE INDEX idx_sessions_expires_at ON sessions (expires_at);
CREATE INDEX idx_draft_items_owner ON draft_items (user_id, kind);
CREATE INDEX idx_stock_movements_product ON stock_movements (product_id);
CREATE INDEX idx_returns_sale ON returns (sale_id);
CREATE INDEX idx_decants_parent ON decants (parent_product_id);
CREATE UNIQUE INDEX idx_stock_opnames_one_open ON stock_opnames (status) WHERE status = 'open';

ALTER TABLE draft_items DROP CONSTRAINT IF EXISTS draft_items_kind_check;
ALTER TABLE draft_items ADD CONSTRAINT draft_items_kind_check CHECK (kind IN ('sale','purchase','exchange'));

INSERT INTO products (sku, brand, name, category, size_ml, cost_price, sell_price, stock, min_stock) VALUES
('DIOR-SAU-100', 'Dior', 'Sauvage', 'EDP', 100, 1500000, 1900000, 5, 2),
('YSL-LIB-90', 'YSL', 'Libre', 'EDP', 90, 1700000, 2150000, 2, 3);
