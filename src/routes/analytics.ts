import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const JWT_SECRET = 'adition-secret-key-2026-secure'
const analytics  = new Hono<{ Bindings: Bindings; Variables: Variables }>()

analytics.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    if (payload.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
    c.set('role', payload.role); c.set('user', payload.sub); c.set('staff_name', payload.staff_name || '')
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
  await next()
})

// ── GET /api/analytics/customers ─────────────────────────────────────────────
analytics.get('/customers', async (c) => {
  try {
    const db   = c.env.DB
    const from = c.req.query('from'), to = c.req.query('to')
    let where = 'WHERE j.deleted_at IS NULL'
    const params: any[] = []
    if (from && to) { where += ` AND DATE(j.created_at) >= ? AND DATE(j.created_at) <= ?`; params.push(from, to) }

    const query = `
      SELECT
        j.customer_name,
        j.customer_mobile,
        COUNT(DISTINCT j.job_id)        AS total_jobs,
        COUNT(m.id)                     AS total_machines,
        COALESCE(SUM(m.unit_price * m.quantity), 0) AS total_revenue,
        MAX(j.created_at)               AS last_job_at
      FROM jobs j
      LEFT JOIN machines m ON m.job_id = j.job_id AND m.deleted_at IS NULL
      ${where}
      GROUP BY j.customer_mobile, j.customer_name
      ORDER BY total_jobs DESC LIMIT 100`

    const rows = params.length
      ? await db.prepare(query).bind(...params).all()
      : await db.prepare(query).all()

    return c.json({ success: true, customers: rows.results })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/analytics/overview ──────────────────────────────────────────────
analytics.get('/overview', async (c) => {
  try {
    const db   = c.env.DB
    const from = c.req.query('from'), to = c.req.query('to')
    let where = 'WHERE m.deleted_at IS NULL'
    const params: any[] = []
    if (from && to) { where += ` AND DATE(m.created_at) >= ? AND DATE(m.created_at) <= ?`; params.push(from, to) }

    const q = `
      SELECT
        COUNT(*)                                                   AS total_machines,
        SUM(CASE WHEN m.status='Under Repair'  THEN 1 ELSE 0 END) AS under_repair,
        SUM(CASE WHEN m.status='Repaired'      THEN 1 ELSE 0 END) AS repaired,
        SUM(CASE WHEN m.status='Return'        THEN 1 ELSE 0 END) AS returned,
        SUM(CASE WHEN m.status='Delivered'     THEN 1 ELSE 0 END) AS delivered,
        COALESCE(SUM(unit_price * quantity), 0)                   AS total_revenue,
        COUNT(DISTINCT m.job_id)                                   AS total_jobs
      FROM machines m ${where}`

    const row: any = params.length
      ? await db.prepare(q).bind(...params).first()
      : await db.prepare(q).first()

    return c.json({ success: true, overview: row })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

export default analytics
