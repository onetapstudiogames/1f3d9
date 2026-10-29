import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test, { mock } from 'node:test'
import type { Pool } from 'pg'

const CANARY = 'PRIVATE_SHOWING_ROOM_CANARY_lilacseven271028'
const FOUNDER_KEY = `1f3d9_sk_${'1'.repeat(48)}`
const RESIDENT_KEY = `1f3d9_sk_${'2'.repeat(48)}`
const SECOND_FOUNDER_KEY = `1f3d9_sk_${'3'.repeat(48)}`
type Statement = Readonly<{ text: string; params: readonly unknown[] }>

test('unpublished showing room prompts stay private through real PostgreSQL public routes', { timeout: 180_000 }, async t => {
  let database: Pool
  const sql = Object.assign(async (strings: TemplateStringsArray, ...params: readonly unknown[]) => {
    const text = strings.reduce((statement, part, index) => statement + part + (index < params.length ? `$${index + 1}` : ''), '')
    return (await database.query(text, [...params])).rows as Record<string, unknown>[]
  }, {
    query: async (text: string, params: readonly unknown[] = []) => (await database.query(text, [...params])).rows as Record<string, unknown>[],
    transaction: async (build: (transaction: { query(text: string, params?: readonly unknown[]): Statement }) => readonly Statement[]) => {
      const statements = build({ query: (text, params = []) => ({ text, params }) })
      const connection = await database.connect()
      try {
        await connection.query('BEGIN READ ONLY')
        const answers = []
        for (const statement of statements) answers.push((await connection.query(statement.text, [...statement.params])).rows)
        await connection.query('COMMIT')
        return answers
      } catch (error) {
        await connection.query('ROLLBACK')
        throw error
      } finally { connection.release() }
    },
  })
  const databaseMock = mock.module(new URL('../../src/db.ts', import.meta.url).href, {
    namedExports: { sql, runtimeDatabaseUrl: () => 'postgresql://synthetic.invalid/showing-privacy' },
  })
  t.after(() => databaseMock.restore())
  const { startPostgres } = await import('../helpers/gazette-fixtures/postgres.ts')
  const started = await startPostgres()
  database = started.database
  t.after(async () => {
    await database.end()
    spawnSync('docker', ['stop', '--time', '0', started.containerName], { encoding: 'utf8', windowsHide: true })
  })
  const schema = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')
  const migration = await readFile(new URL('../../db/migrations/20261027_showing_room.sql', import.meta.url), 'utf8')
  await database.query(schema.replace(migration, ''))
  await database.query(migration)
  const { default: app } = await import('../../src/index.ts')
  const { allowOAuthForHostedConnectorRequest, setPassiveOAuthResidentResolver } = await import('../../src/core.ts')
  await database.query(`
    INSERT INTO residents(id,handle,model,secret_hash) VALUES
      (1,'privacy-founder','synthetic',$1),(2,'privacy-second-founder','synthetic',$2),
      (3,'privacy-resident','synthetic',$3);
  `, [FOUNDER_KEY, SECOND_FOUNDER_KEY, RESIDENT_KEY].map(key => createHash('sha256').update(key).digest('hex')))
  await database.query(`
    INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes)
      SELECT 2,id,'continent','Synthetic privacy continent','Public synthetic place.',1,FALSE FROM places WHERE place_kind='world';
    INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes)
      VALUES(438,2,'place','the showing room','Public synthetic showing room.',1,TRUE);
    INSERT INTO resident_presence(resident_id,current_place_id,home_place_id) VALUES(1,438,438),(2,438,438),(3,438,438);
  `)
  const publicNote = (await database.query(`INSERT INTO notes(place_id,author_id,body)
    VALUES(438,1,'Ordinary public showing room note.') RETURNING id`)).rows[0]!.id
  await database.query(`INSERT INTO events(kind,actor,detail) VALUES('note','privacy-founder',$1::jsonb)`, [JSON.stringify({ note_id: publicNote, place_id: 438 })])
  await database.query(`INSERT INTO showing_room_contests(request_id,request_hash,title,prompt)
    VALUES('privacy-proof','synthetic-fingerprint','Synthetic unpublished question',$1)`, [CANARY])
  assert.equal((await database.query('SELECT prompt FROM showing_room_contests WHERE request_id=$1', ['privacy-proof'])).rows[0]!.prompt, CANARY)
  const before = (await database.query('SELECT row_to_json(control) AS row FROM showing_room_control control')).rows
  const presence = (await database.query('SELECT * FROM resident_presence ORDER BY resident_id')).rows

  await t.test('anonymous place, window, replay, events and change reads contain public records only', async () => {
    for (const path of [
      '/api/place/438', '/api/window?view=full', '/api/window?view=outline', '/api/window?view=directory',
      '/api/replay?span=1h', '/api/events?place_id=438&limit=100', '/api/changes?since=0&limit=100',
    ]) {
      const response = await app.request(`http://city.test${path}`)
      const text = await response.text()
      assert.equal(response.status, 200, `${path}: ${text.slice(0, 200)}`)
      assert.equal(text.includes(CANARY), false, path)
      assert.equal(text.includes('Synthetic unpublished question'), false, path)
    }
  })

  await t.test('public search cannot find stored queue text', async () => {
    const response = await app.request('http://city.test/api/search?q=lilacseven271028&mode=phrase')
    const text = await response.text()
    assert.equal(response.status, 200, text.slice(0, 200))
    assert.equal(text.includes(CANARY), false)
    const body = JSON.parse(text) as { results: unknown[]; total_items: number }
    assert.deepEqual(body.results, [])
    assert.equal(body.total_items, 0)
  })

  await t.test('anonymous, another resident and a hosted founder cannot discover even a queue count', async () => {
    let hostedLookups = 0
    setPassiveOAuthResidentResolver(async () => {
      hostedLookups++
      return { id: 1, handle: 'privacy-founder', model: 'synthetic', joined_at: '2026-10-28T00:00:00.000Z',
        quota_day: '2026-10-28', things_today: 0, notes_today: 0, agreement_actions_today: 0 }
    })
    t.after(() => setPassiveOAuthResidentResolver(null))
    for (const [token, expected] of [[null, 401], [RESIDENT_KEY, 403], [SECOND_FOUNDER_KEY, 403], ['1f3d9_at_synthetic-founder-session', 401]] as const) {
      const request = new Request('http://city.test/api/founder/showing-room', { headers: token === null ? {} : { authorization: `Bearer ${token}` } })
      if (token?.startsWith('1f3d9_at_')) allowOAuthForHostedConnectorRequest(request)
      const response = await app.fetch(request)
      const text = await response.text()
      assert.equal(response.status, expected)
      assert.match(response.headers.get('cache-control') ?? '', /no-store/u)
      assert.equal(text.includes(CANARY), false)
      assert.equal(text.includes('queue_count'), false)
      assert.equal(text.includes('contests'), false)
    }
    assert.equal(hostedLookups, 0)
  })

  await t.test('the founder root read reveals the stored prompt without advancing any room', async () => {
    const response = await app.request('http://city.test/api/founder/showing-room', { headers: { authorization: `Bearer ${FOUNDER_KEY}` } })
    const text = await response.text()
    assert.equal(response.status, 200)
    assert.equal(text.includes(CANARY), true)
    assert.deepEqual((await database.query('SELECT row_to_json(control) AS row FROM showing_room_control control')).rows, before)
    assert.deepEqual((await database.query('SELECT * FROM resident_presence ORDER BY resident_id')).rows, presence)
    assert.equal((await database.query("SELECT count(*)::integer AS count FROM events WHERE kind='room_settled'")).rows[0]!.count, 0)
  })
})
