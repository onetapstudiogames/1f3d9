import test from 'node:test'
import assert from 'node:assert/strict'
import {
  decodePublicSearchCursor,
  encodePublicSearchCursor,
  loadPublicSearchResults,
  parsePublicSearchQuery,
} from '../src/public-search.ts'

type SearchQueryValues = Readonly<Record<string, readonly string[] | undefined>>

function validSearch(query: SearchQueryValues) {
  const parsed = parsePublicSearchQuery(query)
  if (!parsed.ok) assert.fail(parsed.error)
  return parsed
}

function invalidSearch(query: SearchQueryValues): string {
  const parsed = parsePublicSearchQuery(query)
  if (parsed.ok) assert.fail('expected the public search query to be rejected')
  return parsed.error
}

test('public search parses one bounded GET query with explicit defaults', () => {
  const defaults = validSearch({ q: ['  Cafe\u0301\t  garden  '] })
  assert.equal(defaults.q, 'Caf\u00e9 garden')
  assert.equal(defaults.mode, 'words')
  assert.equal(defaults.type, 'all')
  assert.equal(defaults.maker, null)
  assert.equal(defaults.limit, 10)
  assert.equal(defaults.fetchLimit, 11)
  assert.equal(defaults.before, null)

  assert.equal(validSearch({ q: ['moss'], limit: ['1'] }).limit, 1)
  assert.equal(validSearch({ q: ['moss'], limit: ['200'] }).limit, 200)
  assert.equal(validSearch({ q: ['moss'], mode: ['phrase'] }).mode, 'phrase')
  assert.equal(validSearch({ q: ['moss'], type: ['note'] }).type, 'note')
  assert.equal(validSearch({ q: ['moss'], type: ['thing'] }).type, 'thing')
  assert.equal(validSearch({ q: ['moss'], type: ['place'] }).type, 'place')
  assert.equal(validSearch({ q: ['moss'], maker: ['first-maker'] }).maker, 'first-maker')

  for (const query of [
    {},
    { q: [] },
    { q: [''] },
    { q: ['moss', 'fern'] },
    { q: ['moss'], mode: ['ranked'] },
    { q: ['moss'], maker: ['first-maker'], type: ['place'] },
    { q: ['moss'], maker: ['First-Maker'] },
    { q: ['moss'], maker: ['first-maker', 'second-maker'] },
    { q: ['moss'], maker: ['first-maker'], type: ['note'] },
    { q: ['moss'], limit: ['0'] },
    { q: ['moss'], limit: ['201'] },
    { q: ['moss'], limit: ['1.5'] },
    { q: ['moss'], extra: ['true'] },
  ] satisfies SearchQueryValues[]) {
    assert.match(invalidSearch(query), /q|mode|type|maker|limit|unsupported/i)
  }
})

test('place search matches current or former names and returns stable lifecycle facts', async () => {
  const parsed = validSearch({ q: ['old porch'], type: ['place'] })
  let searchSql = ''
  const result = await loadPublicSearchResults(async text => {
    searchSql = text
    return [{
      result_type: 'place', id: 42, place_id: 42, name: 'Quiet porch',
      founding_name: 'test porch',
      name_history: [
        { name: 'test porch', started_at: '2026-08-01T00:00:00.000000Z', ended_at: '2026-08-02T00:00:00.000000Z' },
        { name: 'old porch', started_at: '2026-08-02T00:00:00.000000Z', ended_at: '2026-08-03T00:00:00.000000Z' },
        { name: 'Quiet porch', started_at: '2026-08-03T00:00:00.000000Z', ended_at: null },
      ],
      retired_at: '2026-09-01T00:00:00.000000Z', status: 'retired',
      body_text_bytes: 0, created_at: '2026-08-01T00:00:00.000000Z',
      total_items: 1, total_body_bytes: '0', change_marker: '12',
    }]
  }, parsed)

  assert.match(searchSql, /FROM\s+place_name_history/iu)
  assert.match(searchSql, /lead\s*\(\s*history\.started_at/iu)
  assert.deepEqual(result.items, [{
    type: 'place', id: 42, name: 'Quiet porch', founding_name: 'test porch',
    name_history: [
      { name: 'test porch', started_at: '2026-08-01T00:00:00.000000Z', ended_at: '2026-08-02T00:00:00.000000Z' },
      { name: 'old porch', started_at: '2026-08-02T00:00:00.000000Z', ended_at: '2026-08-03T00:00:00.000000Z' },
      { name: 'Quiet porch', started_at: '2026-08-03T00:00:00.000000Z', ended_at: null },
    ],
    retired_at: '2026-09-01T00:00:00.000000Z', status: 'retired',
    created_at: '2026-08-01T00:00:00.000000Z',
  }])
})

test('public search rejects unsafe, credential-bearing, oversized, and over-tokenized q values', () => {
  const syntheticCredential = `1f3d9_sk_${'ab'.repeat(24)}`
  for (const q of [
    'two\nlines',
    'two\rlines',
    `hidden\u202etext`,
    `two\u2028lines`,
    'broken \u00C3\u00A9 text',
    'broken \u00E2\u20AC\u201D text',
    `find ${syntheticCredential}`,
    '\u00e9'.repeat(129),
  ]) {
    assert.match(invalidSearch({ q: [q] }), /q|query|safe|credential|256/i)
  }

  assert.equal(validSearch({ q: ['\u00e9'.repeat(128)], mode: ['phrase'] }).q.length, 128)

  const sixteenWords = Array.from({ length: 16 }, (_, index) => `word${index}`).join(' ')
  const seventeenWords = `${sixteenWords} overflow`
  assert.equal(validSearch({ q: [sixteenWords] }).mode, 'words')
  assert.match(invalidSearch({ q: [seventeenWords] }), /16|word|lexeme|q/i)
  assert.match(
    invalidSearch({ q: [Array.from({ length: 17 }, (_, index) => `token${index}`).join(',')] }),
    /16|word|lexeme|q/i,
  )
  assert.match(invalidSearch({ q: ['---'], mode: ['words'] }), /word|lexeme|q/i)
  assert.equal(validSearch({ q: [seventeenWords], mode: ['phrase'] }).mode, 'phrase')
})

test('opaque search cursors bind normalized q, mode, and type without losing microseconds', () => {
  const cursorRecord = Object.freeze({
    q: 'Caf\u00e9 garden',
    mode: 'words' as const,
    type: 'all' as const,
    createdAt: '2026-08-21T19:20:21.123456Z',
    itemType: 'note' as const,
    id: 73,
    changeMarker: '12',
  })
  const cursor = encodePublicSearchCursor(cursorRecord)

  assert.match(cursor, /^[A-Za-z0-9_-]+$/u)
  assert.doesNotMatch(cursor, /Caf|garden|2026|note/u)
  assert.deepEqual(decodePublicSearchCursor(cursor), cursorRecord)
  assert.equal(decodePublicSearchCursor('not-a-valid-search-cursor'), null)
  assert.equal(decodePublicSearchCursor(encodePublicSearchCursor({
    ...cursorRecord,
    createdAt: '9999-99-99T99:99:99.999999Z',
  })), null)
  assert.equal(decodePublicSearchCursor(encodePublicSearchCursor({
    ...cursorRecord,
    createdAt: '2026-02-29T19:20:21.123456Z',
  })), null)

  const accepted = validSearch({
    q: ['  Cafe\u0301   garden '],
    before: [cursor],
  })
  assert.deepEqual(accepted.before, {
    createdAt: '2026-08-21T19:20:21.123456Z',
    itemType: 'note',
    id: 73,
    changeMarker: '12',
  })

  for (const query of [
    { q: ['Caf\u00e9 grove'], before: [cursor] },
    { q: ['Caf\u00e9 garden'], mode: ['phrase'], before: [cursor] },
    { q: ['Caf\u00e9 garden'], type: ['note'], before: [cursor] },
    { q: ['Caf\u00e9 garden'], before: [`${cursor}x`] },
  ] satisfies SearchQueryValues[]) {
    assert.match(invalidSearch(query), /before|cursor|query/i)
  }
})

test('maker-filtered cursors bind the permanent maker across every continuation', () => {
  const cursorRecord = Object.freeze({
    q: 'lantern',
    mode: 'words' as const,
    type: 'thing' as const,
    maker: 'first-maker',
    createdAt: '2026-08-21T19:20:21.123456Z',
    itemType: 'thing' as const,
    id: 73,
    changeMarker: '12',
  })
  const cursor = encodePublicSearchCursor(cursorRecord)
  assert.deepEqual(decodePublicSearchCursor(cursor), cursorRecord)

  const accepted = validSearch({
    q: ['lantern'], type: ['thing'], maker: ['first-maker'], before: [cursor],
  })
  assert.equal(accepted.maker, 'first-maker')
  assert.equal(accepted.before?.maker, 'first-maker')

  assert.match(invalidSearch({
    q: ['lantern'], type: ['thing'], maker: ['second-maker'], before: [cursor],
  }), /before|cursor|maker|query/i)
  assert.match(invalidSearch({
    q: ['lantern'], type: ['thing'], before: [cursor],
  }), /before|cursor|maker|query/i)
})

test('search extraction returns exact body-free outlines, exact totals, and a stable next cursor', async () => {
  const parsed = validSearch({
    q: ['hush lantern'],
    mode: ['phrase'],
    type: ['all'],
    limit: ['2'],
  })
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const rows = [
    {
      result_type: 'thing',
      id: 31,
      place_id: 7,
      name: 'Hush Lantern',
      maker_id: 1,
      made_by: 'first-maker',
      current_owner_id: 2,
      current_owner: 'tinylantern',
      owner_id: 2,
      owner: 'tinylantern',
      open_to_use: true,
      has_drawing: true,
      body_text_bytes: 12,
      created_at: '2026-08-21T19:20:21.654321Z',
      total_items: 3,
      total_body_bytes: '47',
      change_marker: '12',
      body: 'must never leave the search boundary',
      snippet: 'must not exist',
      rank: 0.99,
    },
    {
      result_type: 'note',
      id: 29,
      place_id: 7,
      author_id: 3,
      author: 'mosslight',
      body_text_bytes: 30,
      created_at: '2026-08-21T19:20:21.654320Z',
      total_items: 3,
      total_body_bytes: '47',
      change_marker: '12',
      body: 'must never leave the search boundary',
      secret_hash: 'must never leave the search boundary',
    },
    {
      result_type: 'thing',
      id: 28,
      place_id: 8,
      name: 'lookahead only',
      maker_id: 4,
      made_by: 'ember',
      current_owner_id: 4,
      current_owner: 'ember',
      owner_id: 4,
      owner: 'ember',
      open_to_use: false,
      body_text_bytes: 5,
      created_at: '2026-08-21T19:20:21.654319Z',
      total_items: 3,
      total_body_bytes: '47',
      change_marker: '12',
    },
  ]

  const result = await loadPublicSearchResults(async (text, params) => {
    calls.push({ text, params })
    return rows
  }, parsed)

  assert.equal(calls.length, 1)
  assert.deepEqual(result.items, [
    {
      type: 'thing',
      id: 31,
      place_id: 7,
      name: 'Hush Lantern',
      maker_id: 1,
      made_by: 'first-maker',
      current_owner_id: 2,
      current_owner: 'tinylantern',
      owner_id: 2,
      owner: 'tinylantern',
      open_to_use: true,
      has_drawing: true,
      body_text_bytes: 12,
      created_at: '2026-08-21T19:20:21.654321Z',
    },
    {
      type: 'note',
      id: 29,
      place_id: 7,
      author_id: 3,
      author: 'mosslight',
      body_text_bytes: 30,
      created_at: '2026-08-21T19:20:21.654320Z',
    },
  ])
  assert.equal(result.totalItems, 3)
  assert.equal(result.totalBodyBytes, 47)
  assert.equal(result.hasMore, true)
  assert.equal(result.changeMarker, '12')
  assert.equal(typeof result.nextBefore, 'string')
  assert.deepEqual(decodePublicSearchCursor(result.nextBefore!), {
    q: 'hush lantern',
    mode: 'phrase',
    type: 'all',
    createdAt: '2026-08-21T19:20:21.654320Z',
    itemType: 'note',
    id: 29,
    changeMarker: '12',
  })
})

test('every continuation keeps the first search marker as its reconciliation baseline', async () => {
  const firstQuery = validSearch({ q: ['lantern'], limit: ['1'] })
  const first = await loadPublicSearchResults(async () => [{
    result_type: 'thing', id: 3, place_id: 1, name: 'new lantern',
    maker_id: 2, made_by: 'alice', current_owner_id: 2, current_owner: 'alice',
    owner_id: 2, owner: 'alice', open_to_use: true, body_text_bytes: 4,
    created_at: '2026-08-21T19:20:21.000000Z',
    total_items: 2, total_body_bytes: '8', change_marker: '12',
  }, {
    result_type: 'thing', id: 2, place_id: 1, name: 'old lantern',
    maker_id: 2, made_by: 'alice', current_owner_id: 2, current_owner: 'alice',
    owner_id: 2, owner: 'alice', open_to_use: true, body_text_bytes: 4,
    created_at: '2026-08-20T19:20:21.000000Z',
    total_items: 2, total_body_bytes: '8', change_marker: '12',
  }], firstQuery)
  const continuation = validSearch({ q: ['lantern'], limit: ['1'], before: [first.nextBefore!] })
  assert.equal(continuation.before?.changeMarker, '12')

  const later = await loadPublicSearchResults(async () => [{
    result_type: 'thing', id: 2, place_id: 1, name: 'old lantern',
    maker_id: 2, made_by: 'alice', current_owner_id: 2, current_owner: 'alice',
    owner_id: 2, owner: 'alice', open_to_use: true, body_text_bytes: 4,
    created_at: '2026-08-20T19:20:21.000000Z',
    total_items: 2, total_body_bytes: '8', change_marker: '14',
  }, {
    result_type: 'thing', id: 1, place_id: 1, name: 'older lantern',
    maker_id: 2, made_by: 'alice', current_owner_id: 2, current_owner: 'alice',
    owner_id: 2, owner: 'alice', open_to_use: true, body_text_bytes: 4,
    created_at: '2026-08-19T19:20:21.000000Z',
    total_items: 2, total_body_bytes: '8', change_marker: '14',
  }], continuation)
  assert.equal(later.changeMarker, '12')
  assert.equal(decodePublicSearchCursor(later.nextBefore!)?.changeMarker, '12')
})

test('a continuation cursor cannot claim a marker ahead of the database checkpoint', async () => {
  const before = encodePublicSearchCursor({
    q: 'lantern',
    mode: 'words',
    type: 'all',
    createdAt: '2026-08-21T19:20:21.000000Z',
    itemType: 'thing',
    id: 3,
    changeMarker: '999',
  })
  const continuation = validSearch({ q: ['lantern'], before: [before] })

  await assert.rejects(
    loadPublicSearchResults(async () => [{
      result_type: null,
      id: null,
      total_items: 0,
      total_body_bytes: '0',
      change_marker: '12',
    }], continuation),
    /search marker 999 is ahead of checkpoint 12/iu,
  )
})

test('search SQL filters private rows before matching and pages by creation time without ranking', async () => {
  const rawPhrase = `100%_literal' OR TRUE; --`
  const phrase = validSearch({ q: [rawPhrase], mode: ['phrase'], type: ['all'] })
  let phraseSql = ''
  let phraseParams: readonly unknown[] = []
  await loadPublicSearchResults(async (text, params) => {
    phraseSql = text
    phraseParams = params
    return [{
      result_type: null,
      id: null,
      total_items: 0,
      total_body_bytes: '0',
      change_marker: '12',
    }]
  }, phrase)

  const compactPhraseSql = phraseSql.replace(/\s+/gu, ' ').trim()
  assert.doesNotMatch(phraseSql, /100%_literal|OR TRUE/u)
  assert.ok(phraseParams.includes(rawPhrase))
  assert.ok(phraseParams.includes(11))
  assert.ok(phraseParams.some(value => (
    typeof value === 'string' && value.includes('1f3d9_')
  )))

  assert.match(compactPhraseSql, /FROM notes\b/i)
  assert.match(compactPhraseSql, /FROM things\b/i)
  assert.match(compactPhraseSql, /thing\.maker_id/i)
  assert.match(compactPhraseSql, /maker\.handle AS made_by/i)
  assert.match(compactPhraseSql, /thing\.owner_id AS current_owner_id/i)
  assert.match(compactPhraseSql, /owner\.handle AS current_owner/i)
  assert.match(compactPhraseSql, /JOIN residents maker ON maker\.id = thing\.maker_id/i)
  assert.match(compactPhraseSql, /thing\.withdrawn_at IS NULL/i)
  assert.match(compactPhraseSql, /moderation_actions/i)
  assert.match(compactPhraseSql, /\bremove\b/i)
  assert.match(compactPhraseSql, /created_at DESC, [\w.]+id DESC/i)
  assert.match(compactPhraseSql, /note\.body[\s\S]*?!~\*/i)
  assert.match(compactPhraseSql, /thing\.(?:name|body)[\s\S]*?!~\*/i)
  assert.match(compactPhraseSql, /\b(?:strpos|position)\s*\(/i)
  assert.doesNotMatch(compactPhraseSql, /\bILIKE\b/i)
  assert.match(
    compactPhraseSql,
    /ORDER BY [\w.]+created_at DESC, [\w.]*(?:result|item)_type (?:ASC|DESC), [\w.]+id DESC/i,
  )
  assert.match(compactPhraseSql, /count\s*\(\s*\*\s*\)[\s\S]*total_items/i)
  assert.match(compactPhraseSql, /sum\s*\([\s\S]*octet_length\([\s\S]*body[\s\S]*total_body_bytes/i)
  assert.doesNotMatch(
    compactPhraseSql,
    /\b(?:ts_rank(?:_cd)?|ts_headline|similarity|snippet|score)\b/i,
  )

  const matchPosition = compactPhraseSql.search(/\b(?:strpos|position)\s*\(/i)
  assert.ok(matchPosition > compactPhraseSql.search(/moderation_actions/i))
  assert.ok(matchPosition > compactPhraseSql.search(/!~\*/u))

  const words = validSearch({
    q: ['garden gardens'],
    mode: ['words'],
    type: ['thing'],
  })
  let wordSql = ''
  let wordParams: readonly unknown[] = []
  await loadPublicSearchResults(async (text, params) => {
    wordSql = text
    wordParams = params
    return [{
      result_type: null,
      id: null,
      total_items: 0,
      total_body_bytes: '0',
      change_marker: '12',
    }]
  }, words)

  assert.ok(wordParams.includes('garden gardens'))
  assert.match(wordSql, /to_tsvector\s*\(\s*'simple'/i)
  assert.match(wordSql, /plainto_tsquery\s*\(\s*'simple'/i)
  assert.doesNotMatch(wordSql, /\benglish\b|\b(?:stem|rank|headline|snippet)\w*\b/i)
})

test('maker filtering uses the permanent thing maker and excludes notes before totals', async () => {
  const query = validSearch({
    q: ['lantern'], maker: ['first-maker'], type: ['all'], limit: ['5'],
  })
  let sql = ''
  let params: readonly unknown[] = []
  await loadPublicSearchResults(async (text, values) => {
    sql = text
    params = values
    return [{
      result_type: null,
      id: null,
      total_items: 0,
      total_body_bytes: '0',
      change_marker: '12',
    }]
  }, query)

  assert.ok(params.includes('first-maker'))
  assert.match(sql, /note_candidates[\s\S]*AND \$9::text IS NULL/iu)
  assert.match(sql, /thing_candidates[\s\S]*maker\.handle\s*=\s*\$\d+::text/iu)
})
