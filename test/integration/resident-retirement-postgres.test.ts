import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Pool } from 'pg'
import { Hono } from 'hono'
import { runResidentRetirements } from '../../scripts/resident-retirements.ts'

function docker(args: string[]): string {
  const result = spawnSync('docker', args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
  return result.stdout.trim()
}

test('requested retirement freezes writes, can be canceled, and only founder completes after 30 days', { timeout: 120_000 }, async () => {
  const migration = await readFile(new URL('../../db/migrations/20261109_resident_retirement.sql', import.meta.url), 'utf8')
  const name = `city-retirement-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')
  docker(['run', '--detach', '--rm', '--name', name, '-p', '127.0.0.1::5432', '-e', `POSTGRES_PASSWORD=${password}`, 'postgres:17'])
  const port = Number(docker(['port', name, '5432/tcp']).match(/:(\d+)$/u)?.[1])
  const pool = new Pool({ host: '127.0.0.1', port, user: 'postgres', password, database: 'postgres', connectionTimeoutMillis: 3_000 })
  try {
    for (let attempt = 0; ; attempt += 1) {
      try { await pool.query('SELECT 1'); break } catch (error) { if (attempt > 20) throw error; await delay(100) }
    }
    await pool.query(await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8'))
    await pool.query(migration)
    await pool.query(migration)
    const writeLocks = await readFile(new URL('../../db/migrations/20261109_resident_retirement_write_locks.sql', import.meta.url), 'utf8')
    assert.ok((await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')).endsWith(writeLocks.replace(/^BEGIN;\n/u, '').replace(/COMMIT;\n$/u, '')))
    await pool.query(writeLocks)
    await pool.query(writeLocks)
    await pool.query(`INSERT INTO residents (id,handle,model,secret_hash) VALUES
      (1,'founder','test',repeat('1',64)), (2,'retirement-test','test',repeat('2',64)), (3,'other-test','test',repeat('3',64))`)
    const key = '1f3d9_sk_' + randomBytes(24).toString('hex')
    const keyHash = createHash('sha256').update(key).digest('hex')
    await pool.query('UPDATE residents SET secret_hash=$1 WHERE id=2', [keyHash])
    const tagged = Object.assign(async (parts: TemplateStringsArray, ...values: unknown[]) =>
      (await pool.query(parts.reduce((text, part, index) => text + part + (index < values.length ? `$${index+1}` : ''), ''), values)).rows,
    { query: async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows })
    mock.module('../../src/db.ts', { namedExports: { sql: tagged,
      runtimeDatabaseUrl: () => { throw new Error('This test uses only its injected local Docker connection') } } })
    const { mountResidentRetirementRoutes } = await import('../../src/resident-retirement.ts')
    const { auth } = await import('../../src/core.ts')
    const { residentRetirementRefusal } = await import('../../src/retirement-errors.ts')
    const app = new Hono()
    app.onError((error, c) => c.json({ error: residentRetirementRefusal(error) ?? 'unexpected test error' }, 403))
    mountResidentRetirementRoutes(app)
    app.post('/write', async c => c.json({ id: (await auth(c))?.id }))
    const request = (action: string, handle?: string) => app.request('/api/resident-retirement', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, action, ...(handle ? { handle } : {}) }),
    })
    const status = await request('status')
    assert.equal(status.status, 200)
    assert.equal((await status.json()).resident.handle, 'retirement-test')
    await pool.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id)
      SELECT 101,id,'continent','retirement-land','land',2 FROM places WHERE place_kind='world'`)
    await pool.query(`INSERT INTO things(id,name,body,owner_id,maker_id,place_id) VALUES (101,'retirement-thing','thing',2,2,101)`)
    const activeWriter = await pool.connect()
    const activeObserver = await pool.connect()
    try {
      await activeObserver.query("SET lock_timeout = '500ms'")
      await activeWriter.query('BEGIN')
      await activeWriter.query('UPDATE residents SET notes_today=notes_today+1 WHERE id=2')
      await activeObserver.query("UPDATE things SET body='active owner can edit' WHERE id=101")
      await activeWriter.query('ROLLBACK')
      await activeWriter.query('BEGIN')
      await activeWriter.query("UPDATE things SET body='active property write' WHERE id=101")
      await activeObserver.query('UPDATE residents SET notes_today=notes_today+1 WHERE id=2')
    } finally {
      try {
        await activeWriter.query('ROLLBACK')
        await activeObserver.query('RESET lock_timeout')
      } finally {
        activeWriter.release()
        activeObserver.release()
      }
    }
    await pool.query(`INSERT INTO resident_recovery_codes(resident_id,generation,code_hash) VALUES (2,1,repeat('a',64))`)
    const family = (await pool.query(`INSERT INTO oauth_token_families(resident_id,client_id,resource,scope,expires_at)
      VALUES(2,'test-client','https://1f3d9.com/mcp/connect','city:resident',now()+interval '30 days') RETURNING id`)).rows[0].id
    const refresh = (await pool.query(`INSERT INTO oauth_tokens(token_hash,token_type,family_id,expires_at)
      VALUES(repeat('b',64),'refresh',$1,now()+interval '30 days') RETURNING id`, [family])).rows[0].id
    await pool.query(`INSERT INTO oauth_tokens(token_hash,token_type,family_id,rotated_from_token_id,expires_at)
      VALUES(repeat('c',64),'refresh',$1,$2,now()+interval '30 days')`, [family, refresh])
    await pool.query(`INSERT INTO resident_key_rotations(resident_id,recovery_generation,session_hash,csrf_hash,
      resident_secret_hash,replacement_secret_hash,created_at,expires_at)
      VALUES(2,0,repeat('b',64),repeat('c',64),$1,repeat('d',64),now()-interval '20 minutes',now()-interval '5 minutes')`, [keyHash])
    const offer = (await pool.query(`INSERT INTO transfer_offers(asset_type,asset_id,seller_id,buyer_id,price_usdc,seller_wallet)
      VALUES('thing',101,2,3,1,'0x'||repeat('a',40)) RETURNING id`)).rows[0].id
    await assert.rejects(pool.query("UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp() WHERE id=2"), /open sale offers/)
    await pool.query("UPDATE transfer_offers SET status='canceled',canceled_at=clock_timestamp() WHERE id=$1", [offer])
    assert.equal((await request('retire', 'retirement-test')).status, 200)
    const { stageRootRotation } = await import('../../src/identity-store.ts')
    assert.equal((await stageRootRotation({ sessionHash: 'e'.repeat(64), csrfHash: 'f'.repeat(64),
      residentSecretHash: '3'.repeat(64), replacementSecretHash: 'a'.repeat(64) })).status, 'staged')
    await assert.rejects(stageRootRotation({ sessionHash: '9'.repeat(64), csrfHash: '8'.repeat(64),
      residentSecretHash: keyHash, replacementSecretHash: '7'.repeat(64) }), /retiring/)
    const refused = await app.request('/write', { method: 'POST', headers: { Authorization: `Bearer ${key}` } })
    assert.equal(refused.status, 403)
    assert.match((await refused.json()).error, /retiring/)
    await assert.rejects(pool.query('UPDATE residents SET notes_today=notes_today+1 WHERE id=2'), /retiring/)
    await assert.rejects(pool.query('UPDATE things SET owner_id=3 WHERE id=101'), /retiring/)
    await assert.rejects(pool.query("UPDATE places SET description='changed' WHERE id=101"), /retiring/)
    await assert.rejects(pool.query("INSERT INTO active_labels(target_type,target_id,label,actor_id) VALUES ('thing',101,'test-label',3)"), /retiring/)
    const snapshot = async () => (await pool.query("SELECT payload FROM city_snapshot.public_records_v4 WHERE class_name='residents' AND record_id='2'")).rows[0].payload
    assert.equal((await snapshot()).display_handle, 'retirement-test (retiring)')
    await assert.rejects(pool.query("SELECT complete_resident_retirement(1,2)"), /30 days/)
    assert.equal((await request('cancel')).status, 200)
    assert.equal((await snapshot()).display_handle, undefined)
    await pool.query('UPDATE residents SET notes_today=notes_today+1 WHERE id=2')
    const concurrentWriter = await pool.connect()
    try {
      await concurrentWriter.query('BEGIN')
      await concurrentWriter.query("UPDATE things SET body='last active edit' WHERE id=101")
      let completed = false
      const retiring = Promise.resolve(request('retire', 'retirement-test')).then(value => { completed = true; return value })
      await delay(50)
      assert.equal(completed, false, 'retirement waits for the in-flight property write owner lock')
      await concurrentWriter.query('COMMIT')
      assert.equal((await retiring).status, 200)
    } finally { await concurrentWriter.query('ROLLBACK'); concurrentWriter.release() }
    await pool.query('DELETE FROM identity_rate_limits')
    assert.equal((await request('cancel')).status, 200)
    const retiringFirst = await pool.connect()
    const waitingWriter = await pool.connect()
    let lateWrite: Promise<unknown> | undefined
    try {
      await retiringFirst.query('BEGIN')
      await retiringFirst.query("UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp() WHERE id=2")
      const pid = (await waitingWriter.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      lateWrite = assert.rejects(
        waitingWriter.query("UPDATE things SET body='must not apply after retirement' WHERE id=101"), /retiring/,
      )
      let blocked = false
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = (await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0]
        if (state?.wait_event_type === 'Lock') { blocked = true; break }
        await delay(10)
      }
      assert.equal(blocked, true, 'a write must wait for an uncommitted retirement')
      await retiringFirst.query('COMMIT')
      await lateWrite
      assert.equal((await pool.query('SELECT body FROM things WHERE id=101')).rows[0].body, 'last active edit')
    } finally {
      try {
        await retiringFirst.query('ROLLBACK')
        await lateWrite
      } finally {
        retiringFirst.release()
        waitingWriter.release()
      }
    }
    await pool.query("UPDATE residents SET retirement_state='active',retirement_requested_at=NULL WHERE id=2")
    await pool.query(`UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id=2`)
    await assert.rejects(pool.query('SELECT complete_resident_retirement(3,2)'), /founder/)
    await pool.query('SELECT complete_resident_retirement(1,2)')
    const resident = (await pool.query('SELECT * FROM residents WHERE id=2')).rows[0]
    assert.equal(resident.retirement_state, 'retired')
    assert.notEqual(resident.secret_hash, keyHash)
    assert.equal((await snapshot()).display_handle, 'retirement-test (retired)')
    assert.equal((await request('status')).status, 401)
    assert.equal((await pool.query('SELECT count(*) FROM resident_recovery_codes WHERE resident_id=2')).rows[0].count, '0')
    assert.equal((await pool.query('SELECT count(*) FROM oauth_token_families WHERE resident_id=2')).rows[0].count, '0')
    assert.equal((await pool.query('SELECT count(*) FROM oauth_tokens WHERE family_id=$1', [family])).rows[0].count, '0')
    assert.equal((await pool.query('SELECT owner_id FROM places WHERE id=101')).rows[0].owner_id, 2)
    assert.equal((await pool.query('SELECT owner_id FROM things WHERE id=101')).rows[0].owner_id, 2)
    await assert.rejects(pool.query(`INSERT INTO residents(id,handle,model,secret_hash) VALUES (5,'retirement-test','test',repeat('5',64))`), /unique/)
    await assert.rejects(pool.query("UPDATE residents SET retirement_state='active',retirement_requested_at=NULL,retired_at=NULL WHERE id=2"), /retired/)
    await assert.rejects(pool.query('DELETE FROM residents WHERE id=2'), /permanently/)
    await pool.query(`UPDATE residents SET retirement_state='retiring',retirement_requested_at=clock_timestamp()-interval '31 days' WHERE id IN (1,3)`)
    await runResidentRetirements(pool, ['--list'])
    assert.equal((await pool.query('SELECT retirement_state FROM residents WHERE id=1')).rows[0].retirement_state, 'retiring')
    await runResidentRetirements(pool, ['--complete', '1'])
    await runResidentRetirements(pool, ['--complete', '3'])
    assert.equal((await pool.query("SELECT count(*) FROM residents WHERE retirement_state='retired'")).rows[0].count, '3')
    const { checkRetirementEngine } = await import('./resident-retirement-engine-check.ts')
    await checkRetirementEngine(pool)
  } finally {
    await pool.end()
    docker(['rm', '--force', name])
  }
})
