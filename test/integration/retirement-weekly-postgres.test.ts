import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { after, before, test } from 'node:test'
import { Pool } from 'pg'
import { deliverPayPalCreditAtomically, readPayPalIntentBySubscription, recordPayPalCreditEvent } from '../../src/paypal-credit-store.ts'
import { residentRetirementRefusal } from '../../src/retirement-errors.ts'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || String(result.error))
  return result.stdout.trim()
}
const name = `city-retirement-weekly-${process.pid}-${randomBytes(4).toString('hex')}`
let pool: Pool
let started = false
const db = { query: async (text: string, values: readonly unknown[] = []) => (await pool.query(text, [...values])).rows }
const migration = new URL('../../db/migrations/20261109_retirement_weekly.sql', import.meta.url)
const retire = (id: number) => pool.query(`UPDATE residents SET retirement_state='retiring',
  retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id=$1`, [id])
const allowance = async (id: number, attach = true) => {
  await pool.query(`INSERT INTO paypal_credit_intents(public_id,request_id,intent_kind,delivery,recipient_id,amount_units,paypal_environment,status)
    VALUES ($1,$2,'allowance','self',$3,1000000,'sandbox','created')`, [`city_paypal_${String(id).repeat(32)}`, `synthetic-weekly-${id}`, id])
  if (attach) await pool.query(`UPDATE paypal_credit_intents SET remote_subscription_id=$1,status='approval_pending'
    WHERE recipient_id=$2`, [`SYNTHETIC-SUB-${id}`, id])
}
const cancel = (id: number) => recordPayPalCreditEvent(db, { eventId: `SYNTHETIC-CANCEL-${id}`,
  eventKind: 'BILLING.SUBSCRIPTION.CANCELLED', remoteResourceId: `SYNTHETIC-SUB-${id}`, sourceKey: null, outcome: 'ignored' })
const deliver = async (id: number, sale: string) => {
  const intent = await readPayPalIntentBySubscription(db, `SYNTHETIC-SUB-${id}`)
  assert.ok(intent)
  return deliverPayPalCreditAtomically(db, { intent, sourceKey: `paypal:sale:${sale}`, purchaseKind: 'allowance',
    eventId: `EVENT-${sale}`, eventKind: 'PAYMENT.SALE.COMPLETED', remoteResourceId: sale })
}

before(async () => {
  const password = randomBytes(24).toString('hex')
  docker(['run', '--detach', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17'])
  started = true
  const port = Number(docker(['port', name, '5432/tcp']).match(/:(\d+)$/u)?.[1])
  pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 3000 })
  for (let attempt = 0; ; attempt += 1) {
    try { await pool.query('SELECT 1'); break } catch (error) { if (attempt > 100) throw error; await delay(100) }
  }
  await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
  for (const file of ['20261109_resident_retirement.sql', '20261109_resident_retirement_private_data.sql']) {
    await pool.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'))
  }
  // Replay the additive fix, including after the earlier retirement migration.
  const sql = await readFile(migration, 'utf8')
  await pool.query(sql)
  await pool.query(sql)
  await pool.query(await readFile(new URL('../../db/migrations/20261109_resident_retirement_write_locks.sql', import.meta.url), 'utf8'))
  await pool.query(`INSERT INTO residents(id,handle,model,secret_hash)
    SELECT id,'weekly-test-'||id,'test',repeat(id::text,64) FROM generate_series(1,6) id WHERE id<>4`)
}, { timeout: 120_000 })
after(async () => {
  if (pool) await pool.end()
  if (started) docker(['stop', '--time', '0', name])
})

test('retirement waits for weekly cancellation, including an approval awaiting its first receipt', async () => {
  await allowance(2)
  const refused = (error: unknown) => {
    assert.match(residentRetirementRefusal(error) ?? '', /cancel.*weekly.*PayPal.*\/setup#weekly-payment/iu)
    return true
  }
  await assert.rejects(retire(2), refused)
  await deliver(2, 'SYNTHETIC-FIRST-2')
  await assert.rejects(retire(2), refused)
  assert.equal((await pool.query('SELECT retirement_state FROM residents WHERE id=2')).rows[0].retirement_state, 'active')
  await cancel(2)
  await retire(2)
})

test('retiring and retired residents cannot start or attach a weekly allowance', async () => {
  await allowance(3, false)
  const retiring = await pool.connect()
  const attaching = await pool.connect()
  try {
    await retiring.query('BEGIN')
    await retiring.query(`UPDATE residents SET retirement_state='retiring',
      retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id=3`)
    const pid = (await attaching.query('SELECT pg_backend_pid() AS id')).rows[0].id
    const attachment = assert.rejects(attaching.query(`UPDATE paypal_credit_intents
      SET remote_subscription_id='SYNTHETIC-SUB-3',status='approval_pending' WHERE recipient_id=3`), /retir/iu)
    for (let attempt = 0; ; attempt += 1) {
      const waiting = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]
      if (waiting.wait_event_type === 'Lock') break
      assert.ok(attempt < 100, 'attachment must wait for the retirement transaction')
      await delay(10)
    }
    await retiring.query('COMMIT')
    await attachment
  } finally {
    await retiring.query('ROLLBACK')
    retiring.release()
    attaching.release()
  }
  for (const state of ['retiring', 'retired']) {
    await assert.rejects(pool.query(`INSERT INTO paypal_credit_intents(public_id,request_id,intent_kind,delivery,recipient_id,amount_units,paypal_environment,status)
      VALUES ($1,$2,'allowance','self',3,1000000,'sandbox','created')`, [`synthetic_new_${state}`, `synthetic-new-${state}`]), /retir/iu)
    await assert.rejects(pool.query(`UPDATE paypal_credit_intents SET remote_subscription_id='SYNTHETIC-SUB-3',status='approval_pending'
      WHERE recipient_id=3`), /retir/iu)
    if (state === 'retiring') await pool.query('SELECT complete_resident_retirement(1,3)')
  }
})

test('late weekly receipts are retained without new credit during or after retirement; old delivery replays', async () => {
  await allowance(6)
  await deliver(6, 'SYNTHETIC-FIRST-6')
  await cancel(6)
  await retire(6)
  for (const state of ['retiring', 'retired']) {
    const sale = `SYNTHETIC-LATE-${state}`
    assert.equal((await deliver(6, sale)).status, 'withheld')
    assert.equal((await deliver(6, sale)).status, 'withheld')
    assert.equal((await deliver(6, 'SYNTHETIC-FIRST-6')).disposition, 'existing')
    const event = (await pool.query('SELECT outcome,intent_public_id,source_key,purchase_entry_id FROM paypal_credit_events WHERE remote_resource_id=$1', [sale])).rows[0]
    assert.deepEqual(event, { outcome: 'withheld', intent_public_id: 'city_paypal_' + '6'.repeat(32), source_key: `paypal:sale:${sale}`, purchase_entry_id: null })
    assert.equal((await pool.query('SELECT balance_units FROM city_credit_accounts WHERE resident_id=6')).rows[0].balance_units, '1000000')
    if (state === 'retiring') await pool.query('SELECT complete_resident_retirement(1,6)')
  }
})

test('founder completion rechecks a legacy retiring resident with an active weekly payment', async () => {
  await allowance(5)
  await deliver(5, 'SYNTHETIC-FIRST-5')
  // Simulate a request accepted by the old release, before the new prerequisite.
  await pool.query('ALTER TABLE residents DISABLE TRIGGER resident_weekly_retirement_guard')
  try { await retire(5) } finally {
    await pool.query('ALTER TABLE residents ENABLE TRIGGER resident_weekly_retirement_guard')
  }
  await assert.rejects(pool.query('SELECT complete_resident_retirement(1,5)'), /cancel.*weekly.*PayPal/iu)
  assert.equal((await pool.query('SELECT retirement_state FROM residents WHERE id=5')).rows[0].retirement_state, 'retiring')
  await cancel(5)
  await pool.query('SELECT complete_resident_retirement(1,5)')
  assert.equal((await pool.query('SELECT retirement_state FROM residents WHERE id=5')).rows[0].retirement_state, 'retired')
})
