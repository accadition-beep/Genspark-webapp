-- ADITION ELECTRIC SOLUTION - D1 Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK(role IN ('admin','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  mobile TEXT UNIQUE NOT NULL,
  mobile2 TEXT,
  address TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS job_counter (
  id INTEGER PRIMARY KEY CHECK(id=1),
  last_seq INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO job_counter(id, last_seq) VALUES(1, 0);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  snap_name TEXT NOT NULL,
  snap_mobile TEXT NOT NULL,
  snap_mobile2 TEXT,
  snap_address TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'under_repair' CHECK(status IN ('under_repair','repaired','returned','delivered')),
  delivery_method TEXT CHECK(delivery_method IN ('in_person','courier')),
  delivery_courier_name TEXT,
  delivery_tracking TEXT,
  delivery_address TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  product_name TEXT NOT NULL,
  product_complaint TEXT,
  charges REAL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  assigned_staff_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'under_repair' CHECK(status IN ('under_repair','repaired','returned')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machine_images (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  r2_object_key TEXT,
  url TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_jobs_customer ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_machines_job ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_staff ON machines(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_machine_images_machine ON machine_images(machine_id);
CREATE INDEX IF NOT EXISTS idx_customers_mobile ON customers(mobile);

-- Seed admin user (password: 0010 hashed with bcrypt)
-- We'll handle seeding at runtime in the Worker on first startup
