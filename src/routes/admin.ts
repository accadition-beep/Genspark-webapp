import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const admin = new Hono<{ Bindings: Bindings; Variables: Variables }>()
const JWT_SECRET  = 'adition-secret-key-2026-secure'
const OWNER_EMAIL = 'acc.adition@gmail.com'

admin.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    if (payload.role !== 'admin') return c.json({ error: 'Admin only' }, 403)
    c.set('role', payload.role); c.set('user', payload.sub); c.set('staff_name', payload.staff_name || '')
  } catch { return c.json({ error: 'Invalid token' }, 401) }
  await next()
})

// GET /api/admin/export
admin.get('/export', async (c) => {
  const db = c.env.DB
  const from = c.req.query('from'), to = c.req.query('to'), month = c.req.query('month')
  let fromDate = from, toDate = to
  if (month) {
    fromDate = `${month}-01`
    const [y, m] = month.split('-').map(Number)
    toDate = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  }
  let jobRows: any
  if (fromDate && toDate) jobRows = await db.prepare(`SELECT * FROM jobs WHERE DATE(created_at) >= ? AND DATE(created_at) <= ? ORDER BY created_at DESC`).bind(fromDate, toDate).all()
  else jobRows = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
  const jobIds = (jobRows.results as any[]).map((j: any) => j.job_id)
  let machineRows: any = { results: [] }
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',')
    machineRows = await db.prepare(`SELECT * FROM machines WHERE job_id IN (${ph}) ORDER BY created_at ASC`).bind(...jobIds).all()
  }
  return c.json({ jobs: jobRows.results, machines: machineRows.results })
})

// GET /api/admin/report
admin.get('/report', async (c) => {
  const db = c.env.DB
  const from = c.req.query('from'), to = c.req.query('to'), month = c.req.query('month')
  const statuses = c.req.query('statuses'), staff = c.req.query('staff')
  let fromDate = from, toDate = to
  if (month) {
    fromDate = `${month}-01`
    const [y, m] = month.split('-').map(Number)
    toDate = `${month}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`
  }
  const conditions: string[] = []; const params: any[] = []
  if (fromDate && toDate) { conditions.push(`DATE(m.created_at) >= ? AND DATE(m.created_at) <= ?`); params.push(fromDate, toDate) }
  if (statuses) {
    const sl = statuses.split(',').map((s: string) => s.trim()).filter(Boolean)
    if (sl.length) { conditions.push(`m.status IN (${sl.map(() => '?').join(',')})`); params.push(...sl) }
  }
  if (staff) { conditions.push(`m.assigned_to = ?`); params.push(staff) }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  const query = `SELECT m.*, j.customer_name, j.customer_mobile FROM machines m LEFT JOIN jobs j ON j.job_id = m.job_id ${where} ORDER BY m.created_at DESC`
  const rows = params.length ? await db.prepare(query).bind(...params).all() : await db.prepare(query).all()
  const items = rows.results as any[]
  const summary = {
    total: items.length,
    under_repair: items.filter((r: any) => r.status === 'Under Repair').length,
    repaired: items.filter((r: any) => r.status === 'Repaired').length,
    return_count: items.filter((r: any) => r.status === 'Return').length,
    delivered: items.filter((r: any) => r.status === 'Delivered').length,
    total_revenue: items.reduce((s: number, r: any) => s + (r.quantity || 1) * (r.unit_price || 0), 0),
  }
  return c.json({ machines: items, summary })
})

// POST /api/admin/restore
admin.post('/restore', async (c) => {
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  const db = c.env.DB; const body = await c.req.json()
  const { jobs = [], machines = [] } = body
  let upsertedJobs = 0, upsertedMachines = 0, skipped = 0
  for (const j of jobs) {
    if (!j.job_id || !j.customer_name) { skipped++; continue }
    try {
      await db.prepare(`INSERT INTO jobs (job_id,customer_name,customer_mobile,customer_address,amount_received,notes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET customer_name=excluded.customer_name,customer_mobile=excluded.customer_mobile,customer_address=excluded.customer_address,amount_received=excluded.amount_received,notes=excluded.notes`)
        .bind(j.job_id, j.customer_name, j.customer_mobile || null, j.customer_address || null, j.amount_received || 0, j.notes || null, j.created_at || new Date().toISOString(), j.updated_at || new Date().toISOString()).run()
      upsertedJobs++
    } catch { skipped++ }
  }
  for (const m of machines) {
    if (!m.job_id || !m.description) { skipped++; continue }
    try {
      await db.prepare(`INSERT INTO machines (job_id,description,condition_text,image_data,quantity,unit_price,status,assigned_to,work_done,return_reason,delivery_info,delivered_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(m.job_id, m.description, m.condition_text || null, m.image_data || null, m.quantity || 1, m.unit_price || 0, m.status || 'Under Repair', m.assigned_to || null, m.work_done || null, m.return_reason || null, m.delivery_info || null, m.delivered_at || null, m.created_at || new Date().toISOString(), m.updated_at || new Date().toISOString()).run()
      upsertedMachines++
    } catch { skipped++ }
  }
  return c.json({ upserted_jobs: upsertedJobs, upserted_machines: upsertedMachines, skipped })
})

// POST /api/admin/cleanup
admin.post('/cleanup', async (c) => {
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  const db = c.env.DB; const body = await c.req.json()
  const { from, to } = body
  if (!from || !to) return c.json({ error: 'from and to dates required' }, 400)
  const jobRows = await db.prepare(`SELECT job_id FROM jobs WHERE DATE(created_at) >= ? AND DATE(created_at) <= ?`).bind(from, to).all()
  const jobIds = (jobRows.results as any[]).map((j: any) => j.job_id)
  if (jobIds.length) {
    const ph = jobIds.map(() => '?').join(',')
    await db.prepare(`DELETE FROM machines WHERE job_id IN (${ph})`).bind(...jobIds).run()
    await db.prepare(`DELETE FROM jobs WHERE job_id IN (${ph})`).bind(...jobIds).run()
  }
  return c.json({ deleted: jobIds.length, job_ids: jobIds })
})

// POST /api/admin/reset-sequence
admin.post('/reset-sequence', async (c) => {
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  const db = c.env.DB
  const count = await db.prepare('SELECT COUNT(*) as cnt FROM jobs').first() as any
  if (count?.cnt > 0) return c.json({ error: 'Cannot reset while jobs exist' }, 400)
  await db.prepare('UPDATE job_sequence SET current_val = 0 WHERE id = 1').run()
  return c.json({ success: true })
})

export default admin
