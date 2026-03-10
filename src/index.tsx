import { Hono } from 'hono'
import { cors } from 'hono/cors'
import authRoutes     from './routes/auth'
import jobRoutes      from './routes/jobs'
import adminRoutes    from './routes/admin'
import customerRoutes from './routes/customers'

type Bindings = { DB: D1Database; JWT_SECRET: string }
const app = new Hono<{ Bindings: Bindings }>()

app.use('/api/*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'], allowHeaders: ['Content-Type','Authorization','X-Offline-Ts'] }))

// Auto-init DB
app.use('/api/*', async (c, next) => {
  if (c.env?.DB) {
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS job_sequence (id INTEGER PRIMARY KEY CHECK (id=1), current_val INTEGER NOT NULL DEFAULT 0)`),
        c.env.DB.prepare(`INSERT OR IGNORE INTO job_sequence (id, current_val) VALUES (1, 0)`),
        c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS jobs (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT UNIQUE NOT NULL, customer_name TEXT NOT NULL, customer_mobile TEXT, customer_address TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, amount_received REAL DEFAULT 0, notes TEXT)`),
        c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS machines (id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, description TEXT NOT NULL, condition_text TEXT, image_data TEXT, quantity INTEGER DEFAULT 1, unit_price REAL DEFAULT 0, status TEXT DEFAULT 'Under Repair', assigned_to TEXT, work_done TEXT, return_reason TEXT, delivery_info TEXT, delivered_at DATETIME, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (job_id) REFERENCES jobs(job_id) ON DELETE CASCADE)`),
        c.env.DB.prepare(`CREATE TABLE IF NOT EXISTS customer_profiles (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, mobile TEXT UNIQUE NOT NULL, address TEXT, job_count INTEGER DEFAULT 1, last_seen DATETIME DEFAULT CURRENT_TIMESTAMP, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`),
        c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_job_id ON machines(job_id)`),
        c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_assigned ON machines(assigned_to)`),
        c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_machines_status ON machines(status)`),
        c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at)`),
        c.env.DB.prepare(`CREATE INDEX IF NOT EXISTS idx_cust_mobile ON customer_profiles(mobile)`),
      ])
      const migrations = [
        `ALTER TABLE machines ADD COLUMN delivery_info TEXT`,
        `ALTER TABLE machines ADD COLUMN delivered_at DATETIME`,
        `ALTER TABLE jobs ADD COLUMN customer_address TEXT`,
        `ALTER TABLE machines ADD COLUMN assigned_to TEXT`,
        `ALTER TABLE machines ADD COLUMN work_done TEXT`,
        `ALTER TABLE machines ADD COLUMN return_reason TEXT`,
      ]
      for (const sql of migrations) { try { await c.env.DB.prepare(sql).run() } catch {} }
    } catch {}
  }
  await next()
})

app.route('/api/auth',      authRoutes)
app.route('/api/jobs',      jobRoutes)
app.route('/api/admin',     adminRoutes)
app.route('/api/customers', customerRoutes)

app.get('/api/health', (c) => c.json({ status: 'ok', service: 'adition', version: '10.3' }))
app.get('/favicon.ico', (c) => new Response(null, { status: 204 }))
app.get('/favicon.svg', (c) => new Response(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#1e40af"/><text x="50" y="68" font-size="60" text-anchor="middle" fill="white">&#9889;</text></svg>`, { headers: { 'Content-Type': 'image/svg+xml' } }))

export default app
