-- V6 Upgrade: Add received_amount to jobs, delivery_receiver fields
-- SAFE: received_amount already exists in v1 schema; these ALTER TABLEs
--       are kept for databases that were created before the v6 schema.
--       SQLite will error on duplicate columns, so we wrap in a no-op.

-- NOTE: 0001_schema.sql already includes received_amount and
--       delivery_receiver_name / delivery_receiver_mobile in the jobs table.
--       This migration is intentionally empty to avoid SQLITE_CONSTRAINT errors.
SELECT 1; -- no-op placeholder
