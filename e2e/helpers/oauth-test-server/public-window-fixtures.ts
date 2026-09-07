const placeDescription = 'A quiet test square with a brass observatory window.'
const noteExcerpt = 'The public note begins here'
const noteFull = `${noteExcerpt}, then continues beyond the snapshot excerpt.`
const thingExcerpt = 'A lantern with an abbreviated inscription'
const thingFull = `${thingExcerpt}; the complete inscription is readable without signing in.`
const publicPlaceShareRecord = Object.freeze({
  id: 11,
  name: 'test_square',
  description: placeDescription,
  owner: 'browser-resident',
  moderated: false,
})
const publicThingShareRecord = Object.freeze({
  id: 401,
  place_id: 11,
  name: 'field_lantern',
  made_by: 'browser-resident',
  current_owner: 'browser-resident',
  body: thingFull,
  moderated: false,
  has_drawing: true,
})
const publicNoteShareRecord = Object.freeze({
  id: 301,
  place_id: 11,
  author: 'browser-resident',
  body: noteFull,
  created_at: '2026-08-13T19:03:00.000Z',
  moderated: false,
})
const publicWindowFixture = Object.freeze({
  places: [{
    id: 11,
    parent_id: null,
    name: 'test_square',
    description: placeDescription,
    owner: 'browser-resident',
    places: 0,
    things: 1,
    notes: 1,
    moderated: false,
    children: [],
  }, {
    id: 12,
    parent_id: null,
    name: 'side_room',
    description: 'A second room used to prove global conversation order.',
    owner: 'oldwalker',
    places: 0,
    things: 0,
    notes: 1,
    moderated: false,
    children: [],
  }],
  residents: [{
    id: 49,
    handle: 'browser-resident',
    current_place_id: 11,
    joined_at: '2026-08-13T17:00:00.000Z',
  }, {
    id: 48,
    handle: 'oldwalker',
    current_place_id: 12,
    joined_at: '2026-08-12T17:00:00.000Z',
  }],
  notes: [{
    id: 303,
    place_id: 11,
    author: 'browser-resident',
    body: 'Newest in test square',
    created_at: '2026-08-13T19:05:00.000Z',
    moderated: false,
  }, {
    id: 302,
    place_id: 12,
    author: 'oldwalker',
    body: 'Middle in side room',
    created_at: '2026-08-13T19:04:00.000Z',
    moderated: false,
  }, {
    id: 301,
    place_id: 11,
    author: 'browser-resident',
    body: noteExcerpt,
    created_at: '2026-08-13T19:03:00.000Z',
    moderated: false,
    truncated: true,
  }],
  things: [{
    id: 401,
    place_id: 11,
    name: 'field_lantern',
    body: thingExcerpt,
    owner: 'browser-resident',
    kind_id: 77,
    kind: 'artifact',
    traits: ['bright'],
    created_at: '2026-08-13T19:02:00.000Z',
    moderated: false,
    kind_moderated: false,
    truncated: true,
  }],
  agreements: [{
    id: 601,
    body: 'A public agreement opened by its author.',
    created_by: 'browser-resident',
    parties: ['browser-resident', 'oldwalker', 'late-signer'],
    acceded: ['late-signer'],
    signatures: ['browser-resident', 'late-signer'],
    open: true,
    accession_open: true,
    party_count: 35,
    parties_truncated: true,
    created_at: '2026-08-13T19:01:00.000Z',
    moderated: false,
  }, {
    id: 600,
    body: 'An older agreement that remains closed.',
    created_by: 'browser-resident',
    parties: ['browser-resident'],
    acceded: [],
    signatures: [],
    open: true,
    accession_open: false,
    party_count: 1,
    parties_truncated: false,
    created_at: '2026-08-13T19:00:00.000Z',
    moderated: false,
  }],
  events: [{
    id: 503,
    at: '2026-08-13T19:03:00.000Z',
    kind: 'note',
    actor: 'browser-resident',
    detail: { place_id: 11, note_id: 301 },
  }, {
    id: 502,
    at: '2026-08-13T19:02:00.000Z',
    kind: 'thing_created',
    actor: 'browser-resident',
    detail: { place_id: 11, thing_id: 401 },
  }],
  totals: {
    places: 2,
    residents: 2,
    conversations: 3,
    things: 1,
    agreements: 2,
    events: 4,
  },
  body_limits: { notes: 2_000, things: 1_000, agreements: 4_000 },
  change_marker: '9',
  refreshed_at: '2026-08-13T19:04:00.000Z',
})
const transparentDrawingThumbnail = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
  'base64',
)

// The followed-resident context slice: oldwalker's own notes in the side
// room plus what a neighbor said back, newest first.
const followedResidentContextNotes = Object.freeze([{
  id: 302,
  place_id: 12,
  author: 'oldwalker',
  body: 'Middle in side room',
  created_at: '2026-08-13T19:04:00.000Z',
  moderated: false,
}, {
  id: 300,
  place_id: 12,
  author: 'oldwalker',
  body: 'An earlier thought in the side room.',
  created_at: '2026-08-13T18:58:00.000Z',
  moderated: false,
}, {
  id: 299,
  place_id: 12,
  author: 'browser-resident',
  body: 'A neighbor answers in the side room.',
  created_at: '2026-08-13T18:57:00.000Z',
  moderated: false,
}])

const olderPublicEvents = Object.freeze([{
  id: 501,
  at: '2026-08-13T19:01:00.000Z',
  kind: 'place_edited',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}, {
  id: 500,
  at: '2026-08-13T19:00:00.000Z',
  kind: 'home_set',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}])

export { publicPlaceShareRecord, publicThingShareRecord, publicNoteShareRecord, publicWindowFixture, transparentDrawingThumbnail, followedResidentContextNotes, olderPublicEvents }
