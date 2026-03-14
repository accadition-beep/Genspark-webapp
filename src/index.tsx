import { Hono } from 'hono'
import { cors } from 'hono/cors'
import authRoutes     from './routes/auth'
import jobRoutes      from './routes/jobs'
import adminRoutes    from './routes/admin'
import customerRoutes from './routes/customers'
import analyticsRoutes from './routes/analytics'

type Bindings = { DB: D1Database; JWT_SECRET: string }
const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Offline-Ts'] }))

// ── DB initialisation — v12.0 schema ─────────────────────────────────────────
export async function initDB(db: D1Database) {
  const creates = [
    // Core tables
    `CREATE TABLE IF NOT EXISTS job_sequence (
       id INTEGER PRIMARY KEY CHECK (id=1),
       current_val INTEGER NOT NULL DEFAULT 0
     )`,
    `INSERT OR IGNORE INTO job_sequence (id, current_val) VALUES (1, 0)`,
    `CREATE TABLE IF NOT EXISTS jobs (
       id               INTEGER  PRIMARY KEY AUTOINCREMENT,
       job_id           TEXT     UNIQUE NOT NULL,
       customer_name    TEXT     NOT NULL,
       customer_mobile  TEXT,
       customer_address TEXT,
       notes            TEXT,
       amount_received  REAL     DEFAULT 0,
       deleted_at       DATETIME,
       created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS machines (
       id             INTEGER  PRIMARY KEY AUTOINCREMENT,
       job_id         TEXT     NOT NULL,
       description    TEXT     NOT NULL,
       condition_text TEXT,
       image_data     TEXT,
       quantity       INTEGER  DEFAULT 1,
       unit_price     REAL     DEFAULT 0,
       status         TEXT     DEFAULT 'Under Repair',
       assigned_to    TEXT,
       work_done      TEXT,
       return_reason  TEXT,
       delivery_info  TEXT,
       delivered_at   DATETIME,
       audio_note     TEXT,
       priority_flag  INTEGER  DEFAULT 0,
       deleted_at     DATETIME,
       created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
       updated_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE
     )`,
    `CREATE TABLE IF NOT EXISTS machine_images (
       id         INTEGER  PRIMARY KEY AUTOINCREMENT,
       machine_id INTEGER  NOT NULL,
       image_data TEXT     NOT NULL,
       caption    TEXT,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
     )`,
    `CREATE TABLE IF NOT EXISTS machine_timeline (
       id          INTEGER  PRIMARY KEY AUTOINCREMENT,
       machine_id  INTEGER  NOT NULL,
       job_id      TEXT     NOT NULL,
       event_type  TEXT     NOT NULL,
       event_note  TEXT,
       actor       TEXT,
       created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
       FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
     )`,
    `CREATE TABLE IF NOT EXISTS customer_profiles (
       id         INTEGER  PRIMARY KEY AUTOINCREMENT,
       name       TEXT     NOT NULL,
       mobile     TEXT     UNIQUE NOT NULL,
       address    TEXT,
       job_count  INTEGER  DEFAULT 1,
       last_seen  DATETIME DEFAULT CURRENT_TIMESTAMP,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS job_summary (
       job_id          TEXT    PRIMARY KEY,
       total_machines  INTEGER DEFAULT 0,
       repaired_count  INTEGER DEFAULT 0,
       returned_count  INTEGER DEFAULT 0,
       pending_count   INTEGER DEFAULT 0,
       delivered_count INTEGER DEFAULT 0,
       last_updated    DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS monthly_backups (
       id          INTEGER  PRIMARY KEY AUTOINCREMENT,
       backup_key  TEXT     UNIQUE NOT NULL,
       record_count INTEGER DEFAULT 0,
       created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    `CREATE TABLE IF NOT EXISTS trash_items (
       id          INTEGER  PRIMARY KEY AUTOINCREMENT,
       item_type   TEXT     NOT NULL,
       item_id     TEXT     NOT NULL,
       item_data   TEXT     NOT NULL,
       deleted_by  TEXT,
       deleted_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
       purge_at    DATETIME
     )`,
    // ── NEW v12: Assignment requests ──────────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS assignment_requests (
       id           INTEGER  PRIMARY KEY AUTOINCREMENT,
       machine_id   INTEGER  NOT NULL,
       job_id       TEXT     NOT NULL,
       requested_by TEXT     NOT NULL,
       current_staff TEXT,
       status       TEXT     DEFAULT 'pending',
       admin_note   TEXT,
       created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
       resolved_at  DATETIME
     )`,
    // ── NEW v12: Dashboard snapshot cache ────────────────────────────────────
    `CREATE TABLE IF NOT EXISTS dashboard_snapshot (
       id         INTEGER PRIMARY KEY CHECK (id=1),
       data       TEXT    NOT NULL,
       updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
     )`,
    // Indexes — jobs
    `CREATE INDEX IF NOT EXISTS idx_jobs_status     ON jobs(deleted_at, created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_mobile     ON jobs(customer_mobile)`,
    `CREATE INDEX IF NOT EXISTS idx_jobs_deleted    ON jobs(deleted_at)`,
    // Indexes — machines
    `CREATE INDEX IF NOT EXISTS idx_machines_job_id     ON machines(job_id)`,
    `CREATE INDEX IF NOT EXISTS idx_machines_status     ON machines(status)`,
    `CREATE INDEX IF NOT EXISTS idx_machines_assigned   ON machines(assigned_to)`,
    `CREATE INDEX IF NOT EXISTS idx_machines_deleted    ON machines(deleted_at)`,
    `CREATE INDEX IF NOT EXISTS idx_machines_created    ON machines(created_at)`,
    // Indexes — timeline
    `CREATE INDEX IF NOT EXISTS idx_timeline_machine ON machine_timeline(machine_id)`,
    `CREATE INDEX IF NOT EXISTS idx_timeline_job     ON machine_timeline(job_id)`,
    // Indexes — customers
    `CREATE INDEX IF NOT EXISTS idx_cust_mobile ON customer_profiles(mobile)`,
    // Indexes — machine_images
    `CREATE INDEX IF NOT EXISTS idx_mi_machine ON machine_images(machine_id)`,
    // Indexes — assignment_requests
    `CREATE INDEX IF NOT EXISTS idx_ar_machine ON assignment_requests(machine_id)`,
    `CREATE INDEX IF NOT EXISTS idx_ar_status  ON assignment_requests(status)`,
    `CREATE INDEX IF NOT EXISTS idx_ar_requestor ON assignment_requests(requested_by)`,
  ]

  for (const sql of creates) {
    try { await db.prepare(sql).run() } catch { /* already exists */ }
  }

  // Safe ALTER migrations for existing tables
  const alters = [
    `ALTER TABLE jobs     ADD COLUMN customer_address TEXT`,
    `ALTER TABLE jobs     ADD COLUMN customer_mobile  TEXT`,
    `ALTER TABLE jobs     ADD COLUMN notes            TEXT`,
    `ALTER TABLE jobs     ADD COLUMN amount_received  REAL DEFAULT 0`,
    `ALTER TABLE jobs     ADD COLUMN updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE jobs     ADD COLUMN deleted_at       DATETIME`,
    `ALTER TABLE machines ADD COLUMN condition_text   TEXT`,
    `ALTER TABLE machines ADD COLUMN image_data       TEXT`,
    `ALTER TABLE machines ADD COLUMN quantity         INTEGER DEFAULT 1`,
    `ALTER TABLE machines ADD COLUMN unit_price       REAL DEFAULT 0`,
    `ALTER TABLE machines ADD COLUMN assigned_to      TEXT`,
    `ALTER TABLE machines ADD COLUMN work_done        TEXT`,
    `ALTER TABLE machines ADD COLUMN return_reason    TEXT`,
    `ALTER TABLE machines ADD COLUMN delivery_info    TEXT`,
    `ALTER TABLE machines ADD COLUMN delivered_at     DATETIME`,
    `ALTER TABLE machines ADD COLUMN updated_at       DATETIME DEFAULT CURRENT_TIMESTAMP`,
    `ALTER TABLE machines ADD COLUMN audio_note       TEXT`,
    `ALTER TABLE machines ADD COLUMN priority_flag    INTEGER DEFAULT 0`,
    `ALTER TABLE machines ADD COLUMN deleted_at       DATETIME`,
  ]

  for (const sql of alters) {
    try { await db.prepare(sql).run() } catch { /* column already exists */ }
  }
}

// ── Helper: update job_summary for a given job ───────────────────────────────
export async function refreshJobSummary(db: D1Database, jobId: string) {
  try {
    const rows = await db.prepare(
      `SELECT status FROM machines WHERE job_id = ? AND deleted_at IS NULL`
    ).bind(jobId).all()
    const machines = rows.results as any[]
    const total     = machines.length
    const repaired  = machines.filter((m: any) => m.status === 'Repaired').length
    const returned  = machines.filter((m: any) => m.status === 'Return').length
    const delivered = machines.filter((m: any) => m.status === 'Delivered').length
    const pending   = machines.filter((m: any) => m.status === 'Under Repair').length

    await db.prepare(
      `INSERT INTO job_summary (job_id, total_machines, repaired_count, returned_count,
         pending_count, delivered_count, last_updated)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(job_id) DO UPDATE SET
         total_machines=excluded.total_machines,
         repaired_count=excluded.repaired_count,
         returned_count=excluded.returned_count,
         pending_count=excluded.pending_count,
         delivered_count=excluded.delivered_count,
         last_updated=CURRENT_TIMESTAMP`
    ).bind(jobId, total, repaired, returned, pending, delivered).run()
  } catch (e) {
    console.error('[refreshJobSummary] error:', e)
  }
}

// ── Helper: invalidate dashboard snapshot ────────────────────────────────────
export async function invalidateDashboardSnapshot(db: D1Database) {
  try {
    await db.prepare(`DELETE FROM dashboard_snapshot WHERE id=1`).run()
  } catch {}
}

// Auto-init on every /api/* request (skip heavy tables scan)
let dbInitialized = false
app.use('/api/*', async (c, next) => {
  if (c.env?.DB && !dbInitialized) {
    try {
      await initDB(c.env.DB)
      dbInitialized = true
    } catch (e) {
      console.error('DB init error:', e)
    }
  }
  await next()
})

// ── Debug endpoints ──────────────────────────────────────────────────────────
app.get('/api/debug/schema', async (c) => {
  if (!c.env?.DB) return c.json({ error: 'No DB' }, 500)
  try {
    const tables = ['jobs','machines','machine_images','machine_timeline','job_summary','customer_profiles','trash_items','assignment_requests','dashboard_snapshot']
    const result: any = {}
    for (const t of tables) {
      try {
        const r = await c.env.DB.prepare(`PRAGMA table_info(${t})`).all()
        result[t] = (r.results as any[]).map(x => x.name)
      } catch { result[t] = 'table not found' }
    }
    return c.json(result)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

app.post('/api/debug/repair', async (c) => {
  if (!c.env?.DB) return c.json({ error: 'No DB' }, 500)
  try {
    dbInitialized = false
    await initDB(c.env.DB)
    dbInitialized = true
    const tables = ['jobs','machines','job_summary','assignment_requests','dashboard_snapshot']
    const result: any = {}
    for (const t of tables) {
      try {
        const r = await c.env.DB.prepare(`PRAGMA table_info(${t})`).all()
        result[t] = (r.results as any[]).map(x => x.name)
      } catch { result[t] = [] }
    }
    return c.json({ success: true, ...result })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

app.route('/api/auth',      authRoutes)
app.route('/api/jobs',      jobRoutes)
app.route('/api/admin',     adminRoutes)
app.route('/api/customers', customerRoutes)
app.route('/api/analytics', analyticsRoutes)

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'adition', version: '12.0.0' }))
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }))
app.get('/favicon.svg', (c) => new Response(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1e40af"/><text x="50" y="68" font-size="60" text-anchor="middle" fill="white">&#9889;</text></svg>`,
  { headers: { 'Content-Type': 'image/svg+xml' } }
))

export default app
