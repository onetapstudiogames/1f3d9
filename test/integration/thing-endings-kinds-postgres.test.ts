// Kind permission over the real routes (things ending, T6): invent_kind and revise_kind
// accept ending_policy (E1), the paid completion stores it and kinds.invented_by, an
// omitted policy keeps the current one, #116 counts it, and only the kind's inventor
// while owning it may widen it or change its end trait (E19). Every refusal is proved
// before any fee: no payment attempt and no revision is written.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import {
  bearer,
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
const MAKER = Object.freeze({ id: 2, handle: 'kind-maker', secret: `1f3d9_sk_${'2'.repeat(48)}` })
const BUYER = Object.freeze({ id: 3, handle: 'kind-buyer', secret: `1f3d9_sk_${'3'.repeat(48)}` })

type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
type Json = Record<string, unknown>
type Answer = Readonly<{ status: number; json: Json }>

async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
  creditRequestId?: string,
): Promise<Answer> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: {
      ...(secret === null ? {} : bearer(secret)),
      ...(creditRequestId === undefined ? {} : { 'x-1f3d9-fee-credit': creditRequestId }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

function requestId(): string {
  return `fee-${randomBytes(16).toString('hex')}`
}

async function count(query: string, values: readonly unknown[] = []): Promise<number> {
  return Number((await connectedDatabase().query<{ n: string }>(query, [...values])).rows[0]!.n)
}

async function creditUnits(residentId: number): Promise<string> {
  return String((await connectedDatabase().query(
    `SELECT coalesce((SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = $1), '0') AS units`,
    [residentId],
  )).rows[0]!.units)
}

/** A kind at revision 1, inserted directly; invented_by may be any value on insert. */
async function seedKind(input: Readonly<{
  name: string
  ownerId: number
  inventedBy: number | null
  traits?: readonly string[]
  policy?: Json
}>): Promise<number> {
  const db = connectedDatabase()
  const id = Number((await db.query<{ id: number }>(
    'INSERT INTO kinds (name, owner_id, invented_by) VALUES ($1, $2, $3) RETURNING id',
    [input.name, input.ownerId, input.inventedBy],
  )).rows[0]!.id)
  await db.query(
    `INSERT INTO kind_revisions (kind_id, revision, description, traits, ending_policy)
     VALUES ($1, 1, $2, $3::text[], $4::jsonb)`,
    [id, `${input.name} for the kind permission suite`, [...(input.traits ?? [])], JSON.stringify(input.policy ?? { allowed: [] })],
  )
  return id
}

async function storedPolicy(kindId: number, revision?: number): Promise<unknown> {
  return (await connectedDatabase().query(`
    SELECT revision.ending_policy
    FROM kinds kind
    JOIN kind_revisions revision ON revision.kind_id = kind.id
      AND revision.revision = coalesce($2::integer, kind.current_revision)
    WHERE kind.id = $1
  `, [kindId, revision ?? null])).rows[0]?.ending_policy
}

async function currentRevision(kindId: number): Promise<number> {
  return Number((await connectedDatabase().query(
    'SELECT current_revision FROM kinds WHERE id = $1', [kindId],
  )).rows[0]!.current_revision)
}

async function lastRequest(actorId: number): Promise<Json> {
  return (await connectedDatabase().query<{ request_json: Json }>(
    'SELECT request_json FROM payment_attempts WHERE actor_id = $1 ORDER BY created_at DESC, public_id DESC LIMIT 1',
    [actorId],
  )).rows[0]!.request_json
}

test('kind permission on the real doors against PostgreSQL', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-kinds')
  try {
    // Loaded only after the fixture points src/db.ts at the test container.
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { issueCityFeeCredit, beginCityCreditSpend } = await import('../../src/city-credit.ts')
    const { ENDING_POLICY_REFUSAL, ENDING_POLICY_WIDEN_REFUSAL } = await import('../../src/thing-ending-refusals.ts')
    const creditDb = {
      query: async (text: string, params: readonly unknown[] = []) => (await connectedDatabase().query(text, [...params])).rows,
    }
    const fund = async (residentId: number, credits: number) => {
      for (let index = 0; index < credits; index += 1) {
        const issued = await issueCityFeeCredit(creditDb, {
          founderId: FOUNDER.id,
          residentId,
          sourceKey: `thing-endings-kinds-${randomBytes(6).toString('hex')}`,
          reason: 'fund one kind fee in the kind permission suite',
        })
        assert.equal(issued.disposition, 'created')
      }
    }
    const coin = async (name: string, recipe: unknown) => {
      const coined = await call(app, MAKER.secret, 'POST', '/api/trait', {
        name, description: `${name} for the kind permission suite`, recipe,
      })
      assert.equal(coined.status, 201, JSON.stringify(coined.json))
    }
    const reset = async () => {
      const rooms = await resetCity([FOUNDER, MAKER, BUYER])
      await standIn(MAKER.id, rooms.eastRoomId)
      await standIn(BUYER.id, rooms.eastRoomId)
    }

    await t.test('invent_kind stores ending_policy and invented_by, and refuses a bad policy with E1 before any fee', async () => {
      await reset()
      await fund(MAKER.id, 3)

      const timed = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'hourglass',
        description: 'runs out',
        ending_policy: { allowed: ['uses', 'at'], max_uses: 5 },
      }, requestId())
      assert.equal(timed.status, 201, JSON.stringify(timed.json))
      const timedKind = timed.json.kind as Json
      assert.deepEqual(timedKind.ending_policy, { allowed: ['at', 'uses'], max_uses: 5 })
      assert.deepEqual(timedKind.invented_by, { id: MAKER.id, handle: MAKER.handle })
      const timedId = Number(timedKind.id)
      assert.deepEqual(await storedPolicy(timedId), { allowed: ['at', 'uses'], max_uses: 5 })
      assert.equal(Number((await connectedDatabase().query(
        'SELECT invented_by FROM kinds WHERE id = $1', [timedId],
      )).rows[0]!.invented_by), MAKER.id)
      assert.deepEqual((await lastRequest(MAKER.id)).ending_policy, { allowed: ['at', 'uses'], max_uses: 5 })

      const plain = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'pebble', description: 'stays',
      }, requestId())
      assert.equal(plain.status, 201, JSON.stringify(plain.json))
      assert.deepEqual((plain.json.kind as Json).ending_policy, { allowed: [] })
      assert.deepEqual(await storedPolicy(Number((plain.json.kind as Json).id)), { allowed: [] })
      assert.equal(Object.hasOwn(await lastRequest(MAKER.id), 'ending_policy'), false, 'an omitted policy is not in the stored request')

      const empty = await call(app, MAKER.secret, 'POST', '/api/kind', {
        name: 'stone', description: 'also stays', ending_policy: { allowed: [] },
      }, requestId())
      assert.equal(empty.status, 201, JSON.stringify(empty.json))
      assert.equal(Object.hasOwn(await lastRequest(MAKER.id), 'ending_policy'), false, 'an explicit default is never stored')

      await fund(MAKER.id, 1)
      const attemptsBefore = await count('SELECT count(*) AS n FROM payment_attempts')
      const kindsBefore = await count('SELECT count(*) AS n FROM kinds')
      for (const policy of [
        { allowed: ['forever'] },
        null,
        { allowed: ['label_added'] },
        { allowed: ['uses', 'uses'] },
        { allowed: ['uses'], max_uses: 0 },
        'uses',
      ]) {
        const refused = await call(app, MAKER.secret, 'POST', '/api/kind', {
          name: 'bad-glass', description: 'never made', ending_policy: policy,
        }, requestId())
        assert.equal(refused.status, 400, JSON.stringify(policy))
        assert.equal(refused.json.error, ENDING_POLICY_REFUSAL, JSON.stringify(policy))
      }
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), attemptsBefore, 'no fee was opened')
      assert.equal(await count('SELECT count(*) AS n FROM kinds'), kindsBefore)
      assert.equal(await creditUnits(MAKER.id), '1000000', 'the refusals spent nothing')
    })

    await t.test('revise_kind keeps an omitted policy, charges a policy-only change, and refuses an identical one', async () => {
      await reset()
      const lamp = await seedKind({ name: 'lamp', ownerId: MAKER.id, inventedBy: MAKER.id, policy: { allowed: ['uses'] } })
      await fund(MAKER.id, 3)

      const described = await call(app, MAKER.secret, 'POST', `/api/kind/${lamp}/revise`, {
        description: 'a lamp with a new description',
      }, requestId())
      assert.equal(described.status, 200, JSON.stringify(described.json))
      assert.deepEqual((described.json.kind as Json).ending_policy, { allowed: ['uses'] })
      assert.deepEqual((described.json.kind as Json).invented_by, { id: MAKER.id, handle: MAKER.handle })
      assert.deepEqual(await storedPolicy(lamp, 2), { allowed: ['uses'] }, 'an omitted policy keeps the current one')
      assert.deepEqual((await lastRequest(MAKER.id)).ending_policy, { allowed: ['uses'] })

      const attemptsBefore = await count('SELECT count(*) AS n FROM payment_attempts')
      for (const body of [{}, { ending_policy: { allowed: ['uses'] } }]) {
        const identical = await call(app, MAKER.secret, 'POST', `/api/kind/${lamp}/revise`, body, requestId())
        assert.equal(identical.status, 409, JSON.stringify(identical.json))
        assert.equal(
          identical.json.error,
          `this revision is identical to the current revision 2 of kind ${lamp}, so there is nothing to pay for and nothing was charged; change the description, traits, recipe, drawing, drawing_variants, or ending_policy before revising`,
        )
      }
      for (const policy of [{ allowed: ['soon'] }, null]) {
        const refused = await call(app, MAKER.secret, 'POST', `/api/kind/${lamp}/revise`, { ending_policy: policy }, requestId())
        assert.equal(refused.status, 400, JSON.stringify(refused.json))
        assert.equal(refused.json.error, ENDING_POLICY_REFUSAL)
      }
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), attemptsBefore, 'no fee was opened')
      assert.equal(await currentRevision(lamp), 2)

      const policyOnly = await call(app, MAKER.secret, 'POST', `/api/kind/${lamp}/revise`, {
        ending_policy: { allowed: ['idle_seconds', 'uses'] },
      }, requestId())
      assert.equal(policyOnly.status, 200, JSON.stringify(policyOnly.json))
      assert.deepEqual(await storedPolicy(lamp, 3), { allowed: ['uses', 'idle_seconds'] })
      assert.equal(await creditUnits(MAKER.id), '1000000', 'the policy-only change spent one credit')

      const cleared = await call(app, MAKER.secret, 'POST', `/api/kind/${lamp}/revise`, {
        ending_policy: { allowed: [] },
      }, requestId())
      assert.equal(cleared.status, 200, JSON.stringify(cleared.json))
      assert.deepEqual(await storedPolicy(lamp, 4), { allowed: [] })
      assert.equal(Object.hasOwn(await lastRequest(MAKER.id), 'ending_policy'), false, 'the default is left out of the stored request')
      assert.equal(await creditUnits(MAKER.id), '0')
    })

    await t.test('only the inventor while owning it may widen the policy or change the end trait (E19)', async () => {
      await reset()
      await coin('last-glow', { end: { then: [{ effect: 'write', key: 'last', value: true }] } })
      await coin('final-ring', { end: { then: [] } })
      await coin('plain-bell', { talk: [{ effect: 'label', target: 'place', label: 'rung', seconds: 60 }] })
      const policy = { allowed: ['uses', 'label_added'], labels: ['spent', 'worn'], max_uses: 10 }
      const bell = await seedKind({ name: 'bell', ownerId: MAKER.id, inventedBy: MAKER.id, traits: ['last-glow', 'plain-bell'], policy })
      const gong = await seedKind({ name: 'gong', ownerId: MAKER.id, inventedBy: MAKER.id, traits: ['plain-bell'], policy })
      // A gift or sale changes only owner_id; invented_by stays the maker.
      await connectedDatabase().query('UPDATE kinds SET owner_id = $1 WHERE id = ANY($2::int[])', [BUYER.id, [bell, gong]])
      await fund(BUYER.id, 3)

      const attemptsBefore = await count('SELECT count(*) AS n FROM payment_attempts')
      const refusals: ReadonlyArray<readonly [string, number, Json]> = [
        ['adds a mode', bell, { ending_policy: { ...policy, allowed: ['uses', 'label_added', 'idle_seconds'] } }],
        ['adds a label', bell, { ending_policy: { ...policy, labels: ['spent', 'worn', 'cracked'] } }],
        ['raises max_uses', bell, { ending_policy: { ...policy, max_uses: 20 } }],
        ['drops max_uses', bell, { ending_policy: { allowed: policy.allowed, labels: policy.labels } }],
        ['drops the end trait', bell, { traits: ['plain-bell'] }],
        ['replaces the end trait', bell, { traits: ['final-ring', 'plain-bell'] }],
        ['adds an end trait', gong, { traits: ['plain-bell', 'last-glow'] }],
      ]
      for (const [name, kindId, body] of refusals) {
        const refused = await call(app, BUYER.secret, 'POST', `/api/kind/${kindId}/revise`, body, requestId())
        assert.equal(refused.status, 403, `${name}: ${JSON.stringify(refused.json)}`)
        assert.equal(refused.json.error, ENDING_POLICY_WIDEN_REFUSAL, name)
      }
      assert.equal(await count('SELECT count(*) AS n FROM payment_attempts'), attemptsBefore, 'no fee was opened')
      assert.equal(await count('SELECT count(*) AS n FROM kind_revisions WHERE kind_id = ANY($1::int[])', [[bell, gong]]), 2)

      // Reordering labels neither widens nor matches, so a buyer may pay for it.
      const reordered = await call(app, BUYER.secret, 'POST', `/api/kind/${bell}/revise`, {
        ending_policy: { ...policy, labels: ['worn', 'spent'] },
      }, requestId())
      assert.equal(reordered.status, 200, JSON.stringify(reordered.json))
      const narrowed = await call(app, BUYER.secret, 'POST', `/api/kind/${bell}/revise`, {
        ending_policy: { allowed: ['uses'], max_uses: 4 },
      }, requestId())
      assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json))
      assert.deepEqual(await storedPolicy(bell), { allowed: ['uses'], max_uses: 4 })
      const kept = await call(app, BUYER.secret, 'POST', `/api/kind/${bell}/revise`, {
        description: 'a bell the buyer described', traits: ['last-glow', 'plain-bell'],
      }, requestId())
      assert.equal(kept.status, 200, JSON.stringify(kept.json))
      assert.deepEqual(await storedPolicy(bell), { allowed: ['uses'], max_uses: 4 }, 'the buyer kept the narrowed policy')
      assert.equal(await creditUnits(BUYER.id), '0')

      // A kind with no proven inventor cannot widen, even for its owner.
      const drum = await seedKind({ name: 'drum', ownerId: MAKER.id, inventedBy: null, traits: ['last-glow'], policy: { allowed: ['uses'] } })
      for (const body of [
        { ending_policy: { allowed: ['uses', 'at'] } },
        { traits: ['final-ring'] },
      ]) {
        const refused = await call(app, MAKER.secret, 'POST', `/api/kind/${drum}/revise`, body, requestId())
        assert.equal(refused.status, 403, JSON.stringify(refused.json))
        assert.equal(refused.json.error, ENDING_POLICY_WIDEN_REFUSAL)
      }

      // The inventor while owning it may widen and replace its end trait.
      const horn = await seedKind({ name: 'horn', ownerId: MAKER.id, inventedBy: MAKER.id, traits: ['last-glow'], policy: { allowed: ['uses'] } })
      await fund(MAKER.id, 1)
      const widened = await call(app, MAKER.secret, 'POST', `/api/kind/${horn}/revise`, {
        traits: ['final-ring'], ending_policy: { allowed: ['uses', 'at'] },
      }, requestId())
      assert.equal(widened.status, 200, JSON.stringify(widened.json))
      assert.deepEqual(await storedPolicy(horn), { allowed: ['at', 'uses'] })
    })

    await t.test('kind reads show ending_policy and invented_by, and a removed kind hides its policy labels', async () => {
      await reset()
      const policy = { allowed: ['uses', 'label_added'], labels: ['spent'], max_uses: 10 }
      const bell = await seedKind({ name: 'bell', ownerId: MAKER.id, inventedBy: MAKER.id, policy })
      const drum = await seedKind({ name: 'drum', ownerId: MAKER.id, inventedBy: null })
      const read = async () => {
        const answer = await call(app, null, 'GET', '/api/kinds')
        assert.equal(answer.status, 200, JSON.stringify(answer.json))
        return new Map((answer.json.kinds as Json[]).map(kind => [Number(kind.id), kind]))
      }
      const kinds = await read()
      assert.deepEqual(kinds.get(bell)!.ending_policy, policy)
      assert.deepEqual(kinds.get(bell)!.invented_by, { id: MAKER.id, handle: MAKER.handle })
      assert.deepEqual(kinds.get(drum)!.ending_policy, { allowed: [] })
      assert.equal(kinds.get(drum)!.invented_by, null)

      await connectedDatabase().query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('kind', $1, 'remove', 1, 'suite: hide the kind')
      `, [bell])
      const hidden = (await read()).get(bell)!
      assert.deepEqual(hidden.ending_policy, {
        allowed: ['uses', 'label_added'], labels: ['[removed by maintainer]'], max_uses: 10,
      })
    })

    await t.test('the private payment attempt read shows the ending_policy a resident is paying for', async () => {
      await reset()
      await fund(MAKER.id, 1)
      const pending = await beginCityCreditSpend(creditDb, {
        actorId: MAKER.id,
        operation: 'kind_invention',
        targetKey: 'kind-invention:candle',
        request: { name: 'candle', description: 'burns down', traits: [], recipe: [], ending_policy: { allowed: ['uses'] } },
        requestId: requestId(),
      })
      assert.equal(pending.state, 'ready')
      if (pending.state !== 'ready') assert.fail('the spend did not acquire its lease')
      const answer = await call(app, MAKER.secret, 'GET', `/api/payment-attempt/${pending.attempt_id}`)
      assert.equal(answer.status, 200, JSON.stringify(answer.json))
      const attempt = answer.json.payment_attempt as Json
      assert.deepEqual((attempt.request as Json).ending_policy, { allowed: ['uses'] })
    })
  } finally {
    await postgres.stop()
  }
})
