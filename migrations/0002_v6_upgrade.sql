-- V6 Upgrade: Add received_amount to jobs, delivery_receiver fields
-- PRAGMA foreign_keys is session-level; handled at runtime in Worker

-- Add received_amount to jobs (safe: ignored if column already exists via migration guard)
ALTER TABLE jobs ADD COLUMN received_amount REAL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN delivery_receiver_name TEXT;
ALTER TABLE jobs ADD COLUMN delivery_receiver_mobile TEXT;
