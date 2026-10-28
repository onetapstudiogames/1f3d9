import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { FOUNDER, GROWER, NEIGHBOUR, call, coin, seedKind, seedThing, traitId, use } from '../helpers/abilities-fixtures.ts'
import {
  bearer, connectedDatabase, resetCity, standIn, startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

type RoomEvidence = Readonly<{ place_id: number | null; unavailable: boolean }>

async function clearStamps(): Promise<void> {
  await connectedDatabase().query(`
    UPDATE residents SET last_public_action_at = NULL WHERE last_public_action_at IS NOT NULL;
    UPDATE places SET last_public_action_at = NULL WHERE last_public_action_at IS NOT NULL;
  `)
}

async function event(kind: string, detail: Record<string, unknown>, options: {
  id?: number; at?: string; actor?: string
} = {}): Promise<number> {
  const result = await connectedDatabase().query<{ id: number }>(`
    INSERT INTO events (id, at, kind, actor, detail)
    VALUES (coalesce($1, nextval('events_id_seq')), coalesce($2::timestamptz, now()), $3, $4, $5)
    RETURNING id
  `, [options.id ?? null, options.at ?? null, kind, options.actor ?? FOUNDER.handle, detail])
  return result.rows[0]!.id
}

test('public activity uses provable historical room evidence', { timeout: 600_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('public-activity-rooms')
  const evidence = async (id: number): Promise<RoomEvidence> => {
    const result = await postgres.client.query<RoomEvidence>(`
      SELECT room.place_id, room.place_id IS NULL AND event.kind <> 'rotate'
        AND NOT (event.kind = 'transfer_cancel' AND EXISTS (
          SELECT 1 FROM transfer_offers WHERE id = public_activity_id(event.detail->>'offer_id')
            AND asset_type = 'kind'
        )) AS unavailable
      FROM events event CROSS JOIN LATERAL (
        SELECT public_activity_room(event.id, event.kind, event.actor, event.detail) AS place_id
      ) room WHERE event.id = $1
    `, [id])
    assert.equal(result.rows.length, 1)
    return result.rows[0]!
  }
  try {
    await t.test('moves use the destination and direct records need no historical guess', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const moved = await event('action', {
        action: 'move', status: 'applied', from_place_id: rooms.eastRoomId,
        to_place_id: rooms.westRoomId, place_id: rooms.eastRoomId,
      })
      assert.deepEqual(await evidence(moved), { place_id: rooms.westRoomId, unavailable: false })
      const edited = await event('thing_edited', { thing_id: 42, place_id: rooms.eastRoomId })
      assert.deepEqual(await evidence(edited), { place_id: rooms.eastRoomId, unavailable: false })
      assert.deepEqual(await evidence(await event('rotate', {})), { place_id: null, unavailable: false })
    })

    await t.test('creation and every move prove the old room in committed order, including carry and effect moves', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await postgres.client.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, maker_id)
        VALUES (42, $1, 'historical thing', '', 1, 1)
      `, [rooms.westRoomId])
      await event('thing_created', { thing_id: 42, place_id: rooms.eastRoomId }, {
        id: 90, at: '2026-10-27T10:00:00Z',
      })
      await event('thing_moved', {
        thing_id: 42, mode: 'carry', from_place_id: rooms.eastRoomId, place_id: rooms.continentId,
      }, { id: 80, at: '2026-10-27T09:00:00Z' })
      await event('thing_moved', {
        thing_id: 42, from_place_id: rooms.continentId, place_id: rooms.eastRoomId,
      }, { id: 70, at: '2026-10-27T08:00:00Z' })
      const edited = await event('thing_edited', { thing_id: 42 }, {
        id: 60, at: '2026-10-27T07:00:00Z',
      })
      await event('thing_moved', {
        thing_id: 42, from_place_id: rooms.eastRoomId, place_id: rooms.westRoomId,
      }, { id: 50, at: '2026-10-27T06:00:00Z' })
      assert.deepEqual(await evidence(edited), { place_id: rooms.eastRoomId, unavailable: false })
      const sold = await event('sale', { type: 'thing', id: 42 })
      assert.deepEqual(await evidence(sold), { place_id: rooms.westRoomId, unavailable: false })
    })

    await t.test('missing anchors, broken movement chains and malformed room IDs remain unavailable', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await event('thing_created', { thing_id: 42, place_id: rooms.eastRoomId })
      await event('thing_moved', {
        thing_id: 42, from_place_id: rooms.westRoomId, place_id: rooms.continentId,
      })
      for (const [kind, detail] of [
        ['thing_edited', { thing_id: 42 }],
        ['thing_upgraded', { thing_id: 999 }],
        ['thing_withdrawn', { thing_id: '999999999999999999999999999' }],
        ['note', { place_id: '999999999999999999999999999' }],
        ['place_edited', {}],
      ] as const) {
        assert.deepEqual(await evidence(await event(kind, detail)), {
          place_id: null, unavailable: true,
        }, kind)
      }
    })

    await t.test('action references match the actor and legacy delayed outcomes remain unproved', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const actionId = (await postgres.client.query<{ id: string }>(`
        INSERT INTO action_runs (actor_id, action_name, place_id)
        VALUES (1, 'use', $1) RETURNING id
      `, [rooms.eastRoomId])).rows[0]!.id
      await postgres.client.query(`
        INSERT INTO action_resolutions (action_run_id, status, detail)
        VALUES ($1, 'applied', '{"effects_applied":1}')
      `, [actionId])
      const applied = { action_id: actionId, action: 'use', status: 'applied' }
      assert.deepEqual(await evidence(await event('action', applied)), {
        place_id: rooms.eastRoomId, unavailable: false,
      })
      assert.deepEqual(await evidence(await event('action', applied, { actor: GROWER.handle })), {
        place_id: null, unavailable: true,
      })
      assert.deepEqual(await evidence(await event('action', { ...applied, action: 'make' })), {
        place_id: null, unavailable: true,
      })
      const pendingId = (await postgres.client.query<{ id: string }>(`
        INSERT INTO pending_effects (action_id, place_id, actor_id, payload, due_at)
        VALUES ($1, $2, 1, '[]', now()) RETURNING id
      `, [actionId, rooms.westRoomId])).rows[0]!.id
      await postgres.client.query(`
        INSERT INTO effect_resolutions (pending_effect_id, status, detail)
        VALUES ($1, 'applied', '{"effects_applied":1}')
      `, [pendingId])
      assert.deepEqual(await evidence(await event('effect_resolved', { effect_id: pendingId, status: 'applied' })), {
        place_id: null, unavailable: true,
      })
      assert.deepEqual(await evidence(await event('effect_resolved', { effect_id: pendingId, status: 'applied' }, {
        actor: GROWER.handle,
      })), { place_id: null, unavailable: true })
    })

    await t.test('immutable notes and offers supply missing recorded locations, while kind transfers stay global', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const noteId = (await postgres.client.query<{ id: number }>(`
        INSERT INTO notes (place_id, author_id, body) VALUES ($1, 1, 'recorded here') RETURNING id
      `, [rooms.eastRoomId])).rows[0]!.id
      assert.deepEqual(await evidence(await event('note', { note_id: noteId })), {
        place_id: rooms.eastRoomId, unavailable: false,
      })
      await event('thing_created', { thing_id: 42, place_id: rooms.westRoomId })
      const offerId = (await postgres.client.query<{ id: number }>(`
        INSERT INTO transfer_offers (asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
        VALUES ('thing', 42, 1, 2, 1, $1) RETURNING id
      `, [`0x${'1'.repeat(40)}`])).rows[0]!.id
      assert.deepEqual(await evidence(await event('transfer_cancel', { offer_id: offerId })), {
        place_id: rooms.westRoomId, unavailable: false,
      })
      const kindOfferId = (await postgres.client.query<{ id: number }>(`
        INSERT INTO transfer_offers (asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
        VALUES ('kind', 21, 1, 2, 1, $1) RETURNING id
      `, [`0x${'1'.repeat(40)}`])).rows[0]!.id
      assert.deepEqual(await evidence(await event('transfer_cancel', { offer_id: kindOfferId })), {
        place_id: null, unavailable: false,
      })
    })

    await t.test('held gifts do not count, while another applied public label does', async () => {
      const giver = { id: 6, handle: 'activity-giver', secret: `1f3d9_sk_${'6'.repeat(48)}` }
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR, giver])
      const { default: app } = await import('../../src/index.ts')
      await standIn(giver.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      await connectedDatabase().query(`INSERT INTO resident_mutes
        (resident_id, target_type, target_id, choice) VALUES (3, 'resident', 6, 'mute')`)
      assert.equal((await coin(app, giver.secret, 'activity-gift', {
        use: [{ effect: 'transfer', target: 'source', to: 'recipient' }],
      })).status, 201)
      assert.equal((await coin(app, giver.secret, 'activity-label', {
        use: [{ effect: 'label', target: 'source', label: 'offered' }],
      })).status, 201)
      const giftKind = await seedKind(giver.id, 'activity-gift-kind', [await traitId('activity-gift')])
      const mixedKind = await seedKind(giver.id, 'activity-mixed-kind', [
        await traitId('activity-gift'), await traitId('activity-label'),
      ])
      const held = await seedThing(giver.id, rooms.eastRoomId, giftKind, 'held gift')
      const mixed = await seedThing(giver.id, rooms.eastRoomId, mixedKind, 'labelled gift')
      await clearStamps()
      const first = await use(app, giver.secret, held, { to_handle: NEIGHBOUR.handle })
      assert.equal(first.status, 200, JSON.stringify(first.json))
      const before = await connectedDatabase().query(`SELECT last_public_action_at FROM residents WHERE id = 6`)
      assert.equal(before.rows[0]!.last_public_action_at, null)
      assert.equal((await connectedDatabase().query(`SELECT count(*)::int AS count FROM events WHERE kind = 'transfer'`)).rows[0]!.count, 0)
      const second = await use(app, giver.secret, mixed, { to_handle: NEIGHBOUR.handle })
      assert.equal(second.status, 200, JSON.stringify(second.json))
      const changed = (await connectedDatabase().query(`SELECT detail->'applied_public_activity' AS outcomes
        FROM events WHERE kind = 'action' ORDER BY id DESC LIMIT 1`)).rows[0]!.outcomes
      assert.deepEqual(changed.map((entry: { operation: string }) => entry.operation), ['label'])
      assert.ok((await connectedDatabase().query(`SELECT last_public_action_at FROM residents WHERE id = 6`)).rows[0]!.last_public_action_at)
      assert.equal((await connectedDatabase().query(`SELECT owner_id FROM things WHERE id = $1`, [mixed])).rows[0]!.owner_id, giver.id)
    })

    await t.test('dynamic and delayed reach members retain their changed target room and owner', async () => {
      const rooms = await resetCity([FOUNDER, GROWER, NEIGHBOUR])
      const { default: app } = await import('../../src/index.ts')
      const db = connectedDatabase()
      await standIn(GROWER.id, rooms.eastRoomId)
      await standIn(NEIGHBOUR.id, rooms.eastRoomId)
      assert.equal((await coin(app, GROWER.secret, 'activity-reach', {
        use: [{ effect: 'reach', then: [{ effect: 'wait', seconds: 1,
          then: [{ effect: 'label', target: 'target', label: 'later-public-label' }] }] }],
      })).status, 201)
      const kind = await seedKind(GROWER.id, 'activity-reach-kind', [await traitId('activity-reach')])
      const source = await seedThing(GROWER.id, rooms.eastRoomId, kind, 'reach source')
      const applied = await seedThing(GROWER.id, rooms.eastRoomId, null, 'changed member')
      const skipped = await seedThing(NEIGHBOUR.id, rooms.eastRoomId, null, 'closed later', { openToReach: true })
      const used = await use(app, GROWER.secret, source)
      assert.equal(used.status, 200, JSON.stringify(used.json))
      await db.query('UPDATE things SET open_to_reach = false WHERE id = $1', [skipped])
      await clearStamps()
      await delay(1_200)
      const read = await call(app, NEIGHBOUR.secret, 'GET', '/api/me')
      assert.equal(read.status, 200, JSON.stringify(read.json))
      assert.deepEqual((await db.query(`SELECT target_id FROM active_labels WHERE label = 'later-public-label' ORDER BY target_id`)).rows,
        [{ target_id: applied }])
      const outcomes = (await db.query(`SELECT actor, detail->'applied_public_activity' AS outcomes
        FROM events WHERE kind = 'effect_resolved' ORDER BY id`)).rows
      const changed = outcomes.flatMap(row => row.outcomes ?? [])
      assert.deepEqual(changed, [{ actor: GROWER.handle, operation: 'label', place_id: rooms.eastRoomId,
        target_type: 'thing', target_id: applied }])
      assert.ok((await db.query('SELECT last_public_action_at FROM residents WHERE id = 2')).rows[0]!.last_public_action_at)
      assert.equal((await db.query('SELECT last_public_action_at FROM residents WHERE id = 3')).rows[0]!.last_public_action_at, null)
      assert.ok((await db.query('SELECT last_public_action_at FROM places WHERE id = $1', [rooms.eastRoomId])).rows[0]!.last_public_action_at)
    })

    await t.test('public outcome detail excludes hidden targets and feed rooms', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      const db = connectedDatabase()
      const { publicActivityEventDetailSql } = await import('../../src/public-events.ts')
      await db.query('UPDATE places SET quiet = true, feed = true WHERE id = $1', [rooms.westRoomId])
      const target = await seedThing(1, rooms.eastRoomId, null, 'hidden label target')
      await db.query(`INSERT INTO moderation_actions (target_type, target_id, action, reason, actor_id)
        VALUES ('thing', $1, 'remove', 'test removal', 1)`, [target])
      const outcomes = [
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.eastRoomId, target_type: 'thing', target_id: target },
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.westRoomId, target_type: 'thing', target_id: target },
        { actor: FOUNDER.handle, operation: 'move', place_id: rooms.westRoomId },
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.westRoomId, target_type: 'place', target_id: rooms.westRoomId },
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.eastRoomId, internal: 'never shown' },
      ]
      const projected = await db.query(`SELECT ${publicActivityEventDetailSql('event')} AS detail
        FROM (SELECT $1::jsonb AS detail) event`, [{ applied_public_activity: outcomes }])
      assert.deepEqual(projected.rows[0]!.detail, { applied_public_activity: [
        { actor: FOUNDER.handle, operation: 'move', place_id: rooms.westRoomId },
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.westRoomId },
        { actor: FOUNDER.handle, operation: 'label', place_id: rooms.eastRoomId },
      ] })
    })

    await t.test('direct edits, both upgrade paths and withdrawal record their changed room', async () => {
      const rooms = await resetCity([FOUNDER, GROWER])
      await standIn(1, rooms.eastRoomId)
      await postgres.client.query(`
        INSERT INTO kinds (id, name, owner_id, current_revision) VALUES (10, 'activity-kind', 1, 2);
        INSERT INTO kind_revisions (kind_id, revision, description, traits, recipe)
        VALUES (10, 1, 'first revision', '{}', '[]'), (10, 2, 'second revision', '{}', '[]');
      `)
      await postgres.client.query(`
        INSERT INTO things (id, place_id, name, body, owner_id, maker_id,
          kind_id, birth_revision, current_revision, as_kind_id, as_revision)
        VALUES (41, $1, 'plain thing', '', 1, 1, NULL, NULL, NULL, NULL, NULL),
          (42, $1, 'kind thing', '', 1, 1, 10, 1, 1, NULL, NULL),
          (43, $1, 'converted thing', '', 1, 1, 10, 1, 1, 10, 1)
      `, [rooms.eastRoomId])
      const { default: app } = await import('../../src/index.ts')
      for (const [path, method, body] of [
        ['/api/thing/41', 'PATCH', { body: 'edited body' }],
        ['/api/thing/42/upgrade', 'POST', undefined],
        ['/api/thing/43/upgrade', 'POST', undefined],
        ['/api/thing/41/withdraw', 'POST', { thing_name: 'plain thing' }],
      ] as const) {
        const response = await app.request(path, {
          method, headers: bearer(FOUNDER.secret),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        assert.equal(response.status, 200, await response.text())
      }
      const result = await postgres.client.query<{ kind: string; place_id: number }>(`
        SELECT kind, (detail->>'place_id')::integer AS place_id FROM events
        WHERE kind IN ('thing_edited', 'thing_upgraded', 'thing_withdrawn') ORDER BY id
      `)
      assert.deepEqual(result.rows, [
        { kind: 'thing_edited', place_id: rooms.eastRoomId },
        { kind: 'thing_upgraded', place_id: rooms.eastRoomId },
        { kind: 'thing_upgraded', place_id: rooms.eastRoomId },
        { kind: 'thing_withdrawn', place_id: rooms.eastRoomId },
      ])
    })
  } finally {
    await postgres.stop()
  }
})
