// The settle-query timing check for things ending (T11), against real PostgreSQL on a
// city-sized fixture (precedent: public-activity-benchmark-postgres.test.ts). Every act,
// note and me settles its room, so the reads the settle step adds must stay cheap even in
// a busy room: the room's due pick, the widened wake probe, the end-try claim with its
// marker over recent settles, and the wake candidates read.
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { coin, FOUNDER, NEIGHBOUR, seedKind, traitId, type CityApp } from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  startNoteSuiteDatabase,
  withNoteSuiteQueryObserver,
} from '../helpers/note-suite-fixtures/postgres.ts'

const KEEPER = Object.freeze({ id: 5, handle: 'end-keeper', secret: `1f3d9_sk_${'5'.repeat(48)}` })
const KINDLESS_GRANT = JSON.stringify({
  kindless: true,
  allowed: ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'],
  limits: { max_seconds: 31_622_400, max_uses: 10_000, labels: null },
  city_limits_version: 1,
})
const ROOMS = 200
const THINGS = 20_000
const OPEN_ENDS = 2_000
const OPEN_ENDS_IN_BUSY_ROOM = 500
const DUE_IN_BUSY_ROOM = 70
const PENDING_IN_BUSY_ROOM = 64
const SETTLES_IN_BUSY_ROOM = 5_000
const SETTLES_ELSEWHERE = 20_000
const RUNS = 5
const BUDGET_MS = 50

interface Captured {
  readonly name: string
  readonly text: string
  readonly values: readonly unknown[]
}

type PlanNode = Readonly<{
  'Node Type'?: string
  'Relation Name'?: string
  'Index Name'?: string
  'Subplan Name'?: string
  'Actual Rows'?: number
  Plans?: PlanNode[]
}>

/** The first plan node with this subplan name, depth first. */
function subplan(node: PlanNode, name: string): PlanNode | null {
  if (node['Subplan Name'] === name) return node
  for (const child of node.Plans ?? []) {
    const found = subplan(child, name)
    if (found) return found
  }
  return null
}

/** Every scan in a plan, as node type and relation or index. */
function scans(node: PlanNode): string[] {
  const own = node['Relation Name'] === undefined && node['Index Name'] === undefined ? [] : [`${node['Node Type']} ${node['Index Name'] ?? node['Relation Name']}`]
  return [...own, ...(node.Plans ?? []).flatMap(scans)]
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

test('the settle step reads stay fast on a city-sized fixture', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('thing-endings-settle-timing')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const { recordDueEnd } = await import('../../src/thing-ending-record.ts')
    const { settleRoom } = await import('../../src/engine-settle.ts')
    const db = connectedDatabase()
    const rooms = await resetCity([FOUNDER, NEIGHBOUR, KEEPER])
    const roomIds = (await db.query<{ id: number }>(`
      INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_things)
      SELECT $1, 'place', 'Timing Room ' || g, 'a room of the timing fixture', $2, TRUE
      FROM generate_series(1, $3::int) g
      RETURNING id
    `, [rooms.continentId, KEEPER.id, ROOMS])).rows.map(row => Number(row.id))
    const busy = roomIds[0]!
    await db.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id)
      SELECT ($1::int[])[1 + (g % $2::int)], 'timing thing ' || g, '', $3, $3
      FROM generate_series(1, $4::int) g
    `, [roomIds, ROOMS, KEEPER.id, THINGS])
    const setEnds = (where: string, at: string, values: readonly unknown[]) => db.query(`
      UPDATE things SET ending_rule = jsonb_build_object('any', jsonb_build_array(jsonb_build_object(
          'at', to_char((now() + '${at}'::interval) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))),
        ending_grant = '${KINDLESS_GRANT}'::jsonb, ending_set_by = owner_id,
        ending_set_at = now() - interval '1 hour', ending_deadline = now() + '${at}'::interval
      WHERE id IN (${where})
    `, [...values])
    await setEnds(`SELECT id FROM things WHERE place_id = $1 AND ending_rule IS NULL ORDER BY id LIMIT $2`,
      '1 day', [busy, OPEN_ENDS_IN_BUSY_ROOM])
    await setEnds(`SELECT id FROM things WHERE place_id <> $1 AND ending_rule IS NULL ORDER BY id LIMIT $2`,
      '1 day', [busy, OPEN_ENDS - OPEN_ENDS_IN_BUSY_ROOM])
    await setEnds(`SELECT id FROM things WHERE place_id = $1 AND ending_rule IS NULL ORDER BY id LIMIT $2`,
      '-1 minute', [busy, DUE_IN_BUSY_ROOM])

    // Remnants whose end try waits, and waking things, in the busy room.
    assert.equal((await coin(app, KEEPER.secret, 'timing-end', { end: { then: [{ effect: 'write', key: 'n', op: 'add' }] } })).status, 201)
    assert.equal((await coin(app, KEEPER.secret, 'timing-wake', { wake: { then: [{ effect: 'write', key: 'n', op: 'add' }] } })).status, 201)
    const endKind = await seedKind(KEEPER.id, 'timing-ends', [await traitId('timing-end')])
    const wakeKind = await seedKind(KEEPER.id, 'timing-wakes', [await traitId('timing-wake')])
    const pending = (await db.query<{ id: number }>(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
      SELECT $1, 'timing remnant ' || g, '', $2, $2, $3, 1, 1, TRUE FROM generate_series(1, $4::int) g
      RETURNING id
    `, [busy, KEEPER.id, endKind, PENDING_IN_BUSY_ROOM])).rows.map(row => Number(row.id))
    await setEnds('SELECT unnest($1::int[])', '-2 minutes', [pending])
    assert.equal((await recordDueEnd(pending)).length, PENDING_IN_BUSY_ROOM)
    await db.query(`
      INSERT INTO things (place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision, wake_enabled)
      SELECT $1, 'timing waker ' || g, '', $2, $2, $3, 1, 1, TRUE FROM generate_series(1, 50) g
    `, [busy, KEEPER.id, wakeKind])

    // Earlier settles of the busy room, the most recent ones naming end units still open.
    // Ids and times rise together, as in a real room: the newest settle is 20 seconds old
    // (outside the 10-second quiet), so the claim marker's recent set holds the latest ones.
    await db.query(`
      INSERT INTO wake_settles (place_id, trigger, resident_id, budget, units, picked, created_at)
      SELECT $1, 'arrive', $2, 8,
        jsonb_build_array(jsonb_build_object('thing_id', ($3::int[])[1 + (g % $4::int)], 'unit_index', 0,
          'reason', 'end', 'pinned', false)),
        '[]'::jsonb, now() - make_interval(secs => ($5::int - g + 1) * 20)
      FROM generate_series(1, $5::int) g
      ORDER BY g
    `, [busy, KEEPER.id, pending, PENDING_IN_BUSY_ROOM, SETTLES_IN_BUSY_ROOM])
    // Settles and their tries in the other rooms, so no read of the busy room's settles or of
    // its things' tries can lean on the busy room being the only one.
    await db.query(`
      INSERT INTO wake_settles (place_id, trigger, resident_id, budget, units, picked, created_at)
      SELECT ($1::int[])[2 + (g % ($2::int - 1))], 'arrive', $3, 8, '[]'::jsonb, '[]'::jsonb,
        now() - make_interval(secs => g)
      FROM generate_series(1, $4::int) g
    `, [roomIds, ROOMS, KEEPER.id, SETTLES_ELSEWHERE])
    await db.query(`
      INSERT INTO wake_tries (settle_id, thing_id, reason, unit_index, status)
      SELECT settle.id, thing.id, 'arrive', 0, 'quiet'
      FROM (SELECT id, row_number() OVER (ORDER BY id) AS n FROM wake_settles WHERE place_id <> $1) settle
      JOIN (SELECT id, row_number() OVER (ORDER BY id) AS n FROM things WHERE place_id <> $1) thing
        ON thing.n = settle.n
    `, [busy])
    await db.query('ANALYZE')

    // Capture the settle's own statements through the fixture's observer, writing nothing:
    // the due pick answers none, and the claim stops at its insert.
    const captured: Captured[] = []
    const markers: ReadonlyArray<readonly [string, (text: string) => boolean]> = [
      ['room due pick', text => text.includes('/* thing-endings:room-due */')],
      ['wake probe', text => text.includes('/* wake:probe */')],
      ['end-try claim', text => text.includes('/* thing-endings:end-claim */')],
      ['wake candidates', text => text.includes("trait.recipe ? 'wake'") && text.includes('thing_wake_state state')],
    ]
    const observe = (text: string, values: readonly unknown[]): string => {
      const marker = markers.find(([, matches]) => matches(text))
      if (marker) captured.push({ name: marker[0], text, values })
      if (marker?.[0] === 'room due pick') return `SELECT * FROM (${text}) captured WHERE false`
      // The claim stops at its insert, so the claim transaction rolls back and nothing runs.
      if (/INSERT INTO wake_settles/u.test(text)) return 'SELECT 1 / 0'
      return text
    }
    const logged = mock.method(console, 'error', () => {})
    try {
      await withNoteSuiteQueryObserver(observe, () => settleRoom(busy, 'arrive', KEEPER.id))
    } finally {
      logged.mock.restore()
    }
    assert.deepEqual(captured.map(statement => statement.name).sort(),
      ['end-try claim', 'room due pick', 'wake candidates', 'wake probe'])

    for (const statement of captured) {
      const times: number[] = []
      let plan = ''
      let recentRows: number | null = null
      for (let run = 0; run < RUNS; run += 1) {
        const explained = (await db.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${statement.text}`, [...statement.values]))
          .rows[0]!['QUERY PLAN'] as Array<{ 'Execution Time': number; 'Planning Time': number; Plan: PlanNode }>
        times.push(explained[0]!['Execution Time'] + explained[0]!['Planning Time'])
        plan = scans(explained[0]!.Plan).join(', ')
        recentRows = subplan(explained[0]!.Plan, 'CTE recent')?.['Actual Rows'] ?? null
      }
      const took = median(times)
      // The marker must be measured doing its work: the busy room's latest settles are recent.
      if (statement.name === 'end-try claim') {
        assert.ok(recentRows !== null && recentRows > 0, `end-try claim: the marker's recent set is empty (${recentRows})`)
      }
      t.diagnostic(`${statement.name}: median ${took.toFixed(2)} ms over ${RUNS} runs${
        statement.name === 'end-try claim' ? `, recent settles ${recentRows}` : ''}, plan ${plan}`)
      assert.ok(took < BUDGET_MS, `${statement.name}: median ${took.toFixed(1)} ms over ${RUNS} runs, plan ${plan}`)
      assert.doesNotMatch(plan, /Seq Scan (things|wake_settles)\b/u, `${statement.name}: no full scan of things or settles: ${plan}`)
      if (statement.name === 'room due pick') assert.match(plan, /things_ending_open/u, plan)
      if (statement.name === 'end-try claim') assert.match(plan, /things_end_try_pending/u, plan)
    }
  } finally {
    await postgres.stop()
  }
})
