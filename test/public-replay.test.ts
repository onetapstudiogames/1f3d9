import assert from 'node:assert/strict'
import test from 'node:test'
import { PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES } from '../src/public-pagination.ts'
import {
  buildPublicReplay,
  noteTimelineFields,
  parsePublicReplayQuery,
  sanitizePublicReplay,
  PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES,
  PUBLIC_REPLAY_ROW_CEILING,
  type PublicReplay,
} from '../src/public-replay.ts'
import { canonicalJson } from '../src/public-snapshot-format.ts'

const parsedOneHour = parsePublicReplayQuery({ span: ['1h'] })
assert.equal(parsedOneHour.ok, true)

test('replay accepts exactly one named span and refuses every other option', () => {
  for (const span of ['1h', '2h', '6h', '24h']) {
    assert.deepEqual(parsePublicReplayQuery({ span: [span] }), { ok: true, span })
  }
  assert.deepEqual(parsePublicReplayQuery({}), {
    ok: false,
    error: 'span must be one of 1h, 2h, 6h, or 24h',
  })
  assert.deepEqual(parsePublicReplayQuery({ span: ['30m'] }), {
    ok: false,
    error: 'span must be one of 1h, 2h, 6h, or 24h',
  })
  assert.deepEqual(parsePublicReplayQuery({ span: ['1h', '2h'] }), {
    ok: false,
    error: 'span must appear at most once',
  })
  assert.deepEqual(parsePublicReplayQuery({ span: ['1h'], before_id: ['7'] }), {
    ok: false,
    error: 'unsupported query option: before_id; remove the shown option and retry',
  })
})

test('note timeline fields carry one 200-code-point line and never the body', () => {
  const unicode = `${'🏮'.repeat(199)}AB\nsecond line must not travel`
  const fields = noteTimelineFields({ id: 51, body: unicode })
  assert.equal(Array.from(fields.line).length, 200)
  assert.equal(fields.line, `${'🏮'.repeat(199)}A`)
  assert.equal(fields.line_cut, true)
  assert.equal(Object.hasOwn(fields, 'body'), false)

  assert.deepEqual(noteTimelineFields({ id: 52, body: 'one complete line' }), {
    id: 52,
    line: 'one complete line',
    line_cut: false,
  })
})

test('the replay row and aggregate note-line ceilings cover worst-case UTF-8', () => {
  assert.equal(PUBLIC_REPLAY_ROW_CEILING, 800)
  assert.equal(PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES, PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES)
  const worstCaseLines = Array.from(
    { length: PUBLIC_REPLAY_ROW_CEILING },
    () => '🏮'.repeat(200),
  )
  const bytes = worstCaseLines.reduce(
    (total, line) => total + Buffer.byteLength(line, 'utf8'),
    0,
  )
  assert.equal(bytes, 640_000)
  assert.ok(bytes <= PUBLIC_REPLAY_NOTE_LINES_MAX_BYTES)
})

test('the builder pins the file, sorts the timeline, moderates note lines, and emits no bodies', async () => {
  assert.equal(parsedOneHour.ok, true)
  if (!parsedOneHour.ok) return
  const calls: Array<{ statement: string; params: readonly unknown[] }> = []
  const execute = async (
    statement: string,
    params: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]> => {
    calls.push({ statement, params })
    if (statement.includes('public:changes-checkpoint')) return [{ checkpoint: '12' }]
    if (statement.includes('public:replay-window')) {
      return [{ window_end: new Date('2026-09-05T12:00:00.123Z') }]
    }
    if (statement.includes('public:replay-map')) {
      return [{
        id: 2,
        parent_id: 1,
        name: 'quiet archive',
        owner_id: 7,
        owner: 'lamp-reader',
        drawing_marker: '4',
        quiet: true,
      }]
    }
    if (statement.includes('public:replay-start')) {
      return [
        {
          entity_type: 'resident', id: 7, place_id: 2,
          origin_event_id: 101, origin: null, withdrawn_at: null,
        },
        {
          entity_type: 'thing', id: 80, place_id: 2,
          origin: null, withdrawn_at: new Date('2026-09-05T11:30:00.000Z'),
        },
      ]
    }
    if (statement.includes('public:replay-timeline')) {
      return [
        {
          change_id: '12', event_id: 103, at: new Date('2026-09-05T12:00:00.123Z'),
          kind: 'note', actor: 'lamp-reader', detail: { note_id: 51, place_id: 2 },
          note_id: 51, note_body: 'moderate this\nprivate remainder',
        },
        {
          change_id: '11', event_id: 102, at: new Date('2026-09-05T11:59:00.123Z'),
          kind: 'action', actor: 'lamp-reader',
          detail: { action: 'move', from_place_id: 1, to_place_id: 2 },
          note_id: null, note_body: null,
        },
        {
          change_id: '10', event_id: 100, at: new Date('2026-09-05T11:30:00.123Z'),
          kind: 'thing_created', actor: 'lamp-reader', detail: { thing_id: 80, place_id: 2 },
          note_id: null, note_body: null,
        },
      ]
    }
    if (statement.includes('public:replay-counts')) {
      return [{ place_id: 2, residents: 1, things: 3 }]
    }
    throw new Error(`unexpected replay query: ${statement}`)
  }
  const moderationCalls: Array<{ type: string; ids: unknown[] }> = []
  const moderate = async <T extends object>(type: string, rows: readonly T[]) => {
    moderationCalls.push({ type, ids: rows.map(row => (row as { id?: unknown }).id) })
    return rows.map(row => Object.freeze({
      ...row,
      ...((row as { id?: unknown }).id === 51
        ? { body: '[removed by maintainer]' }
        : {}),
    }))
  }
  const eventModerationCalls: number[][] = []
  const moderateEvents = async <T extends object>(rows: readonly T[]) => {
    eventModerationCalls.push(rows.map(row => Number((row as { event_id?: unknown }).event_id)))
    return rows.map(row => {
      const replayRow = row as T & { event_id?: unknown; detail?: Record<string, unknown> }
      return replayRow.event_id === 100
        ? Object.freeze({
          ...replayRow,
          detail: Object.freeze({
            ...replayRow.detail,
            name: '[removed]',
            moderated: true,
            moderation: { reason: 'must not enter the replay file' },
          }),
        })
        : row
    })
  }

  const replay = await buildPublicReplay(execute, parsedOneHour, moderate, moderateEvents)
  assert.deepEqual(moderationCalls, [{ type: 'note', ids: [51] }])
  assert.deepEqual(eventModerationCalls, [[100, 102, 103]])
  assert.equal(replay.span, '1h')
  assert.equal(replay.checkpoint, '12')
  assert.equal(replay.window_end, '2026-09-05T12:00:00.123Z')
  assert.equal(replay.window_start, '2026-09-05T11:00:00.123Z')
  assert.equal(replay.row_ceiling, PUBLIC_REPLAY_ROW_CEILING)
  assert.equal(replay.complete, true)
  assert.deepEqual(replay.start['resident:7'], { place_id: 2, origin_event_id: 101 })
  assert.equal(replay.start['thing:80'], undefined)
  assert.deepEqual(replay.counts['2'], { residents: 1, things: 3 })
  assert.deepEqual(replay.timeline.map(row => row.change_id), ['10', '11', '12'])
  assert.equal(replay.timeline[0]?.detail.name, '[removed]')
  assert.equal(Object.hasOwn(replay.timeline[0]?.detail ?? {}, 'moderated'), false)
  assert.equal(Object.hasOwn(replay.timeline[0]?.detail ?? {}, 'moderation'), false)
  assert.equal(replay.timeline[2]?.line, '[removed by maintainer]')
  assert.equal(replay.timeline[2]?.line_cut, false)

  const body = canonicalJson(replay)
  assert.equal(body, canonicalJson(JSON.parse(body)))
  assert.doesNotMatch(body, /moderate this|private remainder|note_body|"body"/u)
  const timelineCall = calls.find(call => call.statement.includes('public:replay-timeline'))
  const startCall = calls.find(call => call.statement.includes('public:replay-start'))
  assert.match(
    timelineCall?.statement ?? '',
    /event\.at >= checkpoint_event\.at - \$1::integer \* interval '1 hour'/u,
  )
  assert.doesNotMatch(timelineCall?.statement ?? '', /event\.at <=/u)
  assert.equal(timelineCall?.params[0], 1)
  assert.ok(Array.isArray(timelineCall?.params[1]))
  assert.equal(timelineCall?.params[2], PUBLIC_REPLAY_ROW_CEILING + 1)
  assert.match(
    startCall?.statement ?? '',
    /event\.at >= checkpoint_event\.at - \$1::integer \* interval '1 hour'/u,
  )
  assert.doesNotMatch(startCall?.statement ?? '', /event\.at <=/u)
  assert.equal(startCall?.params[0], 1)
  assert.ok(Array.isArray(startCall?.params[1]))
  assert.equal(startCall?.params.length, 2)
  assert.ok(calls.filter(call => call.statement.includes('public:changes-checkpoint')).length >= 2)
})

test('the builder marks an over-ceiling file incomplete and names only its covered range', async () => {
  const parsed = parsePublicReplayQuery({ span: ['1h'] })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const end = Date.parse('2026-09-05T12:00:00.000Z')
  const rows = Array.from({ length: PUBLIC_REPLAY_ROW_CEILING + 1 }, (_, index) => ({
    change_id: String(index + 1),
    event_id: index + 1,
    at: new Date(end - ((PUBLIC_REPLAY_ROW_CEILING - index) * 1_000)),
    kind: 'action',
    actor: 'lamp-reader',
    detail: { action_id: index + 1 },
    note_id: null,
    note_body: null,
  }))
  const execute = async (statement: string): Promise<readonly Record<string, unknown>[]> => {
    if (statement.includes('public:changes-checkpoint')) return [{ checkpoint: '801' }]
    if (statement.includes('public:replay-window')) return [{ window_end: new Date(end) }]
    if (statement.includes('public:replay-map') || statement.includes('public:replay-start') ||
        statement.includes('public:replay-counts')) return []
    if (statement.includes('public:replay-timeline')) return rows
    throw new Error(`unexpected replay query: ${statement}`)
  }
  const replay = await buildPublicReplay(execute, parsed, async (_type, noteRows) => noteRows, async rows => rows)

  assert.equal(replay.complete, false)
  assert.equal(replay.timeline.length, PUBLIC_REPLAY_ROW_CEILING)
  assert.equal(replay.window_start, '2026-09-05T11:00:00.000Z')
  assert.ok(Date.parse(replay.timeline[0]!.at) > Date.parse(replay.window_start))
  assert.equal(replay.timeline.at(-1)?.change_id, '801')
})

test('credential safety accepts a large valid replay without skipping row checks', () => {
  const places = Array.from({ length: 800 }, (_, index) => Object.freeze({
    id: index + 1, parent_id: null, name: `place ${index + 1}`,
    owner_id: null, owner: null, drawing_marker: null, quiet: false,
  }))
  const start = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [
    `resident:${index + 1}`, Object.freeze({ place_id: index + 1 }),
  ]))
  const timeline = Array.from({ length: 800 }, (_, index) => Object.freeze({
    change_id: String(index + 1), event_id: index + 1,
    at: '2026-09-05T12:00:00.000Z', kind: 'note', actor: 'lamp-reader',
    detail: Object.freeze({ note_id: index + 1 }),
    line: index === 799 ? `1f3d9_sk_${'a'.repeat(48)}` : 'safe line', line_cut: false,
  }))
  const counts = Object.fromEntries(Array.from({ length: 800 }, (_, index) => [
    String(index + 1), Object.freeze({ residents: 1, things: 1 }),
  ]))
  const guarded = sanitizePublicReplay(Object.freeze({
    span: '1h', checkpoint: '800',
    window_start: '2026-09-05T11:00:00.000Z',
    window_end: '2026-09-05T12:00:00.000Z',
    row_ceiling: 800, complete: true,
    map: Object.freeze({ places: Object.freeze(places) }),
    start: Object.freeze(start), timeline: Object.freeze(timeline), counts: Object.freeze(counts),
  }) as PublicReplay)

  assert.equal(guarded.withheld, false)
  assert.equal(guarded.changed, true)
  assert.doesNotMatch(canonicalJson(guarded.value), /1f3d9_sk_/iu)
})
