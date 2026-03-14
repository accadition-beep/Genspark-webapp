import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const customers = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const JWT_SECRET = 'adition-secret-key-2026-secure'

customers.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role',       String(payload.role       || ''))
    c.set('user',       String(payload.sub        || ''))
    c.set('staff_name', String(payload.staff_name || ''))
  } catch { return c.json({ error: 'Invalid token' }, 401) }
  await next()
})

// Search — admin only (customer data is sensitive: phone numbers etc.)
// Staff autocomplete uses a stripped endpoint below
customers.get('/search', async (c) => {
  const role = c.get('role')
  if (role !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const q = (c.req.query('q') || '').trim()
  if (!q.length) return c.json([])
  const db = c.env.DB; const ql = q.toLowerCase()
  try {
    const rows = await db.prepare(
      `SELECT * FROM customer_profiles WHERE LOWER(mobile) LIKE ? OR LOWER(name) LIKE ? OR LOWER(name) LIKE ? ORDER BY last_seen DESC LIMIT 10`
    ).bind(`${ql}%`, `${ql}%`, `%${ql}%`).all()
    return c.json(rows.results)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

// Staff autocomplete — returns only name+address (no mobile) for auto-fill
customers.get('/autocomplete', async (c) => {
  const role      = c.get('role')
  const q = (c.req.query('q') || '').trim()
  if (!q.length || q.length < 2) return c.json([])
  const db = c.env.DB
  const ql = q.toLowerCase()
  try {
    let rows: any
    if (role === 'admin') {
      rows = await db.prepare(
        `SELECT name, mobile, address FROM customer_profiles WHERE LOWER(mobile) LIKE ? OR LOWER(name) LIKE ? ORDER BY last_seen DESC LIMIT 5`
      ).bind(`${ql}%`, `%${ql}%`).all()
    } else {
      // Staff only see name+address, no mobile
      rows = await db.prepare(
        `SELECT name, address FROM customer_profiles WHERE LOWER(name) LIKE ? ORDER BY last_seen DESC LIMIT 5`
      ).bind(`%${ql}%`).all()
    }
    return c.json(rows.results)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

customers.post('/upsert', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    let body: any = {}
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
    const { name, mobile, address } = body
    if (!name || !mobile) return c.json({ error: 'name and mobile required' }, 400)
    await db.prepare(
      `INSERT INTO customer_profiles (name,mobile,address,job_count,last_seen) VALUES (?,?,?,1,CURRENT_TIMESTAMP)
       ON CONFLICT(mobile) DO UPDATE SET name=excluded.name,address=COALESCE(excluded.address,customer_profiles.address),job_count=customer_profiles.job_count+1,last_seen=CURRENT_TIMESTAMP`
    ).bind(name, mobile, address || null).run()
    const row = await db.prepare('SELECT * FROM customer_profiles WHERE mobile = ?').bind(mobile).first()
    return c.json({ success: true, ...row })
  } catch (err: any) {
    return c.json({ success: false, error: err.message }, 500)
  }
})

customers.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const rows = await c.env.DB.prepare('SELECT * FROM customer_profiles ORDER BY last_seen DESC LIMIT 500').all()
    return c.json(rows.results)
  } catch (err: any) {
    return c.json({ error: err.message }, 500)
  }
})

export default customers
