import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { Pool } from 'pg'
import { loadPublicChanges, parsePublicChangeQuery } from '../../../src/public-changes.ts'
import type { PublicQueryExecutor } from '../../../src/public-pagination.ts'
import { schemaDdl } from '../../helpers/public-pagination-fixtures/seed-city.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerChangesTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  function publicChangeQuery(
    query: Readonly<Record<string, readonly string[]>>,
  ) {
    const parsed = parsePublicChangeQuery(query)
    if (!parsed.ok) assert.fail(parsed.error)
    return parsed
  }

  await t.test('public markers page committed changes without exposing event ids', async () => {
    const markerSchema = `wave_five_markers_${randomBytes(6).toString('hex')}`
    await postgres.client.query(`CREATE SCHEMA "${markerSchema}"`)
    const markerPool = new Pool({
      connectionString: postgres.databaseUrl,
      options: `-c search_path=${markerSchema}`,
    })
    const markerExecute: PublicQueryExecutor = async (text, values) => (
      await markerPool.query(text, [...values])
    ).rows as Record<string, unknown>[]
    try {
      await markerPool.query(schemaDdl)
    type ChangePayload = Readonly<{
      change_marker: string
      changes: readonly Readonly<Record<string, unknown> & { change_id: string; kind: string }>[]
      returned_items: number
      unchanged: boolean
      has_more: boolean
      next_since: string
    }>
    const checkpoint = await loadPublicChanges(
      markerExecute,
      publicChangeQuery({}),
    ) as Readonly<{ change_marker: string }>
    const unchanged = await loadPublicChanges(
      markerExecute,
      publicChangeQuery({ since: [checkpoint.change_marker] }),
    ) as ChangePayload
    assert.equal(unchanged.unchanged, true)
    assert.equal(unchanged.returned_items, 0)
    assert.equal(unchanged.next_since, checkpoint.change_marker)

    const committedIds: number[] = []
    for (let itemNumber = 1; itemNumber <= 5; itemNumber += 1) {
      const event = (await markerPool.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('note', 'wave-five-marker', jsonb_build_object('item', $1::integer))
          RETURNING id
        `, [itemNumber])).rows[0]!
      committedIds.push(event.id)
    }

    const changes: Array<Readonly<Record<string, unknown> & { change_id: string; kind: string }>> = []
    let since = checkpoint.change_marker
    let finalCheckpoint: string | null = null
    for (let pageNumber = 0; pageNumber < 10; pageNumber += 1) {
      const page = await loadPublicChanges(
        markerExecute,
        publicChangeQuery({ since: [since], limit: ['2'] }),
      ) as ChangePayload
      finalCheckpoint ??= page.change_marker
      assert.equal(page.change_marker, finalCheckpoint)
      assert.equal(page.returned_items, page.changes.length)
      changes.push(...page.changes)
      since = page.next_since
      if (!page.has_more) break
    }
    assert.deepEqual(
      changes.map(change => BigInt(change.change_id)),
      changes.map((_, index) => BigInt(checkpoint.change_marker) + BigInt(index + 1)),
    )
    assert.equal(new Set(changes.map(change => change.change_id)).size, committedIds.length)
    assert.equal(changes.every(change => !Object.hasOwn(change, 'id')), true)

    const filterStart = BigInt(finalCheckpoint!)
    for (const [kind, actor] of [
      ['action', 'wave-five-filter-action-one'],
      ['note', 'wave-five-filter-note-one'],
      ['action', 'wave-five-filter-action-two'],
      ['note', 'wave-five-filter-note-two'],
      ['action', 'wave-five-filter-action-three'],
    ] as const) {
      await markerPool.query(`
          INSERT INTO events (kind, actor, detail)
          VALUES ($1, $2, '{}')
        `, [kind, actor])
    }

    const firstNotePage = await loadPublicChanges(
      markerExecute,
      publicChangeQuery({
        since: [filterStart.toString()], kind: ['note'], limit: ['1'],
      }),
    ) as ChangePayload
    assert.equal(firstNotePage.has_more, true)
    assert.equal(firstNotePage.next_since, (filterStart + 2n).toString())
    assert.deepEqual(firstNotePage.changes.map(change => change.kind), ['note'])
    assert.equal(firstNotePage.changes.every(change => !Object.hasOwn(change, 'id')), true)

    const finalNotePage = await loadPublicChanges(
      markerExecute,
      publicChangeQuery({
        since: [firstNotePage.next_since], kind: ['note'], limit: ['1'],
      }),
    ) as ChangePayload
    assert.equal(finalNotePage.has_more, false)
    assert.equal(finalNotePage.next_since, (filterStart + 5n).toString())
    assert.equal(finalNotePage.change_marker, finalNotePage.next_since)
    assert.deepEqual(finalNotePage.changes.map(change => change.kind), ['note'])

    const firstCommitClient = await markerPool.connect()
    const secondCommitClient = await markerPool.connect()
    let pendingSecondInsert: Promise<{ id: number }> | null = null
    try {
      await firstCommitClient.query('BEGIN')
      await secondCommitClient.query('BEGIN')

      const firstBackendPid = (
        await firstCommitClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid
      const secondBackendPid = (
        await secondCommitClient.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid
      const markerBeforeConcurrentCommits = BigInt((await firstCommitClient.query<{
        marker: string
      }>(`
          SELECT current_change_id::text AS marker
          FROM public_change_state WHERE singleton = true
        `)).rows[0]!.marker)

      const firstConcurrentEvent = (await firstCommitClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-first-concurrent', '{"concurrent":1}')
          RETURNING id
        `)).rows[0]!

      let secondInsertSettled = false
      pendingSecondInsert = secondCommitClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-second-concurrent', '{"concurrent":2}')
          RETURNING id
        `).then(result => result.rows[0]!).finally(() => {
        secondInsertSettled = true
      })

      let secondInsertIsBlocked = false
      for (let attempt = 0; attempt < 200 && !secondInsertIsBlocked; attempt += 1) {
        const blockingResult = await markerPool.query<{ blocked: boolean }>(
          'SELECT $1::integer = ANY(pg_blocking_pids($2::integer)) AS blocked',
          [firstBackendPid, secondBackendPid],
        )
        secondInsertIsBlocked = blockingResult.rows[0]?.blocked === true
        if (!secondInsertIsBlocked) {
          await new Promise(resolve => setTimeout(resolve, 10))
        }
      }

      assert.equal(
        secondInsertIsBlocked,
        true,
        'the second insert should wait for the singleton marker row held by the first transaction',
      )
      assert.equal(secondInsertSettled, false)

      await firstCommitClient.query('COMMIT')
      const secondConcurrentEvent = await pendingSecondInsert
      await secondCommitClient.query('COMMIT')
      pendingSecondInsert = null

      const concurrentMarkers = await markerPool.query<{
        event_id: number
        change_id: string
      }>(`
          SELECT event_id, change_id::text AS change_id
          FROM public_change_log
          WHERE event_id = ANY($1::bigint[])
          ORDER BY change_id ASC
        `, [[firstConcurrentEvent.id, secondConcurrentEvent.id]])
      assert.deepEqual(concurrentMarkers.rows, [
        {
          event_id: firstConcurrentEvent.id,
          change_id: (markerBeforeConcurrentCommits + 1n).toString(),
        },
        {
          event_id: secondConcurrentEvent.id,
          change_id: (markerBeforeConcurrentCommits + 2n).toString(),
        },
      ])
    } finally {
      await firstCommitClient.query('ROLLBACK').catch(() => undefined)
      await pendingSecondInsert?.catch(() => undefined)
      await secondCommitClient.query('ROLLBACK').catch(() => undefined)
      firstCommitClient.release()
      secondCommitClient.release()
    }

    const markerBeforeRollback = BigInt((await markerPool.query<{ marker: string }>(`
        SELECT current_change_id::text AS marker
        FROM public_change_state WHERE singleton = true
      `)).rows[0]!.marker)
    const rollbackClient = await markerPool.connect()
    let rolledBackEventId = 0
    try {
      await rollbackClient.query('BEGIN')
      rolledBackEventId = (await rollbackClient.query<{ id: number }>(`
          INSERT INTO events (kind, actor, detail)
          VALUES ('action', 'wave-five-rollback', '{"rolled_back":true}')
          RETURNING id
        `)).rows[0]!.id
      const provisional = (await rollbackClient.query<{ change_id: string }>(`
          SELECT change_id::text FROM public_change_log WHERE event_id = $1
        `, [rolledBackEventId])).rows[0]!
      assert.equal(BigInt(provisional.change_id), markerBeforeRollback + 1n)
      await rollbackClient.query('ROLLBACK')
    } finally {
      rollbackClient.release()
    }
    assert.equal((await markerPool.query(
      `SELECT 1 FROM public_change_log WHERE event_id = $1`,
      [rolledBackEventId],
    )).rowCount, 0)
    const afterRollback = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('action', 'wave-five-after-rollback', '{"committed":true}')
        RETURNING id
      `)).rows[0]!
    const reused = (await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [afterRollback.id])).rows[0]!
    assert.equal(BigInt(reused.change_id), markerBeforeRollback + 1n)

    const reservedLowerId = Number((await markerPool.query<{ id: string }>(`
        SELECT nextval(pg_get_serial_sequence('events', 'id'))::text AS id
      `)).rows[0]!.id)
    const higher = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (kind, actor, detail)
        VALUES ('action', 'wave-five-higher-id', '{}')
        RETURNING id
      `)).rows[0]!
    const higherMarker = BigInt((await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [higher.id])).rows[0]!.change_id)
    const lower = (await markerPool.query<{ id: number }>(`
        INSERT INTO events (id, kind, actor, detail)
        VALUES ($1, 'action', 'wave-five-lower-id-later', '{}')
        RETURNING id
      `, [reservedLowerId])).rows[0]!
    const lowerMarker = BigInt((await markerPool.query<{ change_id: string }>(`
        SELECT change_id::text FROM public_change_log WHERE event_id = $1
      `, [lower.id])).rows[0]!.change_id)
    assert.ok(lower.id < higher.id)
    assert.equal(lowerMarker, higherMarker + 1n)
    } finally {
      await markerPool.end().catch(() => undefined)
    }
  })

}
