-- ================================================================
-- AES v11 — Fix Status Constraints (SQLite CHECK constraint)
-- Rebuild machines and jobs tables to remove old CHECK constraints
-- that only allowed 'under_repair','repaired','returned'
-- New statuses: received, diagnosing, in_progress, waiting_parts, ready, returned, delivered
-- ================================================================

-- Rebuild machines table without old CHECK constraint
CREATE TABLE IF NOT EXISTS machines_new (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id            TEXT    NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  product_name      TEXT    NOT NULL,
  product_complaint TEXT,
  charges           REAL    NOT NULL DEFAULT 0,
  quantity          INTEGER NOT NULL DEFAULT 1,
  assigned_staff_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status            TEXT    NOT NULL DEFAULT 'received',
  brand             TEXT,
  created_at        TEXT    DEFAULT (datetime('now')),
  updated_at        TEXT    DEFAULT (datetime('now')),
  audio_note_key    TEXT,
  audio_note_url    TEXT
);

INSERT INTO machines_new
  SELECT id, job_id, product_name, product_complaint, charges, quantity,
         assigned_staff_id,
         CASE status
           WHEN 'under_repair' THEN 'in_progress'
           WHEN 'repaired'     THEN 'ready'
           WHEN 'returned'     THEN 'returned'
           ELSE status
         END,
         brand, created_at, updated_at, audio_note_key, audio_note_url
  FROM machines;

DROP TABLE machines;
ALTER TABLE machines_new RENAME TO machines;

-- Rebuild indexes for machines
CREATE INDEX IF NOT EXISTS idx_machines_job_id    ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_staff_id  ON machines(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_machines_status    ON machines(status);

-- Rebuild jobs table without old CHECK constraint
CREATE TABLE IF NOT EXISTS jobs_new (
  id                         TEXT    PRIMARY KEY,
  customer_id                INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  snap_name                  TEXT,
  snap_mobile                TEXT,
  snap_mobile2               TEXT,
  snap_address               TEXT,
  note                       TEXT,
  received_amount            REAL    DEFAULT 0,
  status                     TEXT    NOT NULL DEFAULT 'received',
  estimated_delivery         TEXT,
  delivery_method            TEXT,
  delivery_receiver_name     TEXT,
  delivery_receiver_mobile   TEXT,
  delivery_courier_name      TEXT,
  delivery_tracking          TEXT,
  delivery_address           TEXT,
  delivered_at               TEXT,
  created_at                 TEXT    DEFAULT (datetime('now')),
  updated_at                 TEXT    DEFAULT (datetime('now'))
);

INSERT INTO jobs_new
  SELECT id, customer_id, snap_name, snap_mobile, snap_mobile2, snap_address,
         note, received_amount,
         CASE status
           WHEN 'under_repair' THEN 'in_progress'
           WHEN 'repaired'     THEN 'ready'
           WHEN 'returned'     THEN 'returned'
           WHEN 'delivered'    THEN 'delivered'
           ELSE status
         END,
         estimated_delivery, delivery_method, delivery_receiver_name,
         delivery_receiver_mobile, delivery_courier_name, delivery_tracking,
         delivery_address, delivered_at, created_at, updated_at
  FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;

-- Rebuild indexes for jobs
CREATE INDEX IF NOT EXISTS idx_jobs_customer   ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created    ON jobs(created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_updated    ON jobs(updated_at);
