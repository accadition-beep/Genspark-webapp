import { Hono } from 'hono'
import { sign } from 'hono/jwt'

type Bindings = { DB: D1Database; JWT_SECRET: string }

const auth = new Hono<{ Bindings: Bindings }>()
const JWT_SECRET = 'adition-secret-key-2026-secure'

const STAFF_ACCOUNTS: Record<string, { name: string; password: string }> = {
  staff1: { name: 'Staff 1', password: 'staff1' },
  staff2: { name: 'Staff 2', password: 'staff2' },
  staff3: { name: 'Staff 3', password: 'staff3' },
  staff4: { name: 'Staff 4', password: 'staff4' },
}

const ADMIN_EMAIL   = 'acc.adition@gmail.com'
const ADMIN_EMAIL2  = 'bilalkhan1108@gmail.com'   // legacy fallback
const ADMIN_MOBILE  = '7801990001'
const ADMIN_PASS    = '0010'

auth.post('/login', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'Invalid body' }, 400) }

  const { email = '', password = '', username = '' } = body
  const secret = c.env?.JWT_SECRET || JWT_SECRET
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30

  const loginKey = (email || username || '').trim().toLowerCase()

  // Admin login
  if (
    (loginKey === ADMIN_EMAIL.toLowerCase() ||
     loginKey === ADMIN_EMAIL2.toLowerCase() ||
     loginKey === ADMIN_MOBILE) &&
    password === ADMIN_PASS
  ) {
    const token = await sign(
      { sub: ADMIN_EMAIL, role: 'admin', staff_name: 'Admin', exp },
      secret, 'HS256'
    )
    return c.json({ token, role: 'admin', email: ADMIN_EMAIL, staff_name: 'Admin' })
  }

  // Staff login
  const account = STAFF_ACCOUNTS[loginKey]
  if (account && password === account.password) {
    const token = await sign(
      { sub: loginKey, role: 'staff', staff_name: account.name, exp },
      secret, 'HS256'
    )
    return c.json({ token, role: 'staff', email: loginKey, staff_name: account.name })
  }

  return c.json({ error: 'Invalid credentials' }, 401)
})

auth.get('/staff-list', async (c) => {
  const h = c.req.header('Authorization')
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401)
  return c.json(Object.entries(STAFF_ACCOUNTS).map(([key, v]) => ({ key, name: v.name })))
})

export default auth
