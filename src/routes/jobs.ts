import { Hono } from 'hono'
import { verify } from 'hono/jwt'
import { refreshJobSummary } from '../index'

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
  if (!h?.startsWith('Bearer ')) return c.json({ success: false, error: 'Unauthorized' }, 401)
  try {
    const payload = await verify(h.substring(7), c.env?.JWT_SECRET || JWT_SECRET, 'HS256') as any
    c.set('role',       String(payload.role       || ''))
    c.set('user',       String(payload.sub        || ''))
    c.set('staff_name', String(payload.staff_name || ''))
  } catch (e: any) {
    return c.json({ success: false, error: 'Invalid token' }, 401)
  }
  await next()
})

// ── Helpers ──────────────────────────────────────────────────────────────────
function safeStr(v: any, fallback = ''): string {
  if (v === null || v === undefined) return fallback
  return String(v).trim()
}
function safeNum(v: any, fallback = 0): number {
  const n = Number(v); return isFinite(n) ? n : fallback
}

function sanitizeMachine(m: any, role: string, staffName?: string) {
  const out: any = { ...m }
  if (role !== 'admin') {
    delete out.unit_price
    delete out.delivery_info
    delete out.delivered_at
    delete out.return_reason
    if (out.status === 'Delivered') out.status = 'Repaired'
    out.is_mine = out.assigned_to === staffName
  }
  return out
}

function sanitizeJob(job: any, machines: any[], role: string, staffName?: string, summary?: any) {
  const sm           = machines.map(m => sanitizeMachine(m, role, staffName))
  const grandTotal   = machines.reduce((s, m) => s + safeNum(m.quantity, 1) * safeNum(m.unit_price, 0), 0)
  // Use summary table counts if available, else calculate
  const totalM       = summary ? summary.total_machines  : machines.length
  const repairedC    = summary ? summary.repaired_count   : machines.filter(m => m.status === 'Repaired').length
  const returnC      = summary ? summary.returned_count   : machines.filter(m => m.status === 'Return').length
  const pendingC     = summary ? summary.pending_count    : machines.filter(m => m.status === 'Under Repair').length
  const deliveredC   = summary ? summary.delivered_count  : machines.filter(m => m.status === 'Delivered').length
  const allDone      = totalM > 0 && pendingC === 0
  const allDelivered = totalM > 0 && deliveredC === totalM

  const out: any = {
    ...job,
    machines: sm,
    machine_count: totalM,
    repaired_count: repairedC,
    returned_count: returnC,
    pending_count: pendingC,
    delivered_count: deliveredC,
    all_repaired: allDone,
    all_delivered: allDelivered,
  }
  if (role !== 'admin') {
    delete out.customer_mobile
    delete out.customer_address
    delete out.amount_received
    out.has_mine = machines.some(m => m.assigned_to === staffName)
  } else {
    out.grand_total = grandTotal
    out.balance     = grandTotal - safeNum(job.amount_received, 0)
  }
  return out
}

// ── Add timeline event ────────────────────────────────────────────────────────
async function addTimeline(db: D1Database, machineId: number, jobId: string, eventType: string, note: string, actor: string) {
  try {
    await db.prepare(
      `INSERT INTO machine_timeline (machine_id, job_id, event_type, event_note, actor) VALUES (?,?,?,?,?)`
    ).bind(machineId, jobId, eventType, note, actor).run()
  } catch {}
}

// ── GET /api/jobs ─────────────────────────────────────────────────────────────
jobs.get('/', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')

    let jobRows: any, machineRows: any, summaryRows: any

    if (role === 'admin') {
      jobRows     = await db.prepare(`SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC`).all()
      machineRows = await db.prepare(`SELECT * FROM machines WHERE deleted_at IS NULL ORDER BY created_at ASC`).all()
    } else {
      jobRows = await db.prepare(
        `SELECT DISTINCT j.* FROM jobs j
         INNER JOIN machines m ON m.job_id = j.job_id
         WHERE m.status != 'Delivered' AND m.deleted_at IS NULL AND j.deleted_at IS NULL
         ORDER BY j.created_at DESC`
      ).all()
      machineRows = await db.prepare(
        `SELECT m.* FROM machines m WHERE m.status != 'Delivered' AND m.deleted_at IS NULL ORDER BY m.created_at ASC`
      ).all()
    }

    // Load all summaries at once
    summaryRows = await db.prepare(`SELECT * FROM job_summary`).all()
    const summaryMap: Record<string, any> = {}
    ;(summaryRows.results as any[]).forEach((s: any) => { summaryMap[s.job_id] = s })

    const jobList = (jobRows.results as any[]).map((job: any) => {
      const mList = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
      return sanitizeJob(job, mList, role, staffName, summaryMap[job.job_id])
    })
    return c.json(jobList)
  } catch (err: any) {
    console.error('[GET /jobs]', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to load jobs' }, 500)
  }
})

// ── GET /api/jobs/all ─────────────────────────────────────────────────────────
jobs.get('/all', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    const [jobRows, machineRows, custRows, summaryRows] = await Promise.all([
      db.prepare(`SELECT * FROM jobs WHERE deleted_at IS NULL ORDER BY created_at DESC`).all(),
      db.prepare(`SELECT * FROM machines WHERE deleted_at IS NULL ORDER BY created_at ASC`).all(),
      db.prepare(`SELECT * FROM customer_profiles ORDER BY last_seen DESC`).all(),
      db.prepare(`SELECT * FROM job_summary`).all(),
    ])
    const summaryMap: Record<string, any> = {}
    ;(summaryRows.results as any[]).forEach((s: any) => { summaryMap[s.job_id] = s })

    const jobList = (jobRows.results as any[]).map((job: any) => {
      const mList = (machineRows.results as any[]).filter((m: any) => m.job_id === job.job_id)
      return sanitizeJob(job, mList, 'admin', '', summaryMap[job.job_id])
    })
    return c.json({ jobs: jobList, customers: custRows.results, synced_at: new Date().toISOString() })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── GET /api/jobs/search ──────────────────────────────────────────────────────
jobs.get('/search', async (c) => {
  try {
    const db   = c.env.DB
    const role = c.get('role')
    const q    = safeStr(c.req.query('q'))
    if (!q || q.length < 2) return c.json([])

    const like = `%${q}%`
    const rows = await db.prepare(
      `SELECT DISTINCT j.job_id, j.customer_name, j.customer_mobile, j.created_at
       FROM jobs j
       LEFT JOIN machines m ON m.job_id = j.job_id
       WHERE j.deleted_at IS NULL AND (
         j.job_id LIKE ? OR
         j.customer_name LIKE ? OR
         j.customer_mobile LIKE ? OR
         m.description LIKE ?
       )
       ORDER BY j.created_at DESC LIMIT 20`
    ).bind(like, like, like, like).all()

    const results = (rows.results as any[]).map((r: any) => {
      if (role !== 'admin') { delete r.customer_mobile }
      return r
    })
    return c.json(results)
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/jobs/barcode/:jobId ──────────────────────────────────────────────
jobs.get('/barcode/:jobId', async (c) => {
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const job   = await db.prepare(`SELECT * FROM jobs WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).first()
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404)
    return c.json({ success: true, job_id: jobId })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/jobs/health ──────────────────────────────────────────────────────
jobs.get('/system-health', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    const [totalJobs, totalMachines, deliveredJobs, deletedJobs, lastBackup, summaryRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as cnt FROM jobs WHERE deleted_at IS NULL`).first() as any,
      db.prepare(`SELECT COUNT(*) as cnt FROM machines WHERE deleted_at IS NULL`).first() as any,
      db.prepare(`SELECT COUNT(*) as cnt FROM jobs WHERE deleted_at IS NULL AND job_id IN (SELECT DISTINCT job_id FROM job_summary WHERE delivered_count = total_machines AND total_machines > 0)`).first() as any,
      db.prepare(`SELECT COUNT(*) as cnt FROM jobs WHERE deleted_at IS NOT NULL`).first() as any,
      db.prepare(`SELECT backup_key, created_at FROM monthly_backups ORDER BY created_at DESC LIMIT 1`).first() as any,
      db.prepare(`SELECT SUM(total_machines) as tm, SUM(repaired_count) as rc FROM job_summary`).first() as any,
    ])
    return c.json({
      success: true,
      total_jobs:       (totalJobs as any)?.cnt || 0,
      total_machines:   (totalMachines as any)?.cnt || 0,
      delivered_jobs:   (deliveredJobs as any)?.cnt || 0,
      soft_deleted:     (deletedJobs as any)?.cnt || 0,
      last_backup:      lastBackup,
      est_db_size_mb:   (((totalMachines as any)?.cnt || 0) * 0.05).toFixed(2),
    })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/jobs/ai-suggest/:machineDesc ─────────────────────────────────────
jobs.get('/ai-suggest', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db   = c.env.DB
    const desc = safeStr(c.req.query('desc'))
    const cond = safeStr(c.req.query('cond'))
    if (!desc) return c.json({ success: false, error: 'desc required' }, 400)

    const like = `%${desc.split(' ')[0]}%`
    const rows = await db.prepare(
      `SELECT work_done, return_reason, status, created_at, updated_at
       FROM machines
       WHERE description LIKE ? AND work_done IS NOT NULL AND deleted_at IS NULL
       ORDER BY created_at DESC LIMIT 50`
    ).bind(like).all()

    const items = rows.results as any[]
    if (!items.length) return c.json({ success: true, suggestions: [], message: 'No historical data found' })

    // Aggregate most common repairs
    const workMap: Record<string, number> = {}
    items.forEach((m: any) => {
      if (m.work_done) {
        const key = m.work_done.toLowerCase().slice(0, 60)
        workMap[key] = (workMap[key] || 0) + 1
      }
    })
    const sortedWork = Object.entries(workMap).sort((a, b) => b[1] - a[1]).slice(0, 5)

    // Average repair time (updated_at - created_at in hours)
    const times = items
      .filter((m: any) => m.updated_at && m.created_at && m.status !== 'Under Repair')
      .map((m: any) => {
        const d = new Date(m.updated_at).getTime() - new Date(m.created_at).getTime()
        return d / (1000 * 3600)
      })
      .filter(t => t > 0 && t < 720)
    const avgHours = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null

    const suggestions = sortedWork.map(([work, count]) => ({
      repair: work,
      frequency: count,
      pct: Math.round((count / items.length) * 100)
    }))

    return c.json({
      success: true,
      query: desc,
      total_similar: items.length,
      suggestions,
      avg_repair_hours: avgHours,
      message: `Based on ${items.length} historical repairs`
    })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/jobs/:jobId ──────────────────────────────────────────────────────
jobs.get('/:jobId', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')
    const jobId     = c.req.param('jobId')

    const job = await db.prepare(`SELECT * FROM jobs WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).first()
    if (!job) return c.json({ success: false, error: 'Not found' }, 404)

    let mq: any
    if (role === 'admin') {
      mq = await db.prepare(`SELECT * FROM machines WHERE job_id = ? AND deleted_at IS NULL ORDER BY created_at ASC`).bind(jobId).all()
    } else {
      mq = await db.prepare(`SELECT * FROM machines WHERE job_id = ? AND status != 'Delivered' AND deleted_at IS NULL ORDER BY created_at ASC`).bind(jobId).all()
    }
    const summary = await db.prepare(`SELECT * FROM job_summary WHERE job_id = ?`).bind(jobId).first()
    return c.json(sanitizeJob(job, mq.results, role, staffName, summary))
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── POST /api/jobs ─────────────────────────────────────────────────────────────
jobs.post('/', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB

    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    console.log('[POST /jobs] body:', JSON.stringify({ ...body }))

    const customerName    = safeStr(body.customer_name)
    const customerMobile  = safeStr(body.customer_mobile)  || null
    const customerAddress = safeStr(body.customer_address) || null
    const notes           = safeStr(body.notes)            || null

    if (!customerName) return c.json({ success: false, error: 'customer_name is required' }, 400)

    // Gap-less job ID
    const existing = await db.prepare(`SELECT job_id FROM jobs ORDER BY created_at ASC`).all()
    const usedNums = new Set(
      (existing.results as any[]).map((r: any) => {
        const n = parseInt(String(r.job_id || '').replace('C-', ''), 10)
        return isNaN(n) ? 0 : n
      })
    )
    let next = 1; while (usedNums.has(next)) next++
    const jobId = `C-${String(next).padStart(3, '0')}`

    await db.prepare(
      `INSERT INTO jobs (job_id, customer_name, customer_mobile, customer_address, notes) VALUES (?,?,?,?,?)`
    ).bind(jobId, customerName, customerMobile, customerAddress, notes).run()

    // Initialize job_summary
    await db.prepare(
      `INSERT OR IGNORE INTO job_summary (job_id, total_machines, repaired_count, returned_count, pending_count, delivered_count)
       VALUES (?,0,0,0,0,0)`
    ).bind(jobId).run()

    const newJob: any = await db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).bind(jobId).first()
    console.log('[POST /jobs] created:', jobId)
    return c.json({ success: true, ...newJob }, 201)
  } catch (err: any) {
    console.error('[POST /jobs] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to create job' }, 500)
  }
})

// ── PUT /api/jobs/:jobId ──────────────────────────────────────────────────────
jobs.put('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const existing: any = await db.prepare(`SELECT * FROM jobs WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).first()
    if (!existing) return c.json({ success: false, error: 'Job not found' }, 404)

    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }

    const name    = body.customer_name    !== undefined ? safeStr(body.customer_name)    : existing.customer_name
    const mobile  = body.customer_mobile  !== undefined ? (safeStr(body.customer_mobile)  || null) : existing.customer_mobile
    const addr    = body.customer_address !== undefined ? (safeStr(body.customer_address) || null) : existing.customer_address
    const amt     = body.amount_received  !== undefined ? safeNum(body.amount_received, 0) : safeNum(existing.amount_received, 0)
    const notesv  = body.notes            !== undefined ? (safeStr(body.notes) || null) : existing.notes

    await db.prepare(
      `UPDATE jobs SET customer_name=?,customer_mobile=?,customer_address=?,amount_received=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE job_id=?`
    ).bind(name, mobile, addr, amt, notesv, jobId).run()

    const updated: any = await db.prepare(`SELECT * FROM jobs WHERE job_id = ?`).bind(jobId).first()
    return c.json({ success: true, ...updated })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── DELETE /api/jobs/:jobId (soft delete) ────────────────────────────────────
jobs.delete('/:jobId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const actor = c.get('user')

    // Soft delete: set deleted_at
    const job: any = await db.prepare(`SELECT * FROM jobs WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).first()
    if (!job) return c.json({ success: false, error: 'Job not found' }, 404)

    await db.prepare(`UPDATE jobs SET deleted_at=CURRENT_TIMESTAMP WHERE job_id=?`).bind(jobId).run()
    await db.prepare(`UPDATE machines SET deleted_at=CURRENT_TIMESTAMP WHERE job_id=?`).bind(jobId).run()

    // Save to trash
    const purgeAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    const machines = await db.prepare(`SELECT * FROM machines WHERE job_id=?`).bind(jobId).all()
    await db.prepare(
      `INSERT INTO trash_items (item_type, item_id, item_data, deleted_by, purge_at) VALUES (?,?,?,?,?)`
    ).bind('job', jobId, JSON.stringify({ job, machines: machines.results }), actor, purgeAt).run()

    return c.json({ success: true, message: 'Job moved to trash (30-day recovery window)' })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── GET /api/jobs/:jobId/timeline ─────────────────────────────────────────────
jobs.get('/:jobId/timeline', async (c) => {
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const rows  = await db.prepare(
      `SELECT t.*, m.description FROM machine_timeline t
       LEFT JOIN machines m ON m.id = t.machine_id
       WHERE t.job_id = ? ORDER BY t.created_at ASC`
    ).bind(jobId).all()
    return c.json({ success: true, timeline: rows.results })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── GET /api/jobs/:jobId/machines/:mid/images ─────────────────────────────────
jobs.get('/:jobId/machines/:machineId/images', async (c) => {
  try {
    const db        = c.env.DB
    const machineId = c.req.param('machineId')
    const rows = await db.prepare(
      `SELECT id, caption, created_at FROM machine_images WHERE machine_id = ? ORDER BY created_at ASC`
    ).bind(machineId).all()
    return c.json({ success: true, images: rows.results })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── POST /api/jobs/:jobId/machines ────────────────────────────────────────────
jobs.post('/:jobId/machines', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const actor = c.get('staff_name') || c.get('user')

    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    console.log('[POST /machines] jobId:', jobId, 'desc:', body.description)

    const description   = safeStr(body.description)
    const conditionText = safeStr(body.condition_text)    || null
    const imageData     = (body.image_data && String(body.image_data).length > 10) ? String(body.image_data) : null
    const quantity      = Math.max(1, Math.floor(safeNum(body.quantity, 1)))
    const unitPrice     = Math.max(0, safeNum(body.unit_price, 0))
    const assignedTo    = safeStr(body.assigned_to)       || null
    const workDone      = safeStr(body.work_done)         || null
    const returnReason  = safeStr(body.return_reason)     || null
    const audioNote     = safeStr(body.audio_note)        || null
    const status        = ALL_STATUSES.includes(body.status) ? body.status : 'Under Repair'

    if (!description) return c.json({ success: false, error: 'description is required' }, 400)
    if (status === 'Repaired' && !workDone) return c.json({ success: false, error: 'work_done required for Repaired' }, 400)
    if (status === 'Return'   && !returnReason) return c.json({ success: false, error: 'return_reason required for Return' }, 400)

    const jobRow = await db.prepare(`SELECT job_id FROM jobs WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).first()
    if (!jobRow) return c.json({ success: false, error: `Job ${jobId} not found` }, 404)

    const result = await db.prepare(
      `INSERT INTO machines (job_id,description,condition_text,image_data,quantity,unit_price,status,assigned_to,work_done,return_reason,audio_note)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).bind(jobId, description, conditionText, imageData, quantity, unitPrice, status, assignedTo, workDone, returnReason, audioNote).run()

    const lastId = result.meta?.last_row_id
    const newMachine = await db.prepare(`SELECT * FROM machines WHERE id = ?`).bind(lastId).first()

    // Timeline
    await addTimeline(db, lastId, jobId, 'received', `Machine received: ${description}`, actor)
    if (assignedTo) await addTimeline(db, lastId, jobId, 'assigned', `Assigned to ${assignedTo}`, actor)

    // Refresh job summary
    await refreshJobSummary(db, jobId)

    return c.json({ success: true, machine: newMachine, ...newMachine }, 201)
  } catch (err: any) {
    console.error('[POST /machines] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed to add machine' }, 500)
  }
})

// ── POST /api/jobs/:jobId/machines/:machineId/images ──────────────────────────
jobs.post('/:jobId/machines/:machineId/images', async (c) => {
  try {
    const db        = c.env.DB
    const machineId = c.req.param('machineId')

    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }

    const imageData = safeStr(body.image_data)
    const caption   = safeStr(body.caption) || null
    if (!imageData || imageData.length < 10) return c.json({ success: false, error: 'image_data required' }, 400)

    const machine = await db.prepare(`SELECT id FROM machines WHERE id = ?`).bind(machineId).first()
    if (!machine) return c.json({ success: false, error: 'Machine not found' }, 404)

    const result = await db.prepare(
      `INSERT INTO machine_images (machine_id, image_data, caption) VALUES (?,?,?)`
    ).bind(machineId, imageData, caption).run()

    return c.json({ success: true, id: result.meta?.last_row_id })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── PUT /api/jobs/:jobId/machines/:machineId ──────────────────────────────────
jobs.put('/:jobId/machines/:machineId', async (c) => {
  try {
    const db        = c.env.DB
    const role      = c.get('role')
    const staffName = c.get('staff_name')
    const jobId     = c.req.param('jobId')
    const machineId = c.req.param('machineId')
    const actor     = staffName || c.get('user')

    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }

    const existing: any = await db.prepare(`SELECT * FROM machines WHERE id = ? AND deleted_at IS NULL`).bind(machineId).first()
    if (!existing) return c.json({ success: false, error: 'Machine not found' }, 404)

    if (role !== 'admin' && existing.assigned_to !== staffName) {
      return c.json({ success: false, error: 'Not assigned to you' }, 403)
    }

    let desc       = existing.description
    let cond       = existing.condition_text
    let img        = existing.image_data
    let qty        = existing.quantity
    let price      = existing.unit_price
    let assignedTo = existing.assigned_to
    let audioNote  = existing.audio_note

    if (role === 'admin') {
      if (body.description    !== undefined) desc = safeStr(body.description) || existing.description
      if (body.condition_text !== undefined) cond = safeStr(body.condition_text) || null
      if (body.image_data     !== undefined) img  = (body.image_data && String(body.image_data).length > 10) ? String(body.image_data) : null
      if (body.quantity       !== undefined) qty  = Math.max(1, Math.floor(safeNum(body.quantity, existing.quantity)))
      if (body.unit_price     !== undefined) price = Math.max(0, safeNum(body.unit_price, existing.unit_price))
      if (body.assigned_to    !== undefined) assignedTo = safeStr(body.assigned_to) || null
    }
    if (body.audio_note !== undefined) audioNote = safeStr(body.audio_note) || null

    const allowedStatuses = role === 'admin' ? ALL_STATUSES : ACTIVE_STATUSES
    let newStatus = existing.status
    if (body.status !== undefined) {
      newStatus = allowedStatuses.includes(body.status) ? body.status : existing.status
    }

    const workDone     = body.work_done     !== undefined ? (safeStr(body.work_done)     || null) : existing.work_done
    const returnReason = body.return_reason !== undefined ? (safeStr(body.return_reason) || null) : existing.return_reason

    if (newStatus === 'Repaired' && !workDone) return c.json({ success: false, error: 'work_done required for Repaired' }, 400)
    if (newStatus === 'Return'   && !returnReason) return c.json({ success: false, error: 'return_reason required for Return' }, 400)

    let deliveryInfo = existing.delivery_info
    let deliveredAt  = existing.delivered_at
    if (role === 'admin' && newStatus === 'Delivered') {
      if (body.delivery_info !== undefined) {
        deliveryInfo = typeof body.delivery_info === 'string' ? body.delivery_info : JSON.stringify(body.delivery_info)
      }
      if (!deliveredAt) deliveredAt = new Date().toISOString()
    }

    await db.prepare(
      `UPDATE machines SET description=?,condition_text=?,image_data=?,quantity=?,unit_price=?,
         status=?,assigned_to=?,work_done=?,return_reason=?,delivery_info=?,delivered_at=?,
         audio_note=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=?`
    ).bind(desc, cond, img, qty, price, newStatus, assignedTo, workDone, returnReason,
           deliveryInfo, deliveredAt, audioNote, machineId).run()

    const updated: any = await db.prepare(`SELECT * FROM machines WHERE id = ?`).bind(machineId).first()

    // Timeline events
    if (newStatus !== existing.status) {
      const eventMap: Record<string, string> = {
        'Repaired':   'repair_completed',
        'Return':     'marked_return',
        'Delivered':  'delivered',
        'Under Repair': 'status_changed',
      }
      await addTimeline(db, Number(machineId), jobId, eventMap[newStatus] || 'status_changed',
        `Status changed to ${newStatus}${workDone ? ': ' + workDone.slice(0, 80) : ''}`, actor)
    }
    if (body.image_data && (!existing.image_data || body.image_data !== existing.image_data)) {
      await addTimeline(db, Number(machineId), jobId, 'photo_uploaded', 'Photo updated', actor)
    }
    if (assignedTo && assignedTo !== existing.assigned_to) {
      await addTimeline(db, Number(machineId), jobId, 'assigned', `Assigned to ${assignedTo}`, actor)
    }

    await refreshJobSummary(db, jobId)

    return c.json({ success: true, machine: updated, ...updated })
  } catch (err: any) {
    console.error('[PUT /machines] error:', err?.message)
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── DELETE /api/jobs/:jobId/machines/:machineId (soft delete) ─────────────────
jobs.delete('/:jobId/machines/:machineId', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db        = c.env.DB
    const machineId = c.req.param('machineId')
    const jobId     = c.req.param('jobId')
    const actor     = c.get('user')

    const existing = await db.prepare(`SELECT * FROM machines WHERE id = ? AND deleted_at IS NULL`).bind(machineId).first()
    if (!existing) return c.json({ success: false, error: 'Machine not found' }, 404)

    await db.prepare(`UPDATE machines SET deleted_at=CURRENT_TIMESTAMP WHERE id=?`).bind(machineId).run()

    const purgeAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
    await db.prepare(
      `INSERT INTO trash_items (item_type, item_id, item_data, deleted_by, purge_at) VALUES (?,?,?,?,?)`
    ).bind('machine', machineId, JSON.stringify(existing), actor, purgeAt).run()

    await refreshJobSummary(db, jobId)
    return c.json({ success: true, message: 'Machine moved to trash' })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Failed' }, 500)
  }
})

// ── POST /api/jobs/:jobId/deliver ─────────────────────────────────────────────
jobs.post('/:jobId/deliver', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db    = c.env.DB
    const jobId = c.req.param('jobId')
    const actor = c.get('staff_name') || c.get('user')

    let body: any = {}
    try { body = await c.req.json() } catch { body = {} }

    const machines = await db.prepare(`SELECT * FROM machines WHERE job_id = ? AND deleted_at IS NULL`).bind(jobId).all()
    if (!machines.results.length) return c.json({ success: false, error: 'No machines on this job' }, 400)

    const eligible = (machines.results as any[]).every(
      (m: any) => ['Repaired', 'Return', 'Delivered'].includes(m.status)
    )
    if (!eligible) return c.json({ success: false, error: 'All machines must be Repaired or Return before delivery' }, 400)

    const diStr       = body.delivery_info ? JSON.stringify(body.delivery_info) : null
    const deliveredAt = new Date().toISOString()

    await db.prepare(
      `UPDATE machines SET status='Delivered',delivery_info=?,delivered_at=?,updated_at=CURRENT_TIMESTAMP
       WHERE job_id=? AND status IN ('Repaired','Return') AND deleted_at IS NULL`
    ).bind(diStr, deliveredAt, jobId).run()

    await db.prepare(`UPDATE jobs SET updated_at=CURRENT_TIMESTAMP WHERE job_id=?`).bind(jobId).run()

    // Timeline for each delivered machine
    for (const m of machines.results as any[]) {
      if (m.status !== 'Delivered') {
        await addTimeline(db, m.id, jobId, 'delivered', `Delivered${diStr ? ' via ' + (body.delivery_info?.type || 'unknown') : ''}`, actor)
      }
    }

    await refreshJobSummary(db, jobId)

    const updated = await db.prepare(`SELECT * FROM machines WHERE job_id=? ORDER BY created_at ASC`).bind(jobId).all()
    const job     = await db.prepare(`SELECT * FROM jobs WHERE job_id=?`).bind(jobId).first()
    const summary = await db.prepare(`SELECT * FROM job_summary WHERE job_id=?`).bind(jobId).first()

    return c.json({ success: true, job: sanitizeJob(job, updated.results, 'admin', '', summary) })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message || 'Delivery failed' }, 500)
  }
})

// ── GET /api/jobs/trash ───────────────────────────────────────────────────────
jobs.get('/trash/list', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db   = c.env.DB
    const rows = await db.prepare(
      `SELECT * FROM trash_items ORDER BY deleted_at DESC LIMIT 100`
    ).all()
    return c.json({ success: true, items: rows.results })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── POST /api/jobs/trash/restore ──────────────────────────────────────────────
jobs.post('/trash/restore', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { trash_id } = body
    if (!trash_id) return c.json({ success: false, error: 'trash_id required' }, 400)

    const item: any = await db.prepare(`SELECT * FROM trash_items WHERE id=?`).bind(trash_id).first()
    if (!item) return c.json({ success: false, error: 'Trash item not found' }, 404)

    if (item.item_type === 'job') {
      await db.prepare(`UPDATE jobs SET deleted_at=NULL WHERE job_id=?`).bind(item.item_id).run()
      await db.prepare(`UPDATE machines SET deleted_at=NULL WHERE job_id=?`).bind(item.item_id).run()
    } else if (item.item_type === 'machine') {
      await db.prepare(`UPDATE machines SET deleted_at=NULL WHERE id=?`).bind(item.item_id).run()
    }

    await db.prepare(`DELETE FROM trash_items WHERE id=?`).bind(trash_id).run()
    return c.json({ success: true, message: `${item.item_type} restored` })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

// ── POST /api/jobs/bulk ───────────────────────────────────────────────────────
jobs.post('/bulk', async (c) => {
  if (c.get('role') !== 'admin') return c.json({ success: false, error: 'Admin only' }, 403)
  try {
    const db = c.env.DB
    let body: any = {}
    try { body = await c.req.json() } catch {
      return c.json({ success: false, error: 'Invalid JSON body' }, 400)
    }
    const { action, job_ids } = body
    if (!action || !Array.isArray(job_ids) || !job_ids.length) {
      return c.json({ success: false, error: 'action and job_ids[] required' }, 400)
    }

    let affected = 0
    if (action === 'archive') {
      // Soft delete
      for (const jid of job_ids) {
        await db.prepare(`UPDATE jobs SET deleted_at=CURRENT_TIMESTAMP WHERE job_id=? AND deleted_at IS NULL`).bind(jid).run()
        await db.prepare(`UPDATE machines SET deleted_at=CURRENT_TIMESTAMP WHERE job_id=? AND deleted_at IS NULL`).bind(jid).run()
        affected++
      }
    } else if (action === 'export') {
      const ph  = job_ids.map(() => '?').join(',')
      const jobs = await db.prepare(`SELECT id,job_id,customer_name,customer_mobile,customer_address,amount_received,notes,created_at,updated_at FROM jobs WHERE job_id IN (${ph})`).bind(...job_ids).all()
      // Exclude image_data from bulk export to avoid payload size issues
      const macs = await db.prepare(`SELECT id,job_id,description,condition_text,quantity,unit_price,status,assigned_to,work_done,return_reason,delivery_info,delivered_at,created_at,updated_at FROM machines WHERE job_id IN (${ph}) AND deleted_at IS NULL`).bind(...job_ids).all()
      return c.json({ success: true, jobs: jobs.results, machines: macs.results })
    }

    return c.json({ success: true, affected })
  } catch (err: any) {
    return c.json({ success: false, error: err?.message }, 500)
  }
})

export default jobs
