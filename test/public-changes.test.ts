import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadPublicChanges,
  parsePublicChangeQuery,
  PublicChangeReadConflictError,
  readAtStablePublicChangeCheckpoint,
} from '../src/public-changes.ts'
import { PUBLIC_EVENT_KINDS } from '../src/public-events.ts'

type QueryRow = Readonly<Record<string, unknown>>

class FakeExecutor {
  readonly calls: Array<Readonly<{ text: string; params: readonly unknown[] }>> = []
  readonly #results: readonly (readonly QueryRow[])[]
  #resultIndex = 0

  constructor(...results: readonly (readonly QueryRow[])[]) {
    this.#results = results
  }

  readonly query = async (
    text: string,
    params: readonly unknown[],
  ): Promise<readonly QueryRow[]> => {
    this.calls.push(Object.freeze({ text, params: Object.freeze([...params]) }))
    const rows = this.#results[this.#resultIndex]
    this.#resultIndex += 1
    assert.ok(rows, 'the fake executor received an unexpected query')
    return rows
  }
}

function validQuery(query: Record<string, readonly string[]>) {
  const parsed = parsePublicChangeQuery(query)
  if (!parsed.ok) assert.fail(parsed.error)
  return parsed
}

const eventSix = Object.freeze({
  change_id: '6',
  kind: 'thing_edited',
  actor: 'alice',
  detail: Object.freeze({ thing_id: 42 }),
  created_at: '2026-08-21T12:00:06.000Z',
})

const eventSeven = Object.freeze({
  change_id: '7',
  kind: 'thing_moved',
  actor: 'alice',
  detail: Object.freeze({ thing_id: 42, from_place_id: 1, place_id: 2 }),
  created_at: '2026-08-21T12:00:07.000Z',
})

const eventEight = Object.freeze({
  change_id: '8',
  kind: 'thing_withdrawn',
  actor: 'alice',
  detail: Object.freeze({ thing_id: 42 }),
  created_at: '2026-08-21T12:00:08.000Z',
})

test('public change query keeps bigint markers as decimal strings', () => {
  assert.deepEqual(validQuery({}), {
    ok: true,
    since: null,
    kind: null,
    limit: 10,
    fetchLimit: 11,
  })
  assert.deepEqual(validQuery({ since: ['0'], kind: ['note'], limit: ['200'] }), {
    ok: true,
    since: '0',
    kind: 'note',
    limit: 200,
    fetchLimit: 201,
  })
  assert.deepEqual(validQuery({ since: ['9007199254740993'], limit: ['2'] }), {
    ok: true,
    since: '9007199254740993',
    kind: null,
    limit: 2,
    fetchLimit: 3,
  })
  assert.deepEqual(validQuery({ since: ['9223372036854775807'] }), {
    ok: true,
    since: '9223372036854775807',
    kind: null,
    limit: 10,
    fetchLimit: 11,
  })

  for (const kind of PUBLIC_EVENT_KINDS) {
    assert.equal(validQuery({ kind: [kind] }).kind, kind)
  }
})

test('public change query rejects duplicate, malformed, future-sized, and unknown input', () => {
  const cases = [
    [{ since: ['1', '2'] }, /since must appear at most once/iu],
    [{ since: ['-1'] }, /since must be a nonnegative decimal bigint/iu],
    [{ since: ['1.0'] }, /since must be a nonnegative decimal bigint/iu],
    [{ since: [' 1'] }, /since must be a nonnegative decimal bigint/iu],
    [{ since: ['9223372036854775808'] }, /since must be a nonnegative decimal bigint/iu],
    [{ since: ['9'.repeat(100_000)] }, /since must be a nonnegative decimal bigint/iu],
    [{ kind: ['note', 'action'] }, /kind must appear at most once/iu],
    [{ kind: ['NOTE'] }, /kind must be one of the public event kinds/iu],
    [{ kind: [''] }, /kind must be one of the public event kinds/iu],
    [{ kind: ['not-a-public-event'] }, /kind must be one of the public event kinds/iu],
    [{ id: ['5'] }, /unsupported query option: id/iu],
    [{ action_id: ['5'] }, /unsupported query option: action_id/iu],
    [{ since: ['1'], limit: ['0'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: ['01'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: ['1.0'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: ['1e2'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: ['0x10'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: ['+1'] }, /limit must be between 1 and 200/iu],
    [{ since: ['1'], limit: [' 1'] }, /limit must be between 1 and 200/iu],
    [{ q: ['not-a-change-option'] }, /unsupported query option/iu],
  ] as const

  for (const [query, message] of cases) {
    const parsed = parsePublicChangeQuery(query)
    assert.equal(parsed.ok, false)
    if (parsed.ok) assert.fail(`expected ${JSON.stringify(query)} to be rejected`)
    assert.match(parsed.error, message)
  }
})

test('a public read that crosses two checkpoints fails explicitly after discarding both reads', async () => {
  const database = new FakeExecutor(
    [{ checkpoint: '20' }],
    [{ checkpoint: '21' }],
    [{ checkpoint: '21' }],
    [{ checkpoint: '22' }],
  )
  let reads = 0

  await assert.rejects(
    readAtStablePublicChangeCheckpoint(database.query, '20', async () => {
      reads += 1
      return reads
    }),
    error => {
      assert.ok(error instanceof PublicChangeReadConflictError)
      assert.match(error.message, /changed from marker 21 to 22.*retry/iu)
      return true
    },
  )

  assert.equal(reads, 2)
  assert.equal(database.calls.length, 4)
})

test('a request without since returns only a caller-held checkpoint', async () => {
  const database = new FakeExecutor([
    { checkpoint: '12', ...eventSix },
  ])

  const result = await loadPublicChanges(database.query, validQuery({ kind: ['note'] }))

  assert.deepEqual(result, { change_marker: '12' })
  assert.equal(database.calls.length, 1)
  assert.match(database.calls[0]!.text, /public_change_state/iu)
  assert.doesNotMatch(JSON.stringify(result), /thing_edited|alice|thing_id/iu)
})

test('a marker ahead of the transactional checkpoint is rejected as future', async () => {
  const database = new FakeExecutor([
    { checkpoint: '4', change_id: null },
  ])

  await assert.rejects(
    loadPublicChanges(database.query, validQuery({ since: ['5'] })),
    /since marker 5 is ahead of checkpoint 4/iu,
  )
  assert.equal(database.calls.length, 1)
})

test('changes page forward by public change log id with exact checkpoints and no gaps', async () => {
  const database = new FakeExecutor(
    [
      { checkpoint: '8', ...eventSix },
      { checkpoint: '8', ...eventSeven },
      { checkpoint: '8', ...eventEight },
    ],
    [
      { checkpoint: '8', ...eventEight },
    ],
    [
      { checkpoint: '8', change_id: null },
    ],
  )

  const first = await loadPublicChanges(
    database.query,
    validQuery({ since: ['5'], limit: ['2'] }),
  )
  assert.deepEqual(first, {
    change_marker: '8',
    changes: [eventSix, eventSeven],
    returned_items: 2,
    unchanged: false,
    has_more: true,
    next_since: '7',
  })

  const second = await loadPublicChanges(
    database.query,
    validQuery({ since: [first.next_since], limit: ['2'] }),
  )
  assert.deepEqual(second, {
    change_marker: '8',
    changes: [eventEight],
    returned_items: 1,
    unchanged: false,
    has_more: false,
    next_since: '8',
  })

  const unchanged = await loadPublicChanges(
    database.query,
    validQuery({ since: [second.next_since], limit: ['2'] }),
  )
  assert.deepEqual(unchanged, {
    change_marker: '8',
    changes: [],
    returned_items: 0,
    unchanged: true,
    has_more: false,
    next_since: '8',
  })

  assert.deepEqual(database.calls.map(call => call.params), [
    ['5', 3, null],
    ['7', 3, null],
    ['8', 3, null],
  ])
  for (const { text } of database.calls) {
    assert.match(text, /FROM\s+public_change_log\s+(?:AS\s+)?pcl/iu)
    assert.match(text, /JOIN\s+events\s+(?:AS\s+)?e\s+ON\s+e\.id\s*=\s*pcl\.event_id/iu)
    assert.match(text, /pcl\.change_id\s*>\s*\$1::bigint/iu)
    assert.match(text, /ORDER BY\s+pcl\.change_id\s+ASC/iu)
    assert.doesNotMatch(text, /(?:e|events?)\.public_change_id/iu)
    assert.doesNotMatch(text, /(?:WHERE|AND)\s+(?:e|events?)\.id\s*>/iu)
    assert.doesNotMatch(text, /ORDER BY\s+(?:e|events?)\.id/iu)
    assert.doesNotMatch(text, /MAX\s*\(\s*(?:e\.)?id\s*\)/iu)
    assert.doesNotMatch(text, /(?:SELECT|,)\s+(?:e|page)\.id\s*(?:,|FROM)/iu)
  }
})

test('an exact kind filter pages in global change-id space and advances to the checkpoint', async () => {
  const noteSix = Object.freeze({ ...eventSix, kind: 'note', detail: { note_id: 66 } })
  const noteNine = Object.freeze({
    change_id: '9', kind: 'note', actor: 'bob', detail: { note_id: 69 },
    created_at: '2026-08-21T12:00:09.000Z',
  })
  const noteEleven = Object.freeze({
    change_id: '11', kind: 'note', actor: 'carol', detail: { note_id: 71 },
    created_at: '2026-08-21T12:00:11.000Z',
  })
  const database = new FakeExecutor(
    [
      { checkpoint: '12', ...noteSix },
      { checkpoint: '12', ...noteNine },
      { checkpoint: '12', ...noteEleven },
    ],
    [{ checkpoint: '12', ...noteEleven }],
    [{ checkpoint: '12', change_id: null }],
  )

  const first = await loadPublicChanges(
    database.query,
    validQuery({ since: ['5'], kind: ['note'], limit: ['2'] }),
  )
  assert.deepEqual(first, {
    change_marker: '12',
    changes: [noteSix, noteNine],
    returned_items: 2,
    unchanged: false,
    has_more: true,
    next_since: '9',
  })

  const second = await loadPublicChanges(
    database.query,
    validQuery({ since: ['9'], kind: ['note'], limit: ['2'] }),
  )
  assert.deepEqual(second, {
    change_marker: '12',
    changes: [noteEleven],
    returned_items: 1,
    unchanged: false,
    has_more: false,
    next_since: '12',
  })

  const exhausted = await loadPublicChanges(
    database.query,
    validQuery({ since: ['12'], kind: ['note'], limit: ['2'] }),
  )
  assert.deepEqual(exhausted, {
    change_marker: '12',
    changes: [],
    returned_items: 0,
    unchanged: true,
    has_more: false,
    next_since: '12',
  })

  assert.deepEqual(database.calls.map(call => call.params), [
    ['5', 3, 'note'],
    ['9', 3, 'note'],
    ['12', 3, 'note'],
  ])
  assert.match(database.calls[0]!.text, /\$3::text\s+IS\s+NULL[\s\S]*e\.kind\s*=\s*\$3::text/iu)
})

test('a filtered page with no match advances directly to its fixed checkpoint', async () => {
  const database = new FakeExecutor([{ checkpoint: '15', change_id: null }])

  const result = await loadPublicChanges(
    database.query,
    validQuery({ since: ['12'], kind: ['note'], limit: ['2'] }),
  )

  assert.deepEqual(result, {
    change_marker: '15',
    changes: [],
    returned_items: 0,
    unchanged: false,
    has_more: false,
    next_since: '15',
  })
})

test('failed action changes expose the basic verb and safe reason, never the request payload', async () => {
  const database = new FakeExecutor([{
    checkpoint: '16',
    change_id: '16',
    kind: 'action',
    actor: 'alice',
    detail: {
      action_id: 416,
      action: 'move',
      status: 'failed',
      error: 'move must cross one parent-child edge',
      payload: 'resident-authored text must stay private',
      body: 'resident-authored text must stay private',
    },
    created_at: '2026-08-21T12:00:16.000Z',
  }])

  const result = await loadPublicChanges(
    database.query,
    validQuery({ since: ['15'], kind: ['action'], limit: ['1'] }),
  )

  assert.deepEqual(result.changes, [{
    change_id: '16',
    kind: 'action',
    actor: 'alice',
    detail: {
      action_id: 416,
      action: 'move',
      status: 'failed',
      error: 'move must cross one parent-child edge',
    },
    created_at: '2026-08-21T12:00:16.000Z',
  }])
  assert.doesNotMatch(JSON.stringify(result), /resident-authored text/iu)
})

test('successful use changes keep the source thing reference without exposing request payload', async () => {
  const database = new FakeExecutor([{
    checkpoint: '17',
    change_id: '17',
    kind: 'action',
    actor: 'alice',
    detail: {
      action_id: 417,
      action: 'use',
      status: 'noop',
      place_id: 7,
      source_thing_id: 42,
      payload: 'resident-authored text must stay private',
    },
    created_at: '2026-08-21T12:00:17.000Z',
  }])

  const result = await loadPublicChanges(
    database.query,
    validQuery({ since: ['16'], kind: ['action'], limit: ['1'] }),
  )

  assert.deepEqual(result.changes, [{
    change_id: '17',
    kind: 'action',
    actor: 'alice',
    detail: {
      action_id: 417,
      action: 'use',
      status: 'noop',
      place_id: 7,
      source_thing_id: 42,
    },
    created_at: '2026-08-21T12:00:17.000Z',
  }])
  assert.doesNotMatch(JSON.stringify(result), /resident-authored text/iu)
})

test('change references keep asset type paired with asset id without leaking authored detail', async () => {
  const database = new FakeExecutor([{
    checkpoint: '9',
    id: 109,
    change_id: '9',
    kind: 'transfer',
    actor: 'alice',
    detail: {
      asset_type: 'thing', asset_id: 42, transfer_id: 77,
      secret_id: 991,
      body: 'not public in a change notice', wallet: 'not public either',
    },
    created_at: '2026-08-21T12:00:09.000Z',
  }])

  const result = await loadPublicChanges(
    database.query,
    validQuery({ since: ['8'], limit: ['1'] }),
  )
  assert.deepEqual(result.changes, [{
    change_id: '9',
    kind: 'transfer',
    actor: 'alice',
    detail: { asset_type: 'thing', asset_id: 42, transfer_id: 77 },
    created_at: '2026-08-21T12:00:09.000Z',
  }])
  assert.equal('id' in (result.changes as readonly Record<string, unknown>[])[0]!, false)
  assert.match(database.calls[0]!.text, /'asset_type'/u)
  assert.doesNotMatch(JSON.stringify(result), /not public|wallet|secret_id|991/iu)
  assert.doesNotMatch(database.calls[0]!.text, /\*_id|endsWith|field\.key\s*~/iu)
})

test('unknown event kinds and invalid actors advance reconciliation without exposing a notice', async () => {
  const database = new FakeExecutor([
    {
      checkpoint: '10', id: 110, change_id: '9', kind: 'internal_rebalance',
      actor: 'private:service', detail: { resident_id: 7, secret_id: 991 },
      created_at: '2026-08-21T12:00:10.000Z',
    },
    {
      checkpoint: '10', id: 111, change_id: '10', kind: 'thing_edited',
      actor: 'private:service', detail: { thing_id: 42 },
      created_at: '2026-08-21T12:00:11.000Z',
    },
  ])

  const result = await loadPublicChanges(
    database.query,
    validQuery({ since: ['8'], limit: ['2'] }),
  )
  assert.deepEqual(result, {
    change_marker: '10',
    changes: [],
    returned_items: 0,
    unchanged: false,
    has_more: false,
    next_since: '10',
  })
  assert.doesNotMatch(JSON.stringify(result), /internal_rebalance|private:service|991/iu)
})
