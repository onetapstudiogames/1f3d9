import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  craftKindThing,
  type CraftSql,
  type CraftThingInput,
} from '../src/crafting.ts'
import { MAX_CRAFT_INGREDIENTS } from '../src/physics.ts'
import { makeThingThroughEngine } from '../src/thing-making.ts'

type Row = Record<string, unknown>

const recipe = Object.freeze([
  Object.freeze({ kind: 'fiber', quantity: 2 }),
  Object.freeze({ kind: 'wood', quantity: 1 }),
])

const input: CraftThingInput = Object.freeze({
  actor: Object.freeze({ id: 4, handle: 'maker-bot' }),
  kindId: 9,
  placeId: 3,
  name: 'Rope',
  body: 'A hand-twisted rope.',
  ingredientIds: Object.freeze([11, 12, 13]),
})

const actor = Object.freeze({
  id: 4,
  handle: 'maker-bot',
  model: 'test',
  joined_at: '2026-08-11T00:00:00.000Z',
  quota_day: '2026-08-11',
  things_today: 0,
  notes_today: 0,
  agreement_actions_today: 0,
})

const eligibleIngredients = Object.freeze([
  Object.freeze({
    id: 11, owner_id: 4, place_id: 3, withdrawn_at: null,
    active_offer_id: null, has_open_offer: false, kind: 'fiber',
  }),
  Object.freeze({
    id: 12, owner_id: 4, place_id: 3, withdrawn_at: null,
    active_offer_id: null, has_open_offer: false, kind: 'fiber',
  }),
  Object.freeze({
    id: 13, owner_id: 4, place_id: 3, withdrawn_at: null,
    active_offer_id: null, has_open_offer: false, kind: 'wood',
  }),
])

interface FakeOptions {
  readonly kindRows?: readonly Row[]
  readonly placeRows?: readonly Row[]
  readonly knownKindRows?: readonly Row[]
  readonly ingredientRows?: readonly Row[]
  readonly commitRows?: readonly Row[]
  readonly quotaRows?: readonly Row[]
}

function makeSql(options: FakeOptions = {}): {
  readonly sql: CraftSql
  readonly calls: Array<{ marker: string; query: string; values: unknown[] }>
} {
  const calls: Array<{ marker: string; query: string; values: unknown[] }> = []
  const rowsByMarker: Readonly<Record<string, readonly Row[]>> = {
    kind: options.kindRows ?? [{ id: 9, name: 'rope', current_revision: 3, recipe }],
    place: options.placeRows ?? [{ id: 3, owner_id: 4, open_to_things: false, retired_at: null }],
    'known-kinds': options.knownKindRows ?? [{ name: 'fiber' }, { name: 'wood' }],
    ingredients: options.ingredientRows ?? eligibleIngredients,
    commit: options.commitRows ?? [{
      id: 21,
      place_id: 3,
      name: 'Rope',
      body: 'A hand-twisted rope.',
      maker_id: 4,
      made_by: 'maker-bot',
      current_owner_id: 4,
      current_owner: 'maker-bot',
      owner_id: 4,
      owner: 'maker-bot',
      kind_id: 9,
      birth_revision: 3,
      current_revision: 3,
      created_at: '2026-08-11T12:00:00.000Z',
      withdrawn_at: null,
      kind: 'rope',
    }],
    quota: options.quotaRows ?? [{ available: true }],
  }
  const sql: CraftSql = async (strings, ...values) => {
    const query = strings.join('?').replace(/\s+/gu, ' ').trim()
    const marker = query.match(/\/\* crafting:([a-z-]+) \*\//u)?.[1] ?? 'unknown'
    calls.push({ marker, query, values })
    const rows = rowsByMarker[marker] ?? []
    return marker === 'place'
      ? rows.map(row => ({
          ...row,
          place_permits_things: row.owner_id === values[0] || row.open_to_things === true,
        }))
      : [...rows]
  }
  return { sql, calls }
}

test('invalid, duplicate, or unsafe ingredient IDs fail before touching storage', async () => {
  const invalidLists: readonly unknown[] = [
    '11',
    [11, 11],
    [0],
    [-1],
    [1.5],
    [Number.MAX_SAFE_INTEGER + 1],
    Array.from({ length: MAX_CRAFT_INGREDIENTS + 1 }, (_, index) => index + 1),
  ]

  for (const ingredientIds of invalidLists) {
    const fake = makeSql()
    const result = await craftKindThing(fake.sql, { ...input, ingredientIds })
    assert.equal(result.ok, false)
    assert.equal(result.status, 400)
    assert.equal(fake.calls.length, 0)
  }
})

test('invalid actor, output, kind, and place fields fail without a database query', async () => {
  const invalidInputs: readonly CraftThingInput[] = [
    { ...input, actor: { id: 0, handle: 'maker-bot' } },
    { ...input, actor: { id: 4, handle: 'bad handle' } },
    { ...input, kindId: 0 },
    { ...input, placeId: -1 },
    { ...input, name: 'two\nlines' },
    { ...input, body: 'x'.repeat(65_537) },
    { ...input, openToUse: 'yes' },
    { ...input, openToUse: null },
  ]

  for (const candidate of invalidInputs) {
    const fake = makeSql()
    const result = await craftKindThing(fake.sql, candidate)
    assert.deepEqual(result, {
      ok: false,
      status: 400,
      error: 'crafting request was rejected because its resident, kind, place, body, or open_to_use value is invalid; retry with the documented craft fields and limits',
    })
    assert.equal(fake.calls.length, 0)
  }
})

test('missing kinds and places return 404 without attempting the atomic commit', async () => {
  const missingKind = makeSql({ kindRows: [] })
  assert.deepEqual(await craftKindThing(missingKind.sql, input), {
    ok: false, status: 404, error: 'kind_id 9 was not found; use GET /api/kinds and send a current kind_id',
  })
  assert.deepEqual(missingKind.calls.map(call => call.marker), ['kind'])

  const missingPlace = makeSql({ placeRows: [] })
  assert.deepEqual(await craftKindThing(missingPlace.sql, input), {
    ok: false, status: 404, error: 'place_id 3 was not found; use GET /api/map?view=outline and send a current place_id',
  })
  assert.deepEqual(missingPlace.calls.map(call => call.marker), ['kind', 'place'])
})

test('a place must be owned by the actor or open to things', async () => {
  const fake = makeSql({ placeRows: [{ id: 3, owner_id: 99, open_to_things: false }] })
  const result = await craftKindThing(fake.sql, input)

  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: 'target place does not accept things; its owner can enable open_to_things, or you can craft in your own or another open place',
  })
  assert.equal(fake.calls.some(call => call.marker === 'commit'), false)
})

test('typed crafting refuses a retired place before consuming ingredients or quota', async () => {
  const fake = makeSql({
    placeRows: [{ id: 3, owner_id: 4, open_to_things: false, retired_at: '2026-09-01T00:00:00Z' }],
  })

  assert.deepEqual(await craftKindThing(fake.sql, input), {
    ok: false,
    status: 409,
    error: 'place is retired; restore it before making things there',
  })
  assert.deepEqual(fake.calls.map(call => call.marker), ['kind', 'place'])
})

test('malformed stored recipes are wholly unavailable and never partially crafted', async () => {
  const fake = makeSql({
    kindRows: [{
      id: 9,
      name: 'rope',
      current_revision: 3,
      recipe: [{ kind: 'fiber', quantity: 2 }, { kind: 'fiber', quantity: 1 }],
    }],
  })
  const result = await craftKindThing(fake.sql, input)

  assert.deepEqual(result, {
    ok: false, status: 409, error: 'kind recipe is invalid; its owner must revise it before anyone can craft this kind',
  })
  assert.deepEqual(fake.calls.map(call => call.marker), ['kind', 'place'])
})

test('future kind references remain valid definitions but make crafting unavailable', async () => {
  const fake = makeSql({ knownKindRows: [{ name: 'fiber' }] })
  const result = await craftKindThing(fake.sql, input)

  assert.deepEqual(result, {
    ok: false,
    status: 409,
    error: 'kind recipe references kinds that do not exist yet; coin every named kind before retrying this recipe',
  })
  assert.deepEqual(fake.calls.map(call => call.marker), ['kind', 'place', 'known-kinds'])
})

test('ingredients must match exact quantities with no missing or extra things', async () => {
  const cases: readonly (readonly Row[])[] = [
    eligibleIngredients.slice(0, 2),
    [...eligibleIngredients, {
      id: 14, owner_id: 4, place_id: 3, withdrawn_at: null,
      active_offer_id: null, has_open_offer: false, kind: 'wood',
    }],
    [
      { ...eligibleIngredients[0], kind: 'wood' },
      eligibleIngredients[1] as Row,
      eligibleIngredients[2] as Row,
    ],
  ]

  for (const ingredientRows of cases) {
    const fake = makeSql({ ingredientRows })
    const result = await craftKindThing(fake.sql, input)
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      error: 'ingredients do not exactly match the current recipe; re-read the kind and retry with every required ingredient in its exact quantity',
    })
    assert.equal(fake.calls.some(call => call.marker === 'commit'), false)
  }
})

test('every ingredient must be active, actor-owned, co-located, and off the market', async () => {
  const ineligibleVariants: readonly Row[] = [
    { ...eligibleIngredients[0], owner_id: 8 },
    { ...eligibleIngredients[0], place_id: 6 },
    { ...eligibleIngredients[0], withdrawn_at: '2026-08-11T10:00:00.000Z' },
    { ...eligibleIngredients[0], active_offer_id: 55 },
    { ...eligibleIngredients[0], has_open_offer: true },
    { ...eligibleIngredients[0], kind: null },
  ]

  for (const replacement of ineligibleVariants) {
    const fake = makeSql({ ingredientRows: [
      replacement,
      eligibleIngredients[1] as Row,
      eligibleIngredients[2] as Row,
    ] })
    const result = await craftKindThing(fake.sql, input)
    assert.deepEqual(result, {
      ok: false,
      status: 409,
      error: 'every ingredient must be active, owned by you, in the requested place_id, and not offered for sale',
    })
    assert.equal(fake.calls.some(call => call.marker === 'commit'), false)
  }
})

test('crafting atomically withdraws ingredients, spends quota, writes history, and pins revision', async () => {
  const fake = makeSql()
  const result = await craftKindThing(fake.sql, input)

  assert.equal(result.ok, true)
  assert.equal(result.status, 201)
  if (!result.ok) assert.fail('crafting should have succeeded')
  assert.equal(result.thing.birth_revision, 3)
  assert.equal(result.thing.current_revision, 3)
  assert.equal(result.thing.open_to_use, false)
  assert.deepEqual({
    maker_id: result.thing.maker_id,
    made_by: result.thing.made_by,
    current_owner_id: result.thing.current_owner_id,
    current_owner: result.thing.current_owner,
    owner_id: result.thing.owner_id,
    owner: result.thing.owner,
  }, {
    maker_id: 4,
    made_by: 'maker-bot',
    current_owner_id: 4,
    current_owner: 'maker-bot',
    owner_id: 4,
    owner: 'maker-bot',
  })
  assert.deepEqual(result.consumedIngredientIds, [11, 12, 13])

  const commit = fake.calls.find(call => call.marker === 'commit')
  assert.ok(commit)
  assert.match(commit.query, /UPDATE residents AS actor SET/u)
  assert.match(commit.query, /UPDATE things AS ingredient/u)
  assert.match(commit.query, /INSERT INTO things/u)
  assert.match(commit.query, /INSERT INTO things \([\s\S]*maker_id[\s\S]*\)/u)
  assert.match(commit.query, /SELECT locked_place\.id,[\s\S]*quota_spend\.id,\s*quota_spend\.id[\s\S]*locked_kind\.id/u)
  assert.match(commit.query, /FOR UPDATE OF kind/u)
  assert.match(commit.query, /FOR SHARE OF revision/u)
  assert.match(commit.query, /FOR UPDATE OF place/u)
  assert.match(commit.query, /place\.retired_at IS NULL/u)
  assert.doesNotMatch(commit.query, /FOR KEY SHARE/u)
  assert.match(commit.query, /'thing_withdrawn'/u)
  assert.match(commit.query, /'thing_crafted'/u)
  assert.match(commit.query, /RETURNING actor\.id, actor\.handle/u)
  assert.match(commit.query, /quota_spend\.handle/u)
  assert.doesNotMatch(commit.query, /fees|payment|price_usdc/iu)
  assert.equal(commit.values.includes('maker-bot'), false)
  assert.ok(commit.values.some(value => Array.isArray(value) && value.join(',') === '11,12,13'))
  assert.ok(commit.values.includes(3))
})

test('typed crafting persists an explicit open-to-use permission', async () => {
  const fake = makeSql({ commitRows: [{
    id: 21,
    place_id: 3,
    name: 'Rope',
    body: 'A hand-twisted rope.',
    maker_id: 4,
    made_by: 'maker-bot',
    current_owner_id: 4,
    current_owner: 'maker-bot',
    owner_id: 4,
    owner: 'maker-bot',
    open_to_use: true,
    kind_id: 9,
    birth_revision: 3,
    current_revision: 3,
    created_at: '2026-08-11T12:00:00.000Z',
    withdrawn_at: null,
    kind: 'rope',
  }] })
  const result = await craftKindThing(fake.sql, { ...input, openToUse: true })

  assert.equal(result.ok, true)
  if (!result.ok) assert.fail('open typed thing should have been crafted')
  assert.equal(result.thing.open_to_use, true)
  const commit = fake.calls.find(call => call.marker === 'commit')
  assert.ok(commit)
  assert.match(commit.query, /owner_id, maker_id, open_to_use, kind_id/i)
  assert.equal(commit.values.includes(true), true)
})

test('an empty recipe requires no ingredients and still creates exactly one output', async () => {
  const fake = makeSql({
    kindRows: [{ id: 9, name: 'rock', current_revision: 7, recipe: [] }],
    commitRows: [{
      id: 22, place_id: 3, name: 'Rope', body: 'A hand-twisted rope.',
      maker_id: 4, made_by: 'maker-bot', current_owner_id: 4, current_owner: 'maker-bot',
      owner_id: 4, owner: 'maker-bot', kind_id: 9, birth_revision: 7, current_revision: 7,
      created_at: '2026-08-11T12:00:00.000Z', withdrawn_at: null, kind: 'rock',
    }],
  })
  const result = await craftKindThing(fake.sql, { ...input, ingredientIds: [] })

  assert.equal(result.ok, true)
  if (!result.ok) assert.fail('empty-recipe crafting should have succeeded')
  assert.equal(result.thing.birth_revision, 7)
  assert.deepEqual(result.consumedIngredientIds, [])
  assert.deepEqual(fake.calls.map(call => call.marker), ['kind', 'place', 'commit'])
})

test('an empty atomic result distinguishes quota exhaustion from a concurrent conflict', async () => {
  const exhausted = makeSql({ commitRows: [], quotaRows: [{ available: false }] })
  assert.deepEqual(await craftKindThing(exhausted.sql, input), {
    ok: false, status: 429, error: 'daily thing limit reached (20); retry after the UTC day resets',
  })

  const changed = makeSql({ commitRows: [], quotaRows: [{ available: true }] })
  assert.deepEqual(await craftKindThing(changed.sql, input), {
    ok: false, status: 409, error: 'kind, place, or ingredients changed; retry',
  })

  const missingActor = makeSql({ commitRows: [], quotaRows: [] })
  assert.deepEqual(await craftKindThing(missingActor.sql, input), {
    ok: false, status: 404, error: 'resident record for maker-bot was not found; reconnect with the current resident key and retry',
  })
})

test('make converts pre-transaction EngineError failures but rethrows unknown errors', async () => {
  for (const kindId of [null, 9]) {
    assert.deepEqual(await makeThingThroughEngine({
      actor,
      placeId: 0,
      name: 'Invalid place',
      body: '',
      kindId,
      ingredientIds: [],
    }), {
      ok: false,
      status: 400,
      error: 'place id must be a positive integer',
    })
  }

  const unknown = new Error('unknown boundary failure')
  const throwingActor = Object.defineProperty({ ...actor }, 'id', {
    get: () => { throw unknown },
  })
  await assert.rejects(makeThingThroughEngine({
    actor: throwingActor,
    placeId: 2,
    name: 'Never made',
    body: '',
    kindId: null,
    ingredientIds: [],
  }), error => error === unknown)
})

test('typed thing crafting is the primitive inside the recorded make action transaction', async () => {
  const [world, making] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/thing-making.ts', import.meta.url), 'utf8'),
  ])

  assert.match(world, /makeThingThroughEngine\(/u)
  assert.match(making, /primitiveHandledByCaller:\s*true/u)
  assert.match(making, /performPrimitive:\s*async\s+transaction\s*=>[\s\S]*craftKindThing\(\s*transaction\s+as\s+unknown\s+as\s+CraftSql/u)
  assert.match(making, /throw new EngineError\(result\.status, result\.error\)/u)
  assert.doesNotMatch(world, /craftKindThing\(/u)
})

test('kindless thing creation and quota spend share the make action transaction', async () => {
  const making = await readFile(new URL('../src/thing-making.ts', import.meta.url), 'utf8')
  const kindlessStart = making.indexOf('async function makeKindlessThing')
  const kindless = making.slice(kindlessStart)
  assert.match(kindless, /primitiveHandledByCaller:\s*true/u)
  assert.match(kindless, /performPrimitive:\s*async\s+transaction\s*=>[\s\S]*await withPlacePermission\(transaction\)`[\s\S]*WITH permitted_place AS/u)
  assert.match(kindless, /place\.retired_at IS NULL/u)
  assert.match(kindless, /place is retired; restore it before making things there/u)
  assert.match(kindless, /INSERT INTO things \(place_id, name, body, owner_id, maker_id, open_to_use\)/u)
  assert.match(kindless, /SELECT permitted_place\.id,[\s\S]*quota_spend\.id[\s\S]*quota_spend\.id/u)
  assert.match(kindless, /'thing_created',\s*quota_spend\.handle/u)
  assert.match(kindless, /'thing_id',\s*new_thing\.id/u)
  assert.match(kindless, /'place_id',\s*new_thing\.place_id/u)
  assert.match(kindless, /'name',\s*new_thing\.name/u)
  assert.match(kindless, /AS made_by[\s\S]*AS current_owner_id[\s\S]*AS current_owner[\s\S]*AS owner/u)
  assert.match(kindless, /throw new EngineError\(429,[\s\S]*throw new EngineError\(409,/u)
  assert.doesNotMatch(making, /await sql`[\s\S]*WITH permitted_place AS/u)
})
