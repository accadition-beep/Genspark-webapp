import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const JWT_SECRET  = 'adition-secret-key-2026-secure'
const OWNER_EMAIL = 'acc.adition@gmail.com'
const ACTIVE_STATUSES = ['Under Repair', 'Repaired', 'Return']
const ALL_STATUSES    = ['Under Repair', 'Repaired', 'Return', 'Delivered']

const jobs = new Hono<{ Bindings: Bindings; Variables: Variables }>()

jobs.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role', payload.role)
    c.set('user', payload.sub)
    c.set('staff_name', payload.staff_name || '')
  } catch { return c.json({ error: 'Invalid token' }, 401) }
  await next()
})

function sanitizeMachine(m: any, role: string) {
  const out: any = { ...m }
  if (role !== 'admin') {
    delete out.unit_price
    delete out.delivery_info
    delete out.delivered_at
    delete out.return_reason
    if (out.status === 'Delivered') out.status = 'Repaired'
  }
  return out
}

function sanitizeJob(job: any, machines: any[], role: string) {
  const sm = machines.map(m => sanitizeMachine(m, role))
  const grandTotal = machines.reduce((s, m) => s + (m.quantity || 1) * (m.unit_price || 0), 0)
  const allDone = machines.length > 0 && machines.every(m => ['Repaired','Return','Delivered'].includes(m.status))
  const allDelivered = machines.length > 0 && machines.every(m => m.status === 'Delivered')
  const out: any = { ...job, machines: sm, machine_count: machines.length, all_repaired: allDone, all_delivered: allDelivered }
  if (role !== 'admin') { delete out.customer_mobile; delete out.customer_address; delete out.amount_received }
  else { out.grand_total = grandTotal; out.balance = grandTotal - (job.amount_received || 0) }
  return out
}

// GET /api/jobs
jobs.get('/', async (c) => {
  const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
  let jobRows: any, machineRows: any
  if (role === 'admin') {
    jobRows     = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
    machineRows = await db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all()
  } else {
    jobRows = await db.prepare(`
      SELECT DISTINCT j.* FROM jobs j
      INNER JOIN machines m ON m.job_id = j.job_id
      WHERE m.assigned_to = ? AND m.status != 'Delivered'
      ORDER BY j.created_at DESC`).bind(staffName).all()
    machineRows = await db.prepare(
      `SELECT * FROM machines WHERE assigned_to = ? AND status != 'Delivered' ORDER BY created_at ASC`
    ).bind(staffName).all()
  }
  const jobList = (jobRows.results as any[]).map((job: any) => {
    const machines = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
    return sanitizeJob(job, machines, role)
  })
  return c.json(jobList)
})

// GET /api/jobs/all — full snapshot for offline cache
jobs.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB
  const [jobRows, machineRows, custRows] = await Promise.all([
    db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all(),
    db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all(),
    db.prepare('SELECT * FROM customer_profiles ORDER BY last_seen DESC').all(),
  ])
  const jobList = (jobRows.results as any[]).map((job: any) => {
    const machines = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
    return sanitizeJob(job, machines, 'admin')
  })
  return c.json({ jobs: jobList, customers: custRows.results, synced_at: new Date().toISOString() })
})

// GET /api/jobs/:jobId
jobs.get('/:jobId', async (c) => {
  const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
  const jobId = c.req.param('jobId')
  const job = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
  if (!job) return c.json({ error: 'Not found' }, 404)
  let mq: any
  if (role === 'admin') mq = await db.prepare('SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all()
  else mq = await db.prepare(`SELECT * FROM machines WHERE job_id = ? AND assigned_to = ? AND status != 'Delivered' ORDER BY created_at ASC`).bind(jobId, staffName).all()
  return c.json(sanitizeJob(job, mq.results, role))
})

// POST /api/jobs
jobs.post('/', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB; const body = await c.req.json()
  const { customer_name, customer_mobile, customer_address, notes } = body
  if (!customer_name) return c.json({ error: 'customer_name required' }, 400)
  // Gapless ID
  const existingRows = await db.prepare(`SELECT job_id FROM jobs ORDER BY CAST(SUBSTR(job_id,3) AS INTEGER) ASC`).all()
  const usedNums = new Set((existingRows.results as any[]).map((r: any) => { const n = parseInt(r.job_id.replace('C-', ''), 10); return isNaN(n) ? 0 : n }))
  let nextNum = 1
  while (usedNums.has(nextNum)) nextNum++
  const jobId = `C-${String(nextNum).padStart(3, '0')}`
  await db.prepare('INSERT INTO jobs (job_id, customer_name, customer_mobile, customer_address, notes) VALUES (?, ?, ?, ?, ?)')
    .bind(jobId, customer_name, customer_mobile || null, customer_address || null, notes || null).run()
  return c.json(await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first(), 201)
})

// PUT /api/jobs/:jobId
jobs.put('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB; const jobId = c.req.param('jobId')
  const existing: any = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const body = await c.req.json()
  await db.prepare('UPDATE jobs SET customer_name=?,customer_mobile=?,customer_address=?,amount_received=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?')
    .bind(body.customer_name ?? existing.customer_name, body.customer_mobile ?? existing.customer_mobile,
      body.customer_address ?? existing.customer_address, body.amount_received ?? existing.amount_received,
      body.notes ?? existing.notes, jobId).run()
  return c.json(await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first())
})

// DELETE /api/jobs/:jobId
jobs.delete('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  const db = c.env.DB; const jobId = c.req.param('jobId')
  await db.prepare('DELETE FROM machines WHERE job_id = ?').bind(jobId).run()
  await db.prepare('DELETE FROM jobs WHERE job_id = ?').bind(jobId).run()
  return c.json({ success: true })
})

// POST /api/jobs/:jobId/machines
jobs.post('/:jobId/machines', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB; const jobId = c.req.param('jobId'); const body = await c.req.json()
  const { description, condition_text, image_data, quantity, unit_price, status, assigned_to, work_done, return_reason } = body
  if (!description) return c.json({ error: 'description required' }, 400)
  const resolvedStatus = ALL_STATUSES.includes(status) ? status : 'Under Repair'
  if (resolvedStatus === 'Repaired' && !work_done) return c.json({ error: 'work_done required' }, 400)
  if (resolvedStatus === 'Return' && !return_reason) return c.json({ error: 'return_reason required' }, 400)
  const result = await db.prepare(`INSERT INTO machines (job_id,description,condition_text,image_data,quantity,unit_price,status,assigned_to,work_done,return_reason) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(jobId, description, condition_text || null, image_data || null, quantity || 1, unit_price || 0, resolvedStatus, assigned_to || null, work_done || null, return_reason || null).run()
  return c.json(await db.prepare('SELECT * FROM machines WHERE id = ?').bind(result.meta.last_row_id).first(), 201)
})

// PUT /api/jobs/:jobId/machines/:machineId
jobs.put('/:jobId/machines/:machineId', async (c) => {
  const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
  const machineId = c.req.param('machineId'); const body = await c.req.json()
  const existing: any = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first()
  if (!existing) return c.json({ error: 'Not found' }, 404)
  if (role !== 'admin' && existing.assigned_to !== staffName) return c.json({ error: 'Not assigned to you' }, 403)

  let desc = existing.description, cond = existing.condition_text, img = existing.image_data,
    qty = existing.quantity, price = existing.unit_price, assignedTo = existing.assigned_to
  if (role === 'admin') {
    desc = body.description ?? existing.description
    cond = body.condition_text ?? existing.condition_text
    img  = body.image_data !== undefined ? body.image_data : existing.image_data
    qty  = body.quantity ?? existing.quantity
    price = body.unit_price ?? existing.unit_price
    assignedTo = body.assigned_to !== undefined ? body.assigned_to : existing.assigned_to
  }

  const allowedStatuses = role === 'admin' ? ALL_STATUSES : ACTIVE_STATUSES
  let status = body.status ?? existing.status
  if (!allowedStatuses.includes(status)) status = existing.status
  const work_done     = body.work_done     !== undefined ? body.work_done     : existing.work_done
  const return_reason = body.return_reason !== undefined ? body.return_reason : existing.return_reason
  if (status === 'Repaired' && !work_done) return c.json({ error: 'work_done required' }, 400)
  if (status === 'Return'   && !return_reason) return c.json({ error: 'return_reason required' }, 400)

  let delivery_info = existing.delivery_info, delivered_at = existing.delivered_at
  if (role === 'admin' && status === 'Delivered') {
    if (body.delivery_info) delivery_info = typeof body.delivery_info === 'string' ? body.delivery_info : JSON.stringify(body.delivery_info)
    if (!delivered_at) delivered_at = new Date().toISOString()
  }

  await db.prepare(`UPDATE machines SET description=?,condition_text=?,image_data=?,quantity=?,unit_price=?,status=?,assigned_to=?,work_done=?,return_reason=?,delivery_info=?,delivered_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .bind(desc, cond, img, qty, price, status, assignedTo, work_done, return_reason, delivery_info, delivered_at, machineId).run()
  return c.json(await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first())
})

// DELETE /api/jobs/:jobId/machines/:machineId
jobs.delete('/:jobId/machines/:machineId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  const db = c.env.DB; const machineId = c.req.param('machineId')
  await db.prepare('DELETE FROM machines WHERE id = ?').bind(machineId).run()
  return c.json({ success: true })
})

// POST /api/jobs/:jobId/deliver
jobs.post('/:jobId/deliver', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  const db = c.env.DB; const jobId = c.req.param('jobId'); const body = await c.req.json()
  const machines = await db.prepare('SELECT * FROM machines WHERE job_id = ?').bind(jobId).all()
  if (!machines.results.length) return c.json({ error: 'No machines' }, 400)
  const eligible = (machines.results as any[]).every((m: any) => ['Repaired','Return','Delivered'].includes(m.status))
  if (!eligible) return c.json({ error: 'All machines must be Repaired or Return before delivery' }, 400)
  const diStr = body.delivery_info ? JSON.stringify(body.delivery_info) : null
  const deliveredAt = new Date().toISOString()
  await db.prepare(`UPDATE machines SET status='Delivered',delivery_info=?,delivered_at=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=? AND status IN ('Repaired','Return')`)
    .bind(diStr, deliveredAt, jobId).run()
  await db.prepare('UPDATE jobs SET updated_at=CURRENT_TIMESTAMP WHERE job_id=?').bind(jobId).run()
  const updated = await db.prepare('SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all()
  const job = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
  return c.json(sanitizeJob(job, updated.results, 'admin'))
})

export default jobs
