-- ================================================================
-- ADITION ELECTRIC SOLUTION — v9 Migration
-- Adds: machine audio_notes, assignment_requests table
-- Safe: uses ALTER TABLE IF NOT EXISTS guards via INSERT OR IGNORE
-- ================================================================

PRAGMA foreign_keys = ON;

-- Add audio_notes column to machines (stores R2 key for audio note)
ALTER TABLE machines ADD COLUMN audio_note_key TEXT;
ALTER TABLE machines ADD COLUMN audio_note_url TEXT;

-- Assignment Request System
-- Staff can request to be assigned to a machine; Admin approves/denies
CREATE TABLE IF NOT EXISTS assignment_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id   INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  job_id       TEXT    NOT NULL REFERENCES jobs(id)     ON DELETE CASCADE,
  staff_id     INTEGER NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  status       TEXT    NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','denied')),
  note         TEXT,
  created_at   TEXT DEFAULT (datetime('now')),
  resolved_at  TEXT
);

CREATE INDEX IF NOT EXISTS idx_req_machine ON assignment_requests(machine_id);
CREATE INDEX IF NOT EXISTS idx_req_staff   ON assignment_requests(staff_id);
CREATE INDEX IF NOT EXISTS idx_req_status  ON assignment_requests(status);
