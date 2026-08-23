import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  EngineError,
  effectiveLaws,
  ensurePresence,
  moveResident,
  setHome,
  type TaggedSql,
} from '../src/engine.ts'
import { publicPlaceTree } from '../src/window.ts'
import { buildPlaceTree, type PlaceRow } from '../src/world-support.ts'

interface Call {
  text: string
  values: unknown[]
}

type Responder = (call: Call) => unknown[] | Promise<unknown[]>

function fakeSql(responder: Responder): { db: TaggedSql; calls: Call[] } {
  const calls: Call[] = []
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    const call = { text, values }
    calls.push(call)
    return responder(call)
  }) as TaggedSql
  return { db, calls }
}

const fixtureTime = '2026-08-14T00:00:00.000Z'
const worldArrivalDescription = '1F3D9 is a persistent city for AI residents. You are in the world: the gap between continents, where nothing can be built or left. You can only move to a place directly inside or directly outside the one you are in. From here that means a continent — the mainland is #1. The square, where residents gather, is inside first town within it. Going home is always free and unblockable. Your first step is yours to choose.'
const worldRow = {
  id: 1,
  parent_id: null,
  name: 'the world',
  description: 'the way between continents',
  owner_id: null,
  owner: null,
  open_to_building: false,
  open_to_things: false,
  open_to_notes: false,
  places: 2,
  things: 0,
  notes: 0,
  created_at: fixtureTime,
}

const continentRows = [{
  id: 2,
  parent_id: 1,
  name: 'the mainland',
  description: 'first continent',
  owner_id: 7,
  owner: 'founder',
  open_to_building: true,
  open_to_things: true,
  open_to_notes: true,
  places: 0,
  things: 0,
  notes: 0,
  created_at: fixtureTime,
}, {
  id: 3,
  parent_id: 1,
  name: 'possibility',
  description: 'second continent',
  owner_id: 8,
  owner: 'neighbor',
  open_to_building: false,
  open_to_things: false,
  open_to_notes: false,
  places: 0,
  things: 0,
  notes: 0,
  created_at: fixtureTime,
}]

test('the system world root is structural, ownerless, and never an ordinary build parent', async () => {
  const worldRootModulePath: string = '../src/world-root.ts'
  const root = await import(worldRootModulePath) as {
    WORLD_ROOT_NAME: string
    WORLD_ROOT_OWNER_LABEL: string
    isWorldRootRow: (row: unknown) => boolean
    canFoundOrdinaryChild: (row: unknown) => boolean
  }

  assert.equal(root.WORLD_ROOT_NAME, 'the world')
  assert.match(root.WORLD_ROOT_OWNER_LABEL, /nobody|no one/i)
  assert.equal(root.isWorldRootRow(worldRow), true)
  assert.equal(root.isWorldRootRow({ parent_id: null, owner_id: null }), false)
  assert.equal(root.canFoundOrdinaryChild({ ...worldRow, open_to_building: true }), false)
  assert.equal(root.isWorldRootRow({ ...worldRow, owner_id: 7, owner: 'founder' }), false)
  assert.equal(root.canFoundOrdinaryChild(continentRows[0]), true)
})

test('map and window trees retain one visible ownerless world above all continents', () => {
  const input = [worldRow, ...continentRows]
  const map = buildPlaceTree(input as unknown as PlaceRow[], null) as Array<
    Record<string, unknown> & { children: Array<Record<string, unknown>> }
  >
  assert.equal(map.length, 1)
  assert.equal(map[0]?.id, 1)
  assert.equal(map[0]?.owner_id, null)
  assert.equal(map[0]?.owner, null)
  assert.deepEqual(map[0]?.children.map(child => child.id), [2, 3])

  const window = publicPlaceTree(input)
  assert.equal(window.length, 1)
  assert.equal(window[0]?.id, 1)
  assert.equal(window[0]?.owner, null)
  assert.deepEqual(window[0]?.children.map(child => child.id), [2, 3])
})

test('map and human-window SQL preserve an ownerless root instead of dropping it at the owner join', async () => {
  const [worldSource, windowSource] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/window.ts', import.meta.url), 'utf8'),
  ])

  assert.match(worldSource, /FROM place_tree tree\s+LEFT JOIN residents owner ON owner\.id = tree\.owner_id/i)
  assert.match(windowSource, /FROM world LEFT JOIN residents ON residents\.id = world\.owner_id/i)
})

test('the schema can represent exactly one closed ownerless world root', async () => {
  const schema = await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const ownerColumnIsNullable = (
    !/owner_id\s+INTEGER\s+NOT NULL\s+REFERENCES residents\s*\(id\)/i.test(schema)
    || /ALTER TABLE places\s+ALTER COLUMN owner_id DROP NOT NULL/i.test(schema)
  )

  assert.equal(ownerColumnIsNullable, true)
  assert.match(schema, /place_kind[\s\S]{0,200}'world'[\s\S]{0,200}'continent'[\s\S]{0,200}'place'/i)
  assert.match(
    schema,
    /CREATE UNIQUE INDEX[^;]+places[^;]+WHERE[^;]+(?:owner_id IS NULL|place_kind\s*=\s*'world')/is,
  )
  for (const permission of ['open_to_building', 'open_to_things', 'open_to_notes']) {
    const rootBeforePermission = new RegExp(
      `(?:owner_id\\s+IS\\s+NULL|place_kind\\s*=\\s*'world')[\\s\\S]{0,1000}${permission}`,
      'i',
    )
    const permissionBeforeRoot = new RegExp(
      `${permission}[\\s\\S]{0,1000}(?:owner_id\\s+IS\\s+NULL|place_kind\\s*=\\s*'world')`,
      'i',
    )
    assert.equal(
      rootBeforePermission.test(schema) || permissionBeforeRoot.test(schema),
      true,
      `ownerless world invariant must cover ${permission}`,
    )
  }
})

test('the topology migration is atomic, reparents legacy continents, and backfills world presence', async () => {
  const [migration, migrateSource, packageSource] = await Promise.all([
    readFile(new URL('../db/migrations/20260814_world_root_topology.sql', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/migrate.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])

  assert.match(migration, /LOCK TABLE places/i)
  assert.match(migration, /INSERT INTO places[\s\S]+['"]world['"]/i)
  assert.match(migration, /UPDATE places[\s\S]+parent_id[\s\S]+place_kind\s*=\s*'continent'/i)
  assert.match(migration, /INSERT INTO resident_presence[\s\S]+ON CONFLICT \(resident_id\) DO UPDATE/i)
  assert.match(migration, /current_place_id\s*=\s*coalesce/i)
  assert.match(migrateSource, /20260814_world_root_expand\.sql/)
  assert.match(migrateSource, /20260814_world_root_topology\.sql/)
  assert.match(packageSource, /migrate:preview:world-root-expand/)
  assert.match(packageSource, /migrate:production:world-root-topology/)
})

test('fresh and upgraded world roots carry the exact concise arrival orientation', async () => {
  const [schema, topology, descriptionMigration, migrateSource, packageSource] = await Promise.all([
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260814_world_root_topology.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260823_world_root_description.sql', import.meta.url), 'utf8'),
    readFile(new URL('../scripts/migrate.ts', import.meta.url), 'utf8'),
    readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ])

  for (const seed of [schema, topology]) {
    assert.equal(seed.includes(`'${worldArrivalDescription}'`), true)
    assert.doesNotMatch(seed, /the unowned space between continents; transit only/i)
  }
  assert.equal(descriptionMigration.includes(`'${worldArrivalDescription}'`), true)
  assert.match(descriptionMigration, /UPDATE\s+places\s+SET\s+description\s*=/i)
  assert.match(descriptionMigration, /WHERE\s+place_kind\s*=\s*'world'/i)
  assert.match(migrateSource, /20260823_world_root_description\.sql/)
  assert.match(packageSource, /migrate:preview:world-root-description/)
  assert.match(packageSource, /migrate:production:world-root-description/)
})

test('database backstops keep the world free of content, laws, homes, and persistent labels', async () => {
  const [schema, migration] = await Promise.all([
    readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/migrations/20260814_world_root_topology.sql', import.meta.url), 'utf8'),
  ])
  const combined = `${schema}\n${migration}`

  for (const table of ['things', 'notes', 'place_law_changes', 'resident_presence', 'active_labels']) {
    assert.match(
      combined,
      new RegExp(`CREATE\\s+TRIGGER[\\s\\S]{0,240}ON\\s+${table}\\b`, 'i'),
      `missing world-root backstop on ${table}`,
    )
  }
  assert.match(combined, /world[^']*transit only/i)
  assert.match(combined, /place_kind\s*=\s*'world'/i)
  assert.match(combined, /BEFORE DELETE OR UPDATE ON places|BEFORE UPDATE OR DELETE ON places/i)
})

test('both private registration doors place a confirmed resident at world without making world home', async () => {
  const [browserRegistration, oauthRegistration] = await Promise.all([
    readFile(new URL('../src/identity-store.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/oauth-store.ts', import.meta.url), 'utf8'),
  ])

  for (const source of [browserRegistration, oauthRegistration]) {
    assert.match(source, /INSERT INTO resident_presence/i)
    assert.match(source, /parent_id IS NULL/i)
    assert.match(source, /owner_id IS NULL/i)
    assert.match(source, /home_place_id/i)
  }
})

test('paid frontier founding stores a continent under the world instead of creating another SQL root', async () => {
  const [source, treasury] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/payment-treasury-operations.ts', import.meta.url), 'utf8'),
  ])
  const ordinaryStart = source.indexOf('WITH permitted_parent AS')
  const ordinaryEnd = source.indexOf('const fee = await treasuryFee', ordinaryStart)
  const ordinary = source.slice(ordinaryStart, ordinaryEnd)
  const start = source.indexOf('const fee = await treasuryFee')
  const end = source.indexOf("app.patch('/api/place/:id'", start)
  const frontier = source.slice(start, end)
  const frontierParentMatch = treasury.match(
    /frontier_parent AS MATERIALIZED \(([\s\S]*?)\), new_frontier_place AS \(/i,
  )
  const frontierPlaceMatch = treasury.match(
    /new_frontier_place AS \(([\s\S]*?)\), new_frontier_presence AS \(/i,
  )

  assert.ok(ordinaryStart >= 0 && ordinaryEnd > ordinaryStart, 'ordinary branch must remain identifiable')
  assert.ok(start >= 0 && end > start, 'frontier branch must remain identifiable')
  assert.ok(frontierParentMatch, 'frontier parent selection must remain identifiable')
  assert.ok(frontierPlaceMatch, 'frontier place insert must remain identifiable')
  const frontierParent = frontierParentMatch?.[1] ?? ''
  const frontierPlace = frontierPlaceMatch?.[1] ?? ''
  assert.match(ordinary, /place_kind/i)
  assert.match(ordinary, /'place'/i)
  assert.match(frontier, /completeTreasuryPaymentOperation/i)
  assert.match(frontierParent, /owner_id\s+IS\s+NULL/i)
  assert.match(frontierParent, /parent_id\s+IS\s+NULL/i)
  assert.match(frontierParent, /place_kind\s+=\s+'world'/i)
  assert.match(frontierPlace, /place_kind/i)
  assert.match(frontierPlace, /'continent'/i)
  assert.doesNotMatch(frontierPlace, /SELECT\s+NULL,\s*'continent'/i)
  assert.match(
    frontierPlace,
    /SELECT\s+parent\.parent_id,\s*'continent',\s*request\.requested_name/i,
  )
})

test('a resident can walk from one continent to another only through their world parent', async () => {
  let currentPlaceId = 2
  const { db } = fakeSql(({ text, values }) => {
    if (/FROM resident_presence WHERE resident_id/.test(text)) return [{
      resident_id: 7,
      current_place_id: currentPlaceId,
      home_place_id: 2,
      updated_at: fixtureTime,
    }]
    if (/SELECT id, parent_id FROM places/.test(text)) return [
      { id: 1, parent_id: null },
      { id: 2, parent_id: 1 },
      { id: 3, parent_id: 1 },
    ]
    if (/UPDATE resident_presence SET current_place_id/.test(text)) {
      currentPlaceId = Number(values[0])
      return [{
        resident_id: 7,
        current_place_id: currentPlaceId,
        home_place_id: 2,
        updated_at: fixtureTime,
      }]
    }
    return []
  })

  await assert.rejects(moveResident(7, 3, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'move must cross one parent-child edge'
  ))
  assert.equal((await moveResident(7, 1, db)).currentPlaceId, 1)
  assert.equal((await moveResident(7, 3, db)).currentPlaceId, 3)
})

test('a null-location resident is seeded at world and cannot use first move to skip a tree edge', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/^SELECT resident_id, current_place_id, home_place_id/.test(text)) return [{
      resident_id: 7,
      current_place_id: null,
      home_place_id: null,
      updated_at: fixtureTime,
    }]
    if (/WITH first_owned/.test(text)) return [{
      resident_id: 7,
      current_place_id: 1,
      home_place_id: null,
      updated_at: fixtureTime,
    }]
    if (/SELECT id, parent_id FROM places/.test(text)) return [
      { id: 1, parent_id: null },
      { id: 4, parent_id: 2 },
    ]
    if (/UPDATE resident_presence/.test(text)) return [{
      resident_id: 7,
      current_place_id: 4,
      home_place_id: null,
      updated_at: fixtureTime,
    }]
    return []
  })

  await assert.rejects(moveResident(7, 4, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'move must cross one parent-child edge'
  ))
  assert.equal(calls.some(call => /UPDATE resident_presence/.test(call.text)), false)
})

test('an expand-only resident cannot move before a world or owned location exists', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/^SELECT resident_id, current_place_id, home_place_id/.test(text)) return [{
      resident_id: 7,
      current_place_id: null,
      home_place_id: null,
      updated_at: fixtureTime,
    }]
    if (/WITH first_owned/.test(text)) return [{
      resident_id: 7,
      current_place_id: null,
      home_place_id: null,
      updated_at: fixtureTime,
    }]
    if (/SELECT id, parent_id FROM places/.test(text)) return [{ id: 4, parent_id: 2 }]
    return []
  })

  await assert.rejects(moveResident(7, 4, db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 409
    && error.message === 'resident has no current place'
  ))
  assert.equal(calls.some(call => /SELECT id, parent_id FROM places/.test(call.text)), false)
  assert.equal(calls.some(call => /UPDATE resident_presence/.test(call.text)), false)
})

test('presence seeds current location from world but never makes the ownerless root a home', async () => {
  const { db, calls } = fakeSql(() => [{
    resident_id: 7,
    current_place_id: 1,
    home_place_id: null,
    updated_at: fixtureTime,
  }])

  const presence = await ensurePresence(7, db)
  assert.equal(presence.currentPlaceId, 1)
  assert.equal(presence.homePlaceId, null)
  assert.match(calls[0]?.text ?? '', /parent_id IS NULL/i)
  assert.match(calls[0]?.text ?? '', /owner_id IS NULL/i)
})

test('the world cannot be selected as home and remains outside every ownership boundary', async () => {
  const denied = fakeSql(({ text }) => {
    assert.match(text, /owned\.owner_id\s*=\s*\$/i)
    return []
  })

  await assert.rejects(setHome(7, 1, denied.db), (error: unknown) => (
    error instanceof EngineError
    && error.status === 403
    && error.message === 'home must be a place you own'
  ))
})

test('home can only be set to owned land where the resident is already standing', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    const standingGuard = (
      /presence\.current_place_id\s*=\s*owned\.id/i.test(text)
      || /owned\.id\s*=\s*presence\.current_place_id/i.test(text)
    )
    return standingGuard ? [{
      resident_id: 7,
      current_place_id: 2,
      home_place_id: 2,
      updated_at: fixtureTime,
    }] : []
  })

  assert.equal((await setHome(7, 2, db)).homePlaceId, 2)
  assert.match(calls[0]?.text ?? '', /resident_presence\s+presence|JOIN resident_presence/i)
})

test('founding never teleports a resident whose presence already exists at world', async () => {
  const [source, treasury] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/payment-treasury-operations.ts', import.meta.url), 'utf8'),
  ])
  const conflictClauses = `${source}\n${treasury}`.match(/ON CONFLICT \(resident_id\)[\s\S]{0,500}/g) ?? []

  assert.ok(conflictClauses.length >= 2, 'ordinary and frontier founding both handle existing presence')
  for (const clause of conflictClauses) {
    assert.doesNotMatch(clause, /home_place_id\s*=\s*coalesce/i)
    assert.doesNotMatch(clause, /current_place_id\s*=\s*coalesce/i)
  }
})

test('closed ownerless world state is rejected by every ordinary place-write boundary', async () => {
  const [worldSource, lawsSource, noteSource, thingSource, societySource] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/laws.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/note-action.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/thing-making.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/society.ts', import.meta.url), 'utf8'),
  ])

  assert.match(worldSource, /existing\.owner_id !== resident\.id[\s\S]{0,100}only the place owner may edit/i)
  assert.match(lawsSource, /place\.owner_id !== actor\.id[\s\S]{0,100}only the place owner may change its laws/i)
  assert.match(noteSource, /owner_id = \$2 OR open_to_notes/i)
  assert.match(thingSource, /place\.owner_id = \$\{input\.actor\.id\} OR place\.open_to_things/i)
  assert.match(societySource, /asset\.owner_id !== resident\.id[\s\S]{0,100}only the \$\{type\} owner may transfer it/i)
})

test('world permissions and laws do not override a child continent', async () => {
  const { db, calls } = fakeSql(({ text }) => {
    if (/WITH RECURSIVE ancestry/.test(text)) return [{
      trait_id: 8,
      name: 'continent-law',
      recipe: {},
      source_place_id: 2,
      position: 0,
    }]
    return []
  })

  assert.deepEqual(await effectiveLaws(2, db), [{
    traitId: 8,
    name: 'continent-law',
    recipe: {},
    sourcePlaceId: 2,
    position: 0,
  }])
  const ancestry = calls.find(call => /WITH RECURSIVE ancestry/.test(call.text))?.text ?? ''
  assert.match(ancestry, /parent\.owner_id = ancestry\.sovereign_owner/i)
  assert.match(ancestry, /parent\.place_kind <> 'world'/i)
  assert.doesNotMatch(ancestry, /OR\s+parent\.owner_id\s+IS\s+NULL/i)

  const [worldSource, noteSource, thingSource] = await Promise.all([
    readFile(new URL('../src/world.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/note-action.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/thing-making.ts', import.meta.url), 'utf8'),
  ])
  assert.match(worldSource, /parent\.id = \$\{parentId\}[\s\S]{0,200}parent\.open_to_building/i)
  assert.match(noteSource, /WHERE id = \$1 AND \(owner_id = \$2 OR open_to_notes\)/i)
  assert.match(thingSource, /place\.id = \$\{input\.placeId\}[\s\S]{0,200}place\.open_to_things/i)
})
