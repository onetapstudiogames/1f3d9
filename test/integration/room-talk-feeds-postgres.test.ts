import assert from 'node:assert/strict'
import test from 'node:test'
import {
  FOUNDER,
  GROWER,
  NEIGHBOUR,
  call,
  type CityApp,
  type Json,
} from '../helpers/abilities-fixtures.ts'
import {
  connectedDatabase,
  resetCity,
  standIn,
  startNoteSuiteDatabase,
} from '../helpers/note-suite-fixtures/postgres.ts'

const RESIDENTS = [FOUNDER, GROWER, NEIGHBOUR] as const
const TALK_KINDS = ['line_said', 'ping_sent', 'ping_answered'] as const

function requestId(value: number): string {
  return '00000000-0000-4000-8000-' + String(value).padStart(12, '0')
}

test('same-room talk feeds use real PostgreSQL and keep human views quiet', { timeout: 900_000 }, async t => {
  const postgres = await startNoteSuiteDatabase('room-talk-feeds')
  try {
    const { default: app } = await import('../../src/index.ts') as { default: CityApp }
    const db = connectedDatabase()
    let rooms = await resetCity(RESIDENTS)
    let requestNumber = 1
    const nextRequestId = () => requestId(requestNumber++)

    const reset = async () => {
      rooms = await resetCity(RESIDENTS)
      for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)
    }
    const sayLine = async (body = 'a public line'): Promise<number> => {
      const result = await call(app, FOUNDER.secret, 'POST', '/api/line', {
        place_id: rooms.eastRoomId,
        body,
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return Number((result.json.line as Json).id)
    }
    const sendPing = async (): Promise<number> => {
      const result = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return Number((result.json.ping as Json).id)
    }
    const answerPing = async (pingId: number): Promise<void> => {
      const result = await call(app, GROWER.secret, 'POST', '/api/ping/' + pingId + '/answer', {
        answer: 'yes',
        request_id: nextRequestId(),
      })
      assert.equal(result.status, 200, JSON.stringify(result.json))
    }
    const moderate = async (
      targetType: 'line' | 'ping',
      targetId: number,
      action: 'remove' | 'restore',
    ): Promise<Json> => {
      const result = await call(app, FOUNDER.secret, 'POST', '/api/moderation', {
        action,
        target_type: targetType,
        target_id: targetId,
        reason: action === 'remove' ? 'feed test removal' : 'feed test restoration',
      })
      assert.equal(result.status, 201, JSON.stringify(result.json))
      return result.json.moderation as Json
    }
    const readChanges = async (kind?: string): Promise<Json[]> => {
      const changes: Json[] = []
      let since = '0'
      for (;;) {
        const query = new URLSearchParams({ since, limit: '200' })
        if (kind !== undefined) query.set('kind', kind)
        const result = await call(app, null, 'GET', '/api/changes?' + query.toString())
        assert.equal(result.status, 200, JSON.stringify(result.json))
        changes.push(...result.json.changes as Json[])
        if (result.json.has_more !== true) return changes
        since = String(result.json.next_since)
      }
    }
    const readEvents = async (query = ''): Promise<Json> => {
      const result = await call(app, null, 'GET', '/api/events' + query)
      assert.equal(result.status, 200, JSON.stringify(result.json))
      return result.json
    }
    const detail = (row: Json): Json => row.detail as Json

    for (const resident of RESIDENTS) await standIn(resident.id, rooms.eastRoomId)

    await t.test('GET /api/changes carries all three talk kinds with safe references and accepts each kind filter', async () => {
      await reset()
      const lineId = await sayLine('feed line body')
      const pingId = await sendPing()
      await answerPing(pingId)

      const expected = new Map<string, Readonly<{ actor: string; detail: Json }>>([
        ['line_said', {
          actor: FOUNDER.handle,
          detail: { line_id: lineId, place_id: rooms.eastRoomId },
        }],
        ['ping_sent', {
          actor: FOUNDER.handle,
          detail: {
            ping_id: pingId,
            place_id: rooms.eastRoomId,
            target_type: 'resident',
            target_id: GROWER.id,
          },
        }],
        ['ping_answered', {
          actor: GROWER.handle,
          detail: {
            ping_id: pingId,
            place_id: rooms.eastRoomId,
            answer: 'yes',
            target_type: 'resident',
            target_id: FOUNDER.id,
          },
        }],
      ])

      for (const kind of TALK_KINDS) {
        const changes = await readChanges(kind)
        const change = changes.find(row => row.kind === kind)
        assert.ok(change, kind + ' kind filter must return its change')
        assert.equal(change.actor, expected.get(kind)!.actor)
        assert.deepEqual(detail(change), expected.get(kind)!.detail)
        assert.equal(JSON.stringify(change).includes('feed line body'), false)
      }
    })

    await t.test('GET /api/changes preserves ordered body-free markers for removed lines and pings', async () => {
      await reset()
      const lineId = await sayLine('removed line body')
      const pingId = await sendPing()
      await answerPing(pingId)
      const beforeModeration = await readChanges()
      const originalByKind = new Map(
        TALK_KINDS.map(kind => [kind, beforeModeration.find(row => row.kind === kind)!]),
      )

      await moderate('line', lineId, 'remove')
      await moderate('ping', pingId, 'remove')
      const afterModeration = await readChanges()
      const targets = [
        { kind: 'line_said', idField: 'line_id', id: lineId, targetType: 'line' },
        { kind: 'ping_sent', idField: 'ping_id', id: pingId, targetType: 'ping' },
        { kind: 'ping_answered', idField: 'ping_id', id: pingId, targetType: 'ping' },
      ] as const

      for (const target of targets) {
        const marker = afterModeration.find(row => (
          row.kind === target.kind && detail(row)[target.idField] === target.id
        ))
        assert.ok(marker, target.kind + ' marker must remain in the changes feed')
        assert.equal(marker.change_id, originalByKind.get(target.kind)!.change_id)
        assert.equal(marker.actor, '')
        assert.deepEqual(Object.keys(detail(marker)).sort(), [
          target.idField,
          'moderated',
          'moderation',
        ].sort())
        assert.equal(detail(marker)[target.idField], target.id)
        assert.equal(detail(marker).moderated, true)
        const moderation = detail(marker).moderation as Json
        assert.equal(moderation.target_type, target.targetType)
        assert.equal(moderation.target_id, target.id)
        assert.equal(moderation.action, 'remove')
        assert.equal(typeof moderation.created_at, 'string')
        assert.equal(Object.hasOwn(detail(marker), 'answer'), false)
        assert.doesNotMatch(JSON.stringify(marker), /removed line body|founder|seed-keeper/u)
      }
    })

    await t.test('GET /api/events actor and place filters exclude removed talk and its totals agree', async () => {
      await reset()
      const lineId = await sayLine('filtered line')
      const pingId = await sendPing()
      await answerPing(pingId)
      await moderate('line', lineId, 'remove')
      await moderate('ping', pingId, 'remove')

      const checks = [
        { kind: 'line_said', actor: FOUNDER.handle },
        { kind: 'ping_sent', actor: FOUNDER.handle },
        { kind: 'ping_answered', actor: GROWER.handle },
      ] as const
      for (const check of checks) {
        for (const filter of [
          'actor=' + encodeURIComponent(check.actor),
          'place_id=' + rooms.eastRoomId,
        ]) {
          const result = await readEvents('?kind=' + check.kind + '&' + filter + '&limit=20')
          assert.deepEqual(result.events, [], check.kind + ' with ' + filter)
          assert.equal(result.total_items, 0, check.kind + ' total_items with ' + filter)
          assert.equal(result.returned_items, 0, check.kind + ' returned_items with ' + filter)
        }
      }
    })

    await t.test('unfiltered and kind-filtered event lists keep removed talk markers', async () => {
      await reset()
      const lineId = await sayLine('hidden line body')
      const pingId = await sendPing()
      await answerPing(pingId)
      await moderate('line', lineId, 'remove')
      await moderate('ping', pingId, 'remove')

      const unfiltered = await readEvents('?limit=200')
      const rows = unfiltered.events as Json[]
      const targets = [
        { kind: 'line_said', idField: 'line_id', id: lineId },
        { kind: 'ping_sent', idField: 'ping_id', id: pingId },
        { kind: 'ping_answered', idField: 'ping_id', id: pingId },
      ] as const
      for (const target of targets) {
        const marker = rows.find(row => (
          row.kind === target.kind && detail(row)[target.idField] === target.id
        ))
        assert.ok(marker, target.kind + ' must remain in the unfiltered event list')
        assert.equal(detail(marker).moderated, true)
        assert.equal(marker.actor, '')

        const filtered = await readEvents('?kind=' + target.kind + '&limit=20')
        const filteredMarker = (filtered.events as Json[]).find(row => (
          row.kind === target.kind && detail(row)[target.idField] === target.id
        ))
        assert.ok(filteredMarker, target.kind + ' must remain in its kind-filtered event list')
        assert.equal(detail(filteredMarker).moderated, true)
        assert.equal(filtered.total_items, filtered.returned_items)
      }
    })

    await t.test('the window server reads, replay, and front-door activity omit talk events', async () => {
      await reset()
      await db.query('UPDATE places SET quiet = TRUE WHERE id = $1', [rooms.eastRoomId])
      await sayLine('human view hidden line')
      const pingId = await sendPing()
      await answerPing(pingId)

      const windowFull = await call(app, null, 'GET', '/api/window?view=full')
      assert.equal(windowFull.status, 200, JSON.stringify(windowFull.json))
      assert.equal(
        (windowFull.json.events as Json[]).some(row => TALK_KINDS.includes(row.kind as typeof TALK_KINDS[number])),
        false,
      )
      const windowOutline = await call(app, null, 'GET', '/api/window?view=outline')
      assert.equal(windowOutline.status, 200, JSON.stringify(windowOutline.json))
      assert.equal(
        (windowOutline.json.events as Json[]).some(row => TALK_KINDS.includes(row.kind as typeof TALK_KINDS[number])),
        false,
      )

      const replay = await call(app, null, 'GET', '/api/replay?span=1h')
      assert.equal(replay.status, 200, JSON.stringify(replay.json))
      assert.equal(JSON.stringify(replay.json).includes('line_said'), false)
      assert.equal(JSON.stringify(replay.json).includes('ping_sent'), false)
      assert.equal(JSON.stringify(replay.json).includes('ping_answered'), false)

      const frontDoor = await app.request('http://city.test/')
      const text = await frontDoor.text()
      assert.equal(frontDoor.status, 200)
      assert.doesNotMatch(text, /said a line|pinged a resident|answered a ping|human view hidden line/u)
    })

    await t.test('a resident whose only recent act is a line is awake in presence view', async () => {
      await reset()
      await db.query(
        "UPDATE residents SET joined_at = now() - interval '15 days' WHERE id = $1",
        [FOUNDER.id],
      )
      await db.query(
        "UPDATE events SET at = now() - interval '15 days' WHERE actor = $1",
        [FOUNDER.handle],
      )
      const before = await call(
        app,
        null,
        'GET',
        '/api/residents?view=presence&handle=' + FOUNDER.handle,
      )
      assert.equal(before.status, 200, JSON.stringify(before.json))
      assert.equal((before.json.resident as Json).asleep, true)

      await sayLine('only recent act')
      const after = await call(
        app,
        null,
        'GET',
        '/api/residents?view=presence&handle=' + FOUNDER.handle,
      )
      assert.equal(after.status, 200, JSON.stringify(after.json))
      assert.equal((after.json.resident as Json).asleep, false)
    })

    await t.test('a resident flags a line and a ping, and each flag event names its target', async () => {
      await reset()
      const lineId = await sayLine('flagged line')
      const pingId = await sendPing()
      for (const target of [
        { target_type: 'line', target_id: lineId },
        { target_type: 'ping', target_id: pingId },
      ]) {
        const flagged = await call(app, GROWER.secret, 'POST', '/api/flag', {
          ...target,
          reason: 'please review this public record',
        })
        assert.equal(flagged.status, 201, JSON.stringify(flagged.json))
      }

      const flags = await readChanges('flag')
      const targets = flags.map(row => ({
        target_type: detail(row).target_type,
        target_id: detail(row).target_id,
      }))
      assert.deepEqual(targets, [
        { target_type: 'line', target_id: lineId },
        { target_type: 'ping', target_id: pingId },
      ])
      assert.equal(JSON.stringify(flags).includes('please review'), false)
    })

    await t.test('founder moderation removes and restores a ping while hidden pings keep their pair wait', async () => {
      await reset()
      const pingId = await sendPing()
      await answerPing(pingId)
      const removed = await moderate('ping', pingId, 'remove')
      assert.equal(removed.action, 'remove')

      const refused = await call(app, FOUNDER.secret, 'POST', '/api/ping', {
        to_handle: GROWER.handle,
        request_id: nextRequestId(),
      })
      assert.equal(refused.status, 429, JSON.stringify(refused.json))
      assert.equal(typeof refused.json.next_allowed_at, 'string')

      const restored = await moderate('ping', pingId, 'restore')
      assert.equal(restored.action, 'restore')
      const visible = await call(app, null, 'GET', '/api/ping/' + pingId)
      assert.equal(visible.status, 200, JSON.stringify(visible.json))
      assert.equal((visible.json.ping as Json).id, pingId)
    })

    await t.test('there is no ping_expired event kind anywhere', async () => {
      await reset()
      await sendPing()
      const { PUBLIC_EVENT_KINDS } = await import('../../src/public-events.ts')
      assert.equal(PUBLIC_EVENT_KINDS.includes('ping_expired'), false)
      const rows = await db.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM events WHERE kind = 'ping_expired'",
      )
      assert.equal(rows.rows[0]!.count, 0)
      assert.equal((await readChanges()).some(row => row.kind === 'ping_expired'), false)
    })
  } finally {
    await postgres.stop()
  }
})
