import { Hono } from 'hono'
import { verify } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }
type Variables = { role: string; user: string; staff_name: string }

const JWT_SECRET      = 'adition-secret-key-2026-secure'
const OWNER_EMAIL     = 'acc.adition@gmail.com'
const ACTIVE_STATUSES = ['Under Repair', 'Repaired', 'Return']
const ALL_STATUSES    = ['Under Repair', 'Repaired', 'Return', 'Delivered']

const jobs = new Hono<{ Bindings: Bindings; Variables: Variables }>()

// ── Auth middleware ──────────────────────────────────────────────────────────
jobs.use('/*', async (c, next) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) {
    return c.json({ success: false, error: 'Unauthorized' }, 401)
  }
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role',       String(payload.role       || ''))
    c.set('user',       String(payload.sub        || ''))
    c.set('staff_name', String(payload.staff_name || ''))
  } catch (e: any) {
    console.error('[auth] token verify failed:', e?.message)
    return c.json({ success: false, error: 'Invalid token' }, 401)
  }
  await next()
})

// ── Safe coercion helpers ─────────────────────────────────────────────────────
function coerceStr(v: any, fallback = ''): string {
  if (v === null || v === undefined) return fallback
  return String(v).trim()
}
function coerceInt(v: any, fallback = 0): number {
  const n = parseInt(String(v), 10)
  return isFinite(n) ? n : fallback
}
function coerceFloat(v: any, fallback = 0): number {
  const n = parseFloat(String(v))
  return isFinite(n) ? n : fallback
}

// ── Safe JSON body parser ────────────────────────────────────────────────────
async function safeParseBody(c: any): Promise<{ body: any; parseError: string | null }> {
  try {
    const body = await c.req.json()
    return { body: body ?? {}, parseError: null }
  } catch (e: any) {
    console.error('[safeParseBody] failed:', e?.message)
    return { body: {}, parseError: 'Invalid JSON body' }
  }
}

// ── Role-based sanitisers ────────────────────────────────────────────────────
function sanitizeMachine(m: any, role: string, staffName?: string) {
  if (!m) return m
  const out: any = { ...m }
  if (role !== 'admin') {
    delete out.unit_price
    delete out.delivery_info
    delete out.delivered_at
    delete out.return_reason
    if (out.status === 'Delivered') out.status = 'Repaired'
    out.is_mine = (out.assigned_to === staffName)
  }
  return out
}
function sanitizeJob(job: any, machines: any[], role: string, staffName?: string) {
  if (!job) return job
  const mList = Array.isArray(machines) ? machines : []
  const sm           = mList.map(m => sanitizeMachine(m, role, staffName))
  const grandTotal   = mList.reduce((s, m) => s + coerceInt(m.quantity, 1) * coerceFloat(m.unit_price, 0), 0)
  const allDone      = mList.length > 0 && mList.every(m => ['Repaired','Return','Delivered'].includes(m.status))
  const allDelivered = mList.length > 0 && mList.every(m => m.status === 'Delivered')
  const out: any = {
    ...job,
    machines:      sm,
    machine_count: mList.length,
    all_repaired:  allDone,
    all_delivered: allDelivered,
  }
  if (role !== 'admin') {
    delete out.customer_mobile
    delete out.customer_address
    delete out.amount_received
    out.has_mine = mList.some(m => m.assigned_to === staffName)
  } else {
    out.grand_total = grandTotal
    out.balance     = grandTotal - coerceFloat(job.amount_received, 0)
  }
  return out
}

// ────────────────────────────────────────────────────────────────────────────
// GET /api/jobs
// ────────────────────────────────────────────────────────────────────────────
jobs.get('/', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')

    let jobRows:     D1Result
    let machineRows: D1Result

    if (role === 'admin') {
      jobRows     = await db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all()
      machineRows = await db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all()
    } else {
      jobRows = await db.prepare(
        `SELECT DISTINCT j.* FROM jobs j
         INNER JOIN machines m ON m.job_id = j.job_id
         WHERE m.status != 'Delivered'
         ORDER BY j.created_at DESC`
      ).all()
      machineRows = await db.prepare(
        `SELECT m.* FROM machines m WHERE m.status != 'Delivered' ORDER BY m.created_at ASC`
      ).all()
    }

    const jobList = (jobRows.results as any[]).map((job: any) => {
      const mList = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
      return sanitizeJob(job, mList, role, staffName)
    })

    return c.json(jobList)
  } catch (err: any) {
    console.error('[GET /jobs] error:', err?.message, err?.stack)
    return c.json({ success: false, error: err?.message || 'Failed to load jobs' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/all  (admin snapshot)
// ────────────────────────────────────────────────────────────────────────────
jobs.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    const [jobRows, machineRows, custRows] = await Promise.all([
      db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all(),
      db.prepare('SELECT * FROM machines ORDER BY created_at ASC').all(),
      db.prepare('SELECT * FROM customer_profiles ORDER BY last_seen DESC').all(),
    ])
    const jobList = (jobRows.results as any[]).map((job: any) => {
      const mList = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
      return sanitizeJob(job, mList, 'admin')
    })
    return c.json({ jobs: jobList, customers: custRows.results, synced_at: new Date().toISOString() })
  } catch (err: any) {
    console.error('[GET /jobs/all] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to load snapshot' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// GET /api/jobs/:jobId
// ────────────────────────────────────────────────────────────────────────────
jobs.get('/:jobId', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')
    const jobId     = c.req.param('jobId')

    const job = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!job) return c.json({ success: false, error: 'Not found' }, 404)

    const mq = role === 'admin'
      ? await db.prepare('SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC').bind(jobId).all()
      : await db.prepare(`SELECT * FROM machines WHERE job_id = ? AND status != 'Delivered' ORDER BY created_at ASC`).bind(jobId).all()

    return c.json(sanitizeJob(job, mq.results as any[], role, staffName))
  } catch (err: any) {
    console.error('[GET /jobs/:id] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to load job' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// POST /api/jobs  ← CRITICAL FIX
// ────────────────────────────────────────────────────────────────────────────
jobs.post('/', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)

  try {
    const db = c.env.DB

    // 1. Parse body safely
    const { body, parseError } = await safeParseBody(c)
    if (parseError) return c.json({ success: false, error: parseError }, 400)

    console.log('[POST /jobs] incoming body:', JSON.stringify({
      customer_name:    body.customer_name,
      customer_mobile:  body.customer_mobile,
      customer_address: body.customer_address,
      notes:            body.notes,
    }))

    // 2. Coerce all fields
    const customerName:    string      = coerceStr(body.customer_name)
    const customerMobile:  string|null = coerceStr(body.customer_mobile)  || null
    const customerAddress: string|null = coerceStr(body.customer_address) || null
    const notes:           string|null = coerceStr(body.notes)            || null

    // 3. Validate required field
    if (!customerName) {
      return c.json({ success: false, error: 'customer_name is required' }, 400)
    }

    // 4. Generate gapless C-XXX ID
    const existingRows = await db.prepare('SELECT job_id FROM jobs ORDER BY created_at ASC').all()
    const usedNums = new Set<number>(
      (existingRows.results as any[]).map((r: any) => {
        const n = parseInt(String(r.job_id || '').replace('C-', ''), 10)
        return isNaN(n) ? 0 : n
      })
    )
    let nextNum = 1
    while (usedNums.has(nextNum)) nextNum++
    const jobId = `C-${String(nextNum).padStart(3, '0')}`

    console.log('[POST /jobs] inserting job_id:', jobId, '| customer:', customerName)

    // 5. Insert into jobs table
    await db.prepare(
      `INSERT INTO jobs (job_id, customer_name, customer_mobile, customer_address, notes)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(jobId, customerName, customerMobile, customerAddress, notes).run()

    // 6. Fetch created record
    const newJob = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!newJob) {
      console.error('[POST /jobs] job inserted but not retrievable — jobId:', jobId)
      return c.json({ success: false, error: 'Job created but could not be retrieved' }, 500)
    }

    console.log('[POST /jobs] success — job:', JSON.stringify(newJob))
    return c.json({ success: true, data: newJob }, 201)

  } catch (err: any) {
    console.error('[POST /jobs] FATAL error:', err?.message, err?.stack)
    return c.json({ success: false, error: err?.message || 'Failed to create job' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/jobs/:jobId
// ────────────────────────────────────────────────────────────────────────────
jobs.put('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)

  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')

    const existing: any = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!existing) return c.json({ success: false, error: 'Job not found' }, 404)

    const { body, parseError } = await safeParseBody(c)
    if (parseError) return c.json({ success: false, error: parseError }, 400)

    const customerName    = body.customer_name    !== undefined ? (coerceStr(body.customer_name)    || existing.customer_name)  : existing.customer_name
    const customerMobile  = body.customer_mobile  !== undefined ? (coerceStr(body.customer_mobile)  || null) : existing.customer_mobile
    const customerAddress = body.customer_address !== undefined ? (coerceStr(body.customer_address) || null) : existing.customer_address
    const amountReceived  = body.amount_received  !== undefined ? coerceFloat(body.amount_received, 0) : coerceFloat(existing.amount_received, 0)
    const notes           = body.notes            !== undefined ? (coerceStr(body.notes) || null) : existing.notes

    await db.prepare(
      `UPDATE jobs
         SET customer_name=?, customer_mobile=?, customer_address=?,
             amount_received=?, notes=?, updated_at=CURRENT_TIMESTAMP
       WHERE job_id=?`
    ).bind(customerName, customerMobile, customerAddress, amountReceived, notes, jobId).run()

    const updated = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()
    return c.json({ success: true, data: updated })

  } catch (err: any) {
    console.error('[PUT /jobs/:id] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to update job' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/jobs/:jobId
// ────────────────────────────────────────────────────────────────────────────
jobs.delete('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ success: false, error: 'Owner required' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    await db.prepare('DELETE FROM machines WHERE job_id = ?').bind(jobId).run()
    await db.prepare('DELETE FROM jobs     WHERE job_id = ?').bind(jobId).run()
    return c.json({ success: true, data: { deleted: true } })
  } catch (err: any) {
    console.error('[DELETE /jobs/:id] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to delete job' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/:jobId/machines  ← CRITICAL FIX
// ────────────────────────────────────────────────────────────────────────────
jobs.post('/:jobId/machines', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)

  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')

    // 1. Parse body safely
    const { body, parseError } = await safeParseBody(c)
    if (parseError) return c.json({ success: false, error: parseError }, 400)

    console.log('[POST /machines] jobId:', jobId, 'body:', JSON.stringify({
      description:    body.description,
      condition_text: body.condition_text,
      quantity:       body.quantity,
      unit_price:     body.unit_price,
      status:         body.status,
      assigned_to:    body.assigned_to,
      work_done:      body.work_done,
      return_reason:  body.return_reason,
      has_image:      !!body.image_data,
    }))

    // 2. Verify job exists
    const jobRow = await db.prepare('SELECT job_id FROM jobs WHERE job_id = ?').bind(jobId).first()
    if (!jobRow) {
      console.error('[POST /machines] job not found:', jobId)
      return c.json({ success: false, error: `Job ${jobId} not found` }, 404)
    }

    // 3. Extract and coerce all fields
    const description:   string      = coerceStr(body.description)
    const conditionText: string|null = coerceStr(body.condition_text) || null
    const imageData:     string|null = body.image_data ? String(body.image_data) : null
    const quantity:      number      = Math.max(1, coerceInt(body.quantity, 1))
    const unitPrice:     number      = Math.max(0, coerceFloat(body.unit_price, 0))
    const assignedTo:    string|null = coerceStr(body.assigned_to) || null
    const workDone:      string|null = coerceStr(body.work_done) || null
    const returnReason:  string|null = coerceStr(body.return_reason) || null
    const status:        string      = ALL_STATUSES.includes(body.status) ? String(body.status) : 'Under Repair'

    // 4. Validate required field
    if (!description) {
      return c.json({ success: false, error: 'description is required' }, 400)
    }

    // 5. Status-dependent validation
    if (status === 'Repaired' && !workDone) {
      return c.json({ success: false, error: 'work_done is required when status is Repaired' }, 400)
    }
    if (status === 'Return' && !returnReason) {
      return c.json({ success: false, error: 'return_reason is required when status is Return' }, 400)
    }

    console.log('[POST /machines] inserting — description:', description, 'status:', status, 'qty:', quantity, 'price:', unitPrice, 'assigned:', assignedTo)

    // 6. Insert machine row
    const insertResult = await db.prepare(
      `INSERT INTO machines
         (job_id, description, condition_text, image_data,
          quantity, unit_price, status, assigned_to, work_done, return_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      jobId,
      description,
      conditionText,
      imageData,
      quantity,
      unitPrice,
      status,
      assignedTo,
      workDone,
      returnReason
    ).run()

    const lastId = insertResult.meta?.last_row_id
    console.log('[POST /machines] inserted id:', lastId)

    if (!lastId) {
      console.error('[POST /machines] no last_row_id from insert')
      return c.json({ success: false, error: 'Machine inserted but ID not returned' }, 500)
    }

    // 7. Fetch and return the new machine
    const newMachine = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(lastId).first()
    if (!newMachine) {
      console.error('[POST /machines] machine id:', lastId, 'not found after insert')
      return c.json({ success: false, error: 'Machine created but could not be retrieved' }, 500)
    }

    console.log('[POST /machines] success — id:', lastId)
    return c.json({ success: true, data: newMachine }, 201)

  } catch (err: any) {
    console.error('[POST /machines] FATAL error:', err?.message, err?.stack)
    return c.json({ success: false, error: err?.message || 'Failed to add machine' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// PUT /api/jobs/:jobId/machines/:machineId  ← CRITICAL FIX
// ────────────────────────────────────────────────────────────────────────────
jobs.put('/:jobId/machines/:machineId', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')
    const machineId = c.req.param('machineId')
    const jobId     = c.req.param('jobId')

    // 1. Parse body safely
    const { body, parseError } = await safeParseBody(c)
    if (parseError) return c.json({ success: false, error: parseError }, 400)

    console.log('[PUT /machines] machineId:', machineId, 'jobId:', jobId, 'role:', role, 'body keys:', Object.keys(body))

    // 2. Fetch existing machine — try by id+job_id first, then by id alone
    let machine: any = await db.prepare(
      'SELECT * FROM machines WHERE id = ? AND job_id = ?'
    ).bind(machineId, jobId).first()

    if (!machine) {
      machine = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first()
    }

    if (!machine) {
      console.error('[PUT /machines] machine not found:', machineId)
      return c.json({ success: false, error: 'Machine not found' }, 404)
    }

    // 3. Permission check for staff
    if (role !== 'admin') {
      if (machine.assigned_to !== staffName) {
        return c.json({ success: false, error: 'Not assigned to you' }, 403)
      }
    }

    // 4. Build update values — start from existing, override only provided fields
    let desc       = machine.description
    let cond       = machine.condition_text
    let img        = machine.image_data      // keep existing image unless explicitly provided
    let qty        = machine.quantity
    let price      = machine.unit_price
    let assignedTo = machine.assigned_to

    if (role === 'admin') {
      if (body.description    !== undefined) desc       = coerceStr(body.description)    || machine.description
      if (body.condition_text !== undefined) cond       = coerceStr(body.condition_text) || null
      if (body.image_data     !== undefined) img        = body.image_data ? String(body.image_data) : machine.image_data
      if (body.quantity       !== undefined) qty        = Math.max(1, coerceInt(body.quantity, machine.quantity))
      if (body.unit_price     !== undefined) price      = Math.max(0, coerceFloat(body.unit_price, machine.unit_price))
      if (body.assigned_to    !== undefined) assignedTo = coerceStr(body.assigned_to) || null
    }

    // 5. Status — both admin and staff can change
    const allowedStatuses = role === 'admin' ? ALL_STATUSES : ACTIVE_STATUSES
    let newStatus = machine.status
    if (body.status !== undefined) {
      if (allowedStatuses.includes(body.status)) {
        newStatus = String(body.status)
      } else {
        console.warn('[PUT /machines] invalid/disallowed status:', body.status, '— keeping:', machine.status)
      }
    }

    // 6. Work fields — both admin and staff can provide
    const workDone     = body.work_done     !== undefined ? (coerceStr(body.work_done)     || null) : machine.work_done
    const returnReason = body.return_reason !== undefined ? (coerceStr(body.return_reason) || null) : machine.return_reason

    // 7. Status-dependent validation
    if (newStatus === 'Repaired' && !workDone) {
      return c.json({ success: false, error: 'work_done is required when status is Repaired' }, 400)
    }
    if (newStatus === 'Return' && !returnReason) {
      return c.json({ success: false, error: 'return_reason is required when status is Return' }, 400)
    }

    // 8. Delivery fields (admin only)
    let deliveryInfo = machine.delivery_info
    let deliveredAt  = machine.delivered_at
    if (role === 'admin' && newStatus === 'Delivered') {
      if (body.delivery_info !== undefined) {
        deliveryInfo = typeof body.delivery_info === 'string'
          ? body.delivery_info
          : JSON.stringify(body.delivery_info)
      }
      if (!deliveredAt) deliveredAt = new Date().toISOString()
    }

    console.log('[PUT /machines] updating id:', machineId, '→ status:', newStatus, 'work_done:', workDone)

    // 9. Execute update
    await db.prepare(
      `UPDATE machines
         SET description=?, condition_text=?, image_data=?,
             quantity=?, unit_price=?, status=?,
             assigned_to=?, work_done=?, return_reason=?,
             delivery_info=?, delivered_at=?,
             updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(
      desc, cond, img,
      qty, price, newStatus,
      assignedTo, workDone, returnReason,
      deliveryInfo, deliveredAt,
      machineId
    ).run()

    // 10. Fetch and return updated record
    const updated = await db.prepare('SELECT * FROM machines WHERE id = ?').bind(machineId).first()
    console.log('[PUT /machines] success — id:', machineId, 'status:', (updated as any)?.status)

    return c.json({ success: true, data: updated })

  } catch (err: any) {
    console.error('[PUT /machines] FATAL error:', err?.message, err?.stack)
    return c.json({ success: false, error: err?.message || 'Failed to update machine' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// DELETE /api/jobs/:jobId/machines/:machineId
// ────────────────────────────────────────────────────────────────────────────
jobs.delete('/:jobId/machines/:machineId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  if (c.get('user') !== OWNER_EMAIL) return c.json({ success: false, error: 'Owner required' }, 403)
  try {
    const db        = c.env.DB
    const machineId = c.req.param('machineId')
    const existing  = await db.prepare('SELECT id FROM machines WHERE id = ?').bind(machineId).first()
    if (!existing) return c.json({ success: false, error: 'Machine not found' }, 404)
    await db.prepare('DELETE FROM machines WHERE id = ?').bind(machineId).run()
    return c.json({ success: true, data: { deleted: true } })
  } catch (err: any) {
    console.error('[DELETE /machines] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to delete machine' }, 500)
  }
})

// ────────────────────────────────────────────────────────────────────────────
// POST /api/jobs/:jobId/deliver
// ────────────────────────────────────────────────────────────────────────────
jobs.post('/:jobId/deliver', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')

    const { body } = await safeParseBody(c)

    const machines = await db.prepare('SELECT * FROM machines WHERE job_id = ?').bind(jobId).all()
    if (!machines.results.length) {
      return c.json({ success: false, error: 'No machines on this job' }, 400)
    }

    const eligible = (machines.results as any[]).every(
      (m: any) => ['Repaired', 'Return', 'Delivered'].includes(m.status)
    )
    if (!eligible) {
      return c.json({ success: false, error: 'All machines must be Repaired or Return before delivery' }, 400)
    }

    const diStr      = body.delivery_info ? JSON.stringify(body.delivery_info) : null
    const deliveredAt = new Date().toISOString()

    await db.prepare(
      `UPDATE machines
         SET status='Delivered', delivery_info=?, delivered_at=?, updated_at=CURRENT_TIMESTAMP
       WHERE job_id=? AND status IN ('Repaired','Return')`
    ).bind(diStr, deliveredAt, jobId).run()

    await db.prepare(
      'UPDATE jobs SET updated_at=CURRENT_TIMESTAMP WHERE job_id=?'
    ).bind(jobId).run()

    const updatedMachines = await db.prepare(
      'SELECT * FROM machines WHERE job_id = ? ORDER BY created_at ASC'
    ).bind(jobId).all()
    const job = await db.prepare('SELECT * FROM jobs WHERE job_id = ?').bind(jobId).first()

    return c.json({ success: true, data: sanitizeJob(job, updatedMachines.results as any[], 'admin') })

  } catch (err: any) {
    console.error('[POST /deliver] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Delivery failed' }, 500)
  }
})

export default jobs
