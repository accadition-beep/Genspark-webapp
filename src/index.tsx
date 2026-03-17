import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'

// ── Types ─────────────────────────────────────────────────────────────────────
type Bindings = {
  DB: D1Database
  PRODUCT_IMAGES: R2Bucket
  JWT_SECRET: string
}
type Variables = {
  userId: number
  userRole: string
  userEmail: string
  userName: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()
app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'] }))

// ── Auth helpers ──────────────────────────────────────────────────────────────
async function signToken(payload: Record<string, unknown>, secret: string) {
  const key = new TextEncoder().encode(secret)
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}
async function verifyToken(token: string, secret: string) {
  const key = new TextEncoder().encode(secret)
  const { payload } = await jwtVerify(token, key)
  return payload
}

// Runtime seed — fires on login if admin row missing
async function seedAdmin(db: D1Database) {
  const exists = await db.prepare('SELECT id FROM users WHERE email=?')
    .bind('bilalkhan1108@gmail.com').first()
  if (!exists) {
    const hash = await bcrypt.hash('0010', 10)
    await db.prepare(
      'INSERT OR IGNORE INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,1)'
    ).bind('Bilal Khan', 'bilalkhan1108@gmail.com', hash, 'admin').run()
  }
}

// ── Middleware ────────────────────────────────────────────────────────────────
const authMiddleware = async (c: any, next: any) => {
  const header = c.req.header('Authorization') || ''
  const token  = header.replace('Bearer ', '').trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET || 'aes-default-secret')
    c.set('userId',   payload.sub  as number)
    c.set('userRole', payload.role as string)
    c.set('userEmail',payload.email as string)
    c.set('userName', payload.name  as string)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}
const adminOnly = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}

// ── Valid statuses ───────────────────────────────────────────────────────────
const MACHINE_STATUSES = ['received','diagnosing','in_progress','waiting_parts','ready','returned','delivered']
const JOB_STATUSES     = ['received','diagnosing','in_progress','waiting_parts','ready','returned','delivered']

// ── Job status auto-update ────────────────────────────────────────────────────
async function updateJobStatus(db: D1Database, jobId: string) {
  const { results: machines } = await db.prepare(
    'SELECT status FROM machines WHERE job_id=?'
  ).bind(jobId).all<any>()
  if (!machines.length) return
  const job = await db.prepare('SELECT status FROM jobs WHERE id=?').bind(jobId).first<any>()
  if (job?.status === 'delivered') return

  const priority = ['received','diagnosing','in_progress','waiting_parts','ready','returned']
  let bestStatus = 'returned'
  for (const m of machines) {
    const idx = priority.indexOf(m.status)
    const bestIdx = priority.indexOf(bestStatus)
    if (idx !== -1 && idx < bestIdx) bestStatus = m.status
  }
  await db.prepare(`UPDATE jobs SET status=?,updated_at=datetime('now') WHERE id=?`)
    .bind(bestStatus, jobId).run()
}

// ── Dashboard stats cache helper ──────────────────────────────────────────────
async function refreshDashboardStats(db: D1Database) {
  try {
    const today     = new Date().toISOString().split('T')[0]
    const monthStr  = today.substring(0, 7) // YYYY-MM
    await db.prepare(`
      UPDATE dashboard_stats SET
        total_jobs     = (SELECT COUNT(*) FROM jobs),
        active_jobs    = (SELECT COUNT(*) FROM jobs WHERE status != 'delivered'),
        ready_jobs     = (SELECT COUNT(*) FROM jobs WHERE status = 'ready'),
        delivered_jobs = (SELECT COUNT(*) FROM jobs WHERE status = 'delivered'),
        today_jobs     = (SELECT COUNT(*) FROM jobs WHERE DATE(created_at) = ?),
        month_jobs     = (SELECT COUNT(*) FROM jobs WHERE strftime('%Y-%m',created_at) = ?),
        last_updated   = datetime('now')
      WHERE id = 1
    `).bind(today, monthStr).run()
  } catch (_) {}
}

// ── API: Auth ─────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (c) => {
  try { await seedAdmin(c.env.DB) } catch (_) {}
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { email, password } = body
  if (!email || !password) return c.json({ error: 'Email and password required' }, 400)
  const user = await c.env.DB.prepare(
    'SELECT * FROM users WHERE email=? AND active=1'
  ).bind(email).first<any>()
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const token = await signToken(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    c.env.JWT_SECRET || 'aes-default-secret'
  )
  return c.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare(
    'SELECT id,name,email,role,active FROM users WHERE id=?'
  ).bind(c.get('userId')).first<any>()
  return c.json(user)
})

// ── API: Customers ────────────────────────────────────────────────────────────
// Lookup by mobile for auto-fill (unique index ensures one record per mobile)
app.get('/api/customers/by-mobile', authMiddleware, async (c) => {
  const mobile = c.req.query('mobile') || ''
  const cust = await c.env.DB.prepare(
    'SELECT name, mobile, mobile2, address FROM customers WHERE mobile=?'
  ).bind(mobile).first<any>()
  return c.json(cust || null)
})

// ── API: Dashboard Analytics (cache-first, <100ms) ────────────────────────────
app.get('/api/analytics', authMiddleware, async (c) => {
  const isAdminRole = c.get('userRole') === 'admin'
  const userId = c.get('userId')
  const today = new Date().toISOString().split('T')[0]
  const monthStart = today.substring(0, 8) + '01'

  if (isAdminRole) {
    // Use cache table for admin — fast path
    const [stats, byStatus, byStaff] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM dashboard_stats WHERE id=1').first<any>(),
      c.env.DB.prepare(`
        SELECT j.status, COUNT(j.id) AS cnt FROM jobs j GROUP BY j.status ORDER BY cnt DESC
      `).all<any>(),
      c.env.DB.prepare(`
        SELECT u.name, COUNT(m.id) AS cnt, SUM(m.charges) AS total_charges
        FROM machines m JOIN users u ON m.assigned_staff_id=u.id
        GROUP BY u.id, u.name ORDER BY cnt DESC LIMIT 10
      `).all<any>(),
    ])
    return c.json({
      total:     stats?.total_jobs    || 0,
      pending:   stats?.active_jobs   || 0,
      ready:     stats?.ready_jobs    || 0,
      completed: stats?.delivered_jobs || 0,
      today:     stats?.today_jobs    || 0,
      thisMonth: stats?.month_jobs    || 0,
      byStatus:  byStatus.results,
      byStaff:   byStaff.results,
      cached:    true,
    })
  }

  // Staff: count only jobs with machines assigned to them
  const sWhere  = `WHERE EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`
  const sActive = `WHERE j.status!='delivered' AND EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`
  const sDone   = `WHERE j.status='delivered' AND EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`
  const sToday  = `WHERE DATE(j.created_at)='${today}' AND EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`
  const sMonth  = `WHERE j.created_at>='${monthStart}' AND EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`
  const sReady  = `WHERE j.status='ready' AND EXISTS (SELECT 1 FROM machines ms WHERE ms.job_id=j.id AND ms.assigned_staff_id=${userId})`

  const [total, pending, ready, completed, todayCount, monthCount] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sWhere}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sActive}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sReady}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sDone}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sToday}`).first<any>(),
    c.env.DB.prepare(`SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${sMonth}`).first<any>(),
  ])

  return c.json({
    total: total?.cnt || 0,
    pending: pending?.cnt || 0,
    ready: ready?.cnt || 0,
    completed: completed?.cnt || 0,
    today: todayCount?.cnt || 0,
    thisMonth: monthCount?.cnt || 0,
    byStatus: [],
    byStaff: [],
  })
})

// ── API: Jobs — list (paginated, 20 per page) ─────────────────────────────────
app.get('/api/jobs', authMiddleware, async (c) => {
  const status   = c.req.query('status') || ''
  const search   = c.req.query('q')      || ''
  const staffId  = c.req.query('staff_id') || ''
  const from     = c.req.query('from')   || ''
  const to       = c.req.query('to')     || ''
  const page     = Math.max(1, parseInt(c.req.query('page') || '1'))
  const limit    = 20
  const offset   = (page - 1) * limit
  const isAdmin  = c.get('userRole') === 'admin'
  const userId   = c.get('userId')
  const conds: string[] = []
  const params: any[] = []

  if (status) { conds.push('j.status=?'); params.push(status) }
  if (!isAdmin) {
    conds.push(`EXISTS (SELECT 1 FROM machines ms2 WHERE ms2.job_id=j.id AND ms2.assigned_staff_id=?)`)
    params.push(userId)
    conds.push("j.status != 'delivered'")
  }
  if (staffId && isAdmin) {
    conds.push(`EXISTS (SELECT 1 FROM machines ms2 WHERE ms2.job_id=j.id AND ms2.assigned_staff_id=?)`)
    params.push(staffId)
  }
  if (search) {
    conds.push(`(j.snap_name LIKE ? OR j.snap_mobile LIKE ? OR j.id LIKE ? OR
      EXISTS (SELECT 1 FROM machines sm WHERE sm.job_id=j.id AND (sm.product_name LIKE ? OR sm.brand LIKE ?)))`)
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (from) { conds.push('DATE(j.created_at)>=?'); params.push(from) }
  if (to)   { conds.push('DATE(j.created_at)<=?'); params.push(to) }

  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

  // Count total for pagination
  const countRow = await c.env.DB.prepare(`
    SELECT COUNT(DISTINCT j.id) AS cnt FROM jobs j ${where}
  `).bind(...params).first<any>()
  const total = countRow?.cnt || 0

  const { results } = await c.env.DB.prepare(`
    SELECT j.id, j.snap_name, j.snap_mobile, j.status,
           j.received_amount, j.created_at, j.updated_at,
           (SELECT COUNT(*) FROM machines WHERE job_id=j.id) AS machine_count,
           (SELECT GROUP_CONCAT(product_name, ', ') FROM machines WHERE job_id=j.id LIMIT 3) AS machine_names,
           (SELECT SUM(charges) FROM machines WHERE job_id=j.id) AS total_charges,
           (SELECT url FROM machine_images mi
            JOIN machines m2 ON mi.machine_id=m2.id
            WHERE m2.job_id=j.id ORDER BY mi.id LIMIT 1) AS thumb
    FROM jobs j ${where}
    ORDER BY j.created_at DESC LIMIT ? OFFSET ?
  `).bind(...params, limit, offset).all<any>()

  return c.json({
    results: results.map((r: any) => ({
      ...r,
      balance_due: isAdmin ? Math.max(0, (r.total_charges || 0) - (r.received_amount || 0)) : undefined
    })),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) }
  })
})

// ── API: Jobs — create ────────────────────────────────────────────────────────
app.post('/api/jobs', authMiddleware, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { customer_name, customer_mobile } = body
  if (!customer_name || !customer_mobile)
    return c.json({ error: 'customer_name and customer_mobile are required' }, 400)

  await c.env.DB.prepare('UPDATE job_counter SET last_seq=last_seq+1 WHERE id=1').run()
  const counter = await c.env.DB.prepare('SELECT last_seq FROM job_counter WHERE id=1').first<any>()

  const prefixSetting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key='job_prefix'").first<any>()
  const digitsSetting = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key='job_seq_digits'").first<any>()
  const prefix = prefixSetting?.value || 'C'
  const digits = parseInt(digitsSetting?.value || '3')
  const jobId = `${prefix}-${String(counter.last_seq).padStart(digits, '0')}`

  // Auto-fill: ON CONFLICT(mobile) only updates if new record; first entry stores all data
  await c.env.DB.prepare(
    `INSERT INTO customers(name,mobile,mobile2,address) VALUES(?,?,?,?)
     ON CONFLICT(mobile) DO UPDATE SET
       name=excluded.name, mobile2=excluded.mobile2,
       address=excluded.address, updated_at=datetime('now')`
  ).bind(customer_name, customer_mobile,
         body.customer_mobile2 || null, body.customer_address || null).run()

  const cust = await c.env.DB.prepare(
    'SELECT id FROM customers WHERE mobile=?'
  ).bind(customer_mobile).first<any>()

  const isAdmin = c.get('userRole') === 'admin'
  await c.env.DB.prepare(
    `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,
                      snap_address,note,received_amount)
     VALUES(?,?,?,?,?,?,?,?)`
  ).bind(jobId, cust.id, customer_name, customer_mobile,
         body.customer_mobile2 || null, body.customer_address || null,
         body.note || null,
         isAdmin ? (body.received_amount || 0) : 0).run()

  // Refresh dashboard stats cache
  try { await refreshDashboardStats(c.env.DB) } catch (_) {}

  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>()
  return c.json(job, 201)
})

// ── API: Jobs — detail ────────────────────────────────────────────────────────
app.get('/api/jobs/:id', authMiddleware, async (c) => {
  const id  = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<any>()
  if (!job) return c.json({ error: 'Not found' }, 404)

  const isAdmin = c.get('userRole') === 'admin'
  const userId  = c.get('userId')

  if (!isAdmin) {
    const access = await c.env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM machines WHERE job_id=? AND assigned_staff_id=?`
    ).bind(id, userId).first<any>()
    if (job.status === 'delivered' || !access?.cnt)
      return c.json({ error: 'Forbidden' }, 403)
  }

  const { results: machines } = await c.env.DB.prepare(`
    SELECT m.*,
           u.name AS staff_name,
           (SELECT json_group_array(
             json_object('id',mi.id,'url',mi.url,'r2_object_key',mi.r2_object_key)
           ) FROM machine_images mi WHERE mi.machine_id=m.id) AS images_json
    FROM machines m
    LEFT JOIN users u ON m.assigned_staff_id=u.id
    WHERE m.job_id=?
    ORDER BY m.id
  `).bind(id).all<any>()

  const enriched = machines.map((m: any) => ({
    ...m,
    images: (() => { try { return JSON.parse(m.images_json || '[]') } catch { return [] } })()
  }))
  const totalCharges = enriched.reduce((s: number, m: any) => s + (m.charges || 0), 0)

  const responseJob = isAdmin ? job : {
    id: job.id, snap_name: job.snap_name, snap_mobile: null,
    snap_address: job.snap_address, note: job.note,
    status: job.status, created_at: job.created_at, updated_at: job.updated_at
  }

  return c.json({
    ...responseJob,
    machines: enriched,
    total_charges: isAdmin ? totalCharges : undefined,
    balance_due: isAdmin ? Math.max(0, totalCharges - (job.received_amount || 0)) : undefined
  })
})

// ── API: Jobs — update ────────────────────────────────────────────────────────
app.put('/api/jobs/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const isAdmin = c.get('userRole') === 'admin'
  if (!isAdmin) return c.json({ error: 'Forbidden' }, 403)

  const fields: string[] = []
  const vals: any[] = []
  const allowed = [
    'note', 'status',
    'delivery_method', 'delivery_receiver_name', 'delivery_receiver_mobile',
    'delivery_courier_name', 'delivery_tracking', 'delivery_address',
    'snap_name', 'snap_mobile', 'snap_mobile2', 'snap_address',
    'received_amount'
  ]
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  if (body.status === 'delivered') fields.push(`delivered_at=datetime('now')`)
  if (!fields.length) return c.json({ error: 'No fields to update' }, 400)
  fields.push(`updated_at=datetime('now')`)
  vals.push(id)
  await c.env.DB.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()

  // Refresh dashboard stats cache on job update
  try { await refreshDashboardStats(c.env.DB) } catch (_) {}

  return c.json({ ok: true })
})

// ── API: Jobs — delete (admin only) ──────────────────────────────────────────
app.delete('/api/jobs/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  const { results: imgs } = await c.env.DB.prepare(
    `SELECT mi.r2_object_key FROM machine_images mi
     JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?`
  ).bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key && c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  }
  const { results: audioMachines } = await c.env.DB.prepare(
    'SELECT audio_note_key FROM machines WHERE job_id=? AND audio_note_key IS NOT NULL'
  ).bind(id).all<any>()
  for (const m of audioMachines) {
    if (c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(m.audio_note_key) } catch (_) {}
  }
  await c.env.DB.prepare('DELETE FROM assignment_requests WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()

  try { await refreshDashboardStats(c.env.DB) } catch (_) {}
  return c.json({ ok: true })
})

// ── API: Machines — create ────────────────────────────────────────────────────
app.post('/api/jobs/:id/machines', authMiddleware, async (c) => {
  const jobId = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  if (!body.product_name) return c.json({ error: 'product_name required' }, 400)
  const isAdmin = c.get('userRole') === 'admin'
  const result = await c.env.DB.prepare(
    `INSERT INTO machines(job_id,product_name,product_complaint,charges,quantity,assigned_staff_id,status,brand,work_done)
     VALUES(?,?,?,?,?,?,?,?,?)`
  ).bind(
    jobId, body.product_name, body.product_complaint || null,
    isAdmin ? (body.charges || 0) : 0,
    body.quantity || 1,
    body.assigned_staff_id || null,
    'received',
    body.brand || null,
    body.work_done || null
  ).run()
  await updateJobStatus(c.env.DB, jobId)
  return c.json({ id: result.meta.last_row_id }, 201)
})

// ── API: Machines — update ────────────────────────────────────────────────────
app.put('/api/machines/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const isAdmin = c.get('userRole') === 'admin'
  const userId  = c.get('userId')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(id).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)

  if (!isAdmin) {
    if (machine.assigned_staff_id !== userId)
      return c.json({ error: 'Not assigned to this machine' }, 403)
    const staffFields: string[] = []
    const staffVals: any[] = []
    if ('status' in body)           { staffFields.push('status=?');            staffVals.push(body.status) }
    if ('product_complaint' in body) { staffFields.push('product_complaint=?'); staffVals.push(body.product_complaint) }
    if ('work_done' in body)        { staffFields.push('work_done=?');         staffVals.push(body.work_done) }
    if (!staffFields.length) return c.json({ error: 'Nothing to update' }, 400)
    staffFields.push(`updated_at=datetime('now')`)
    staffVals.push(id)
    await c.env.DB.prepare(`UPDATE machines SET ${staffFields.join(',')} WHERE id=?`).bind(...staffVals).run()
    await updateJobStatus(c.env.DB, machine.job_id)
    return c.json({ ok: true })
  }

  const fields: string[] = []
  const vals: any[] = []
  const allowed = ['product_name','product_complaint','quantity','assigned_staff_id','status','charges','brand','work_done']
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  fields.push(`updated_at=datetime('now')`)
  vals.push(id)
  await c.env.DB.prepare(`UPDATE machines SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  await updateJobStatus(c.env.DB, machine.job_id)
  return c.json({ ok: true })
})

// ── API: Machines — delete (admin only) ──────────────────────────────────────
app.delete('/api/machines/:id', authMiddleware, adminOnly, async (c) => {
  const id      = c.req.param('id')
  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(id).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)
  const { results: imgs } = await c.env.DB.prepare(
    'SELECT r2_object_key FROM machine_images WHERE machine_id=?'
  ).bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key && c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  }
  if (machine.audio_note_key && c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  await c.env.DB.prepare('DELETE FROM assignment_requests WHERE machine_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE id=?').bind(id).run()
  if (machine) await updateJobStatus(c.env.DB, machine.job_id)
  return c.json({ ok: true })
})

// ── API: Images ───────────────────────────────────────────────────────────────
app.post('/api/machines/:id/images', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  const isAdmin = c.get('userRole') === 'admin'
  if (!isAdmin && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)

  const formData = await c.req.formData()
  const file     = formData.get('image') as File | null
  if (!file) return c.json({ error: 'No image field' }, 400)
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const key = `machines/${machineId}/${Date.now()}-${safeFilename}`

  // If R2 is not available (e.g. local dev), store a placeholder
  if (!c.env.PRODUCT_IMAGES) {
    const url = `/api/images/${key}`
    await c.env.DB.prepare(
      'INSERT INTO machine_images(machine_id,r2_object_key,url) VALUES(?,?,?)'
    ).bind(machineId, key, url).run()
    return c.json({ url, key }, 201)
  }

  await c.env.PRODUCT_IMAGES.put(key, await file.arrayBuffer(), {
    httpMetadata: { contentType: file.type || 'image/jpeg' }
  })
  const url = `/api/images/${key}`
  await c.env.DB.prepare(
    'INSERT INTO machine_images(machine_id,r2_object_key,url) VALUES(?,?,?)'
  ).bind(machineId, key, url).run()
  return c.json({ url, key }, 201)
})

// Serve image from R2 — authenticated, CORS headers for html2canvas
app.get('/api/images/*', authMiddleware, async (c) => {
  const key = c.req.path.slice('/api/images/'.length)
  if (!c.env.PRODUCT_IMAGES) return c.json({ error: 'Storage not available' }, 503)
  const obj = await c.env.PRODUCT_IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    }
  })
})

// Delete image — admin only
app.delete('/api/images/:imageId', authMiddleware, adminOnly, async (c) => {
  const imageId = c.req.param('imageId')
  const img     = await c.env.DB.prepare('SELECT * FROM machine_images WHERE id=?').bind(imageId).first<any>()
  if (!img) return c.json({ error: 'Not found' }, 404)
  if (img.r2_object_key && c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
  await c.env.DB.prepare('DELETE FROM machine_images WHERE id=?').bind(imageId).run()
  return c.json({ ok: true })
})

// ── API: Audio Notes ──────────────────────────────────────────────────────────
app.post('/api/machines/:id/audio', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  const isAdmin = c.get('userRole') === 'admin'
  if (!isAdmin && machine.assigned_staff_id !== c.get('userId'))
    return c.json({ error: 'Not assigned to this machine' }, 403)

  const formData = await c.req.formData()
  const file     = formData.get('audio') as File | null
  if (!file) return c.json({ error: 'No audio field' }, 400)

  if (machine.audio_note_key && c.env.PRODUCT_IMAGES) {
    try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  }

  const ext = file.type.includes('ogg') ? '.ogg' : file.type.includes('mp4') ? '.m4a' : '.webm'
  const key = `audio/${machineId}/${Date.now()}${ext}`

  if (c.env.PRODUCT_IMAGES) {
    await c.env.PRODUCT_IMAGES.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type || 'audio/webm' }
    })
  }

  const url = `/api/audio/${key}`
  await c.env.DB.prepare(
    `UPDATE machines SET audio_note_key=?,audio_note_url=?,updated_at=datetime('now') WHERE id=?`
  ).bind(key, url, machineId).run()
  return c.json({ url, key }, 201)
})

// Serve audio from R2
app.get('/api/audio/*', authMiddleware, async (c) => {
  const key = c.req.path.slice('/api/audio/'.length)
  if (!c.env.PRODUCT_IMAGES) return c.json({ error: 'Storage not available' }, 503)
  const obj = await c.env.PRODUCT_IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType || 'audio/webm',
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
    }
  })
})

// Delete audio — admin only
app.delete('/api/machines/:id/audio', authMiddleware, adminOnly, async (c) => {
  const machineId = c.req.param('id')
  const machine   = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machineId).first<any>()
  if (!machine) return c.json({ error: 'Not found' }, 404)
  if (machine.audio_note_key && c.env.PRODUCT_IMAGES)
    try { await c.env.PRODUCT_IMAGES.delete(machine.audio_note_key) } catch (_) {}
  await c.env.DB.prepare(
    `UPDATE machines SET audio_note_key=NULL,audio_note_url=NULL WHERE id=?`
  ).bind(machineId).run()
  return c.json({ ok: true })
})

// ── API: Assignment Requests ──────────────────────────────────────────────────
app.post('/api/requests', authMiddleware, async (c) => {
  if (c.get('userRole') === 'admin') return c.json({ error: 'Admins do not need to request' }, 400)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { machine_id, note } = body
  if (!machine_id) return c.json({ error: 'machine_id required' }, 400)

  const machine = await c.env.DB.prepare('SELECT * FROM machines WHERE id=?').bind(machine_id).first<any>()
  if (!machine) return c.json({ error: 'Machine not found' }, 404)

  const existing = await c.env.DB.prepare(
    `SELECT id FROM assignment_requests WHERE machine_id=? AND staff_id=? AND status='pending'`
  ).bind(machine_id, c.get('userId')).first<any>()
  if (existing) return c.json({ error: 'Request already pending' }, 409)

  const result = await c.env.DB.prepare(
    `INSERT INTO assignment_requests(machine_id,job_id,staff_id,note) VALUES(?,?,?,?)`
  ).bind(machine_id, machine.job_id, c.get('userId'), note || null).run()

  return c.json({ id: result.meta.last_row_id, status: 'pending' }, 201)
})

app.get('/api/requests', authMiddleware, adminOnly, async (c) => {
  const status = c.req.query('status') || 'pending'
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, u.name AS staff_name, u.email AS staff_email,
           m.product_name, m.product_complaint, m.job_id
    FROM assignment_requests r
    JOIN users u    ON r.staff_id   = u.id
    JOIN machines m ON r.machine_id = m.id
    WHERE r.status=?
    ORDER BY r.created_at DESC
    LIMIT 100
  `).bind(status).all<any>()
  return c.json(results)
})

app.get('/api/requests/count', authMiddleware, adminOnly, async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT COUNT(*) AS cnt FROM assignment_requests WHERE status='pending'`
  ).first<any>()
  return c.json({ count: row?.cnt || 0 })
})

app.put('/api/requests/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { action } = body
  if (!['approve','deny'].includes(action)) return c.json({ error: 'action must be approve or deny' }, 400)

  const req = await c.env.DB.prepare('SELECT * FROM assignment_requests WHERE id=?').bind(id).first<any>()
  if (!req) return c.json({ error: 'Not found' }, 404)
  if (req.status !== 'pending') return c.json({ error: 'Already resolved' }, 409)

  const newStatus = action === 'approve' ? 'approved' : 'denied'
  await c.env.DB.prepare(
    `UPDATE assignment_requests SET status=?,resolved_at=datetime('now') WHERE id=?`
  ).bind(newStatus, id).run()

  if (action === 'approve') {
    await c.env.DB.prepare(
      `UPDATE machines SET assigned_staff_id=?,updated_at=datetime('now') WHERE id=?`
    ).bind(req.staff_id, req.machine_id).run()
    await c.env.DB.prepare(
      `UPDATE assignment_requests SET status='denied',resolved_at=datetime('now')
       WHERE machine_id=? AND status='pending' AND id!=?`
    ).bind(req.machine_id, id).run()
  }

  return c.json({ ok: true, status: newStatus })
})

app.get('/api/my-requests', authMiddleware, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT r.*, m.product_name, m.job_id
    FROM assignment_requests r
    JOIN machines m ON r.machine_id = m.id
    WHERE r.staff_id=?
    ORDER BY r.created_at DESC
    LIMIT 50
  `).bind(c.get('userId')).all<any>()
  return c.json(results)
})

// ── API: Staff management ─────────────────────────────────────────────────────
app.get('/api/staff', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id,name,email,role,active,created_at FROM users ORDER BY name'
  ).all<any>()
  return c.json(results)
})

app.post('/api/staff', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { name, email, password, role, active } = body
  if (!name || !email || !password) return c.json({ error: 'name, email, password required' }, 400)
  const hash = await bcrypt.hash(password, 10)
  try {
    await c.env.DB.prepare(
      'INSERT INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,?)'
    ).bind(name, email, hash, role || 'staff', active !== undefined ? active : 1).run()
    return c.json({ ok: true }, 201)
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) return c.json({ error: 'Email already exists' }, 409)
    return c.json({ error: 'Failed to create staff' }, 500)
  }
})

app.put('/api/staff/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const fields: string[] = []
  const vals: any[] = []
  if (body.name)     { fields.push('name=?');  vals.push(body.name) }
  if (body.email)    { fields.push('email=?'); vals.push(body.email) }
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    fields.push('password_hash=?'); vals.push(hash)
  }
  if (body.role)               { fields.push('role=?');   vals.push(body.role) }
  if (body.active !== undefined) { fields.push('active=?'); vals.push(body.active) }
  if (!fields.length) return c.json({ error: 'Nothing to update' }, 400)
  vals.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  return c.json({ ok: true })
})

app.delete('/api/staff/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  if (parseInt(id) === c.get('userId')) return c.json({ error: 'Cannot delete yourself' }, 400)
  await c.env.DB.prepare('UPDATE users SET active=0 WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// ── API: Excel Backup / Restore ───────────────────────────────────────────────
app.get('/api/backup/export', authMiddleware, adminOnly, async (c) => {
  const [users, customers, jobs, machines, images] = await Promise.all([
    c.env.DB.prepare('SELECT id,name,email,role,active,created_at FROM users').all<any>(),
    c.env.DB.prepare('SELECT * FROM customers').all<any>(),
    c.env.DB.prepare('SELECT * FROM jobs').all<any>(),
    c.env.DB.prepare('SELECT * FROM machines').all<any>(),
    c.env.DB.prepare('SELECT * FROM machine_images').all<any>(),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.results),    'users')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(customers.results),'customers')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(jobs.results),     'jobs')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(machines.results), 'machines')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(images.results),   'machine_images')
  const buf  = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_backup_${date}.xlsx"`
    }
  })
})

app.post('/api/backup/import', authMiddleware, adminOnly, async (c) => {
  const fd   = await c.req.formData()
  const file = fd.get('file') as File | null
  if (!file) return c.json({ error: 'No file' }, 400)
  const wb        = XLSX.read(await file.arrayBuffer(), { type: 'buffer' })
  const customers = XLSX.utils.sheet_to_json(wb.Sheets['customers']      || XLSX.utils.aoa_to_sheet([])) as any[]
  const jobs      = XLSX.utils.sheet_to_json(wb.Sheets['jobs']           || XLSX.utils.aoa_to_sheet([])) as any[]
  const machines  = XLSX.utils.sheet_to_json(wb.Sheets['machines']       || XLSX.utils.aoa_to_sheet([])) as any[]
  const images    = XLSX.utils.sheet_to_json(wb.Sheets['machine_images'] || XLSX.utils.aoa_to_sheet([])) as any[]

  for (const r of customers) {
    await c.env.DB.prepare(
      `INSERT INTO customers(id,name,mobile,mobile2,address,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,mobile=excluded.mobile,
         mobile2=excluded.mobile2,address=excluded.address`
    ).bind(r.id,r.name,r.mobile,r.mobile2||null,r.address||null,r.created_at||'',r.updated_at||'').run()
  }
  for (const r of jobs) {
    await c.env.DB.prepare(
      `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,snap_address,
                        note,received_amount,status,delivery_method,delivery_receiver_name,
                        delivery_receiver_mobile,delivery_courier_name,delivery_tracking,
                        delivery_address,delivered_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,note=excluded.note,
         received_amount=excluded.received_amount`
    ).bind(r.id,r.customer_id,r.snap_name,r.snap_mobile,r.snap_mobile2||null,r.snap_address||null,
           r.note||null,r.received_amount||0,r.status,r.delivery_method||null,
           r.delivery_receiver_name||null,r.delivery_receiver_mobile||null,
           r.delivery_courier_name||null,r.delivery_tracking||null,r.delivery_address||null,
           r.delivered_at||null,r.created_at||'',r.updated_at||'').run()
  }
  for (const r of machines) {
    await c.env.DB.prepare(
      `INSERT INTO machines(id,job_id,product_name,product_complaint,charges,quantity,
                            assigned_staff_id,status,brand,work_done,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,charges=excluded.charges,
         work_done=excluded.work_done`
    ).bind(r.id,r.job_id,r.product_name,r.product_complaint||null,r.charges||0,r.quantity||1,
           r.assigned_staff_id||null,r.status||'received',r.brand||null,r.work_done||null,
           r.created_at||'',r.updated_at||'').run()
  }
  for (const r of images) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO machine_images(id,machine_id,r2_object_key,url,created_at)
       VALUES(?,?,?,?,?)`
    ).bind(r.id,r.machine_id,r.r2_object_key||null,r.url||'',r.created_at||'').run()
  }
  const maxJob = await c.env.DB.prepare(
    `SELECT MAX(CAST(SUBSTR(id,3) AS INTEGER)) AS m FROM jobs`
  ).first<any>()
  await c.env.DB.prepare('UPDATE job_counter SET last_seq=? WHERE id=1')
    .bind(maxJob?.m || 0).run()

  try { await refreshDashboardStats(c.env.DB) } catch (_) {}
  return c.json({ ok: true, restored: { customers: customers.length, jobs: jobs.length, machines: machines.length } })
})

// ── API: Reports ──────────────────────────────────────────────────────────────
// Admin staff report
app.get('/api/reports/staff', authMiddleware, adminOnly, async (c) => {
  const from    = c.req.query('from')     || ''
  const to      = c.req.query('to')       || ''
  const staffId = c.req.query('staff_id') || ''
  let q = `
    SELECT u.name AS staff_name, m.product_name AS "Product/Machine",
           m.brand AS "Brand", m.product_complaint AS "Problem",
           m.work_done AS "Work Done", m.status AS "Status",
           m.charges AS "Charges", m.quantity AS "Qty",
           j.id AS "Job ID", j.snap_name AS "Customer Name",
           j.snap_mobile AS "Phone",
           DATE(j.created_at) AS "Repair Date"
    FROM machines m
    JOIN jobs j ON m.job_id=j.id
    LEFT JOIN users u ON m.assigned_staff_id=u.id
    WHERE 1=1`
  const ps: any[] = []
  if (from)    { q += ' AND DATE(m.created_at)>=?'; ps.push(from) }
  if (to)      { q += ' AND DATE(m.created_at)<=?'; ps.push(to) }
  if (staffId) { q += ' AND m.assigned_staff_id=?'; ps.push(staffId) }
  q += ' ORDER BY u.name, m.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Staff Report')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_staff_report.xlsx"`
    }
  })
})

// Staff: export completed work — excludes customer mobile and financial data
app.get('/api/reports/my-jobs', authMiddleware, async (c) => {
  const from   = c.req.query('from') || ''
  const to     = c.req.query('to')   || ''
  const userId = c.get('userId')
  const isStaff = c.get('userRole') !== 'admin'
  let q
  if (isStaff) {
    // Staff export: Product, Problem, Work Done, Repair Date, Staff Name
    // NO mobile, NO charges/financial data
    q = `
      SELECT j.id AS "Job ID",
             j.snap_name AS "Customer Name",
             m.product_name AS "Product",
             m.brand AS "Brand",
             m.product_complaint AS "Problem Description",
             m.work_done AS "Work Done",
             m.status AS "Repair Status",
             u.name AS "Staff Name",
             DATE(j.created_at) AS "Repair Date"
      FROM machines m
      JOIN jobs j ON m.job_id=j.id
      LEFT JOIN users u ON m.assigned_staff_id=u.id
      WHERE m.assigned_staff_id=?`
  } else {
    q = `
      SELECT j.id AS "Job ID",
             j.snap_name AS "Customer Name",
             j.snap_mobile AS "Phone",
             m.product_name AS "Product",
             m.brand AS "Brand",
             m.product_complaint AS "Problem Description",
             m.work_done AS "Work Done",
             m.status AS "Repair Status",
             u.name AS "Staff Name",
             m.charges AS "Charges",
             DATE(j.created_at) AS "Repair Date"
      FROM machines m
      JOIN jobs j ON m.job_id=j.id
      LEFT JOIN users u ON m.assigned_staff_id=u.id
      WHERE m.assigned_staff_id=?`
  }
  const ps: any[] = [userId]
  if (from) { q += ' AND DATE(j.created_at)>=?'; ps.push(from) }
  if (to)   { q += ' AND DATE(j.created_at)<=?'; ps.push(to) }
  q += ' ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results.length ? results : [{}]), 'My Jobs')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_my_jobs_${date}.xlsx"`
    }
  })
})

app.get('/api/reports/jobs', authMiddleware, adminOnly, async (c) => {
  const from = c.req.query('from') || ''
  const to   = c.req.query('to')   || ''
  let q = `
    SELECT j.id, j.snap_name AS customer, j.snap_mobile AS mobile, j.status,
           j.received_amount,
           COUNT(m.id) AS machines,
           SUM(m.charges) AS total_charges,
           MAX(0, SUM(m.charges) - j.received_amount) AS balance_due,
           j.created_at
    FROM jobs j LEFT JOIN machines m ON j.id=m.job_id
    WHERE 1=1`
  const ps: any[] = []
  if (from) { q += ' AND DATE(j.created_at)>=?'; ps.push(from) }
  if (to)   { q += ' AND DATE(j.created_at)<=?'; ps.push(to) }
  q += ' GROUP BY j.id ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(q).bind(...ps).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Job Summary')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_job_summary.xlsx"`
    }
  })
})

// ── API: App Settings ─────────────────────────────────────────────────────────
app.get('/api/settings', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT key, value FROM app_settings').all<any>()
  const obj: Record<string, string> = {}
  for (const r of results) obj[r.key] = r.value
  return c.json(obj)
})

app.put('/api/settings', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const allowed = ['job_prefix', 'job_seq_digits']
  for (const k of allowed) {
    if (k in body) {
      await c.env.DB.prepare(
        'INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
      ).bind(k, String(body[k])).run()
    }
  }
  return c.json({ ok: true })
})

// ── API: Customer Data Export ─────────────────────────────────────────────────
app.get('/api/reports/customers', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare(`
    SELECT c.name AS customer_name, c.mobile AS phone_number,
           c.mobile2 AS alt_phone, c.address,
           COUNT(DISTINCT j.id) AS total_jobs,
           MIN(j.created_at) AS first_job, MAX(j.created_at) AS last_job
    FROM customers c
    LEFT JOIN jobs j ON j.customer_id = c.id
    GROUP BY c.id, c.name, c.mobile
    ORDER BY c.name
  `).all<any>()
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(results), 'Customer Data')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0, 10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_customers_${date}.xlsx"`
    }
  })
})

// ── API: Cleanup ──────────────────────────────────────────────────────────────
app.delete('/api/cleanup', authMiddleware, adminOnly, async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid JSON' }, 400) }
  const { from, to, full_reset } = body

  if (full_reset) {
    await c.env.DB.prepare('DELETE FROM assignment_requests').run()
    await c.env.DB.prepare('DELETE FROM machine_images').run()
    await c.env.DB.prepare('DELETE FROM machines').run()
    await c.env.DB.prepare('DELETE FROM jobs').run()
    await c.env.DB.prepare('DELETE FROM customers').run()
    await c.env.DB.prepare('UPDATE job_counter SET last_seq=0 WHERE id=1').run()
    try { await refreshDashboardStats(c.env.DB) } catch (_) {}
    return c.json({ ok: true, message: 'Full reset done — counter reset to C-001' })
  }

  if (from && to) {
    const { results: jobIds } = await c.env.DB.prepare(
      `SELECT id FROM jobs WHERE DATE(created_at)>=? AND DATE(created_at)<=? AND status!='delivered'`
    ).bind(from, to).all<any>()

    let deleted = 0
    for (const { id } of jobIds) {
      const { results: imgs } = await c.env.DB.prepare(
        `SELECT mi.r2_object_key FROM machine_images mi
         JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?`
      ).bind(id).all<any>()
      for (const img of imgs) {
        if (img.r2_object_key && c.env.PRODUCT_IMAGES) try { await c.env.PRODUCT_IMAGES.delete(img.r2_object_key) } catch (_) {}
      }
      await c.env.DB.prepare('DELETE FROM assignment_requests WHERE job_id=?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
      deleted++
    }
    try { await refreshDashboardStats(c.env.DB) } catch (_) {}
    return c.json({ ok: true, deleted })
  }
  return c.json({ error: 'Provide from/to dates or full_reset:true' }, 400)
})

// ── Static + SPA ──────────────────────────────────────────────────────────────
app.use('/static/*',      serveStatic({ root: './' }))
app.use('/icons/*',       serveStatic({ root: './public' }))
app.use('/sw.js',         serveStatic({ root: './public' }))
app.use('/manifest.json', serveStatic({ root: './public' }))
app.get('*', (c) => c.html(HTML_PAGE))

// ── HTML Shell ────────────────────────────────────────────────────────────────
const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="theme-color" content="#1a1a2e">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>ADITION ELECTRIC SOLUTION</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/static/style.css">
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body>
<div id="app"></div>
<script src="/static/app.js"></script>
</body>
</html>`

export default app
