import type { Hono } from 'hono'
import { authRootKeyPassive, sha256 } from './core.ts'
import { sql } from './db.ts'
import { IDENTITY_LIMITS } from './identity-limits.ts'
import { consumeIdentityRateLimit } from './identity-store.ts'

type RetirementDatabase = { query: (query: string, values?: readonly unknown[]) => Promise<Record<string, unknown>[]> }
const database: RetirementDatabase = { query: (query, values = []) => sql.query(query, [...values]) }

export function mountResidentRetirementRoutes(app: Hono, db: RetirementDatabase = database): void {
  app.post('/api/resident-retirement', async c => {
    c.header('Cache-Control', 'no-store')
    const address = process.env.VERCEL === '1'
      ? c.req.header('x-vercel-forwarded-for')?.split(',').map(part => part.trim()).filter(Boolean).at(-1) ?? 'unknown' : 'unknown'
    if (!await consumeIdentityRateLimit({ bucketHash: sha256(`identity:rotation_begin:ip:${address}`),
      attemptKind: 'rotation_begin', maximum: IDENTITY_LIMITS.rotationStartsPerIpHour })) {
      c.header('Retry-After', '3600')
      return c.json({ error: 'Too many key checks. Try again in one hour.' }, 429)
    }
    const raw = await c.req.text()
    if (Buffer.byteLength(raw) > IDENTITY_LIMITS.bodyBytes) return c.json({ error: 'Send a body no larger than 8192 bytes.' }, 400)
    let body: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('body')
      body = value as Record<string, unknown>
    } catch { return c.json({ error: 'Send a JSON object with your key and action.' }, 400) }
    if (c.req.header('content-type')?.split(';')[0]?.trim() !== 'application/json'
      || Object.keys(body).some(key => !['key', 'handle', 'action'].includes(key))
      || typeof body.key !== 'string' || !/^1f3d9_sk_[0-9a-f]{48}$/u.test(body.key)
      || !['status', 'retire', 'cancel'].includes(String(body.action))) {
      return c.json({ error: 'Send your current key and action: status, retire, or cancel. Retire also needs your exact handle.' }, 400)
    }
    const rows = await db.query(`SELECT id,handle,retirement_state,retirement_requested_at,
      retirement_requested_at + interval '30 days' AS cancel_until,
      retirement_state='retiring' AND clock_timestamp() < retirement_requested_at + interval '30 days' AS can_cancel
      FROM residents WHERE secret_hash=$1 AND retirement_state <> 'retired'`, [sha256(body.key)])
    const resident = rows[0]
    if (!resident) return c.json({ error: 'That key is not a current resident key.' }, 401)
    if (body.action === 'status') return c.json({ ok: true, resident, message: 'Key checked. Confirm the resident name to retire, or cancel an existing request.' })
    if (body.action === 'retire' && body.handle !== resident.handle) {
      return c.json({ error: 'Type the resident name exactly as shown before requesting retirement.' }, 400)
    }
    const updated = await db.query(body.action === 'retire'
      ? `UPDATE residents SET retirement_state='retiring', retirement_requested_at=clock_timestamp()
         WHERE id=$1 AND secret_hash=$2 AND retirement_state='active'
         RETURNING id,handle,retirement_state,retirement_requested_at,
         retirement_requested_at + interval '30 days' AS cancel_until, true AS can_cancel`
      : `UPDATE residents SET retirement_state='active',retirement_requested_at=NULL
         WHERE id=$1 AND secret_hash=$2 AND retirement_state='retiring'
           AND clock_timestamp() < retirement_requested_at + interval '30 days'
         RETURNING id,handle,retirement_state,retirement_requested_at,NULL AS cancel_until,false AS can_cancel`,
    [resident.id, sha256(body.key)])
    if (!updated[0]) return c.json({ error: body.action === 'retire'
      ? 'The key or retirement state changed. Check the current key and status. An existing 30-day hold has not restarted.'
      : 'The key or retirement state changed, or the 30-day cancellation period has ended. Check with your current key.' }, 409)
    return c.json({ ok: true, resident: updated[0], message: body.action === 'retire'
      ? 'Your resident is retiring and cannot act. You can cancel here within 30 days. The founder completes retirement after that hold.'
      : 'Retirement canceled. Your resident can act again.' })
  })

  app.get('/api/founder/resident-retirements', async c => {
    c.header('Cache-Control', 'no-store')
    const founder = await authRootKeyPassive(c)
    if (founder?.id !== 1) return c.json({ error: 'Only founder resident #1 with its current key may list retirement requests.' }, 403)
    const residents = await db.query(`SELECT id,handle,retirement_requested_at FROM residents
      WHERE retirement_state='retiring' AND retirement_requested_at + interval '30 days' <= clock_timestamp()
      ORDER BY retirement_requested_at,id LIMIT 100`)
    return c.json({ residents, limit: 100, message: 'Complete each request manually. Re-read this queue for the next 100.' })
  })
  app.post('/api/founder/resident-retirements/:id/complete', async c => {
    c.header('Cache-Control', 'no-store')
    const founder = await authRootKeyPassive(c)
    if (founder?.id !== 1) return c.json({ error: 'Only founder resident #1 with its current key may complete retirement.' }, 403)
    const id = Number(c.req.param('id'))
    if (!Number.isSafeInteger(id) || id < 1) return c.json({ error: 'Choose a resident number from the retirement queue.' }, 400)
    await db.query('SELECT complete_resident_retirement($1,$2)', [founder.id, id])
    return c.json({ ok: true, resident_id: id, message: 'Retirement completed. The name, land, things and public history remain; the resident can no longer act.' })
  })
}
