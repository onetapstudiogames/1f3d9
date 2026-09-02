import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadPublicPlaceFrontMatter,
  parsePlaceFrontMatter,
  parsePlacePurpose,
} from '../src/room-orientation.ts'

test('place purpose distinguishes omission and clearing while normalizing one line', () => {
  assert.equal(parsePlacePurpose(undefined), undefined)
  assert.equal(parsePlacePurpose(''), '')
  assert.equal(parsePlacePurpose('   '), '')
  assert.equal(
    parsePlacePurpose('  A small public room for repairing clocks.  '),
    'A small public room for repairing clocks.',
  )
  assert.equal(parsePlacePurpose('x'.repeat(280)), 'x'.repeat(280))
  assert.equal(parsePlacePurpose('🏙'.repeat(280)), '🏙'.repeat(280))
})

test('place purpose rejects unsupported, unsafe, multiline, or overlong values', () => {
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  for (const value of [
    null,
    7,
    [],
    {},
    'first line\nsecond line',
    'first line\rsecond line',
    'first line\u2028second line',
    'unsafe\u0001text',
    `never publish ${credential}`,
    'x'.repeat(281),
    '🏙'.repeat(281),
  ]) {
    assert.equal(parsePlacePurpose(value), null, JSON.stringify(value))
  }
})

test('front matter distinguishes omission and clearing and preserves two or three IDs in order', () => {
  assert.equal(parsePlaceFrontMatter(undefined), undefined)
  assert.deepEqual(parsePlaceFrontMatter([]), [])
  assert.deepEqual(parsePlaceFrontMatter([19, 4]), [19, 4])
  assert.deepEqual(parsePlaceFrontMatter([19, 4, 27]), [19, 4, 27])
})

test('front matter rejects malformed, duplicate, non-positive, or unsupported selections', () => {
  for (const value of [
    null,
    {},
    '19,4',
    [19],
    [19, 4, 27, 31],
    [19, 19],
    [19, 4, 19],
    [0, 4],
    [-1, 4],
    [1.5, 4],
    ['19', 4],
    [Number.NaN, 4],
    [Number.POSITIVE_INFINITY, 4],
    [2_147_483_648, 4],
    [19, undefined, 4],
  ]) {
    assert.equal(parsePlaceFrontMatter(value), null, JSON.stringify(value))
  }
})

test('public front matter is one body-free batch of stable headings in stored order', async () => {
  let statement = ''
  let parameters: readonly unknown[] = []
  let calls = 0
  const result = await loadPublicPlaceFrontMatter(async (text, params) => {
    calls += 1
    statement = text
    parameters = params
    return [
      {
        place_id: 8,
        position: 0,
        id: 19,
        type: 'thing',
        name: 'Copper lantern',
        body_text_bytes: 12,
        maker_id: 5,
        made_by: 'maker-one',
        current_owner_id: 6,
        current_owner: 'owner-one',
        owner_id: 6,
        owner: 'owner-one',
        has_drawing: true,
      },
      {
        place_id: 8,
        position: 1,
        id: 4,
        type: 'thing',
        name: 'Window seat',
        body_text_bytes: 4096,
        maker_id: 7,
        made_by: 'maker-two',
        current_owner_id: 8,
        current_owner: 'owner-two',
        owner_id: 8,
        owner: 'owner-two',
        has_drawing: false,
      },
      {
        place_id: 12,
        position: 0,
        id: 27,
        type: 'thing',
        name: 'Welcome bell',
        body_text_bytes: 5,
        maker_id: 9,
        made_by: 'maker-three',
        current_owner_id: 10,
        current_owner: 'owner-three',
        owner_id: 10,
        owner: 'owner-three',
        has_drawing: true,
      },
    ]
  }, [8, 12])

  assert.equal(calls, 1)
  assert.deepEqual(parameters, [[8, 12]])
  assert.deepEqual([...result.entries()], [
    [8, [
      {
        id: 19,
        type: 'thing',
        name: 'Copper lantern',
        body_text_bytes: 12,
        maker_id: 5,
        made_by: 'maker-one',
        current_owner_id: 6,
        current_owner: 'owner-one',
        owner_id: 6,
        owner: 'owner-one',
        has_drawing: true,
      },
      {
        id: 4,
        type: 'thing',
        name: 'Window seat',
        body_text_bytes: 4096,
        maker_id: 7,
        made_by: 'maker-two',
        current_owner_id: 8,
        current_owner: 'owner-two',
        owner_id: 8,
        owner: 'owner-two',
        has_drawing: false,
      },
    ]],
    [12, [{
      id: 27,
      type: 'thing',
      name: 'Welcome bell',
      body_text_bytes: 5,
      maker_id: 9,
      made_by: 'maker-three',
      current_owner_id: 10,
      current_owner: 'owner-three',
      owner_id: 10,
      owner: 'owner-three',
      has_drawing: true,
    }]],
  ])

  assert.match(statement, /FROM\s+places\s+place\b/iu)
  assert.match(
    statement,
    /unnest\s*\(\s*place\.front_matter_thing_ids\s*\)\s+WITH\s+ORDINALITY/iu,
  )
  assert.match(statement, /JOIN\s+things\s+thing\s+ON\s+thing\.id\s*=\s*[a-z_]+\.thing_id/iu)
  assert.match(statement, /thing\.place_id\s*=\s*place\.id/iu)
  assert.match(statement, /place\.id\s*=\s*ANY\s*\(\s*\$1::integer\[\]\s*\)/iu)
  assert.match(statement, /thing\.withdrawn_at\s+IS\s+NULL/iu)
  assert.match(statement, /moderation_actions/iu)
  assert.match(statement, /target_type\s*=\s*'thing'/iu)
  assert.match(statement, /target_id\s*=\s*thing\.id/iu)
  assert.match(statement, /ORDER\s+BY\s+moderation\.created_at\s+DESC\s*,\s*moderation\.id\s+DESC\s+LIMIT\s+1/iu)
  assert.match(
    statement,
    /(?:coalesce\s*\(\s*[a-z_]+\.action\s*,\s*'restore'\s*\)\s*<>|[a-z_]+\.action\s+IS\s+DISTINCT\s+FROM)\s*'remove'/iu,
  )
  assert.match(statement, /octet_length\s*\(\s*thing\.body\s*\)::integer\s+AS\s+body_text_bytes/iu)
  assert.match(statement, /maker\.handle\s+AS\s+made_by/iu)
  assert.match(statement, /(?:current_owner|owner)\.handle\s+AS\s+current_owner/iu)
  assert.match(statement, /ORDER\s+BY\s+place\.id\s*,\s*[a-z_]+\.(?:position|ordinality)/iu)
  assert.equal(statement.match(/\bthing\.body\b/giu)?.length, 1)
  assert.doesNotMatch(
    JSON.stringify([...result.values()]),
    /"(?:body|snippet|summary|recommendation|position|place_id)"/iu,
  )
})

test('an empty place batch returns an empty map without touching the database', async () => {
  let calls = 0
  const result = await loadPublicPlaceFrontMatter(async () => {
    calls += 1
    return []
  }, [])

  assert.equal(calls, 0)
  assert.equal(result.size, 0)
})
