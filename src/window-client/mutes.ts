// The human mute list (decision #160): what one browser asked the window and the live view
// not to show. It lives only in this browser's storage under one key on the 1f3d9.com
// origin; the live view at /live/ shares that origin and reads the same list. Nothing here
// is ever sent to the city.
//
// The parser and the rule are copied on purpose from the live view (1f3d9-live,
// src/browser-mutes.ts, a separate repository and build). One shared data file,
// test/fixtures/browser-mutes-fixture.json, is kept byte for byte the same in both
// repositories and pins both copies; change the rule only together with that file and the
// live view's copy.
//
// The window injects createWindowMuteHelpers into its page with toString(), so the factory
// must stay self-contained: no imports and no outside names. The founder pair is passed in
// from src/founders.ts.
//
// The rule (the live view's, which matches the residents' own rule where the page has the
// data):
// - Never hidden: both founder accounts, residents #1 and #2 (decision #159), any note,
//   line, thing or event either founder writes, makes or owns, and a place either owns.
// - An item allow (a note or a thing) beats every mute; an item mute comes next.
// - Then a mute on the author or maker, then a mute on the kind.
// - Then places: the nearest place choice at or above the item's place wins, so an allow
//   on a place beats a mute on a place above it, and muting a place mutes everything
//   inside it. A resident standing in a muted place is hidden there.
// - A resident or a kind cannot be allowed; such an entry is kept but changes nothing.
// - A place owned by a muted resident is not hidden; things are judged by maker, not owner.

export const WINDOW_MUTES_STORAGE_KEY = '1f3d9:mutes:v1'

export type WindowMuteType = 'resident' | 'place' | 'note' | 'thing' | 'kind'
export type WindowMuteChoice = 'mute' | 'allow'
export type WindowMute = Readonly<{ type: WindowMuteType; id: number; choice: WindowMuteChoice }>
export type WindowMutePlace = Readonly<{ id: number; parent_id: number | null }>
export type WindowMuteRules = Readonly<{
  empty: boolean
  residents: ReadonlySet<number>
  kinds: ReadonlySet<number>
  notes: Readonly<{ muted: ReadonlySet<number>; allowed: ReadonlySet<number> }>
  things: Readonly<{ muted: ReadonlySet<number>; allowed: ReadonlySet<number> }>
  places: ReadonlyMap<number, WindowMuteChoice>
}>
/** The live view's subject shapes: what the rule judges. A missing fact never hides anything. */
export type WindowMuteSubject = Readonly<{
  type: 'resident' | 'mark' | 'place' | 'note' | 'line' | 'thing' | 'event'
  id?: number | null
  author_id?: number | null
  owner_id?: number | null
  kind_id?: number | null
  place_id?: number | null
  note_id?: number | null
  thing_id?: number | null
}>
/** A row as the window holds it; handles are turned into resident numbers by the caller's lookup. */
export type WindowMuteRow = Readonly<Record<string, unknown>>
export type WindowMuteRowKind =
  | 'resident' | 'place' | 'note' | 'line' | 'thing' | 'event' | 'archive' | 'gazette'
  | 'note-detail' | 'thing-detail'

export type WindowMuteHelpers = Readonly<{
  maxItems: number
  isFounder: (id: unknown) => boolean
  parse: (raw: unknown) => readonly WindowMute[]
  serialize: (list: readonly WindowMute[]) => string
  withChoice: (list: readonly WindowMute[], type: WindowMuteType, id: number,
    choice: WindowMuteChoice | null) => readonly WindowMute[] | null
  compile: (list: readonly WindowMute[]) => WindowMuteRules
  nearestPlaceChoice: (rules: WindowMuteRules, byId: ReadonlyMap<number, WindowMutePlace>, placeId: number) =>
    Readonly<{ placeId: number; choice: WindowMuteChoice }> | null
  hiddenPlaces: (rules: WindowMuteRules, places: readonly WindowMutePlace[]) => ReadonlySet<number>
  hidden: (subject: WindowMuteSubject, rules: WindowMuteRules, places: ReadonlySet<number>) => boolean
  subject: (kind: WindowMuteRowKind, row: WindowMuteRow, residentId: (handle: unknown) => number | null,
    actorPlaceId?: number | null) => WindowMuteSubject
}>

export function createWindowMuteHelpers(founderIds: readonly number[]): WindowMuteHelpers {
  const VERSION = 1
  const MAX_ITEMS = 1000
  const MAX_ID = 2147483647
  const TYPES: readonly string[] = ['resident', 'place', 'note', 'thing', 'kind']
  const CHOICES: readonly string[] = ['mute', 'allow']
  const NONE: readonly WindowMute[] = Object.freeze([])
  const founders: readonly number[] = Object.freeze([...founderIds])

  const isFounder = (id: unknown): boolean => typeof id === 'number' && founders.includes(id)
  const known = (value: unknown): value is number => typeof value === 'number'
  const positive = (value: unknown): number | null =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_ID ? value : null
  const plainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)

  function entry(value: unknown): WindowMute | null {
    if (!plainObject(value)) return null
    const { type, id, choice } = value
    if (typeof type !== 'string' || !TYPES.includes(type)) return null
    if (typeof choice !== 'string' || !CHOICES.includes(choice)) return null
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > MAX_ID) return null
    return Object.freeze({ type: type as WindowMuteType, id, choice: choice as WindowMuteChoice })
  }

  // The stored list, or an empty list when the value is absent, not JSON, not version 1,
  // longer than the cap, or holds any entry that is not {type, id, choice}. Other keys are
  // ignored. A later entry for the same type and id replaces an earlier one. An entry
  // naming either founder is dropped: neither founder can be muted.
  function parse(raw: unknown): readonly WindowMute[] {
    if (typeof raw !== 'string') return NONE
    let value: unknown
    try { value = JSON.parse(raw) } catch { return NONE }
    if (!plainObject(value) || value['version'] !== VERSION || !Array.isArray(value['items'])) return NONE
    const items = value['items'] as unknown[]
    if (items.length > MAX_ITEMS) return NONE
    const kept = new Map<string, WindowMute>()
    for (const item of items) {
      const parsed = entry(item)
      if (!parsed) return NONE
      const key = parsed.type + ':' + String(parsed.id)
      kept.delete(key)
      if (!(parsed.type === 'resident' && isFounder(parsed.id))) kept.set(key, parsed)
    }
    return kept.size ? Object.freeze([...kept.values()]) : NONE
  }

  function serialize(list: readonly WindowMute[]): string {
    return JSON.stringify({
      version: VERSION,
      items: list.map(item => ({ type: item.type, id: item.id, choice: item.choice })),
    })
  }

  // A new list with this one choice set (or removed, for null) and placed last. A resident
  // or kind takes only a mute, either founder is never named, and a new entry past the cap
  // gives null so nothing is saved.
  function withChoice(list: readonly WindowMute[], type: WindowMuteType, id: number,
    choice: WindowMuteChoice | null): readonly WindowMute[] | null {
    const next = entry({ type, id, choice: choice ?? 'mute' })
    if (!next) return null
    if (choice !== null && type === 'resident' && isFounder(id)) return null
    if (choice === 'allow' && (type === 'resident' || type === 'kind')) return null
    const others = list.filter(item => !(item.type === type && item.id === id))
    if (choice === null) return Object.freeze(others)
    if (others.length >= MAX_ITEMS) return null
    return Object.freeze([...others, next])
  }

  function compile(list: readonly WindowMute[]): WindowMuteRules {
    const residents = new Set<number>()
    const kinds = new Set<number>()
    const notes = { muted: new Set<number>(), allowed: new Set<number>() }
    const things = { muted: new Set<number>(), allowed: new Set<number>() }
    const places = new Map<number, WindowMuteChoice>()
    for (const { type, id, choice } of list) {
      if (type === 'resident') { if (choice === 'mute' && !isFounder(id)) residents.add(id) }
      else if (type === 'kind') { if (choice === 'mute') kinds.add(id) }
      else if (type === 'note') (choice === 'mute' ? notes.muted : notes.allowed).add(id)
      else if (type === 'thing') (choice === 'mute' ? things.muted : things.allowed).add(id)
      else places.set(id, choice)
    }
    return Object.freeze({
      empty: list.length === 0, residents, kinds,
      notes: Object.freeze(notes), things: Object.freeze(things), places,
    })
  }

  // The nearest place choice at or above one place, and the place that carries it.
  function nearestPlaceChoice(rules: WindowMuteRules, byId: ReadonlyMap<number, WindowMutePlace>, placeId: number):
    Readonly<{ placeId: number; choice: WindowMuteChoice }> | null {
    const seen = new Set<number>()
    let current = byId.get(placeId)
    while (current && !seen.has(current.id)) {
      const choice = rules.places.get(current.id)
      if (choice) return Object.freeze({ placeId: current.id, choice })
      seen.add(current.id)
      current = current.parent_id === null ? undefined : byId.get(current.parent_id)
    }
    return null
  }

  // Every place the list hides. A muted place missing from the place list still hides what
  // names it directly.
  function hiddenPlaces(rules: WindowMuteRules, places: readonly WindowMutePlace[]): ReadonlySet<number> {
    const hidden = new Set<number>()
    if (rules.places.size === 0) return hidden
    const byId = new Map(places.map(place => [place.id, place]))
    for (const place of places) {
      if (nearestPlaceChoice(rules, byId, place.id)?.choice === 'mute') hidden.add(place.id)
    }
    for (const [id, choice] of rules.places) if (choice === 'mute' && !byId.has(id)) hidden.add(id)
    return hidden
  }

  // Whether this browser's list hides the subject. `places` is hiddenPlaces() for the list.
  function hidden(subject: WindowMuteSubject, rules: WindowMuteRules, places: ReadonlySet<number>): boolean {
    if (rules.empty) return false
    const inHiddenPlace = known(subject.place_id) && places.has(subject.place_id)
    if (subject.type === 'place') return !isFounder(subject.owner_id) && known(subject.id) && places.has(subject.id)
    if (subject.type === 'resident' || subject.type === 'mark') {
      if (isFounder(subject.id)) return false
      return (known(subject.id) && rules.residents.has(subject.id)) || inHiddenPlace
    }
    if (isFounder(subject.author_id) || isFounder(subject.owner_id)) return false
    const noteId = subject.type === 'note' ? subject.id : subject.type === 'event' ? subject.note_id : null
    const thingId = subject.type === 'thing' ? subject.id : subject.type === 'event' ? subject.thing_id : null
    if ((known(noteId) && rules.notes.allowed.has(noteId)) ||
      (known(thingId) && rules.things.allowed.has(thingId))) return false
    if ((known(noteId) && rules.notes.muted.has(noteId)) ||
      (known(thingId) && rules.things.muted.has(thingId))) return true
    if (known(subject.author_id) && rules.residents.has(subject.author_id)) return true
    if (known(subject.kind_id) && rules.kinds.has(subject.kind_id)) return true
    return inHiddenPlace
  }

  // The adapter: one window row as the live view's subject shape. Handles become resident
  // numbers through the caller's lookup; a fact the row does not carry stays null.
  function subject(kind: WindowMuteRowKind, row: WindowMuteRow, residentId: (handle: unknown) => number | null,
    actorPlaceId: number | null = null): WindowMuteSubject {
    const id = positive(row['id'])
    if (kind === 'resident') {
      return Object.freeze({ type: 'resident', id, place_id: positive(row['current_place_id']) })
    }
    if (kind === 'place') {
      return Object.freeze({ type: 'place', id, owner_id: positive(row['owner_id']) ?? residentId(row['owner']) })
    }
    if (kind === 'note' || kind === 'note-detail') {
      return Object.freeze({ type: 'note', id, author_id: residentId(row['author']),
        place_id: positive(row['place_id']) ?? positive(row['placeId']) })
    }
    if (kind === 'line') {
      return Object.freeze({ type: 'line', id, author_id: residentId(row['author']),
        place_id: positive(row['placeId']) ?? positive(row['place_id']) })
    }
    if (kind === 'thing' || kind === 'thing-detail') {
      return Object.freeze({ type: 'thing', id,
        author_id: positive(row['maker_id']) ?? residentId(row['made_by'] ?? row['madeBy']),
        owner_id: positive(row['current_owner_id']) ?? residentId(row['current_owner'] ?? row['currentOwner']),
        kind_id: positive(row['kind_id']) ?? positive(row['kindId']),
        place_id: positive(row['place_id']) ?? positive(row['placeId']) })
    }
    if (kind === 'archive') {
      return row['type'] === 'thing'
        ? Object.freeze({ type: 'thing', id,
          author_id: positive(row['makerId']) ?? residentId(row['madeBy']),
          owner_id: positive(row['currentOwnerId']) ?? residentId(row['currentOwner']),
          kind_id: positive(row['kindId']) ?? positive(row['kind_id']), place_id: positive(row['placeId']) })
        : Object.freeze({ type: 'note', id, author_id: residentId(row['actor']), place_id: positive(row['placeId']) })
    }
    if (kind === 'gazette') {
      return Object.freeze({ type: 'note', id: positive(row['noteId']), author_id: residentId(row['author']),
        place_id: positive(row['placeId']) })
    }
    const detail = plainObject(row['detail']) ? row['detail'] : {}
    const assetThing = detail['asset_type'] === 'thing' ? positive(detail['asset_id']) : null
    const assetKind = detail['asset_type'] === 'kind' ? positive(detail['asset_id']) : null
    return Object.freeze({ type: 'event', author_id: residentId(row['actor']),
      note_id: positive(detail['note_id']),
      thing_id: positive(detail['thing_id']) ?? positive(detail['source_thing_id']) ?? assetThing,
      kind_id: positive(detail['kind_id']) ?? assetKind,
      place_id: positive(detail['place_id']) ?? positive(detail['to_place_id']) ?? positive(actorPlaceId) })
  }

  return Object.freeze({
    maxItems: MAX_ITEMS, isFounder, parse, serialize, withChoice, compile, nearestPlaceChoice,
    hiddenPlaces, hidden, subject,
  })
}
