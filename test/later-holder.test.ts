import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createLaterHolderCursorCodec,
  isLaterHolderCursor,
  LaterHolderCursorError,
  LATER_HOLDER_PAGE_DEFAULT,
  LATER_HOLDER_SINGULAR_QUESTION,
  laterHolderNotice,
  parseLaterHolderMarkInput,
  parseLaterHolderReadInput,
  readLaterHolderIndex,
  readLaterHolderNotice,
  setLaterHolderMark,
  type LaterHolderQueryExecutor,
} from '../src/later-holder.ts'
import { PUBLIC_CREDENTIAL_REDACTION } from '../src/credential-safety.ts'
import { MODERATED_TEXT } from '../src/moderation.ts'

const CURSOR_KEY = '11'.repeat(32)
const cursorFor = (residentId: number) => createLaterHolderCursorCodec(CURSOR_KEY, residentId)

test('later-holder notice uses the exact zero, singular, and plural shapes', () => {
  assert.deepEqual(laterHolderNotice(0), { count: 0 })
  assert.deepEqual(laterHolderNotice(1), {
    count: 1,
    question: LATER_HOLDER_SINGULAR_QUESTION,
  })
  assert.deepEqual(laterHolderNotice(27), {
    count: 27,
    question:
      'An earlier holder of this resident identity marked 27 public items for later holders. View the index?',
  })
})

test('later-holder read input accepts only the two exact modes and bounded paging', () => {
  const before = cursorFor(7).encode('19')
  assert.deepEqual(parseLaterHolderReadInput({ mode: 'later_holder_notice' }), {
    ok: true,
    request: { mode: 'later_holder_notice' },
  })
  assert.deepEqual(parseLaterHolderReadInput({ mode: 'later_holder_index' }), {
    ok: true,
    request: {
      mode: 'later_holder_index',
      before: null,
      limit: LATER_HOLDER_PAGE_DEFAULT,
    },
  })
  assert.deepEqual(parseLaterHolderReadInput({
    mode: 'later_holder_index', before, limit: 200,
  }), {
    ok: true,
    request: {
      mode: 'later_holder_index', before, limit: 200,
    },
  })

  for (const value of [
    null,
    {},
    { mode: 'notice' },
    { mode: 'later_holder_notice', limit: 1 },
    { mode: 'later_holder_index', thing_id: 4 },
    { mode: 'later_holder_index', before: 4 },
    { mode: 'later_holder_index', before: '0' },
    { mode: 'later_holder_index', before: '01' },
    { mode: 'later_holder_index', before: '19' },
    { mode: 'later_holder_index', before: `lh1_${'a'.repeat(47)}` },
    { mode: 'later_holder_index', limit: 0 },
    { mode: 'later_holder_index', limit: 201 },
  ]) {
    assert.equal(parseLaterHolderReadInput(value).ok, false, JSON.stringify(value))
  }
})

test('mark input is exact and represents retry-safe mark or unmark intent', () => {
  assert.deepEqual(parseLaterHolderMarkInput({ action: 'mark' }), {
    ok: true, action: 'mark',
  })
  assert.deepEqual(parseLaterHolderMarkInput({ action: 'unmark' }), {
    ok: true, action: 'unmark',
  })
  for (const value of [null, {}, { action: 'remove' }, { action: 'mark', opened: false }]) {
    assert.equal(parseLaterHolderMarkInput(value).ok, false, JSON.stringify(value))
  }
})

test('notice reads only the live eligible count and does not expose headings', async () => {
  let statement = ''
  const execute: LaterHolderQueryExecutor = async query => {
    statement = query
    return [{ count: 1 }]
  }

  const notice = await readLaterHolderNotice(execute, 7)

  assert.deepEqual(notice, laterHolderNotice(1))
  assert.match(statement, /thing_later_holder_marks/iu)
  assert.match(statement, /thing\.maker_id\s*=\s*\$1/iu)
  assert.match(statement, /thing\.owner_id\s*=\s*\$1/iu)
  assert.match(statement, /withdrawn_at\s+is\s+null/iu)
  assert.match(statement, /moderation[\s\S]*remove/iu)
  assert.doesNotMatch(statement, /insert|update|delete/iu)
})

test('index returns approved current headings while keeping bodies and mark metadata private', async () => {
  const cursorCodec = cursorFor(7)
  let statement = ''
  let parameters: readonly unknown[] = []
  const execute: LaterHolderQueryExecutor = async (query, params) => {
    statement = query
    parameters = params
    return [
      {
        mark_id: '19', id: 31, title: 'Old copper lantern',
        place_id: 4, place_title: 'Quiet arcade',
        date: '2026-08-01T01:02:03.000000Z', body_text_bytes: 11,
        total_count: 2,
      },
      {
        mark_id: '12', id: 8, title: 'Second title',
        place_id: 2, place_title: 'Square',
        date: '2026-07-01T01:02:03.000000Z', body_text_bytes: 4096,
        total_count: 2,
      },
    ]
  }

  const index = await readLaterHolderIndex(execute, 7, {
    mode: 'later_holder_index', before: null, limit: 1,
  }, cursorCodec)

  assert.equal(index.count, 2)
  assert.deepEqual(index.items, [{
      id: 31,
      type: 'thing',
      title: 'Old copper lantern',
      place: { id: 4, title: 'Quiet arcade' },
      date: '2026-08-01T01:02:03.000000Z',
      body_text_bytes: 11,
  }])
  assert.equal(index.has_more, true)
  assert.equal(isLaterHolderCursor(index.next_before), true)
  assert.equal(cursorCodec.decode(index.next_before!), '19')
  assert.deepEqual(parameters, [7, null, 2, MODERATED_TEXT])
  assert.match(statement, /octet_length\s*\(\s*thing\.body\s*\)/iu)
  assert.doesNotMatch(statement, /thing\.body\s+(?:as\s+)?body\b/iu)
  assert.doesNotMatch(JSON.stringify(index), /mark_id|marked_at|snippet|summary|recommendation|"body"/iu)
})

test('index redacts credential-shaped headings', async () => {
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  const safe = await readLaterHolderIndex(async () => [{
    mark_id: '9', id: 31, title: `title ${credential}`,
    place_id: 4, place_title: `place ${credential}`,
    date: '2026-08-01T01:02:03.000000Z', body_text_bytes: 1,
    total_count: 1,
  }], 7, { mode: 'later_holder_index', before: null, limit: 10 }, cursorFor(7))
  assert.deepEqual(safe.items[0], {
    id: 31,
    type: 'thing',
    title: PUBLIC_CREDENTIAL_REDACTION,
    place: { id: 4, title: PUBLIC_CREDENTIAL_REDACTION },
    date: '2026-08-01T01:02:03.000000Z',
    body_text_bytes: 1,
  })
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(credential, 'iu'))
})

test('opaque cursor is resident-bound and rejects authenticated tampering before a query', async () => {
  const residentCursor = cursorFor(7).encode('19')
  const otherResidentCursor = cursorFor(8).encode('19')
  const tamperedCursor = `${residentCursor.slice(0, -1)}${residentCursor.endsWith('A') ? 'B' : 'A'}`
  assert.equal(isLaterHolderCursor(residentCursor), true)
  assert.equal(cursorFor(7).decode(residentCursor), '19')
  assert.equal(cursorFor(8).decode(residentCursor), null)
  assert.equal(cursorFor(7).decode(tamperedCursor), null)

  let queryCalls = 0
  const execute: LaterHolderQueryExecutor = async () => {
    queryCalls += 1
    return []
  }
  await assert.rejects(
    readLaterHolderIndex(execute, 7, {
      mode: 'later_holder_index', before: otherResidentCursor, limit: 10,
    }, cursorFor(7)),
    LaterHolderCursorError,
  )
  await assert.rejects(
    readLaterHolderIndex(execute, 7, {
      mode: 'later_holder_index', before: tamperedCursor, limit: 10,
    }, cursorFor(7)),
    LaterHolderCursorError,
  )
  assert.equal(queryCalls, 0)
})

test('mark and unmark queries change only the private mark store', async () => {
  const calls: Array<{ query: string; params: readonly unknown[] }> = []
  const execute: LaterHolderQueryExecutor = async (query, params) => {
    calls.push({ query, params })
    return query.includes('DELETE FROM thing_later_holder_marks')
      ? []
      : [{ thing_id: 31, changed: false }]
  }

  assert.deepEqual(await setLaterHolderMark(execute, 7, 31, true), {
    thing_id: 31, marked: true, changed: false,
  })
  assert.deepEqual(await setLaterHolderMark(execute, 7, 31, false), {
    thing_id: 31, marked: false, changed: false,
  })
  assert.deepEqual(calls.map(call => call.params), [[7, 31], [7, 31]])
  for (const call of calls) {
    assert.doesNotMatch(call.query, /\bevents\b|public_change/iu)
  }
})
