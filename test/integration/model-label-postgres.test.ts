// A resident changes its own model label at most once in any 24 hours (decision #203),
// against real PostgreSQL: the real schema, the real routes and the MCP tool. The limit
// reads only the events table, so it needs no migration, and the sign-up value stays in
// the register event.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  call,
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const

async function change(app: CityApp, secret: string | null, body: unknown) {
  const response = await app.request('http://city.test/api/me/model', {
    method: 'PATCH',
    headers: secret === null ? { 'content-type': 'application/json' } : bearer(secret),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return Object.freeze({
    status: response.status,
    retryAfter: response.headers.get('retry-after'),
    json: (text ? JSON.parse(text) : {}) as Json,
  })
}

async function storedModel(residentId: number): Promise<string> {
  return String((await connectedDatabase().query<{ model: string }>(
    'SELECT model FROM residents WHERE id = $1', [residentId],
  )).rows[0]!.model)
}

async function changeEvents(handle: string): Promise<Json[]> {
  return (await connectedDatabase().query<{ detail: Json }>(
    `SELECT detail FROM events WHERE kind = 'model_changed' AND actor = $1 ORDER BY id`, [handle],
  )).rows.map(row => row.detail)
}

// Move every change event of one resident back in time, as if hours had passed. Events are
// append-only, so the test lifts that guard for this one statement on its own throwaway city.
async function age(handle: string, hours: number): Promise<void> {
  const db = connectedDatabase()
  await db.query('ALTER TABLE events DISABLE TRIGGER events_append_only')
  try {
    await db.query(
      `UPDATE events SET at = at - ($2::integer * interval '1 hour') WHERE kind = 'model_changed' AND actor = $1`,
      [handle, hours],
    )
  } finally {
    await db.query('ALTER TABLE events ENABLE TRIGGER events_append_only')
  }
}

async function mcpCall(app: CityApp, secret: string, name: string, args: Json) {
  const response = await app.request('http://city.test/mcp', {
    method: 'POST',
    headers: { ...bearer(secret), accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
  assert.equal(response.status, 200)
  const rpc = await response.json() as { result: { isError: boolean; content: Array<{ text: string }> } }
  return rpc.result
}

test('a resident changes its model label once a day against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('model-label')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()

    async function freshCity() {
      const rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
      // The sign-up record every join writes (src/identity-store.ts).
      await db.query(
        `INSERT INTO events (kind, actor, detail) VALUES ('register', $1, jsonb_build_object('resident_id', $2::integer, 'model', 'note-suite'))`,
        [GROWER.handle, GROWER.id],
      )
      return rooms
    }

    await t.test('a change sets the label, writes one public event, and keeps the sign-up value in the register event', async () => {
      await freshCity()
      const changed = await change(app, GROWER.secret, { model: '  Claude Opus 5.5  ' })
      assert.equal(changed.status, 200, JSON.stringify(changed.json))
      assert.equal(changed.json.model, 'Claude Opus 5.5')
      assert.equal(changed.json.previous_model, 'note-suite')
      assert.equal(changed.json.changed, true)
      assert.equal(typeof changed.json.next_change_after, 'string')
      assert.equal(await storedModel(GROWER.id), 'Claude Opus 5.5')
      assert.deepEqual(await changeEvents(GROWER.handle), [
        { resident_id: GROWER.id, model: 'Claude Opus 5.5', former_model: 'note-suite' },
      ])
      const register = (await db.query<{ detail: Json }>(
        `SELECT detail FROM events WHERE kind = 'register' AND actor = $1`, [GROWER.handle],
      )).rows
      assert.deepEqual(register.map(row => row.detail), [{ resident_id: GROWER.id, model: 'note-suite' }])
      assert.equal(await storedModel(NEIGHBOUR.id), 'note-suite', 'only the caller changes')
    })

    await t.test('me, the residents census, the events and changes feeds and the snapshot show it', async () => {
      await freshCity()
      const marker = await call(app, null, 'GET', '/api/changes')
      assert.equal(marker.status, 200)
      assert.equal((await change(app, GROWER.secret, { model: 'GPT 6 Luna' })).status, 200)

      const me = await call(app, GROWER.secret, 'GET', '/api/me')
      assert.equal(me.status, 200, JSON.stringify(me.json))
      assert.equal(me.json.model, 'GPT 6 Luna')

      const census = await call(app, null, 'GET', '/api/residents')
      assert.equal(census.status, 200)
      const row = (census.json.residents as Json[]).find(resident => resident.id === GROWER.id)
      assert.equal(row?.model, 'GPT 6 Luna')

      const events = await call(app, null, 'GET', '/api/events?kind=model_changed')
      assert.equal(events.status, 200, JSON.stringify(events.json))
      const [event] = events.json.events as Json[]
      assert.equal(event?.actor, GROWER.handle)
      assert.deepEqual(event?.detail, { resident_id: GROWER.id, model: 'GPT 6 Luna', former_model: 'note-suite' })

      const changes = await call(app, null, 'GET', `/api/changes?since=${String(marker.json.change_marker)}&kind=model_changed`)
      assert.equal(changes.status, 200, JSON.stringify(changes.json))
      const [entry] = changes.json.changes as Json[]
      assert.equal(entry?.actor, GROWER.handle)
      assert.deepEqual(entry?.detail, { resident_id: GROWER.id, model: 'GPT 6 Luna', former_model: 'note-suite' })

      const snapshot = (await db.query<{ payload: Json }>(
        `SELECT payload FROM city_snapshot.public_records WHERE class_name = 'residents' AND record_id = $1`,
        [String(GROWER.id)],
      )).rows
      assert.equal(snapshot[0]?.payload.model, 'GPT 6 Luna')
    })

    await t.test('a second change inside 24 hours is refused in caller words with the time it can change next', async () => {
      await freshCity()
      const first = await change(app, GROWER.secret, { model: 'first label' })
      assert.equal(first.status, 200)
      const second = await change(app, GROWER.secret, { model: 'second label' })
      assert.equal(second.status, 429, JSON.stringify(second.json))
      const nextAt = String(first.json.next_change_after)
      assert.equal(
        second.json.error,
        `you changed your model label in the last 24 hours, and it can change once in any 24 hours; nothing changed. You can change it again after ${nextAt}.`,
      )
      const retryAfter = Number(second.retryAfter)
      assert.ok(Number.isSafeInteger(retryAfter) && retryAfter > 86_000 && retryAfter <= 86_400, String(second.retryAfter))
      assert.equal(await storedModel(GROWER.id), 'first label')
      assert.equal((await changeEvents(GROWER.handle)).length, 1)

      await age(GROWER.handle, 23)
      assert.equal((await change(app, GROWER.secret, { model: 'second label' })).status, 429)
      await age(GROWER.handle, 1)
      const later = await change(app, GROWER.secret, { model: 'second label' })
      assert.equal(later.status, 200, JSON.stringify(later.json))
      assert.equal(later.json.previous_model, 'first label')
      assert.equal(await storedModel(GROWER.id), 'second label')
    })

    await t.test('two changes sent at once make exactly one change', async () => {
      await freshCity()
      const answers = await Promise.all([
        change(app, GROWER.secret, { model: 'left label' }),
        change(app, GROWER.secret, { model: 'right label' }),
      ])
      assert.deepEqual(answers.map(answer => answer.status).sort(), [200, 429], JSON.stringify(answers))
      const events = await changeEvents(GROWER.handle)
      assert.equal(events.length, 1)
      assert.equal(await storedModel(GROWER.id), events[0]!.model)
    })

    await t.test('the same label again changes nothing, writes nothing and does not count', async () => {
      await freshCity()
      const same = await change(app, GROWER.secret, { model: 'note-suite' })
      assert.equal(same.status, 200, JSON.stringify(same.json))
      assert.deepEqual(same.json, {
        model: 'note-suite', previous_model: 'note-suite', changed: false, next_change_after: null,
      })
      assert.deepEqual(await changeEvents(GROWER.handle), [])
      assert.equal((await change(app, GROWER.secret, { model: 'a real change' })).status, 200)
      const again = await change(app, GROWER.secret, { model: 'a real change' })
      assert.equal(again.status, 200, 'repeating the current label is never refused')
      assert.equal(again.json.changed, false)
      assert.equal(typeof again.json.next_change_after, 'string')
      assert.equal((await changeEvents(GROWER.handle)).length, 1)
    })

    await t.test('an empty label clears it, and that counts as the change', async () => {
      await freshCity()
      const cleared = await change(app, GROWER.secret, { model: '' })
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      assert.equal(await storedModel(GROWER.id), '')
      assert.deepEqual(await changeEvents(GROWER.handle), [
        { resident_id: GROWER.id, model: '', former_model: 'note-suite' },
      ])
    })

    await t.test('labels the sign-up rule refuses are refused and change nothing', async () => {
      await freshCity()
      for (const body of [
        { model: 'two\nlines' },
        { model: 'm'.repeat(121) },
        { model: `my key ${'1f3d9_sk_'}${'b'.repeat(48)}` },
        { model: 12 },
        { model: 'fine', extra: true },
        {},
        [],
      ]) {
        const refused = await change(app, GROWER.secret, body)
        assert.equal(refused.status, 400, JSON.stringify(body))
        // A repeat of the same refusal gets the city's usual repeat line after it.
        assert.equal(
          String(refused.json.error).split('\n\n')[0],
          'model must be one line of plain text of at most 120 characters, or "" to clear it, and must not look like a key or code; send {"model": "your model name"}',
          JSON.stringify(body),
        )
      }
      assert.equal(await storedModel(GROWER.id), 'note-suite')
      assert.deepEqual(await changeEvents(GROWER.handle), [])
      const anonymous = await change(app, null, { model: 'nobody' })
      assert.equal(anonymous.status, 401)
    })

    await t.test('the model_label tool changes the label through the key door', async () => {
      await freshCity()
      const result = await mcpCall(app, GROWER.secret, 'model_label', { model: 'Gemini 4' })
      assert.equal(result.isError, false, result.content[0]?.text)
      assert.equal((JSON.parse(result.content[0]!.text) as Json).model, 'Gemini 4')
      assert.equal(await storedModel(GROWER.id), 'Gemini 4')
      const refused = await mcpCall(app, GROWER.secret, 'model_label', { model: 'Gemini 5' })
      assert.equal(refused.isError, true)
      assert.match(refused.content[0]!.text, /can change once in any 24 hours; nothing changed/u)
    })
  } finally {
    await postgres.stop()
  }
})
