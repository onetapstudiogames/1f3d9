// Thing endings on the write answers that name a thing (T17b, the read-surface census),
// against real PostgreSQL on the full db/schema.sql, the five-states fixture and the real
// routes. make answers its new thing with the short status, key ends, when an end was
// sent; thing_edit and thing_upgrade answer the full ending object; a place edit answers
// its front matter with ends. test/thing-read-surface-census.test.ts names these subtests
// as the proof for those routes.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { call, type CityApp, type Json } from '../helpers/abilities-fixtures.ts'
import { connectedDatabase, startNoteSuiteDatabase } from '../helpers/note-suite-fixtures/postgres.ts'
import { FIVE_STATES_RESIDENTS, seedFiveStates } from '../helpers/thing-endings-fixtures/five-states.ts'

const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

const MAKER_SECRET = `1f3d9_sk_${'2'.repeat(48)}`

function iso(value: unknown): string {
  return new Date(value as string | Date).toISOString()
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function byId(rows: unknown): Map<number, Json> {
  assert.ok(Array.isArray(rows), 'a list of rows')
  return new Map((rows as Json[]).map(row => [Number(row.id), row]))
}

test('thing endings on the write answers that name a thing, against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-answers')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
    await db.query(schemaDdl)
    const fixture = await seedFiveStates(db)
    const { things, rooms, kinds } = fixture
    const { maker } = FIVE_STATES_RESIDENTS
    await db.query('UPDATE residents SET secret_hash = $2 WHERE id = $1', [
      maker.id, createHash('sha256').update(MAKER_SECRET, 'utf8').digest('hex'),
    ])
    // The maker stands in its own home room, where it makes and edits.
    await db.query(`
      INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
      VALUES ($1, $2, $2)
      ON CONFLICT (resident_id) DO UPDATE SET current_place_id = EXCLUDED.current_place_id
    `, [maker.id, rooms.home])
    const deadline = async (id: number) => iso((await db.query(
      'SELECT ending_deadline FROM things WHERE id = $1', [id],
    )).rows[0]!.ending_deadline)

    await t.test('make answers ends on a kindless and a crafted thing with an end, and none without', async () => {
      const dated = await call(app, MAKER_SECRET, 'POST', '/api/thing', {
        place_id: rooms.home, name: 'a dated pebble', body: '', ending: { any: [{ at: inDays(3) }] },
      })
      assert.equal(dated.status, 201, JSON.stringify(dated.json))
      const datedThing = dated.json.thing as Json
      assert.deepEqual(datedThing.ends, { state: 'set', at: await deadline(Number(datedThing.id)) })

      const counted = await call(app, MAKER_SECRET, 'POST', '/api/thing', {
        place_id: rooms.home, name: 'a counted lamp', body: '', kind_id: kinds.lamp, ingredient_ids: [],
        ending: { any: [{ uses: 2 }] },
      })
      assert.equal(counted.status, 201, JSON.stringify(counted.json))
      assert.deepEqual((counted.json.thing as Json).ends, { state: 'set', at: null }, 'a uses-only end has no known time')

      for (const body of [{}, { ending: null }]) {
        const plain = await call(app, MAKER_SECRET, 'POST', '/api/thing', {
          place_id: rooms.home, name: 'a plain pebble', body: '', ...body,
        })
        assert.equal(plain.status, 201, JSON.stringify(plain.json))
        assert.equal(Object.hasOwn(plain.json.thing as Json, 'ends'), false, 'no end sent, no ends')
      }
    })

    await t.test('thing_edit and thing_upgrade answer the full ending object', async () => {
      const at = inDays(4)
      const edited = await call(app, MAKER_SECRET, 'PATCH', `/api/thing/${things.unset}`, {
        ending: { any: [{ at }] },
      })
      assert.equal(edited.status, 200, JSON.stringify(edited.json))
      const editedEnding = (edited.json.thing as Json).ending as Json
      assert.equal(editedEnding.status, 'active')
      assert.equal(editedEnding.soonest_known_end, await deadline(things.unset))
      assert.equal(typeof (edited.json.thing as Json).end_program_summary, 'string')

      const upgraded = await call(app, MAKER_SECRET, 'POST', `/api/thing/${things.wakeOff}/upgrade`, {
        ending: { any: [{ uses: 3 }] },
      })
      assert.equal(upgraded.status, 200, JSON.stringify(upgraded.json))
      const upgradedEnding = (upgraded.json.thing as Json).ending as Json
      assert.equal(upgradedEnding.status, 'active')
      assert.equal(upgradedEnding.uses_left, 3)
    })

    await t.test('a place edit answers its front matter with ends', async () => {
      await db.query('UPDATE places SET front_matter_thing_ids = $2::integer[] WHERE id = $1', [
        rooms.home, [things.active, things.ran, things.notPermitted],
      ])
      const placed = await call(app, MAKER_SECRET, 'PATCH', `/api/place/${rooms.home}`, {
        description: 'a room for endings, described again',
      })
      assert.equal(placed.status, 200, JSON.stringify(placed.json))
      const frontMatter = byId(placed.json.front_matter)
      assert.deepEqual([...frontMatter.keys()], [things.active, things.ran, things.notPermitted])
      assert.deepEqual(frontMatter.get(things.active)!.ends, { state: 'set', at: await deadline(things.active) })
      const ranEndedAt = iso((await db.query('SELECT ended_at FROM things WHERE id = $1', [things.ran])).rows[0]!.ended_at)
      assert.deepEqual(frontMatter.get(things.ran)!.ends, { state: 'ended', at: ranEndedAt })
      assert.equal(Object.hasOwn(frontMatter.get(things.notPermitted)!, 'ends'), false)
    })
  } finally {
    await postgres.stop()
  }
})
