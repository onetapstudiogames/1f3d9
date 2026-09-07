import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { issueCityFeeCredit, type CityCreditDatabase } from '../../../src/city-credit.ts'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerPlaceLifecycleActionsTests(
  t: TestContext,
  {
    actor, app, bearer, database, founderSecret, postgresCode, resetDatabase,
    setEngineTransactionRunnerForTests, transactionSql, withdrawThing,
  }: Pick<WorldTestContext,
    | 'actor' | 'app' | 'bearer' | 'database' | 'founderSecret' | 'postgresCode'
    | 'resetDatabase' | 'setEngineTransactionRunnerForTests' | 'transactionSql'
    | 'withdrawThing'
  >,
): Promise<void> {
  await t.test('rename, retire, and restore spend atomically while preserving place history', async () => {
    setEngineTransactionRunnerForTests(async (_db, work) => {
      const connection = await database!.connect()
      try {
        await connection.query('BEGIN')
        const result = await work(transactionSql(connection), true)
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK')
        throw error
      } finally {
        connection.release()
      }
    })
    try {
      const roomId = await resetDatabase()
      const creditDatabase: CityCreditDatabase = {
        query: async (text, params = []) => (
          await database!.query(text, [...params])
        ).rows,
      }
      for (let index = 0; index < 5; index += 1) {
        await issueCityFeeCredit(creditDatabase, {
          founderId: 1,
          residentId: 1,
          sourceKey: `place-lifecycle-credit-${index}`,
          reason: `fund place lifecycle integration act ${index}`,
        })
      }
      await database!.query(`
        INSERT INTO notes (place_id, author_id, body)
        VALUES ($1, 1, 'This note must remain readable at the tombstone.')
      `, [roomId])

      const rename = await app.request(`/api/place/${roomId}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-rename-integration-0001',
        },
        body: JSON.stringify({ name: 'The quiet porch' }),
      })
      assert.equal(rename.status, 200, await rename.clone().text())
      assert.equal((await rename.json() as { place: { name: string } }).place.name, 'The quiet porch')

      const refusedRetire = await app.request(`/api/place/${roomId}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-retire-not-empty-0001',
        },
        body: JSON.stringify({ retired: true }),
      })
      assert.equal(refusedRetire.status, 409, await refusedRetire.clone().text())
      assert.match(await refusedRetire.text(), /place is not empty.*1 thing/iu)

      const afterRefusal = await database!.query<{
        name: string
        retired_at: Date | null
        balance_units: string
        spends: number
        returns: number
      }>(`
        SELECT place.name, place.retired_at,
          account.balance_units::text AS balance_units,
          (SELECT count(*)::integer FROM city_credit_entries
            WHERE resident_id = 1 AND entry_kind = 'spend') AS spends,
          (SELECT count(*)::integer FROM city_credit_entries
            WHERE resident_id = 1 AND entry_kind = 'return') AS returns
        FROM places place
        JOIN city_credit_accounts account ON account.resident_id = place.owner_id
        WHERE place.id = $1
      `, [roomId])
      assert.deepEqual(afterRefusal.rows, [{
        name: 'The quiet porch', retired_at: null, balance_units: '4000000', spends: 1, returns: 0,
      }])

      const withdrawn = await withdrawThing(actor, 1, 'withdrawn')
      assert.equal('error' in withdrawn, false)
      const retire = await app.request(`/api/place/${roomId}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-retire-integration-0001',
        },
        body: JSON.stringify({ retired: true }),
      })
      assert.equal(retire.status, 200, await retire.clone().text())

      const tombstoneResponse = await app.request(`/api/place/${roomId}`)
      assert.equal(tombstoneResponse.status, 200, await tombstoneResponse.clone().text())
      const tombstone = await tombstoneResponse.json() as {
        tombstone: { id: number; name: string; retired_at: string }
        notes: Array<{ body: string }>
      }
      assert.equal(tombstone.tombstone.id, roomId)
      assert.equal(tombstone.tombstone.name, 'The quiet porch')
      assert.ok(Number.isFinite(Date.parse(tombstone.tombstone.retired_at)))
      assert.deepEqual(tombstone.notes.map(note => note.body), [
        'This note must remain readable at the tombstone.',
      ])

      const restore = await app.request(`/api/place/${roomId}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-restore-integration-0001',
        },
        body: JSON.stringify({ retired: false }),
      })
      assert.equal(restore.status, 200, await restore.clone().text())

      const retiredChild = (await database!.query<{ id: number }>(`
        INSERT INTO places (parent_id, place_kind, name, description, owner_id)
        VALUES ($1, 'place', 'retired-child', '', 1)
        RETURNING id
      `, [roomId])).rows[0]!
      await database!.query('UPDATE places SET retired_at = now() WHERE id = $1', [retiredChild.id])

      const repeatRetire = await app.request(`/api/place/${roomId}`, {
        // A retired child is a tombstone, not live occupancy.
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-retire-integration-0002',
        },
        body: JSON.stringify({ retired: true }),
      })
      assert.equal(repeatRetire.status, 200, await repeatRetire.clone().text())
      assert.equal((await database!.query<{ retired: boolean }>(`
        SELECT retired_at IS NOT NULL AS retired FROM places WHERE id = $1
      `, [retiredChild.id])).rows[0]?.retired, true)
      await assert.rejects(
        database!.query('UPDATE places SET retired_at = NULL WHERE id = $1', [retiredChild.id]),
        error => postgresCode(error) === '23514',
      )
      const refusedChildRestore = await app.request(`/api/place/${retiredChild.id}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-child-restore-refused-0001',
        },
        body: JSON.stringify({ retired: false }),
      })
      assert.equal(refusedChildRestore.status, 409, await refusedChildRestore.clone().text())
      assert.deepEqual(await refusedChildRestore.json(), {
        error: 'parent place is retired; restore it before restoring this place',
      })
      const repeatRestore = await app.request(`/api/place/${roomId}`, {
        method: 'PATCH',
        headers: {
          ...bearer(founderSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': 'place-restore-integration-0002',
        },
        body: JSON.stringify({ retired: false }),
      })
      assert.equal(repeatRestore.status, 200, await repeatRestore.clone().text())

      const durable = await database!.query(`
        SELECT place.name, place.founding_name, place.retired_at,
          (SELECT jsonb_agg(jsonb_build_object(
            'name', history.name,
            'started_at', history.started_at,
            'ended_at', history.ended_at
          ) ORDER BY history.id)
          FROM place_name_spans history WHERE history.place_id = place.id) AS name_history,
          (SELECT array_agg(event.kind ORDER BY event.id)
          FROM events event
          WHERE (event.detail->>'place_id')::integer = place.id
            AND event.kind IN ('place_renamed', 'place_retired', 'place_restored')) AS lifecycle_events,
          account.balance_units::text AS balance_units
        FROM places place
        JOIN city_credit_accounts account ON account.resident_id = place.owner_id
        WHERE place.id = $1
      `, [roomId])
      assert.equal(durable.rows[0]!.name, 'The quiet porch')
      assert.equal(durable.rows[0]!.founding_name, 'test-room')
      assert.equal(durable.rows[0]!.retired_at, null)
      assert.deepEqual(
        (durable.rows[0]!.name_history as Array<{ name: string; ended_at: string | null }>).map(
          span => ({ name: span.name, ended: span.ended_at === null ? null : 'closed' }),
        ),
        [{ name: 'test-room', ended: 'closed' }, { name: 'The quiet porch', ended: null }],
      )
      assert.deepEqual(durable.rows[0]!.lifecycle_events, [
        'place_renamed', 'place_retired', 'place_restored', 'place_retired', 'place_restored',
      ])
      assert.equal(durable.rows[0]!.balance_units, '0')

      await database!.query(`
        INSERT INTO moderation_actions (target_type, target_id, action, actor_id, reason)
        VALUES ('place', $1, 'remove', 1, 'place lifecycle snapshot regression')
      `, [roomId])
      const snapshotRows = await database!.query<{
        class_name: string
        payload: {
          name?: string
          founding_name?: string
          name_history?: Array<{ name: string }>
          detail?: { name?: string; former_name?: string }
        }
      }>(`
        SELECT record.class_name, record.payload
        FROM city_snapshot.public_records_v2 record
        WHERE (record.class_name = 'places' AND record.record_id = $1::text)
          OR (
            record.class_name = 'events'
            AND record.record_id = (
              SELECT event.id::text FROM events event
              WHERE event.kind = 'place_renamed'
                AND (event.detail->>'place_id')::integer = $1::integer
              ORDER BY event.id DESC LIMIT 1
            )
          )
        ORDER BY record.class_name
      `, [roomId])
      const snapshotEvent = snapshotRows.rows.find(row => row.class_name === 'events')?.payload
      const snapshotPlace = snapshotRows.rows.find(row => row.class_name === 'places')?.payload
      assert.ok(snapshotPlace, JSON.stringify(snapshotRows.rows))
      assert.ok(snapshotEvent, JSON.stringify(snapshotRows.rows))
      assert.deepEqual(snapshotPlace, { id: roomId, status: 'maintainer_hidden' })
      assert.deepEqual(snapshotEvent?.detail, {
        place_id: roomId,
        name: '[removed by maintainer]',
        former_name: '[removed by maintainer]',
      })
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
  })
}
