// The end key over the real routes (things ending, T5): coin_trait stores a valid end key
// and refuses the end-only rules (E13) before anything is stored, invent_kind and
// revise_kind refuse two end-key traits (E17) before any fee, and laws refuse an end-key
// trait (E18).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'bell-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>

async function call(
  app: CityApp,
  secret: string,
  method: string,
  path: string,
  body: unknown,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: bearer(secret),
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

async function coin(app: CityApp, name: string, recipe: unknown) {
  return call(app, MAKER.secret, 'POST', '/api/trait', { name, description: `${name} for the end key suite`, recipe })
}

async function count(query: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query<{ n: string }>(query, [...values])).rows[0]!.n)
}

test('the end key on the real doors against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-recipe')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { END_KEY_REFUSAL, endTraitConflictRefusal } = await import('../../src/thing-ending-refusals.ts')

    await t.test('coin_trait stores a valid end key and refuses the end-only rules', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)

      const glow = await coin(app, 'last-glow', {
        end: { then: [{ effect: 'write', key: 'last', value: true }] },
      })
      assert.equal(glow.status, 201, JSON.stringify(glow.json))
      assert.deepEqual((glow.json.trait as Json).recipe, {
        end: { then: [{ effect: 'write', key: 'last', op: 'set', value: true }] },
      })

      const traitsBefore = await count('SELECT count(*) AS n FROM traits')
      const eventsBefore = await count(`SELECT count(*) AS n FROM events WHERE kind = 'trait_coined'`)
      for (const [name, then] of [
        ['waits', [{ effect: 'wait', seconds: 5, then: [] }]],
        ['names-actor', [{ effect: 'label', target: 'actor', label: 'x', seconds: 60 }]],
        ['hands-over', [{ effect: 'transfer', target: 'source', to: 'recipient' }]],
        ['self-destroy', [{ effect: 'destroy', target: 'source' }]],
        ['far-reach', [{ effect: 'label', target: 'target', label: 'x', seconds: 60 }]],
      ] as const) {
        const refused = await coin(app, name, { end: { then } })
        assert.equal(refused.status, 400, name)
        // The city adds its usual repeat note under a refusal sent again.
        assert.equal(String(refused.json.error).split('\n')[0], END_KEY_REFUSAL, name)
      }
      const dials = await coin(app, 'end-dials', { end: { on: ['arrive'], then: [] } })
      assert.equal(dials.status, 400)
      assert.equal(dials.json.error, "recipe refused at end: end takes only then, a list of steps; call physics for every brick's fields, defaults, and limits")
      assert.equal(await count('SELECT count(*) AS n FROM traits'), traitsBefore, 'nothing refused was stored')
      assert.equal(await count(`SELECT count(*) AS n FROM events WHERE kind = 'trait_coined'`), eventsBefore)
    })

    await t.test('a kind may list one end-key trait, and laws refuse one', async () => {
      const rooms = await resetCity([FOUNDER, MAKER])
      await standIn(MAKER.id, rooms.eastRoomId)
      for (const name of ['glow-one', 'glow-two']) {
        const coined = await coin(app, name, { end: { then: [] } })
        assert.equal(coined.status, 201, JSON.stringify(coined.json))
      }
      const plain = await coin(app, 'plain-bell', { talk: [{ effect: 'label', target: 'place', label: 'rung', seconds: 60 }] })
      assert.equal(plain.status, 201, JSON.stringify(plain.json))

      const twoEnds = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'two-ends', description: 'two end keys', traits: ['glow-one', 'plain-bell', 'glow-two'],
      })
      assert.equal(twoEnds.status, 400)
      assert.equal(twoEnds.json.error, endTraitConflictRefusal('glow-one', 'glow-two'))
      assert.equal(twoEnds.json.error, 'A kind may list only one trait with an end key; glow-one and glow-two both carry one, so keep one of them.')

      const db = connectedDatabase()
      const kindId = Number((await db.query<{ id: number }>(
        `INSERT INTO kinds (name, owner_id) VALUES ('one-end', $1) RETURNING id`, [MAKER.id],
      )).rows[0]!.id)
      await db.query(`INSERT INTO kind_revisions (kind_id, revision, traits) VALUES ($1, 1, ARRAY['glow-one'])`, [kindId])
      const revised = await call(app, MAKER.secret, 'POST', `/api/kind/${kindId}/revise`, {
        traits: ['glow-one', 'glow-two'],
      })
      assert.equal(revised.status, 400)
      assert.equal(revised.json.error, endTraitConflictRefusal('glow-one', 'glow-two'))
      assert.equal(await count('SELECT count(*) AS n FROM kind_revisions WHERE kind_id = $1', [kindId]), 1)

      await db.query('UPDATE places SET owner_id = $1 WHERE id = $2', [MAKER.id, rooms.eastRoomId])
      const law = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['glow-one'] })
      assert.equal(law.status, 400)
      assert.equal(law.json.error, "trait glow-one carries copy, write, a wake key, an end key, or a convert without into_kind, which work only in a kind's traits; put it on a kind, or adopt a law trait without them")
      const plainLaw = await call(app, MAKER.secret, 'PUT', `/api/place/${rooms.eastRoomId}/laws`, { traits: ['plain-bell'] })
      assert.equal(plainLaw.status, 200, JSON.stringify(plainLaw.json))
    })
  } finally {
    await postgres.stop()
  }
})
