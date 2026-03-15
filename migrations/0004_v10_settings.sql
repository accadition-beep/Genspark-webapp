-- ================================================================
-- ADITION ELECTRIC SOLUTION — v10 Migration
-- Adds: app_settings table for job number prefix/sequence config
-- ================================================================

PRAGMA foreign_keys = ON;

-- App settings table
CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default prefix setting
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('job_prefix', 'C');
INSERT OR IGNORE INTO app_settings(key, value) VALUES ('job_seq_digits', '3');
