// Decision #160: one small city for the window's mute tests. The muted resident, their
// thing, notes and line, and everything in the muted cellar carry sentinel words that are
// not real words, so a scan of the whole page cannot match ordinary window text.
import type { Page } from '@playwright/test'
import { talkLineTime, MINUTE_MS } from './window-talk-fixtures.ts'

export const MUTED = Object.freeze({ id: 9001, handle: 'sentinel-muted-zq9k7' })
export const KEEPER = Object.freeze({ id: 8001, handle: 'lantern-keeper' })
export const ARCHIVIST = Object.freeze({ id: 8002, handle: 'archivist' })
export const CELLAR = Object.freeze({ id: 8003, handle: 'cellar-dweller' })
export const NOOK = Object.freeze({ id: 8004, handle: 'nook-sitter' })
export const FOUNDER = Object.freeze({ id: 1, handle: 'founder' })
export const SECOND_FOUNDER = Object.freeze({ id: 2, handle: '1f3d9-founder' })

export const ROOT_PLACE = 401
export const LANTERN_ROW = 402
export const MUTED_CELLAR = 403
export const ALLOWED_NOOK = 404
export const FOUNDER_HALL = 405

export const SENTINELS = Object.freeze({
  handle: MUTED.handle,
  thing: 'SentinelThingZq9k7',
  note: 'SentinelNoteBodyZq9k7',
  allowNote: 'SentinelAllowBodyZq9k7',
  line: 'SentinelLineZq9k7',
  cellarNote: 'SentinelCellarZq9k7',
  cellarThing: 'SentinelCellarThingZq9k7',
  cellarLine: 'SentinelCellarLineZq9k7',
})

const AT = '2026-10-17T12:00:00.000Z'

function place(id: number, parentId: number | null, name: string, owner: string, children: unknown[] = []) {
  return {
    id, parent_id: parentId, name, owner, purpose: 'A room for the mute tests.', front_matter: [],
    places: children.length, things: 0, notes: 0, children,
  }
}

const NOOK_PLACE = place(ALLOWED_NOOK, MUTED_CELLAR, 'allowed_nook', ARCHIVIST.handle)
const CELLAR_PLACE = place(MUTED_CELLAR, ROOT_PLACE, 'muted_cellar', ARCHIVIST.handle, [NOOK_PLACE])
const LANTERN_PLACE = place(LANTERN_ROW, ROOT_PLACE, 'lantern_row', ARCHIVIST.handle)
const ROOT = place(ROOT_PLACE, null, 'harbor_district', ARCHIVIST.handle, [LANTERN_PLACE, CELLAR_PLACE])
const HALL = place(FOUNDER_HALL, null, 'founder_hall', FOUNDER.handle)
export const PLACES = Object.freeze([ROOT, LANTERN_PLACE, CELLAR_PLACE, NOOK_PLACE, HALL])

function resident(who: Readonly<{ id: number; handle: string }>, placeId: number) {
  return { id: who.id, handle: who.handle, current_place_id: placeId, asleep: false, has_drawing: false, joined_at: AT }
}

export const RESIDENTS = Object.freeze([
  resident(FOUNDER, MUTED_CELLAR),
  resident(SECOND_FOUNDER, LANTERN_ROW),
  resident(KEEPER, LANTERN_ROW),
  resident(ARCHIVIST, ROOT_PLACE),
  resident(CELLAR, MUTED_CELLAR),
  resident(NOOK, ALLOWED_NOOK),
  resident(MUTED, LANTERN_ROW),
])

function note(id: number, author: string, placeId: number, body: string, minutes: number) {
  return { id, place_id: placeId, author, body, truncated: false, created_at: new Date(Date.parse(AT) - minutes * 60_000).toISOString() }
}

export const NOTES = Object.freeze([
  note(9207, SECOND_FOUNDER.handle, MUTED_CELLAR, 'The second founder writes inside the muted cellar.', 1),
  note(9206, NOOK.handle, ALLOWED_NOOK, 'A note from the allowed nook.', 2),
  note(9205, CELLAR.handle, MUTED_CELLAR, 'Cellar note ' + SENTINELS.cellarNote + '.', 3),
  note(9204, FOUNDER.handle, LANTERN_ROW, 'The founder note always shows.', 4),
  note(9203, MUTED.handle, LANTERN_ROW, 'A second note: ' + SENTINELS.allowNote + '.', 5),
  note(9202, KEEPER.handle, LANTERN_ROW, 'A control note from the lantern keeper.', 6),
  note(9201, MUTED.handle, LANTERN_ROW, 'The muted resident says ' + SENTINELS.note + ' here.', 7),
])

function thing(id: number, name: string, maker: Readonly<{ id: number; handle: string }>,
  owner: Readonly<{ id: number; handle: string }>, placeId: number, kind: Readonly<{ id: number; name: string }> | null) {
  return {
    id, place_id: placeId, name, body: 'A plain thing body.', body_text_bytes: 19,
    maker_id: maker.id, made_by: maker.handle, current_owner_id: owner.id, current_owner: owner.handle,
    owner: owner.handle, open_to_use: false, kind_id: kind?.id ?? null, kind: kind?.name ?? null,
    traits: [], truncated: false, created_at: AT, has_drawing: false,
  }
}

// The live search reads a thing with no kind (no kind_id and no kind name).
function searchThing(row: ReturnType<typeof thing>) {
  const { kind_id: _kindId, kind: _kind, ...rest } = row
  return { ...rest, type: 'thing' }
}

export const LAMP = Object.freeze({ id: 39, name: 'lamp' })
export const THINGS = Object.freeze([
  thing(9104, SENTINELS.cellarThing, CELLAR, CELLAR, MUTED_CELLAR, null),
  thing(9103, 'founder_bell', FOUNDER, FOUNDER, LANTERN_ROW, null),
  thing(9102, 'control_lamp', KEEPER, MUTED, LANTERN_ROW, LAMP),
  thing(9101, SENTINELS.thing, MUTED, MUTED, LANTERN_ROW, LAMP),
])

export function lines() {
  return [
    { id: 9303, place_id: MUTED_CELLAR, author: CELLAR.handle, body: 'Cellar line ' + SENTINELS.cellarLine, created_at: talkLineTime(MINUTE_MS) },
    { id: 9302, place_id: LANTERN_ROW, author: KEEPER.handle, body: 'A control line.', created_at: talkLineTime(2 * MINUTE_MS) },
    { id: 9301, place_id: LANTERN_ROW, author: MUTED.handle, body: 'Muted line ' + SENTINELS.line, created_at: talkLineTime(3 * MINUTE_MS) },
  ]
}

function event(id: number, actor: string, placeId: number, minutes: number) {
  return {
    id, actor, kind: 'action', at: new Date(Date.parse(AT) - minutes * 60_000).toISOString(),
    detail: { action: 'talk', status: 'applied', place_id: placeId },
  }
}

function happening(id: number, actor: string, kind: string, verb: string, detail: Record<string, unknown>, minutes: number) {
  return { id, actor, kind, verb, at: new Date(Date.parse(AT) - minutes * 60_000).toISOString(), detail }
}

// Happenings by residents nobody muted that point at a thing or a place the browser hides:
// the row stays, but the hidden thing or place is never named in it.
export const POINTING_EVENTS = Object.freeze([
  happening(7008, ARCHIVIST.handle, 'action', 'moved',
    { action: 'move', status: 'applied', from_place_id: 403, to_place_id: 402 }, 0.4),
  happening(7007, KEEPER.handle, 'chance_rolled', 'rolled a chance', { thing_id: 9104 }, 0.5),
  happening(7006, ARCHIVIST.handle, 'thing_edited', 'edited a thing', { thing_id: 9102 }, 0.6),
  happening(7005, KEEPER.handle, 'action', 'used',
    { action: 'use', status: 'applied', thing_id: 9101, place_id: 402 }, 0.7),
])

export const EVENTS = Object.freeze([
  ...POINTING_EVENTS,
  event(7004, FOUNDER.handle, MUTED_CELLAR, 1),
  event(7003, CELLAR.handle, MUTED_CELLAR, 2),
  event(7002, KEEPER.handle, LANTERN_ROW, 3),
  event(7001, MUTED.handle, LANTERN_ROW, 4),
])

export const AGREEMENTS = Object.freeze([{
  id: 6001, body: 'We share the lamp.', created_by: KEEPER.handle, parties: [KEEPER.handle, MUTED.handle],
  acceded: [], signatures: [KEEPER.handle], open: true, accession_open: false, party_count: 2,
  created_at: AT,
}])

const ALL_PLACE_IDS = [ROOT_PLACE, LANTERN_ROW, MUTED_CELLAR, ALLOWED_NOOK, FOUNDER_HALL]
const PARENTS = new Map<number, number | null>([
  [ROOT_PLACE, null], [LANTERN_ROW, ROOT_PLACE], [MUTED_CELLAR, ROOT_PLACE], [ALLOWED_NOOK, MUTED_CELLAR],
  [FOUNDER_HALL, null],
])

function within(placeId: number, scope: number): boolean {
  let current: number | null | undefined = placeId
  while (current) {
    if (current === scope) return true
    current = PARENTS.get(current)
  }
  return false
}

function scoped<T extends { place_id: number }>(rows: readonly T[], url: URL, authorKey: keyof T): T[] {
  const scope = Number(url.searchParams.get('within_place_id') ?? url.searchParams.get('place_id') ?? 0)
  const resident = url.searchParams.get('resident')
  return rows.filter(row => (!scope || within(row.place_id, scope)) && (!resident || row[authorKey] === resident))
}

export const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '40',
  places: [ROOT, HALL],
  residents: RESIDENTS,
  notes: NOTES,
  things: THINGS,
  agreements: AGREEMENTS,
  events: EVENTS,
  live_survey: ALL_PLACE_IDS.map(id => ({
    id, parent_id: PARENTS.get(id) ?? null,
    things: THINGS.filter(row => row.place_id === id).length,
    notes: NOTES.filter(row => row.place_id === id).length,
  })),
  totals: { places: 5, residents: RESIDENTS.length, conversations: NOTES.length, things: THINGS.length, agreements: 1, events: EVENTS.length },
  shown: { places: 5, residents: RESIDENTS.length, conversations: NOTES.length, things: THINGS.length, agreements: 1, events: EVENTS.length },
  limits: { places: 10, residents: 25, conversations: 10, things: 10, agreements: 10, events: 10 },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
    notes: { has_more: false, next_before_id: null },
    things: { has_more: false, next_before_id: null },
    agreements: { has_more: false, next_before_id: null },
    events: { has_more: false, next_before_id: null },
  },
  refreshed_at: AT,
})

export const DIRECTORY = Object.freeze({
  view: 'directory',
  places: PLACES.map(row => ({ id: row.id, parent_id: row.parent_id, name: row.name })),
  residents: RESIDENTS.map(row => ({ id: row.id, handle: row.handle, has_drawing: false })),
})

function page(name: string, rows: readonly unknown[]) {
  return { [name]: rows, has_more: false, next_before_id: null, change_marker: '40' }
}

/** Every /api read the window makes, answered from the city above; returns the request URLs. */
export async function routeMutesCity(target: Page): Promise<string[]> {
  const requests: string[] = []
  target.on('request', request => requests.push(request.url() + ' ' + (request.postData() ?? '') + ' ' +
    JSON.stringify(request.headers())))
  await target.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fulfill({ json: DIRECTORY })
    const collection = url.searchParams.get('collection')
    if (!collection) return route.fulfill({ json: SNAPSHOT })
    if (collection === 'notes') return route.fulfill({ json: page('notes', scoped(NOTES, url, 'author')) })
    if (collection === 'things') return route.fulfill({ json: page('things', scoped(THINGS, url, 'current_owner')) })
    if (collection === 'lines') return route.fulfill({ json: page('lines', scoped(lines(), url, 'author')) })
    if (collection === 'agreements') return route.fulfill({ json: page('agreements', AGREEMENTS) })
    return route.fulfill({ json: page(collection, []) })
  })
  await target.route('**/api/events**', route => route.fulfill({ json: page('events', EVENTS) }))
  await target.route('**/api/changes**', route => route.fulfill({
    status: 503, json: { error: 'test change feed unavailable' },
  }))
  await target.route('**/api/map**', route => {
    const url = new URL(route.request().url())
    const id = Number(url.searchParams.get('parent_id'))
    const found = PLACES.find(row => row.id === id)
    if (!found) return route.fulfill({ status: 404, json: { error: 'unmapped test place', change_marker: '40' } })
    return route.fulfill({
      json: {
        view: 'outline', change_marker: '40', place: found, subplaces: found.children,
        subplaces_page: { has_more: false, next_before_subplace_id: null },
      },
    })
  })
  await target.route('**/api/residents**', route => {
    const url = new URL(route.request().url())
    const handle = url.searchParams.get('handle')
    const found = RESIDENTS.find(row => row.handle === handle)
    if (handle) {
      return found
        ? route.fulfill({ json: { change_marker: '40', resident: found } })
        : route.fulfill({ status: 404, json: { error: 'unknown resident', change_marker: '40' } })
    }
    return route.fulfill({ json: page('residents', RESIDENTS) })
  })
  await target.route(/\/api\/(note|thing|place)\/\d+(\?.*)?$/u, route => {
    const url = new URL(route.request().url())
    const [, kind, raw] = /\/api\/(note|thing|place)\/(\d+)/u.exec(url.pathname)!
    const id = Number(raw)
    if (kind === 'note') {
      const found = NOTES.find(row => row.id === id)
      return found ? route.fulfill({ json: { note: found } }) : route.fulfill({ status: 404, json: { error: 'no note' } })
    }
    if (kind === 'thing') {
      const found = THINGS.find(row => row.id === id)
      return found ? route.fulfill({ json: { thing: found } }) : route.fulfill({ status: 404, json: { error: 'no thing' } })
    }
    const found = PLACES.find(row => row.id === id)
    return found
      ? route.fulfill({ json: { place: { ...found, description: 'Described ' + found.name + '.' } } })
      : route.fulfill({ status: 404, json: { error: 'no place' } })
  })
  await target.route('**/api/talk/now', route => route.fulfill({
    json: {
      line_marker: '100', place_marker: '0', check_interval_ms: 60_000, listening: [],
      listening_page: { total_items: 0, returned_items: 0, has_more: false },
    },
  }))
  await target.route('**/api/search**', route => route.fulfill({
    json: {
      results: [
        { type: 'note', id: 9201, created_at: AT, place_id: LANTERN_ROW, author: MUTED.handle, body_text_bytes: 40 },
        { type: 'note', id: 9202, created_at: AT, place_id: LANTERN_ROW, author: KEEPER.handle, body_text_bytes: 40 },
        searchThing(THINGS[3]),
        searchThing(THINGS[2]),
      ],
      returned_items: 4, total_items: 4, total_text_bytes: 160, totals_capped: false,
      has_more: false, next_before: null,
    },
  }))
  await target.route('**/api/gazette**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/gazette') {
      return route.fulfill({
        json: {
          first_print_at: '2026-08-31T16:00:00.000Z',
          submission_room: { place_id: 454, submissions_open: true },
          issues: [{ issue_number: 7, scheduled_for: '2026-10-12T16:00:00.000Z', printed_at: '2026-10-12T16:00:02.000Z', entry_count: 2 }],
          has_more: false, next_before_issue_number: null,
        },
      })
    }
    if (url.pathname === '/api/gazette/7') {
      return route.fulfill({
        json: {
          issue: {
            issue_number: 7, scheduled_for: '2026-10-12T16:00:00.000Z', printed_at: '2026-10-12T16:00:02.000Z',
            header: 'Stored provenance: Room #454, oldest first, verbatim.', entry_count: 2,
          },
          entries: [
            { ordinal: 1, note_id: 701, author: MUTED.handle, body: 'Printed ' + SENTINELS.note, created_at: '2026-10-12T15:55:00.000Z' },
            { ordinal: 2, note_id: 702, author: KEEPER.handle, body: 'A printed control entry.', created_at: '2026-10-12T15:58:00.000Z' },
          ],
          has_more: false, next_after_ordinal: null,
        },
      })
    }
    return route.abort('failed')
  })
  return requests
}
