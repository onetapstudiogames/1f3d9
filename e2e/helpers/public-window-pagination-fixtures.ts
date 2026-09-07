import { type Page } from '@playwright/test'
import { SNAPSHOT } from './public-window-snapshot-fixtures.ts'

export const FIRST_BRANCH_PAGE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: {
    id: 12,
    parent_id: 11,
    name: 'inner_hall',
    owner: 'mapkeeper',
    places: 3,
    things: 0,
    notes: 1,
    children: [],
  },
  subplaces: [{
    id: 15,
    parent_id: 12,
    name: 'newest_gallery',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }, {
    id: 14,
    parent_id: 12,
    name: 'shared_step',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }],
  subplaces_page: {
    total_items: 3,
    total_text_bytes: 0,
    returned_items: 2,
    returned_text_bytes: 0,
    has_more: true,
    next_before_subplace_id: 14,
  },
  map_complete: false,
})

// The repeated id intentionally exercises the client's overlap-safe merge.
// A refresh or a moving cursor must never duplicate a place already on screen.
export const SECOND_BRANCH_PAGE = Object.freeze({
  view: 'outline',
  change_marker: '20',
  place: FIRST_BRANCH_PAGE.place,
  subplaces: [FIRST_BRANCH_PAGE.subplaces[1], {
    id: 13,
    parent_id: 12,
    name: 'older_cell',
    owner: 'mapkeeper',
    places: 0,
    things: 0,
    notes: 0,
    children: [],
  }],
  subplaces_page: {
    total_items: 3,
    total_text_bytes: 0,
    returned_items: 2,
    returned_text_bytes: 0,
    has_more: false,
    next_before_subplace_id: null,
  },
  map_complete: false,
})

export const RESIDENT_PAGE = Object.freeze({
  change_marker: '20',
  residents: [SNAPSHOT.residents[0], {
    id: 6,
    handle: 'nightwatcher',
    current_place_id: 12,
    asleep: true,
    joined_at: '2026-08-13T12:00:00.000Z',
  }, {
    id: 5,
    handle: 'wayfarer',
    current_place_id: null,
    asleep: false,
    joined_at: '2026-08-12T12:00:00.000Z',
  }],
  total: 3,
  has_more: false,
  next_before_id: null,
})

export const EMPTY_RESIDENT_SNAPSHOT = Object.freeze({
  ...SNAPSHOT,
  places: [{
    ...SNAPSHOT.places[0],
    places: 0,
    children: [],
  }],
  residents: [],
  totals: { ...SNAPSHOT.totals, places: 1, residents: 0 },
  shown: { ...SNAPSHOT.shown, places: 1, residents: 0 },
  pages: {
    ...SNAPSHOT.pages,
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
  },
})

export const API_REQUESTS = new WeakMap<Page, string[]>()

export const OLDER_NOTE = Object.freeze({
  id: 20,
  place_id: 77,
  author: 'leafwalker',
  body: 'An older conversation remains readable.',
  created_at: '2026-08-13T12:01:00.000Z',
})

export const OLDER_GLOBAL_NOTE = Object.freeze({
  id: 19,
  place_id: 12,
  author: 'leafwalker',
  body: 'An older conversation remains readable.',
  created_at: '2026-08-13T11:01:00.000Z',
})

export const FAR_WALKER_NOTE = Object.freeze({
  id: 91,
  place_id: 77,
  author: 'far-walker',
  body: 'Far Walker speaks from the quiet annex.',
  created_at: '2026-08-15T12:01:00.000Z',
})

export const OLDER_FAR_WALKER_NOTE = Object.freeze({
  id: 82,
  place_id: 12,
  author: 'far-walker',
  body: 'Far Walker spoke here earlier.',
  created_at: '2026-08-12T12:01:00.000Z',
})

export const FAR_WALKER_ROOM_CONTEXT = Object.freeze({
  id: 90,
  place_id: 77,
  author: 'mapkeeper',
  body: 'A neighboring voice supplies room context.',
  created_at: '2026-08-15T12:00:00.000Z',
})

export const OLDER_THING = Object.freeze({
  id: 30,
  place_id: 77,
  name: 'old_bench',
  body: 'An older object remains visible.',
  owner: 'leafwalker',
  kind: null,
  traits: [],
  created_at: '2026-08-13T12:02:00.000Z',
})

export const OLDER_AGREEMENT = Object.freeze({
  id: 40,
  body: 'An older promise remains public.',
  created_by: 'leafwalker',
  parties: ['leafwalker'],
  signatures: ['leafwalker'],
  open: false,
  created_at: '2026-08-13T12:03:00.000Z',
})

export const OLDER_EVENT = Object.freeze({
  id: 50,
  at: '2026-08-13T12:03:30.000Z',
  kind: 'thing_created',
  actor: 'leafwalker',
  detail: { place_id: 11, thing_id: 30 },
})
