import { Hono } from 'hono'
import { serveStatic } from 'hono/cloudflare-workers'
import { cors } from 'hono/cors'
import { SignJWT, jwtVerify } from 'jose'
import bcrypt from 'bcryptjs'
import * as XLSX from 'xlsx'

type Bindings = {
  DB: D1Database
  PRODUCT_IMAGES: R2Bucket
  JWT_SECRET: string
}

type Variables = {
  userId: number
  userRole: string
  userEmail: string
}

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>()

app.use('*', cors({ origin: '*', allowMethods: ['GET','POST','PUT','DELETE','OPTIONS'] }))

// ── helpers ──────────────────────────────────────────────────────────────────
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

async function seedAdmin(db: D1Database) {
  const exists = await db.prepare('SELECT id FROM users WHERE email=?')
    .bind('bilalkhan1108@gmail.com').first()
  if (!exists) {
    const hash = await bcrypt.hash('0010', 10)
    await db.prepare(
      'INSERT INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,1)'
    ).bind('Bilal Khan', 'bilalkhan1108@gmail.com', hash, 'admin').run()
  }
}

async function initSchema(db: D1Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'staff',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      mobile TEXT UNIQUE NOT NULL,
      mobile2 TEXT,
      address TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS job_counter (
      id INTEGER PRIMARY KEY CHECK(id=1),
      last_seq INTEGER NOT NULL DEFAULT 0
    );
    INSERT OR IGNORE INTO job_counter(id,last_seq) VALUES(1,0);
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      snap_name TEXT NOT NULL,
      snap_mobile TEXT NOT NULL,
      snap_mobile2 TEXT,
      snap_address TEXT,
      note TEXT,
      status TEXT NOT NULL DEFAULT 'under_repair',
      delivery_method TEXT,
      delivery_courier_name TEXT,
      delivery_tracking TEXT,
      delivery_address TEXT,
      delivered_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS machines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES jobs(id),
      product_name TEXT NOT NULL,
      product_complaint TEXT,
      charges REAL DEFAULT 0,
      quantity INTEGER NOT NULL DEFAULT 1,
      assigned_staff_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'under_repair',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS machine_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
      r2_object_key TEXT,
      url TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `)
}

// ── auth middleware ───────────────────────────────────────────────────────────
const authMiddleware = async (c: any, next: any) => {
  const header = c.req.header('Authorization') || ''
  const token = header.replace('Bearer ', '').trim()
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET || 'default-secret')
    c.set('userId', payload.sub as number)
    c.set('userRole', payload.role as string)
    c.set('userEmail', payload.email as string)
    await next()
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
}

const adminOnly = async (c: any, next: any) => {
  if (c.get('userRole') !== 'admin') return c.json({ error: 'Forbidden' }, 403)
  await next()
}

// ── API routes ────────────────────────────────────────────────────────────────

// Auth
app.post('/api/auth/login', async (c) => {
  try { await seedAdmin(c.env.DB) } catch(e) { /* already seeded or schema not ready */ }
  const { email, password } = await c.req.json()
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email=? AND active=1')
    .bind(email).first<any>()
  if (!user) return c.json({ error: 'Invalid credentials' }, 401)
  const ok = await bcrypt.compare(password, user.password_hash)
  if (!ok) return c.json({ error: 'Invalid credentials' }, 401)
  const token = await signToken(
    { sub: user.id, role: user.role, email: user.email, name: user.name },
    c.env.JWT_SECRET || 'default-secret'
  )
  return c.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } })
})

app.get('/api/auth/me', authMiddleware, async (c) => {
  const user = await c.env.DB.prepare('SELECT id,name,email,role,active FROM users WHERE id=?')
    .bind(c.get('userId')).first<any>()
  return c.json(user)
})

// Customers
app.get('/api/customers/by-mobile', authMiddleware, async (c) => {
  const mobile = c.req.query('mobile') || ''
  const cust = await c.env.DB.prepare('SELECT * FROM customers WHERE mobile=?').bind(mobile).first<any>()
  return c.json(cust || null)
})

app.post('/api/customers', authMiddleware, async (c) => {
  const { name, mobile, mobile2, address } = await c.req.json()
  await c.env.DB.prepare(
    `INSERT INTO customers(name,mobile,mobile2,address) VALUES(?,?,?,?)
     ON CONFLICT(mobile) DO UPDATE SET name=excluded.name,mobile2=excluded.mobile2,address=excluded.address,updated_at=datetime('now')`
  ).bind(name, mobile, mobile2||null, address||null).run()
  const cust = await c.env.DB.prepare('SELECT * FROM customers WHERE mobile=?').bind(mobile).first<any>()
  return c.json(cust)
})

// Jobs
app.get('/api/jobs', authMiddleware, async (c) => {
  const status = c.req.query('status') || ''
  const isAdmin = c.get('userRole') === 'admin'
  let query = `
    SELECT j.*, 
      (SELECT COUNT(*) FROM machines WHERE job_id=j.id) as machine_count,
      (SELECT SUM(charges) FROM machines WHERE job_id=j.id) as total_charges,
      (SELECT url FROM machine_images mi JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=j.id ORDER BY mi.id LIMIT 1) as thumb
    FROM jobs j`
  const conditions: string[] = []
  if (status) conditions.push(`j.status='${status}'`)
  if (!isAdmin) conditions.push(`j.status != 'delivered'`)
  if (conditions.length) query += ` WHERE ${conditions.join(' AND ')}`
  query += ' ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(query).all<any>()
  return c.json(results)
})

app.post('/api/jobs', authMiddleware, async (c) => {
  const body = await c.req.json()
  // Get next job ID
  await c.env.DB.prepare('UPDATE job_counter SET last_seq=last_seq+1 WHERE id=1').run()
  const counter = await c.env.DB.prepare('SELECT last_seq FROM job_counter WHERE id=1').first<any>()
  const seq = counter.last_seq
  const jobId = `C-${String(seq).padStart(3,'0')}`
  // Upsert customer
  await c.env.DB.prepare(
    `INSERT INTO customers(name,mobile,mobile2,address) VALUES(?,?,?,?)
     ON CONFLICT(mobile) DO UPDATE SET name=excluded.name,mobile2=excluded.mobile2,address=excluded.address,updated_at=datetime('now')`
  ).bind(body.customer_name, body.customer_mobile, body.customer_mobile2||null, body.customer_address||null).run()
  const cust = await c.env.DB.prepare('SELECT * FROM customers WHERE mobile=?').bind(body.customer_mobile).first<any>()
  await c.env.DB.prepare(
    `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,snap_address,note) VALUES(?,?,?,?,?,?,?)`
  ).bind(jobId, cust.id, body.customer_name, body.customer_mobile, body.customer_mobile2||null, body.customer_address||null, body.note||null).run()
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(jobId).first<any>()
  return c.json(job, 201)
})

app.get('/api/jobs/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const job = await c.env.DB.prepare('SELECT * FROM jobs WHERE id=?').bind(id).first<any>()
  if (!job) return c.json({ error: 'Not found' }, 404)
  const { results: machines } = await c.env.DB.prepare(
    `SELECT m.*, u.name as staff_name,
      (SELECT json_group_array(json_object('id',mi.id,'url',mi.url,'r2_object_key',mi.r2_object_key))
       FROM machine_images mi WHERE mi.machine_id=m.id) as images_json
     FROM machines m LEFT JOIN users u ON m.assigned_staff_id=u.id WHERE m.job_id=? ORDER BY m.id`
  ).bind(id).all<any>()
  const enriched = machines.map((m: any) => ({
    ...m,
    images: m.images_json ? JSON.parse(m.images_json) : []
  }))
  return c.json({ ...job, machines: enriched })
})

app.put('/api/jobs/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const vals: any[] = []
  const allowed = ['note','status','delivery_method','delivery_courier_name','delivery_tracking','delivery_address','snap_name','snap_mobile','snap_mobile2','snap_address']
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  if (body.status === 'delivered' && !body.delivered_at) {
    fields.push('delivered_at=datetime(\'now\')')
  }
  fields.push('updated_at=datetime(\'now\')')
  vals.push(id)
  await c.env.DB.prepare(`UPDATE jobs SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  return c.json({ ok: true })
})

app.delete('/api/jobs/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  // Delete images from R2
  const { results: imgs } = await c.env.DB.prepare(
    'SELECT mi.r2_object_key FROM machine_images mi JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?'
  ).bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key) await c.env.PRODUCT_IMAGES.delete(img.r2_object_key)
  }
  await c.env.DB.prepare('DELETE FROM machine_images WHERE machine_id IN (SELECT id FROM machines WHERE job_id=?)').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
  return c.json({ ok: true })
})

// Job status auto-update
async function updateJobStatus(db: D1Database, jobId: string) {
  const { results: machines } = await db.prepare(
    'SELECT status FROM machines WHERE job_id=?'
  ).bind(jobId).all<any>()
  if (!machines.length) return
  const job = await db.prepare('SELECT status FROM jobs WHERE id=?').bind(jobId).first<any>()
  if (job?.status === 'delivered') return
  const allReturned = machines.every((m: any) => m.status === 'returned')
  const allRepaired = machines.every((m: any) => m.status === 'repaired' || m.status === 'returned')
  const anyRepair = machines.some((m: any) => m.status === 'under_repair')
  let newStatus = 'under_repair'
  if (allReturned) newStatus = 'returned'
  else if (allRepaired) newStatus = 'repaired'
  else if (!anyRepair) newStatus = 'repaired'
  await db.prepare(`UPDATE jobs SET status=?,updated_at=datetime('now') WHERE id=?`)
    .bind(newStatus, jobId).run()
}

// Machines
app.post('/api/jobs/:id/machines', authMiddleware, async (c) => {
  const jobId = c.req.param('id')
  const body = await c.req.json()
  const isAdmin = c.get('userRole') === 'admin'
  const charges = isAdmin ? (body.charges || 0) : 0
  const result = await c.env.DB.prepare(
    `INSERT INTO machines(job_id,product_name,product_complaint,charges,quantity,assigned_staff_id,status)
     VALUES(?,?,?,?,?,?,?)`
  ).bind(jobId, body.product_name, body.product_complaint||null, charges, body.quantity||1, body.assigned_staff_id||null, 'under_repair').run()
  await updateJobStatus(c.env.DB, jobId)
  return c.json({ id: result.meta.last_row_id }, 201)
})

app.put('/api/machines/:id', authMiddleware, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const isAdmin = c.get('userRole') === 'admin'
  const fields: string[] = []
  const vals: any[] = []
  const allowed = ['product_name','product_complaint','quantity','assigned_staff_id','status']
  if (isAdmin) allowed.push('charges')
  for (const k of allowed) {
    if (k in body) { fields.push(`${k}=?`); vals.push(body[k]) }
  }
  fields.push('updated_at=datetime(\'now\')')
  vals.push(id)
  await c.env.DB.prepare(`UPDATE machines SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  const machine = await c.env.DB.prepare('SELECT job_id FROM machines WHERE id=?').bind(id).first<any>()
  if (machine) await updateJobStatus(c.env.DB, machine.job_id)
  return c.json({ ok: true })
})

app.delete('/api/machines/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  const machine = await c.env.DB.prepare('SELECT job_id FROM machines WHERE id=?').bind(id).first<any>()
  const { results: imgs } = await c.env.DB.prepare('SELECT r2_object_key FROM machine_images WHERE machine_id=?').bind(id).all<any>()
  for (const img of imgs) {
    if (img.r2_object_key) await c.env.PRODUCT_IMAGES.delete(img.r2_object_key)
  }
  await c.env.DB.prepare('DELETE FROM machine_images WHERE machine_id=?').bind(id).run()
  await c.env.DB.prepare('DELETE FROM machines WHERE id=?').bind(id).run()
  if (machine) await updateJobStatus(c.env.DB, machine.job_id)
  return c.json({ ok: true })
})

// Images
app.post('/api/machines/:id/images', authMiddleware, async (c) => {
  const machineId = c.req.param('id')
  const formData = await c.req.formData()
  const file = formData.get('image') as File | null
  if (!file) return c.json({ error: 'No image' }, 400)
  const key = `machines/${machineId}/${Date.now()}-${file.name}`
  const arrayBuffer = await file.arrayBuffer()
  await c.env.PRODUCT_IMAGES.put(key, arrayBuffer, {
    httpMetadata: { contentType: file.type }
  })
  // Generate public URL (requires R2 public bucket or custom domain)
  const url = `/api/images/${key}`
  await c.env.DB.prepare('INSERT INTO machine_images(machine_id,r2_object_key,url) VALUES(?,?,?)')
    .bind(machineId, key, url).run()
  return c.json({ url, key }, 201)
})

app.get('/api/images/*', authMiddleware, async (c) => {
  const key = c.req.path.replace('/api/images/', '')
  const obj = await c.env.PRODUCT_IMAGES.get(key)
  if (!obj) return c.json({ error: 'Not found' }, 404)
  const headers = new Headers()
  headers.set('Content-Type', obj.httpMetadata?.contentType || 'image/jpeg')
  headers.set('Cache-Control', 'public, max-age=86400')
  return new Response(obj.body, { headers })
})

app.delete('/api/images/:imageId', authMiddleware, adminOnly, async (c) => {
  const imageId = c.req.param('imageId')
  const img = await c.env.DB.prepare('SELECT * FROM machine_images WHERE id=?').bind(imageId).first<any>()
  if (!img) return c.json({ error: 'Not found' }, 404)
  if (img.r2_object_key) await c.env.PRODUCT_IMAGES.delete(img.r2_object_key)
  await c.env.DB.prepare('DELETE FROM machine_images WHERE id=?').bind(imageId).run()
  return c.json({ ok: true })
})

// Staff management (admin only)
app.get('/api/staff', authMiddleware, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id,name,email,role,active,created_at FROM users ORDER BY name').all<any>()
  return c.json(results)
})

app.post('/api/staff', authMiddleware, adminOnly, async (c) => {
  const { name, email, password, role, active } = await c.req.json()
  const hash = await bcrypt.hash(password, 10)
  await c.env.DB.prepare('INSERT INTO users(name,email,password_hash,role,active) VALUES(?,?,?,?,?)')
    .bind(name, email, hash, role||'staff', active!==undefined ? active : 1).run()
  return c.json({ ok: true }, 201)
})

app.put('/api/staff/:id', authMiddleware, adminOnly, async (c) => {
  const id = c.req.param('id')
  const body = await c.req.json()
  const fields: string[] = []
  const vals: any[] = []
  if (body.name) { fields.push('name=?'); vals.push(body.name) }
  if (body.email) { fields.push('email=?'); vals.push(body.email) }
  if (body.password) {
    const hash = await bcrypt.hash(body.password, 10)
    fields.push('password_hash=?'); vals.push(hash)
  }
  if (body.role) { fields.push('role=?'); vals.push(body.role) }
  if (body.active !== undefined) { fields.push('active=?'); vals.push(body.active) }
  vals.push(id)
  await c.env.DB.prepare(`UPDATE users SET ${fields.join(',')} WHERE id=?`).bind(...vals).run()
  return c.json({ ok: true })
})

// Excel Backup & Restore
app.get('/api/backup/export', authMiddleware, adminOnly, async (c) => {
  const [users, customers, jobs, machines, images] = await Promise.all([
    c.env.DB.prepare('SELECT id,name,email,role,active,created_at FROM users').all<any>(),
    c.env.DB.prepare('SELECT * FROM customers').all<any>(),
    c.env.DB.prepare('SELECT * FROM jobs').all<any>(),
    c.env.DB.prepare('SELECT * FROM machines').all<any>(),
    c.env.DB.prepare('SELECT * FROM machine_images').all<any>(),
  ])
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(users.results), 'users')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(customers.results), 'customers')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(jobs.results), 'jobs')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(machines.results), 'machines')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(images.results), 'machine_images')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  const date = new Date().toISOString().slice(0,10)
  return new Response(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="AES_backup_${date}.xlsx"`
    }
  })
})

app.post('/api/backup/import', authMiddleware, adminOnly, async (c) => {
  const formData = await c.req.formData()
  const file = formData.get('file') as File | null
  if (!file) return c.json({ error: 'No file' }, 400)
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'buffer' })
  const customers = XLSX.utils.sheet_to_json(wb.Sheets['customers'] || {}) as any[]
  const jobs = XLSX.utils.sheet_to_json(wb.Sheets['jobs'] || {}) as any[]
  const machines = XLSX.utils.sheet_to_json(wb.Sheets['machines'] || {}) as any[]
  const images = XLSX.utils.sheet_to_json(wb.Sheets['machine_images'] || {}) as any[]

  // Restore in order
  for (const c2 of customers) {
    await c.env.DB.prepare(
      `INSERT INTO customers(id,name,mobile,mobile2,address,created_at,updated_at) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET name=excluded.name,mobile=excluded.mobile,mobile2=excluded.mobile2,address=excluded.address`
    ).bind(c2.id,c2.name,c2.mobile,c2.mobile2||null,c2.address||null,c2.created_at||'',c2.updated_at||'').run()
  }
  for (const j of jobs) {
    await c.env.DB.prepare(
      `INSERT INTO jobs(id,customer_id,snap_name,snap_mobile,snap_mobile2,snap_address,note,status,delivery_method,delivery_courier_name,delivery_tracking,delivery_address,delivered_at,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,note=excluded.note`
    ).bind(j.id,j.customer_id,j.snap_name,j.snap_mobile,j.snap_mobile2||null,j.snap_address||null,j.note||null,
      j.status,j.delivery_method||null,j.delivery_courier_name||null,j.delivery_tracking||null,
      j.delivery_address||null,j.delivered_at||null,j.created_at||'',j.updated_at||'').run()
  }
  for (const m of machines) {
    await c.env.DB.prepare(
      `INSERT INTO machines(id,job_id,product_name,product_complaint,charges,quantity,assigned_staff_id,status,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET status=excluded.status,charges=excluded.charges`
    ).bind(m.id,m.job_id,m.product_name,m.product_complaint||null,m.charges||0,m.quantity||1,
      m.assigned_staff_id||null,m.status||'under_repair',m.created_at||'',m.updated_at||'').run()
  }
  for (const img of images) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO machine_images(id,machine_id,r2_object_key,url,created_at) VALUES(?,?,?,?,?)`
    ).bind(img.id,img.machine_id,img.r2_object_key||null,img.url||'',img.created_at||'').run()
  }
  // Reset job counter to max
  const maxJob = await c.env.DB.prepare(`SELECT MAX(CAST(SUBSTR(id,3) AS INTEGER)) as m FROM jobs`).first<any>()
  const maxSeq = maxJob?.m || 0
  await c.env.DB.prepare('UPDATE job_counter SET last_seq=? WHERE id=1').bind(maxSeq).run()
  return c.json({ ok: true, restored: { customers: customers.length, jobs: jobs.length, machines: machines.length } })
})

// Staff work report
app.get('/api/reports/staff', authMiddleware, adminOnly, async (c) => {
  const from = c.req.query('from') || ''
  const to = c.req.query('to') || ''
  const staffId = c.req.query('staff_id') || ''
  let query = `
    SELECT u.name as staff_name, m.product_name, m.status, m.charges, m.quantity,
      j.id as job_id, j.snap_name as customer_name, m.created_at
    FROM machines m
    JOIN jobs j ON m.job_id=j.id
    LEFT JOIN users u ON m.assigned_staff_id=u.id
    WHERE 1=1`
  const params: any[] = []
  if (from) { query += ' AND m.created_at>=?'; params.push(from) }
  if (to) { query += ' AND m.created_at<=?'; params.push(to + ' 23:59:59') }
  if (staffId) { query += ' AND m.assigned_staff_id=?'; params.push(staffId) }
  query += ' ORDER BY u.name, m.created_at DESC'
  const { results } = await c.env.DB.prepare(query).bind(...params).all<any>()
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

// Admin job summary
app.get('/api/reports/jobs', authMiddleware, adminOnly, async (c) => {
  const from = c.req.query('from') || ''
  const to = c.req.query('to') || ''
  let query = `
    SELECT j.id, j.snap_name as customer, j.snap_mobile as mobile, j.status,
      COUNT(m.id) as machines, SUM(m.charges) as total_charges, j.created_at
    FROM jobs j LEFT JOIN machines m ON j.id=m.job_id
    WHERE 1=1`
  const params: any[] = []
  if (from) { query += ' AND j.created_at>=?'; params.push(from) }
  if (to) { query += ' AND j.created_at<=?'; params.push(to + ' 23:59:59') }
  query += ' GROUP BY j.id ORDER BY j.created_at DESC'
  const { results } = await c.env.DB.prepare(query).bind(...params).all<any>()
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

// Cleanup
app.delete('/api/cleanup', authMiddleware, adminOnly, async (c) => {
  const { from, to, full_reset } = await c.req.json()
  if (full_reset) {
    // Delete everything in order
    await c.env.DB.exec('DELETE FROM machine_images; DELETE FROM machines; DELETE FROM jobs; DELETE FROM customers;')
    await c.env.DB.prepare('UPDATE job_counter SET last_seq=0 WHERE id=1').run()
    return c.json({ ok: true, message: 'Full reset done' })
  }
  if (from && to) {
    const { results: jobIds } = await c.env.DB.prepare(
      `SELECT id FROM jobs WHERE created_at>=? AND created_at<=?`
    ).bind(from, to + ' 23:59:59').all<any>()
    for (const { id } of jobIds) {
      const { results: imgs } = await c.env.DB.prepare(
        'SELECT mi.r2_object_key FROM machine_images mi JOIN machines m ON mi.machine_id=m.id WHERE m.job_id=?'
      ).bind(id).all<any>()
      for (const img of imgs) {
        if (img.r2_object_key) await c.env.PRODUCT_IMAGES.delete(img.r2_object_key)
      }
      await c.env.DB.prepare('DELETE FROM machine_images WHERE machine_id IN (SELECT id FROM machines WHERE job_id=?)').bind(id).run()
      await c.env.DB.prepare('DELETE FROM machines WHERE job_id=?').bind(id).run()
      await c.env.DB.prepare('DELETE FROM jobs WHERE id=?').bind(id).run()
    }
    return c.json({ ok: true, deleted: jobIds.length })
  }
  return c.json({ error: 'Provide from/to dates or full_reset=true' }, 400)
})

// Static files
app.use('/static/*', serveStatic({ root: './' }))
app.use('/icons/*', serveStatic({ root: './public' }))
app.use('/manifest.json', serveStatic({ root: './public' }))

// SPA fallback
app.get('*', (c) => {
  return c.html(HTML_PAGE)
})

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="theme-color" content="#1a1a2e">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>ADITION ELECTRIC SOLUTION</title>
<link rel="manifest" href="/manifest.json">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/static/style.css">
<script src="https://cdn.tailwindcss.com?plugins=forms"></script>
<script src="https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/axios@1.6.0/dist/axios.min.js"></script>
<link href="https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@6.4.0/css/all.min.css" rel="stylesheet">
</head>
<body class="bg-gray-50">
<div id="app"></div>
<script src="/static/app.js"></script>
</body>
</html>`

export default app
