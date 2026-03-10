import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const JWT_SECRET  = 'adition-secret-key-2026-secure'
const OWNER_EMAIL = 'acc.adition@gmail.com'
const ACTIVE_STATUSES = ['Under Repair', 'Repaired', 'Return']
const ALL_STATUSES    = ['Under Repair', 'Repaired', 'Return', 'Delivered']

const jobs = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── Auth middleware ──────────────────────────────────────────────────────────
jobs.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role',       payload.role)
    c.set('user',       payload.sub)
    c.set('staff_name', payload.staff_name || '')
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
  await next()
})

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  const sm         = machines.map(m => sanitizeMachine(m, role))
  const grandTotal = machines.reduce((s, m) => s + (m.quantity || 1) * (m.unit_price || 0), 0)
  const allDone    = machines.length > 0 && machines.every(m => ['Repaired','Return','Delivered'].includes(m.status))
  const allDelivered = machines.length > 0 && machines.every(m => m.status === 'Delivered')
  const out: any   = { ...job, machines: sm, machine_count: machines.length, all_repaired: allDone, all_delivered: allDelivered }
  if (role !== 'admin') { delete out.customer_mobile; delete out.customer_address; delete out.amount_received }
  else { out.grand_total = grandTotal; out.balance = grandTotal - (job.amount_received || 0) }
  return out
}

// ── GET /api/jobs ────────────────────────────────────────────────────────────
jobs.get('/', async (c) => {
  try {
    const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
    let jobRows: any, machineRows: any
    if (role === 'admin') {
      jobRows     = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
      machineRows = await db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all()
    } else {
      jobRows = await db.prepare(
        `SELECT DISTINCT j.* FROM jobs j INNER JOIN machines m ON m.job_id = j.job_id
         WHERE m.assigned_to = ? AND m.status != 'Delivered' ORDER BY j.created_at DESC`
      ).bind(staffName).all()
      machineRows = await db.prepare(
        `SELECT * FROM machines WHERE assigned_to = ? AND status != 'Delivered' ORDER BY created_at ASC`
      ).bind(staffName).all()
    }
    const jobList = (jobRows.results as any[]).map((job: any) => {
      const machines = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
      return sanitizeJob(job, machines, role)
    })
    return c.json(jobList)
  } catch (err: any) {
    return c.json({ error: 'Failed to load jobs', detail: err?.message || 'unknown' }, 500)
  }
})

// ── GET /api/jobs/all ────────────────────────────────────────────────────────
jobs.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
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
  } catch (err: any) {
    return c.json({ error: 'Failed to load snapshot', detail: err?.message || 'unknown' }, 500)
  }
})

// ── GET /api/jobs/:jobId ─────────────────────────────────────────────────────
jobs.get('/:jobId', async (c) => {
  try {
    const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
    const jobId = c.req.param('jobId')
    const job = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!job) return c.json({ error: 'Not found' }, 404)
    let mq: any
    if (role === 'admin') {
      mq = await db.prepare('SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all()
    } else {
      mq = await db.prepare(
        `SELECT * FROM machines WHERE job_id = ? AND assigned_to = ? AND status != 'Delivered' ORDER BY created_at ASC`
      ).bind(jobId, staffName).all()
    }
    return c.json(sanitizeJob(job, mq.results, role))
  } catch (err: any) {
    return c.json({ error: 'Failed to load job', detail: err?.message || 'unknown' }, 500)
  }
})

// ── POST /api/jobs ───────────────────────────────────────────────────────────
jobs.post('/', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const { customer_name, customer_mobile, customer_address, notes } = body
    if (!customer_name?.trim()) return c.json({ error: 'customer_name required' }, 400)
    // Gapless ID generation
    const existingRows = await db.prepare(`SELECT job_id FROM jobs ORDER BY created_at ASC`).all()
    const usedNums = new Set(
      (existingRows.results as any[]).map((r: any) => {
        const n = parseInt(String(r.job_id).replace('C-', ''), 10)
        return isNaN(n) ? 0 : n
      })
    )
    let nextNum = 1
    while (usedNums.has(nextNum)) nextNum++
    const jobId = `C-${String(nextNum).padStart(3, '0')}`
    await db.prepare(
      'INSERT INTO jobs (job_id, customer_name, customer_mobile, customer_address, notes) VALUES (?, ?, ?, ?, ?)'
    ).bind(jobId, customer_name.trim(), customer_mobile || null, customer_address || null, notes || null).run()
    const newJob = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    return c.json(newJob, 201)
  } catch (err: any) {
    return c.json({ error: 'Failed to create job', detail: err?.message || 'unknown' }, 500)
  }
})

// ── PUT /api/jobs/:jobId ─────────────────────────────────────────────────────
jobs.put('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const db = c.env.DB; const jobId = c.req.param('jobId')
    const existing: any = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!existing) return c.json({ error: 'Not found' }, 404)
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    await db.prepare(
      'UPDATE jobs SET customer_name=?,customer_mobile=?,customer_address=?,amount_received=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?'
    ).bind(
      body.customer_name   ?? existing.customer_name,
      body.customer_mobile ?? existing.customer_mobile,
      body.customer_address ?? existing.customer_address,
      body.amount_received != null ? parseFloat(body.amount_received) : existing.amount_received,
      body.notes ?? existing.notes,
      jobId
    ).run()
    const updated = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    return c.json(updated)
  } catch (err: any) {
    return c.json({ error: 'Failed to update job', detail: err?.message || 'unknown' }, 500)
  }
})

// ── DELETE /api/jobs/:jobId ──────────────────────────────────────────────────
jobs.delete('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  try {
    const db = c.env.DB; const jobId = c.req.param('jobId')
    await db.prepare('DELETE FROM machines WHERE job_id = ?').bind(jobId).run()
    await db.prepare('DELETE FROM jobs WHERE job_id = ?').bind(jobId).run()
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: 'Failed to delete job', detail: err?.message || 'unknown' }, 500)
  }
})

// ── POST /api/jobs/:jobId/machines ───────────────────────────────────────────
jobs.post('/:jobId/machines', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const db = c.env.DB; const jobId = c.req.param('jobId')
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const { description, condition_text, image_data, quantity, unit_price, status, assigned_to, work_done, return_reason } = body
    if (!description?.trim()) return c.json({ error: 'description required' }, 400)
    // Ensure job exists
    const job = await db.prepare('SELECT job_id FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!job) return c.json({ error: `Job ${jobId} not found` }, 404)
    const resolvedStatus = ALL_STATUSES.includes(status) ? status : 'Under Repair'
    if (resolvedStatus === 'Repaired' && !work_done?.trim()) return c.json({ error: 'work_done required for Repaired status' }, 400)
    if (resolvedStatus === 'Return'   && !return_reason?.trim()) return c.json({ error: 'return_reason required for Return status' }, 400)
    const result = await db.prepare(
      `INSERT INTO machines (job_id,description,condition_text,image_data,quantity,unit_price,status,assigned_to,work_done,return_reason)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).bind(
      jobId, description.trim(), condition_text || null, image_data || null,
      parseInt(quantity) || 1, parseFloat(unit_price) || 0,
      resolvedStatus, assigned_to || null, work_done || null, return_reason || null
    ).run()
    const newMachine = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(result.meta.last_row_id).first()
    return c.json(newMachine, 201)
  } catch (err: any) {
    return c.json({ error: 'Failed to add machine', detail: err?.message || 'unknown' }, 500)
  }
})

// ── PUT /api/jobs/:jobId/machines/:machineId ─────────────────────────────────
jobs.put('/:jobId/machines/:machineId', async (c) => {
  try {
    const db = c.env.DB; const role = c.get('role'); const staffName = c.get('staff_name')
    const machineId = c.req.param('machineId')
    let body: any
    try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON body' }, 400) }
    const existing: any = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first()
    if (!existing) return c.json({ error: 'Machine not found' }, 404)
    if (role !== 'admin' && existing.assigned_to !== staffName) return c.json({ error: 'Not assigned to you' }, 403)

    let desc       = existing.description
    let cond       = existing.condition_text
    let img        = existing.image_data
    let qty        = existing.quantity
    let price      = existing.unit_price
    let assignedTo = existing.assigned_to

    if (role === 'admin') {
      if (body.description  !== undefined) desc       = body.description?.trim() || existing.description
      if (body.condition_text !== undefined) cond     = body.condition_text || null
      if (body.image_data   !== undefined) img        = body.image_data || null
      if (body.quantity     !== undefined) qty        = parseInt(body.quantity)  || existing.quantity
      if (body.unit_price   !== undefined) price      = parseFloat(body.unit_price) || 0
      if (body.assigned_to  !== undefined) assignedTo = body.assigned_to || null
    }

    const allowedStatuses = role === 'admin' ? ALL_STATUSES : ACTIVE_STATUSES
    let newStatus = body.status !== undefined ? body.status : existing.status
    if (!allowedStatuses.includes(newStatus)) newStatus = existing.status

    const work_done     = body.work_done     !== undefined ? (body.work_done     || null) : existing.work_done
    const return_reason = body.return_reason !== undefined ? (body.return_reason || null) : existing.return_reason

    if (newStatus === 'Repaired' && !work_done?.trim())     return c.json({ error: 'work_done required for Repaired status' }, 400)
    if (newStatus === 'Return'   && !return_reason?.trim()) return c.json({ error: 'return_reason required for Return status' }, 400)

    let delivery_info = existing.delivery_info
    let delivered_at  = existing.delivered_at
    if (role === 'admin' && newStatus === 'Delivered') {
      if (body.delivery_info) delivery_info = typeof body.delivery_info === 'string' ? body.delivery_info : JSON.stringify(body.delivery_info)
      if (!delivered_at) delivered_at = new Date().toISOString()
    }

    await db.prepare(
      `UPDATE machines SET description=?,condition_text=?,image_data=?,quantity=?,unit_price=?,status=?,
       assigned_to=?,work_done=?,return_reason=?,delivery_info=?,delivered_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`
    ).bind(desc, cond, img, qty, price, newStatus, assignedTo, work_done, return_reason, delivery_info, delivered_at, machineId).run()

    const updated = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first()
    return c.json(updated)
  } catch (err: any) {
    return c.json({ error: 'Failed to update machine', detail: err?.message || 'unknown' }, 500)
  }
})

// ── DELETE /api/jobs/:jobId/machines/:machineId ──────────────────────────────
jobs.delete('/:jobId/machines/:machineId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ error: 'Owner required' }, 403)
  try {
    const db = c.env.DB; const machineId = c.req.param('machineId')
    const existing = await db.prepare('SELECT id FROM machines WHERE id = ?').bind(machineId).first()
    if (!existing) return c.json({ error: 'Machine not found' }, 404)
    await db.prepare('DELETE FROM machines WHERE id = ?').bind(machineId).run()
    return c.json({ success: true })
  } catch (err: any) {
    return c.json({ error: 'Failed to delete machine', detail: err?.message || 'unknown' }, 500)
  }
})

// ── POST /api/jobs/:jobId/deliver ────────────────────────────────────────────
jobs.post('/:jobId/deliver', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ error: 'Admin only' }, 403)
  try {
    const db = c.env.DB; const jobId = c.req.param('jobId')
    let body: any
    try { body = await c.req.json() } catch { body = {} }
    const machines = await db.prepare('SELECT * FROM machines WHERE job_id = ?').bind(jobId).all()
    if (!machines.results.length) return c.json({ error: 'No machines on this job' }, 400)
    const eligible = (machines.results as any[]).every(
      (m: any) => ['Repaired','Return','Delivered'].includes(m.status)
    )
    if (!eligible) return c.json({ error: 'All machines must be Repaired or Return before delivery' }, 400)
    const diStr      = body.delivery_info ? JSON.stringify(body.delivery_info) : null
    const deliveredAt = new Date().toISOString()
    await db.prepare(
      `UPDATE machines SET status='Delivered',delivery_info=?,delivered_at=?,updated_at=CURRENT_TIMESTAMP
       WHERE job_id=? AND status IN ('Repaired','Return')`
    ).bind(diStr, deliveredAt, jobId).run()
    await db.prepare('UPDATE jobs SET updated_at=CURRENT_TIMESTAMP WHERE job_id=?').bind(jobId).run()
    const updated = await db.prepare('SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all()
    const job     = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    return c.json(sanitizeJob(job, updated.results, 'admin'))
  } catch (err: any) {
    return c.json({ error: 'Delivery failed', detail: err?.message || 'unknown' }, 500)
  }
})

export default jobs
