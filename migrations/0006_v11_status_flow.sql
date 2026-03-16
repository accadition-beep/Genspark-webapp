-- ================================================================
-- AES v11 — Extended Repair Status Flow
-- New statuses: received, diagnosing, in_progress, waiting_parts, ready
-- Jobs: new statuses mirroring machines
-- ================================================================

-- Add brand column to machines for better categorization
ALTER TABLE machines ADD COLUMN brand TEXT;

-- Add estimated_delivery column to jobs
ALTER TABLE jobs ADD COLUMN estimated_delivery TEXT;

-- Recreate CHECK constraints by rebuilding tables is not possible in SQLite
-- Instead we track status as TEXT without CHECK and validate in app layer
-- The status flow is: received → diagnosing → in_progress → waiting_parts → ready → delivered

-- New indexes for performance
CREATE INDEX IF NOT EXISTS idx_jobs_updated ON jobs(updated_at);
CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status);
