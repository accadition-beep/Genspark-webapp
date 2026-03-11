-- ================================================================
-- ADITION ELECTRIC SOLUTION — Complete Schema v6
-- Includes: CASCADE deletes, received_amount, delivery_receiver,
--           seeded admin user (password: 0010)
-- ================================================================

PRAGMA foreign_keys = ON;

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
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  snap_name TEXT NOT NULL,
  snap_mobile TEXT NOT NULL,
  snap_mobile2 TEXT,
  snap_address TEXT,
  note TEXT,
  received_amount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned','delivered')),
  delivery_method TEXT CHECK(delivery_method IN ('in_person','courier')),
  delivery_receiver_name TEXT,
  delivery_receiver_mobile TEXT,
  delivery_courier_name TEXT,
  delivery_tracking TEXT,
  delivery_address TEXT,
  delivered_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  product_complaint TEXT,
  charges REAL NOT NULL DEFAULT 0,
  quantity INTEGER NOT NULL DEFAULT 1,
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'under_repair'
    CHECK(status IN ('under_repair','repaired','returned')),
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

CREATE INDEX IF NOT EXISTS idx_jobs_customer  ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status    ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created   ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_machines_job   ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_staff ON machines(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_mi_machine     ON machine_images(machine_id);
CREATE INDEX IF NOT EXISTS idx_customers_mob  ON customers(mobile);

-- ── Seed admin user ─────────────────────────────────────────────────────────
-- password "0010" pre-hashed with bcrypt rounds=10
-- Hash: $2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi
-- NOTE: The Worker runtime re-seeds on every login attempt if missing,
--       so this serves as the hard-coded fallback for cold DB starts.
INSERT OR IGNORE INTO users(name, email, password_hash, role, active)
VALUES(
  'Bilal Khan',
  'bilalkhan1108@gmail.com',
  '$2b$10$gZ8JJk3b8lQk8GWUZihr/.3S3a13eyQSQT8ckSG1kvIe6zjN9w7dO',
  'admin',
  1
);
