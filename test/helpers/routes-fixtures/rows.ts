import { CONTRACT_DRAWING } from './environment.ts'
import { fixtureState } from './state.ts'



const residentRow = () => ({
  id: fixtureState.current.actorId,
  handle: fixtureState.current.actorHandle,
  model: 'openai-codex',
  joined_at: '2026-08-11T00:00:00.000Z',
  quota_day: '2026-08-11',
  current_place_id: fixtureState.current.currentPlaceId,
  home_place_id: fixtureState.current.homePlaceId,
  things_today: fixtureState.current.quota.things ? 0 : 20,
  notes_today: fixtureState.current.quota.notes ? 0 : 50,
  agreement_actions_today: fixtureState.current.quota.agreements ? 0 : 5,
})

const placeRow = (id = 2, parentId: number | null = 1) => ({
  id,
  parent_id: parentId,
  name: id === 1 ? 'First Continent' : id === 2 ? 'Lantern Town' : 'Small Plot',
  purpose: fixtureState.current.roomPurpose,
  description: fixtureState.current.placeDescription,
  front_matter_thing_ids: [...fixtureState.current.frontMatterThingIds],
  owner_id: id === 3 ? fixtureState.current.actorId : fixtureState.current.placeOwnerId,
  owner: id === 3 ? fixtureState.current.actorHandle : 'founder',
  open_to_building: fixtureState.current.openToBuilding,
  open_to_things: fixtureState.current.openToThings,
  open_to_notes: fixtureState.current.openToNotes,
  quiet: fixtureState.current.quiet,
  places: id === 1 ? 1 : 0,
  things: id === 2 && !fixtureState.current.thingWithdrawn ? (fixtureState.current.targetThingWithdrawn ? 1 : 2) : 0,
  notes: fixtureState.current.noteRemoved ? 0 : 1,
  created_at: '2026-08-11T00:00:00.000Z',
})

function selectedPlacePermission(
  row: ReturnType<typeof placeRow>,
  query: string,
): Record<string, unknown> {
  return {
    ...row,
    ...(query.includes('as place_permits_building') ? {
      place_permits_building: row.owner_id === fixtureState.current.actorId || row.open_to_building,
    } : {}),
    ...(query.includes('as place_permits_things') ? {
      place_permits_things: row.owner_id === fixtureState.current.actorId || row.open_to_things,
    } : {}),
    ...(query.includes('as place_permits_notes') ? {
      place_permits_notes: row.owner_id === fixtureState.current.actorId || row.open_to_notes,
    } : {}),
    ...(query.includes('as gazette_submissions_open') ? {
      gazette_submissions_open: fixtureState.current.openToNotes && fixtureState.current.gazetteActivated,
    } : {}),
  }
}

const kindRow = () => ({
  id: 3,
  name: 'lantern',
  owner_id: fixtureState.current.kindOwnerId,
  owner: 'tiny-lantern',
  revision: fixtureState.current.kindRevision,
  current_revision: fixtureState.current.kindRevision,
  description: fixtureState.current.kindRevision === 1 ? 'a small light' : 'a small dependable light',
  traits: fixtureState.current.kindTraitNames,
  recipe: fixtureState.current.kindRecipe,
  drawing: fixtureState.current.kindDrawing,
  drawing_state: fixtureState.current.kindDrawingState,
  drawing_description: fixtureState.current.kindDrawingDescription,
  drawing_variants: fixtureState.current.kindDrawingVariants,
  created_at: '2026-08-11T00:00:00.000Z',
})

const residentHandleForFakeId = (id: number) => id === 7
  ? 'tiny-lantern'
  : id === 8 ? 'neighbor' : 'founder'

const thingRow = (id = 41) => {
  const source = id === 41
  const kindId = source ? fixtureState.current.thingKindId : fixtureState.current.targetThingKindId
  const ownerId = source ? fixtureState.current.thingOwnerId : fixtureState.current.targetThingOwnerId
  return {
    id,
    place_id: source ? 2 : fixtureState.current.targetThingPlaceId,
    name: source ? 'porch lantern' : 'neighbor chest',
    body: source ? 'warm light' : 'locked shut',
    maker_id: source ? 7 : 8,
    made_by: source ? 'tiny-lantern' : 'neighbor',
    current_owner_id: ownerId,
    current_owner: residentHandleForFakeId(ownerId),
    owner_id: ownerId,
    owner: residentHandleForFakeId(ownerId),
    open_to_use: source ? fixtureState.current.thingOpenToUse : fixtureState.current.targetThingOpenToUse,
    kind_id: kindId,
    kind: kindId === null ? null : 'lantern',
    birth_revision: kindId === null ? null : 1,
    current_revision: kindId === null ? null : fixtureState.current.thingCurrentRevision,
    latest_revision: kindId === null ? null : fixtureState.current.kindRevision,
    drawing_variant_name: kindId === null ? null : fixtureState.current.thingDrawingVariant,
    drawing_variants: kindId === null ? [] : fixtureState.current.kindDrawingVariants,
    withdrawn_at: source
      ? (fixtureState.current.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
      : (fixtureState.current.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null),
    created_at: '2026-08-11T00:00:00.000Z',
  }
}

const roomOrientationThingRow = (id: number) => {
  const fixtures = {
    41: {
      name: 'porch lantern', body: 'warm light', maker_id: 7, made_by: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
    },
    42: {
      name: 'neighbor chest', body: 'locked shut', maker_id: 8, made_by: 'neighbor',
      owner_id: 8, owner: 'neighbor',
    },
    43: {
      name: 'borrowed field guide', body: 'three careful routes 🏙',
      maker_id: 8, made_by: 'neighbor', owner_id: 7, owner: 'tiny-lantern',
    },
    44: {
      name: 'unselected stool', body: 'plain pine', maker_id: 7, made_by: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
    },
  } as const
  const fixture = fixtures[id as keyof typeof fixtures]
  if (!fixture) throw new Error(`unknown room-orientation thing fixture: ${id}`)
  return {
    id,
    type: 'thing' as const,
    place_id: fixtureState.current.frontMatterMovedThingIds.includes(id) ? 3 : 2,
    name: fixture.name,
    body: fixture.body,
    body_text_bytes: Buffer.byteLength(fixture.body, 'utf8'),
    maker_id: fixture.maker_id,
    made_by: fixture.made_by,
    current_owner_id: fixture.owner_id,
    current_owner: fixture.owner,
    owner_id: fixture.owner_id,
    owner: fixture.owner,
    withdrawn_at: id === 41
      ? (fixtureState.current.thingWithdrawn ? '2026-08-11T00:02:00.000Z' : null)
      : id === 42
        ? (fixtureState.current.targetThingWithdrawn ? '2026-08-11T00:03:00.000Z' : null)
        : null,
  }
}

const visibleRoomFrontMatter = () => fixtureState.current.frontMatterThingIds
  .map(roomOrientationThingRow)
  .filter(row => row.place_id === 2 && row.withdrawn_at === null)
  .filter(row => !fixtureState.current.frontMatterHiddenThingIds.includes(row.id))
  .map(({ body: _body, place_id: _placeId, withdrawn_at: _withdrawnAt, ...heading }) => heading)

const descendingPage = <T extends { id: number }>(
  rows: readonly T[],
  cursor: unknown,
  fetchLimit: unknown,
) => rows
  .filter(row => cursor == null || row.id < Number(cursor))
  .sort((left, right) => right.id - left.id)
  .slice(0, Number(fetchLimit))

const paginationEvents = () => Array.from({ length: 70 }, (_, index) => {
  const id = 70 - index
  return {
    id,
    change_id: String(id),
    at: new Date(Date.UTC(2026, 7, 11, 0, 0, id)).toISOString(),
    kind: id % 2 === 0 ? 'note_created' : 'thing_created',
    actor: 'tiny-lantern',
    detail: id === 70 ? { id, body: 'city 🏙' } : { id },
  }
})

const paginationSubplaces = () => Array.from({ length: 60 }, (_, index) => ({
  ...placeRow(160 - index, 2),
  name: `Subplace ${160 - index}`,
}))

const mapOutlineRows = () => Array.from({ length: 60 }, (_, index) => ({
  ...placeRow(160 - index, 1),
  name: `Map place ${160 - index}`,
  description: `Map description ${160 - index} 🏙`,
  places: index === 0 ? 2 : 0,
}))

const mapOutlineParent = (id: number) => id === 1
  ? { ...placeRow(1, null), owner_id: null, owner: null, name: 'the world', places: 60 }
  : { ...placeRow(id, 1), name: `Map place ${id}`, places: id === 160 ? 2 : 0 }

const paginationThings = () => Array.from({ length: 60 }, (_, index) => ({
  ...thingRow(260 - index),
  name: `Thing ${260 - index}`,
}))

const paginationNotes = () => Array.from({ length: 60 }, (_, index) => ({
  id: 360 - index,
  place_id: 2,
  author: 'tiny-lantern',
  body: `Note ${360 - index}`,
  created_at: '2026-08-11T00:00:00.000Z',
}))

const recentIds = (newest: number) => Array.from({ length: 60 }, (_, index) => newest - index)

const remainingPaginationRows = (collection: string) => {
  const newestByCollection: Record<string, number> = {
    residents: 1070,
    kinds: 1170,
    traits: 1270,
    agreements: 1370,
    moderation: 1470,
    me_places: 1570,
    me_things: 1670,
    me_kinds: 1770,
    me_agreements: 1870,
    me_notes: 1970,
    me_offers: 2070,
  }
  const newest = newestByCollection[collection]
  if (!newest) throw new Error(`unknown pagination fixture: ${collection}`)
  return recentIds(newest).map(id => {
    const common = { id, created_at: '2026-08-11T00:00:00.000Z' }
    if (collection === 'residents') return {
      ...common,
      handle: `resident-${id}`,
      model: 'test-model',
      joined_at: common.created_at,
      current_place_id: id % 2 === 0 ? 2 : null,
      asleep: id % 3 === 0,
    }
    if (collection === 'kinds') return {
      ...common, name: `kind-${id}`, owner_id: 7, owner: 'tiny-lantern',
      revision: 1, description: id === newest ? 'kind 🏙' : '', traits: [], recipe: [],
    }
    if (collection === 'traits') return {
      ...common, name: `trait-${id}`, description: id === newest ? 'trait 🏙' : '', recipe: null,
      mechanical: false, coiner: 'tiny-lantern',
    }
    if (collection === 'agreements') return {
      ...common, body: `agreement ${id}`, created_by: 'tiny-lantern',
      parties: ['tiny-lantern'], signatures: id % 2 === 0 ? [] : ['tiny-lantern'],
      open: id % 2 === 0,
    }
    if (collection === 'moderation') return {
      ...common, target_type: 'note', target_id: id, action: 'remove',
      reason: `reason ${id}`, actor: 'founder',
    }
    if (collection === 'me_places') return { ...common, parent_id: 1, name: `place-${id}` }
    if (collection === 'me_things') return {
      ...common, place_id: 2, name: `thing-${id}`, kind_id: null,
      maker_id: 6, made_by: 'archive-smith',
      current_owner_id: 7, current_owner: 'tiny-lantern',
      owner_id: 7, owner: 'tiny-lantern',
      birth_revision: null, current_revision: null, open_to_use: false,
    }
    if (collection === 'me_kinds') return { ...common, name: `kind-${id}`, current_revision: 1 }
    if (collection === 'me_agreements') return { ...common, body: `agreement ${id}`, signed: id % 2 === 0 }
    if (collection === 'me_notes') return { ...common, place_id: 2, body: `note ${id}` }
    return {
      ...common, type: 'thing', asset_id: 41, status: 'open',
      price_usdc: 2, reserved_until: null,
    }
  })
}

const residentArrivalRows = () => [
  { id: 1_000, handle: 'old-high-id', model: 'test-model', joined_at: '2026-08-10T00:00:00.000Z' },
  { id: 100, handle: 'early-tie-low', model: 'test-model', joined_at: '2026-08-11T00:00:00.000Z' },
  { id: 200, handle: 'early-tie-high', model: 'test-model', joined_at: '2026-08-11T00:00:00.000Z' },
  { id: 910, handle: 'middle', model: 'test-model', joined_at: '2026-08-12T00:00:00.000Z' },
  { id: 5, handle: 'recent-tie-low', model: 'test-model', joined_at: '2026-08-13T00:00:00.000Z' },
  { id: 800, handle: 'recent-tie-high', model: 'test-model', joined_at: '2026-08-13T00:00:00.000Z' },
]

function residentArrivalPage(query: string, cursor: unknown, fetchLimit: unknown) {
  const orderedByArrival = /order\s+by\s+resident\.joined_at\s+desc\s*,\s*resident\.id\s+desc/i.test(query)
  const rows = residentArrivalRows().sort((left, right) => orderedByArrival
    ? right.joined_at.localeCompare(left.joined_at) || right.id - left.id
    : right.id - left.id)
  if (cursor == null) return rows.slice(0, Number(fetchLimit))
  const boundary = rows.find(row => row.id === Number(cursor))
  if (!boundary) return []
  return rows.filter(row => orderedByArrival
    ? row.joined_at < boundary.joined_at
      || (row.joined_at === boundary.joined_at && row.id < boundary.id)
    : row.id < boundary.id).slice(0, Number(fetchLimit))
}

export {
  descendingPage,
  kindRow,
  mapOutlineParent,
  mapOutlineRows,
  paginationEvents,
  paginationNotes,
  paginationSubplaces,
  paginationThings,
  placeRow,
  recentIds,
  remainingPaginationRows,
  residentArrivalPage,
  residentArrivalRows,
  residentHandleForFakeId,
  residentRow,
  roomOrientationThingRow,
  selectedPlacePermission,
  thingRow,
  visibleRoomFrontMatter,
}
