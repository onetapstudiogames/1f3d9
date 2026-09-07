import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { issueCityFeeCredit, type CityCreditDatabase } from '../../../src/city-credit.ts'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerTransfersAndRoutesTests(
  t: TestContext,
  {
    app, bearer, database, executeEffects, founderSecret, neighborSecret, resetDatabase,
    setEngineTransactionRunnerForTests, sql, transactionSql,
  }: Pick<WorldTestContext,
    | 'app' | 'bearer' | 'database' | 'executeEffects' | 'founderSecret' | 'neighborSecret'
    | 'resetDatabase' | 'setEngineTransactionRunnerForTests' | 'sql' | 'transactionSql'
  >,
): Promise<void> {
  await t.test('gift and effect transfers publish their interaction resident and place', async () => {
    const roomId = await resetDatabase()
    await database!.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES
          (1, $1, $1),
          (2, $1, NULL)
      `, [roomId])
    await database!.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
        VALUES (2, $1, 'effect gift', 'transferred by a thing effect', 1, 1)
      `, [roomId])

    setEngineTransactionRunnerForTests(async (_db, work) => {
      const connection = await database!.connect()
      try {
        await connection.query('BEGIN')
        const result = await work(transactionSql(connection), true)
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        connection.release()
      }
    })
    let giftResponse: Response
    try {
      giftResponse = await app.request('/api/transfer', {
        method: 'POST',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'thing', id: 1, to_handle: 'neighbor' }),
      })
    } finally {
      setEngineTransactionRunnerForTests(null)
    }
    assert.equal(giftResponse.status, 200, await giftResponse.clone().text())

    const effectsApplied = await executeEffects([{
      effect: 'transfer',
      target: 'source',
      to: 'recipient',
    }], {
      actionId: null,
      actorId: 1,
      actorHandle: 'founder',
      placeId: roomId,
      sourceThingId: 2,
      sharedSourceThingId: null,
      target: null,
      destinationPlaceId: null,
      recipientId: 2,
      sourceTraitId: null,
      lawAuthority: null,
      parentEffectId: null,
      generation: 0,
      logicalAt: new Date(),
    }, sql)
    assert.equal(effectsApplied, 1)

    const committed = await database!.query(`
        SELECT event.actor, event.detail->>'mode' AS mode,
          (event.detail->>'resident_id')::integer AS resident_id,
          (event.detail->>'place_id')::integer AS place_id,
          coalesce(event.detail->>'asset_type', event.detail->>'type') AS asset_type,
          coalesce(
            (event.detail->>'asset_id')::integer,
            (event.detail->>'id')::integer
          ) AS asset_id,
          thing.owner_id
        FROM events event
        JOIN things thing ON thing.id = coalesce(
          (event.detail->>'asset_id')::integer,
          (event.detail->>'id')::integer
        )
        WHERE event.kind = 'transfer'
        ORDER BY event.id
      `)
    assert.deepEqual(committed.rows, [
      {
        actor: 'founder',
        mode: 'gift',
        resident_id: 2,
        place_id: roomId,
        asset_type: 'thing',
        asset_id: 1,
        owner_id: 2,
      },
      {
        actor: 'founder',
        mode: 'effect',
        resident_id: 2,
        place_id: roomId,
        asset_type: 'thing',
        asset_id: 2,
        owner_id: 2,
      },
    ])
  })

  await t.test('generic place, gift, and offer routes cannot alter the closed Gazette shell', async () => {
    const ordinaryRoomId = await resetDatabase()
    const continentId = Number((await database!.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1',
      [ordinaryRoomId],
    )).rows[0]!.parent_id)
    assert.equal(continentId, 2, 'the Gazette contract owns city place #2 as its parent')
    await database!.query(`
        INSERT INTO places (
          id, parent_id, place_kind, name, description, purpose, owner_id,
          open_to_building, open_to_things, open_to_notes
        ) VALUES (
          454, 2, 'place', 'the gazette submission room',
          'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
          '', 1, FALSE, FALSE, FALSE
        );
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES (1, 454, 454), (2, 454, 454);
      `)

    setEngineTransactionRunnerForTests(async (_db, work) => {
      const connection = await database!.connect()
      try {
        await connection.query('BEGIN')
        const result = await work(transactionSql(connection), true)
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        connection.release()
      }
    })
    let responses: readonly Response[]
    try {
      responses = await Promise.all([
        app.request('/api/place/454', {
          method: 'PATCH',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({ description: 'generic route edit' }),
        }),
        app.request('/api/transfer', {
          method: 'POST',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'place', id: 454, to_handle: 'neighbor' }),
        }),
        app.request('/api/transfer/offer', {
          method: 'POST',
          headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'place',
            id: 454,
            to_handle: 'neighbor',
            price_usdc: 1,
            seller_wallet: `0x${'1'.repeat(40)}`,
          }),
        }),
      ])
    } finally {
      setEngineTransactionRunnerForTests(null)
    }

    for (const response of responses) assert.ok(response.status >= 400)
    assert.deepEqual((await database!.query(`
        SELECT gazette_submission_room_state(place) AS state,
          (SELECT count(*)::integer FROM transfers WHERE asset_type = 'place' AND asset_id = 454)
            AS transfers,
          (SELECT count(*)::integer FROM transfer_offers
            WHERE asset_type = 'place' AND asset_id = 454) AS offers
        FROM places place WHERE place.id = 454
      `)).rows[0], { state: 'closed', transfers: 0, offers: 0 })
  })

  await t.test('twelve immediate paid kind requests complete through the real public route', async () => {
    await resetDatabase()
    const creditDatabase: CityCreditDatabase = {
      query: async (text, params = []) => (
        await database!.query(text, [...params])
      ).rows,
    }
    for (let index = 0; index < 12; index += 1) {
      const issued = await issueCityFeeCredit(creditDatabase, {
        founderId: 1,
        residentId: 2,
        sourceKey: `route-burst-kind-credit-${index}`,
        reason: `fund route burst kind ${index}`,
      })
      assert.equal(issued.disposition, 'created')
    }

    for (let index = 0; index < 12; index += 1) {
      const name = `route-burst-kind-${index.toString().padStart(2, '0')}`
      const response = await app.request('/api/kind', {
        method: 'POST',
        headers: {
          ...bearer(neighborSecret),
          'content-type': 'application/json',
          'X-1F3D9-FEE-CREDIT': `route-burst-kind-request-${index}`,
        },
        body: JSON.stringify({
          name,
          description: `Immediate route completion proof ${index}.`,
          traits: [],
          recipe: [],
        }),
      })
      assert.equal(response.status, 201, `request ${index}: ${await response.clone().text()}`)
      const body = await response.json() as {
        readonly kind: { readonly name: string }
        readonly city_fee_credit: { readonly spent_usdc: string }
      }
      assert.equal(body.kind.name, name)
      assert.equal(body.city_fee_credit.spent_usdc, '1.000000')
    }

    const finalState = await database!.query<{
      completed_attempts: number
      spend_entries: number
      return_entries: number
      kind_count: number
      event_count: number
      balance_units: string
    }>(`
        SELECT
          (SELECT count(*)::int FROM payment_attempts
            WHERE actor_id = 2 AND operation = 'kind_invention' AND status = 'completed')
            AS completed_attempts,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE resident_id = 2 AND entry_kind = 'spend') AS spend_entries,
          (SELECT count(*)::int FROM city_credit_entries
            WHERE resident_id = 2 AND entry_kind = 'return') AS return_entries,
          (SELECT count(*)::int FROM kinds
            WHERE owner_id = 2 AND name LIKE 'route-burst-kind-%') AS kind_count,
          (SELECT count(*)::int FROM events
            WHERE actor = 'neighbor' AND kind = 'kind_invented') AS event_count,
          (SELECT balance_units::text FROM city_credit_accounts WHERE resident_id = 2)
            AS balance_units
      `)
    assert.deepEqual(finalState.rows, [{
      completed_attempts: 12,
      spend_entries: 12,
      return_entries: 0,
      kind_count: 12,
      event_count: 12,
      balance_units: '0',
    }])
  })

  await t.test('the reported parent and child both accept make through the public route', async () => {
    const existingRoomId = await resetDatabase()
    const continentId = Number((await database!.query<{ parent_id: number }>(
      'SELECT parent_id FROM places WHERE id = $1',
      [existingRoomId],
    )).rows[0]!.parent_id)
    await database!.query(`
        INSERT INTO places (id, parent_id, place_kind, name, description, owner_id)
        VALUES
          (112, $1, 'place', 'the presence exemption', 'reported parent room', 1),
          (173, 112, 'place', 'the second reading', 'reported child room', 1)
      `, [continentId])
    await database!.query(`
        INSERT INTO traits (id, name, description, recipe, coiner_id)
        VALUES (50, 'hospitable', 'inert inherited law', NULL, 1)
      `)
    await database!.query(`
        INSERT INTO place_law_changes (place_id, trait_id, change_type, position, actor_id)
        VALUES (112, 50, 'add', 0, 1)
      `)
    await database!.query(`
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        VALUES (1, 112, 112)
      `)
    await database!.query(`SELECT setval('places_id_seq', (SELECT max(id) FROM places), true)`)
    await database!.query(`SELECT setval('things_id_seq', (SELECT max(id) FROM things), true)`)

    setEngineTransactionRunnerForTests(async (_db, work) => {
      const connection = await database!.connect()
      try {
        await connection.query('BEGIN')
        const result = await work(transactionSql(connection), true)
        await connection.query('COMMIT')
        return result
      } catch (error) {
        await connection.query('ROLLBACK').catch(() => undefined)
        throw error
      } finally {
        connection.release()
      }
    })
    let parentResponse: Response
    let childResponse: Response
    try {
      parentResponse = await app.request('/api/thing', {
        method: 'POST',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({
          place_id: 112,
          name: 'strata parent reproduction',
          body: 'p'.repeat(3_400),
        }),
      })
      await database!.query(`
          UPDATE resident_presence SET current_place_id = 173 WHERE resident_id = 1
        `)
      childResponse = await app.request('/api/thing', {
        method: 'POST',
        headers: { ...bearer(founderSecret), 'content-type': 'application/json' },
        body: JSON.stringify({
          place_id: 173,
          name: 'strata child control',
          body: 'c'.repeat(66),
        }),
      })
    } finally {
      setEngineTransactionRunnerForTests(null)
    }

    assert.equal(parentResponse.status, 201, await parentResponse.clone().text())
    assert.equal(childResponse.status, 201, await childResponse.clone().text())
    const parentBody = await parentResponse.json() as {
      readonly reading_cost: { readonly available: boolean }
    }
    const childBody = await childResponse.json() as {
      readonly reading_cost: { readonly available: boolean }
    }
    assert.equal(parentBody.reading_cost.available, true)
    assert.equal(childBody.reading_cost.available, true)
    const recorded = await database!.query<{
      action_place_id: number
      thing_place_id: number
      event_place_id: string
      status: string
    }>(`
        SELECT action.place_id AS action_place_id,
          thing.place_id AS thing_place_id,
          event.detail->>'place_id' AS event_place_id,
          resolution.status
        FROM things thing
        JOIN events event ON event.kind = 'thing_created'
          AND (event.detail->>'thing_id')::integer = thing.id
        JOIN action_runs action ON action.actor_id = thing.maker_id
          AND action.place_id = thing.place_id
          AND action.action_name = 'make'
        JOIN action_resolutions resolution ON resolution.action_run_id = action.id
        WHERE thing.name IN ('strata parent reproduction', 'strata child control')
        ORDER BY thing.place_id
      `)
    assert.deepEqual(recorded.rows, [
      { action_place_id: 112, thing_place_id: 112, event_place_id: '112', status: 'applied' },
      { action_place_id: 173, thing_place_id: 173, event_place_id: '173', status: 'applied' },
    ])
  })

}
