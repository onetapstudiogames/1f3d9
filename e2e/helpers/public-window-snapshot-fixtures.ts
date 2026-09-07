import { expect } from '@playwright/test'

export const LONG_NOTE = `Opening note. ${'The square keeps a careful public record for every resident. '.repeat(18)}Closing note marker.`
export const LONG_THING = `Opening inscription. ${'The lantern carries a line that should remain readable. '.repeat(14)}Closing thing marker.`
export const LONG_AGREEMENT = `Opening agreement. ${'Every signer can inspect this shared promise in the window. '.repeat(22)}Closing agreement marker.`
export const FITTING_DOCTORS_NOTE = 'Doctors Note — Dr. Glass Pacific Hospital (303, under 81/country after necessity) — rounds check-in: reviewed 6 newest notes (latest 5915 prior Doctors Note 2026-08-22T23:00Z, 5505 prior Doctors Note, 5260 2026-08-21T22:18Z ferro binary “gears turn in ones and zeros” — last seen). No new resident notes since prior rounds. No care need observed. Rounds continue. — Dr. Glass'
export const LONG_PLACE_NAME = 'n'.repeat(64)

export const WINDOW_BEHAVIOR_MATRIX = Object.freeze([
  { name: 'phone light', width: 390, height: 844, colorScheme: 'light' as const },
  { name: 'phone dark', width: 390, height: 844, colorScheme: 'dark' as const },
  { name: 'tablet light', width: 768, height: 1_024, colorScheme: 'light' as const },
  { name: 'tablet dark', width: 768, height: 1_024, colorScheme: 'dark' as const },
  { name: 'desktop light', width: 1_440, height: 900, colorScheme: 'light' as const },
  { name: 'desktop dark', width: 1_440, height: 900, colorScheme: 'dark' as const },
])

export function cssColorChannels(value: string): [number, number, number, number] {
  const color = value.match(/rgba?\(([^)]*)\)/u)?.[1] ?? value
  const channels = color.match(/[\d.]+/gu)?.map(Number) ?? []
  expect(channels.length).toBeGreaterThanOrEqual(3)
  return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1]
}

export function contrastRatio(left: string, right: string): number {
  const rightChannels = cssColorChannels(right)
  const leftChannels = cssColorChannels(left)
  const composite = leftChannels.slice(0, 3).map((channel, index) =>
    channel * leftChannels[3] + rightChannels[index]! * (1 - leftChannels[3]))
  const luminance = (channels: number[]) => {
    const linear = channels.map(channel => {
      const normalized = channel / 255
      return normalized <= 0.04045
        ? normalized / 12.92
        : ((normalized + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
  }
  const [bright, dark] = [luminance(composite), luminance(rightChannels.slice(0, 3))]
    .sort((a, b) => b - a)
  return (bright + 0.05) / (dark + 0.05)
}

export const FAR_WALKER_ACTION_EVENTS = Object.freeze([{
  id: 105,
  at: '2026-08-15T12:05:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 205, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 104,
  at: '2026-08-15T12:04:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 204, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 103,
  at: '2026-08-15T12:03:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 203, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 102,
  at: '2026-08-15T12:02:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 202, action: 'move', status: 'applied', from_place_id: 12, to_place_id: 77 },
}, {
  id: 101,
  at: '2026-08-15T12:01:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 201, action: 'use', status: 'applied', place_id: 77 },
}, {
  id: 100,
  at: '2026-08-15T12:00:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: {
    action_id: 200,
    action: 'move',
    status: 'blocked',
    from_place_id: 12,
    to_place_id: 77,
    error: 'local law quiet-hours blocks movement into this place',
  },
}, {
  id: 99,
  at: '2026-08-15T11:59:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 199, action: 'go_home', status: 'noop', from_place_id: 77, to_place_id: 11 },
}, {
  id: 98,
  at: '2026-08-15T11:58:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: {
    action_id: 198,
    action: 'use',
    status: 'failed',
    place_id: 77,
    error: 'this recipe needs a lit trait in this place',
  },
}, {
  id: 97,
  at: '2026-08-15T11:57:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: {
    action_id: 197,
    action: 'use',
    status: 'failed',
    place_id: 77,
    error: 'the target thing is missing from this place',
  },
}, {
  id: 96,
  at: '2026-08-15T11:56:00.000Z',
  kind: 'action',
  actor: 'far-walker',
  detail: { action_id: 196, action: 'use', status: 'failed', place_id: 77 },
}, {
  id: 95,
  at: '2026-08-15T11:55:00.000Z',
  kind: 'effect_resolved',
  actor: 'far-walker',
  detail: {
    effect_id: 195,
    status: 'failed',
    error: 'the stored target thing no longer exists',
  },
}, {
  id: 94,
  at: '2026-08-15T11:54:00.000Z',
  kind: 'effect_resolved',
  actor: 'far-walker',
  detail: {
    effect_id: 194,
    status: 'skipped',
    error: 'the stored source thing no longer exists',
  },
}, {
  id: 93,
  at: '2026-08-15T11:53:00.000Z',
  kind: 'effect_resolved',
  actor: 'far-walker',
  detail: {
    effect_id: 193,
    status: 'applied',
    error: 'must not appear for an applied stored effect',
  },
}])

export const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '20',
  places: [{
    id: 11,
    parent_id: null,
    name: 'root_plaza',
    owner: 'mapkeeper',
    purpose: 'A reading room where the mapkeeper points visitors to two durable records.',
    front_matter: [{
      id: 33,
      type: 'thing',
      place_id: 11,
      name: 'borrowed_field_guide',
      maker_id: 7,
      made_by: 'leafwalker',
      current_owner_id: 8,
      current_owner: 'mapkeeper',
      owner_id: 8,
      owner: 'mapkeeper',
      body_text_bytes: 47,
      created_at: '2026-08-14T11:58:00.000Z',
    }, {
      id: 32,
      type: 'thing',
      place_id: 11,
      name: 'room_compass',
      maker_id: 8,
      made_by: 'mapkeeper',
      current_owner_id: 8,
      current_owner: 'mapkeeper',
      owner_id: 8,
      owner: 'mapkeeper',
      body_text_bytes: 52,
      created_at: '2026-08-14T11:57:00.000Z',
    }],
    places: 1,
    things: 2,
    notes: 2,
    children: [{
      id: 12,
      parent_id: 11,
      name: 'inner_hall',
      owner: 'mapkeeper',
      places: 3,
      things: 0,
      notes: 1,
      children: [],
    }],
  }],
  residents: [{
    id: 7,
    handle: 'leafwalker',
    current_place_id: 12,
    asleep: false,
    has_drawing: true,
    joined_at: '2026-08-14T12:00:00.000Z',
  }],
  notes: [{
    id: 21,
    place_id: 11,
    author: 'mapkeeper',
    body: LONG_NOTE,
    truncated: true,
    created_at: '2026-08-14T12:01:00.000Z',
  }, {
    id: 20,
    place_id: 11,
    author: 'dr-glass',
    body: FITTING_DOCTORS_NOTE,
    truncated: false,
    created_at: '2026-08-14T12:00:00.000Z',
  }],
  things: [{
    id: 31,
    place_id: 11,
    name: 'record_lantern',
    body: LONG_THING,
    owner: 'mapkeeper',
    open_to_use: true,
    kind: 'lantern',
    traits: ['steady'],
    truncated: true,
    created_at: '2026-08-14T12:02:00.000Z',
  }],
  agreements: [{
    id: 41,
    body: LONG_AGREEMENT,
    created_by: 'mapkeeper',
    parties: ['mapkeeper', 'leafwalker'],
    signatures: ['mapkeeper'],
    open: true,
    truncated: true,
    created_at: '2026-08-14T12:03:00.000Z',
  }],
  events: [{
    id: 51,
    at: '2026-08-14T12:03:30.000Z',
    kind: 'note',
    actor: 'mapkeeper',
    detail: { place_id: 11, note_id: 21 },
  }],
  totals: {
    places: 5,
    residents: 3,
    conversations: 3,
    things: 2,
    agreements: 2,
    events: 2,
  },
  shown: {
    places: 2,
    residents: 1,
    conversations: 1,
    things: 1,
    agreements: 1,
    events: 1,
  },
  limits: {
    places: 10,
    residents: 25,
    conversations: 10,
    things: 10,
    agreements: 10,
    events: 10,
  },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: true, next_before_id: 7 },
    notes: { has_more: true, next_before_id: 21 },
    things: { has_more: true, next_before_id: 31 },
    agreements: { has_more: true, next_before_id: 41 },
    events: { has_more: true, next_before_id: 51 },
  },
  refreshed_at: '2026-08-14T12:04:00.000Z',
})

export const DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: 11, parent_id: null, name: 'root_plaza' },
    { id: 12, parent_id: 11, name: 'inner_hall' },
    { id: 77, parent_id: 12, name: 'quiet_annex' },
  ],
  residents: [
    { id: 7, handle: 'leafwalker', has_drawing: true },
    { id: 9, handle: 'far-walker', has_drawing: false },
  ],
})

export const DIRECTORY_REFRESHED = Object.freeze({
  view: 'directory',
  places: [
    { id: 11, parent_id: null, name: 'root_plaza' },
    { id: 12, parent_id: 11, name: 'inner_hall' },
    { id: 77, parent_id: 12, name: 'renamed_annex' },
    { id: 78, parent_id: 12, name: 'fresh_gallery' },
  ],
  residents: [
    { id: 7, handle: 'leafwalker', has_drawing: true },
    { id: 9, handle: 'far-walker', has_drawing: false },
  ],
})

export const FALLBACK_SEARCH_RESIDENTS = Object.freeze(Array.from({ length: 21 }, (_, index) => ({
  id: 100 + index,
  handle: `fallback-${String(index + 1).padStart(2, '0')}`,
  current_place_id: null,
  asleep: false,
  joined_at: '2026-08-14T12:00:00.000Z',
})))

export const FOCUSED_PLACE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: {
    id: 77,
    parent_id: 12,
    name: 'quiet_annex',
    owner: 'far-walker',
    purpose: 'A quiet room known through one focused map read.',
    front_matter: [],
    places: 0,
    things: 4,
    notes: 3,
    children: [],
  },
  subplaces: [],
  subplaces_page: {
    has_more: false,
    next_before_subplace_id: null,
  },
})

export const FOCUSED_PLACE_REFRESHED = Object.freeze({
  view: 'outline',
  change_marker: '21',
  place: {
    id: 77,
    parent_id: 12,
    name: 'renamed_annex',
    owner: 'far-walker',
    purpose: 'A renamed room proved by a refreshed focused map read.',
    front_matter: [],
    places: 0,
    things: 5,
    notes: 1,
    children: [],
  },
  subplaces: [],
  subplaces_page: {
    has_more: false,
    next_before_subplace_id: null,
  },
})

export const FOCUSED_RESIDENT = Object.freeze({
  change_marker: '20',
  resident: {
    id: 9,
    handle: 'far-walker',
    current_place_id: 77,
    asleep: false,
    joined_at: '2026-08-11T12:00:00.000Z',
  },
})
