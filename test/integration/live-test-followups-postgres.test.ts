// Follow-ups from the 2026-09-23 live test of the abilities release, against real
// PostgreSQL through the real routes in src/index.ts.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  FOUNDER, GROWER, coin, seedKind, traitId, type CityApp, type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  bearer,
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

// Loaded only after the fixture points src/db.ts at the test container.
const { issueCityFeeCredit } = await import('../../src/city-credit.ts')

function creditRequestId(): string {
  return `fee-${randomBytes(16).toString('hex')}`
}

async function fundOneCredit(residentId: number): Promise<void> {
  const db = connectedDatabase()
  const issued = await issueCityFeeCredit({
    query: async (text, params = []) => (await db.query(text, [...params])).rows,
  }, {
    founderId: FOUNDER.id,
    residentId,
    sourceKey: `live-test-followups-${randomBytes(6).toString('hex')}`,
    reason: 'fund one kind revision in the live-test follow-up suite',
  })
  assert.equal(issued.disposition, 'created')
}

async function creditUnits(residentId: number): Promise<string> {
  return String((await connectedDatabase().query(
    `SELECT coalesce((SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = $1), '0') AS units`,
    [residentId],
  )).rows[0]!.units)
}

async function revise(
  app: CityApp,
  kindId: number,
  body: Json,
  requestId: string | null,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test/api/kind/${kindId}/revise`, {
    method: 'POST',
    headers: {
      ...bearer(GROWER.secret),
      ...(requestId === null ? {} : { 'x-1f3d9-fee-credit': requestId }),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

test('live-test follow-ups against real PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('live-test-followups')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }

    await t.test('a revision identical to the current one is refused before any fee', async () => {
      await resetCity([FOUNDER, GROWER])
      for (const name of ['moss', 'fern']) {
        assert.equal((await coin(app, GROWER.secret, name, null)).status, 201, name)
      }
      const lichen = await seedKind(GROWER.id, 'lichen', [await traitId('moss')])
      await fundOneCredit(GROWER.id)

      for (const [body, requestId] of [
        [{ traits: ['moss'] }, creditRequestId()],
        [{}, creditRequestId()],
        [{ traits: ['moss'], description: '', recipe: [] }, null],
      ] as const) {
        const refused = await revise(app, lichen, body, requestId)
        assert.equal(refused.status, 409, JSON.stringify(refused.json))
        assert.equal(
          refused.json.error,
          `this revision is identical to the current revision 1 of kind ${lichen}, so there is nothing to pay for and nothing was charged; change the description, traits, recipe, drawing, or drawing_variants before revising`,
        )
      }
      const db = connectedDatabase()
      assert.equal(await creditUnits(GROWER.id), '1000000', 'no credit was spent')
      assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM payment_attempts')).rows[0]!.n), 0, 'no payment was opened')
      assert.equal(Number((await db.query('SELECT current_revision FROM kinds WHERE id = $1', [lichen])).rows[0]!.current_revision), 1)

      // The same traits in another order are a change, and a real change is still paid.
      const changed = await revise(app, lichen, { traits: ['fern', 'moss'] }, creditRequestId())
      assert.equal(changed.status, 200, JSON.stringify(changed.json))
      assert.equal((changed.json.kind as Json).revision, 2)
      assert.equal(await creditUnits(GROWER.id), '0', 'the change spent its one credit')
    })
  } finally {
    await postgres.stop()
  }
})
