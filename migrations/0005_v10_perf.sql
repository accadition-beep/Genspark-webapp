-- ================================================================
-- ADITION ELECTRIC SOLUTION — v10 Performance & Feature Migration
-- Adds: performance indexes, app_settings, CORS headers for images
-- ================================================================

PRAGMA foreign_keys = ON;

-- Performance indexes (IF NOT EXISTS = safe to re-run)
CREATE INDEX IF NOT EXISTS idx_jobs_id       ON jobs(id);
CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_updated  ON jobs(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_machines_job  ON machines(job_id);
CREATE INDEX IF NOT EXISTS idx_customers_mob ON customers(mobile);

-- App settings table (for job prefix config)
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('job_prefix', 'C');
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('job_seq_digits', '3');
