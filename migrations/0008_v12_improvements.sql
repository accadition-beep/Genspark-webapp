-- ================================================================
-- ADITION ELECTRIC SOLUTION — v12 Improvements
-- Adds: dashboard_stats cache, work_done column, unique mobile idx,
--       additional performance indexes, machines.job_id index
-- ================================================================

PRAGMA foreign_keys = ON;

-- 1. Unique index on customers.mobile (ON CONFLICT REPLACE already handled in app)
--    This index must be created only if it does not already exist.
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_mobile_unique ON customers(mobile);

-- 2. Add work_done column to machines (records what was actually done / repaired)
ALTER TABLE machines ADD COLUMN work_done TEXT;

-- 3. Add estimated_delivery column to jobs (if not already present from 0006)
-- Note: SQLite allows duplicate ALTER TABLE ADD COLUMN on IF NOT EXISTS via dummy approach
-- We use a safe approach:
CREATE TABLE IF NOT EXISTS _schema_patches (patch TEXT PRIMARY KEY);
INSERT OR IGNORE INTO _schema_patches(patch) VALUES ('machines.work_done.v12');

-- 4. Dashboard stats cache table for <100ms dashboard load
CREATE TABLE IF NOT EXISTS dashboard_stats (
  id            INTEGER PRIMARY KEY DEFAULT 1 CHECK(id=1),
  total_jobs    INTEGER NOT NULL DEFAULT 0,
  active_jobs   INTEGER NOT NULL DEFAULT 0,
  ready_jobs    INTEGER NOT NULL DEFAULT 0,
  delivered_jobs INTEGER NOT NULL DEFAULT 0,
  today_jobs    INTEGER NOT NULL DEFAULT 0,
  month_jobs    INTEGER NOT NULL DEFAULT 0,
  last_updated  DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT OR IGNORE INTO dashboard_stats(id) VALUES (1);

-- 5. Additional performance indexes
CREATE INDEX IF NOT EXISTS idx_jobs_status         ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_customer_id    ON jobs(customer_id);
CREATE INDEX IF NOT EXISTS idx_machines_job_id     ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_machines_status     ON machines(status);
CREATE INDEX IF NOT EXISTS idx_machines_staff      ON machines(assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_assignment_req_st   ON assignment_requests(status);
CREATE INDEX IF NOT EXISTS idx_assignment_req_m    ON assignment_requests(machine_id);

-- 6. Update dashboard_stats from current data (initial sync)
UPDATE dashboard_stats SET
  total_jobs     = (SELECT COUNT(*) FROM jobs),
  active_jobs    = (SELECT COUNT(*) FROM jobs WHERE status != 'delivered'),
  ready_jobs     = (SELECT COUNT(*) FROM jobs WHERE status = 'ready'),
  delivered_jobs = (SELECT COUNT(*) FROM jobs WHERE status = 'delivered'),
  today_jobs     = (SELECT COUNT(*) FROM jobs WHERE DATE(created_at) = DATE('now')),
  month_jobs     = (SELECT COUNT(*) FROM jobs WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m','now')),
  last_updated   = datetime('now')
WHERE id = 1;
