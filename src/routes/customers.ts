import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string }

const customers = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const JWT_SECRET = 'adition-secret-key-2026-secure'

customers.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role', payload.role); c.set('user', payload.sub)
  } catch { return c.json({ error: 'Invalid token' }, 401) }
  await next()
})

customers.get('/search', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const q = (c.req.query('q') || '').trim()
  if (!q.length) return c.json([])
  const db = c.env.DB; const ql = q.toLowerCase()
  const rows = await db.prepare(`SELECT * FROM customer_profiles WHERE LOWER(mobile) LIKE ? OR LOWER(name) LIKE ? OR LOWER(name) LIKE ? ORDER BY last_seen DESC LIMIT 10`)
    .bind(`${ql}%`, `${ql}%`, `%${ql}%`).all()
  return c.json(rows.results)
})

customers.post('/upsert', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB; const body = await c.req.json()
  const { name, mobile, address } = body
  if (!name || !mobile) return c.json({ error: 'name and mobile required' }, 400)
  await db.prepare(`INSERT INTO customer_profiles (name,mobile,address,job_count,last_seen) VALUES (?,?,?,1,CURRENT_TIMESTAMP) ON CONFLICT(mobile) DO UPDATE SET name=excluded.name,address=COALESCE(excluded.address,customer_profiles.address),job_count=customer_profiles.job_count+1,last_seen=CURRENT_TIMESTAMP`)
    .bind(name, mobile, address || null).run()
  return c.json(await db.prepare('SELECT * FROM customer_profiles WHERE mobile = ?').bind(mobile).first())
})

customers.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const rows = await c.env.DB.prepare('SELECT * FROM customer_profiles ORDER BY last_seen DESC LIMIT 500').all()
  return c.json(rows.results)
})

export default customers
