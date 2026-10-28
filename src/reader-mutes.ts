// What one reader's mutes and allows hide from a read (decision #156). Every resident
// read calls this through src/reader-filter.ts right after its moderation overlay, so
// the rule lives here once:
// - Hidden when a mute covers the item: its author or maker, its place or any place
//   above it, its kind, or the item itself; and no more specific allow covers it.
// - An item allow beats every mute; a place allow beats only a mute on a place above it
//   (src/resident-mutes.ts walks each place choice down to the nearest one).
// - Never hidden: anything either founder account, resident #1 or #2 (src/founders.ts,
//   decision #159), writes, makes or owns; your own items and the things you own;
//   agreements you are party to; moderation records.
// - Places are never dropped: a muted place, or one owned by a muted resident, is marked
//   muted and sent without its description, purpose or front matter, so the reader can
//   still walk through. Both founders' places and your own are never marked.
// Facts come from one query per read over every id the read is about to send, so the
// rule never depends on which fields a read happens to carry.
import { sql } from './db.ts'
import { isFounderResident } from './founders.ts'
import type { MuteSet } from './resident-mutes.ts'

export const MUTE_ITEM_TYPES = Object.freeze([
  'note', 'thing', 'line', 'ping', 'kind', 'trait', 'agreement', 'place',
] as const)
export type MuteItemType = typeof MUTE_ITEM_TYPES[number]
/** What a reading filter may cover: any item a read sends, or a resident's own drawing. */
export type FilterItemType = MuteItemType | 'resident'
export type MuteRefs = Readonly<Partial<Record<MuteItemType, readonly number[]>>>

/** A hidden item as its outline: never its body or its name. */
export type HiddenOutline = Readonly<{
  id: number
  type: string
  author: string | null
  kind: string | null
  size: number
  date: string | null
  place_id: number | null
}>

type Facts = Readonly<{
  authorId: number | null
  author: string | null
  placeId: number | null
  kindId: number | null
  kind: string | null
  ownerId: number | null
  size: number
  date: string | null
}>

type FactsQuery = (text: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>
const defaultFactsQuery: FactsQuery = async (text, params) => (
  await sql.query(text, [...params]) as Record<string, unknown>[]
)

const FACTS_SQL = `/* private:reader-mute-facts */
  SELECT 'note'::text AS type, note.id, note.author_id, author.handle AS author, note.place_id,
    NULL::integer AS kind_id, NULL::text AS kind, NULL::integer AS owner_id,
    octet_length(note.body)::integer AS size, note.created_at AS date
  FROM notes note JOIN residents author ON author.id = note.author_id
  WHERE note.id = ANY($1::integer[])
  UNION ALL
  SELECT 'thing', thing.id, thing.maker_id, maker.handle, thing.place_id,
    coalesce(thing.as_kind_id, thing.kind_id), kind.name, thing.owner_id,
    octet_length(thing.body)::integer, thing.created_at
  FROM things thing JOIN residents maker ON maker.id = thing.maker_id
  LEFT JOIN kinds kind ON kind.id = coalesce(thing.as_kind_id, thing.kind_id)
  WHERE thing.id = ANY($2::integer[])
  UNION ALL
  SELECT 'line', line.id, line.resident_id, author.handle, line.place_id,
    NULL, NULL, NULL, line.body_bytes::integer, line.created_at
  FROM room_lines line JOIN residents author ON author.id = line.resident_id
  WHERE line.id = ANY($3::integer[])
  UNION ALL
  SELECT 'ping', ping.id, ping.sender_id, sender.handle, ping.place_id,
    NULL, NULL, NULL, 0, ping.sent_at
  FROM pings ping JOIN residents sender ON sender.id = ping.sender_id
  WHERE ping.id = ANY($4::integer[])
  UNION ALL
  SELECT 'kind', kind.id, kind.owner_id, owner.handle, NULL,
    kind.id, kind.name, kind.owner_id, coalesce(octet_length(revision.description), 0)::integer, kind.created_at
  FROM kinds kind JOIN residents owner ON owner.id = kind.owner_id
  LEFT JOIN kind_revisions revision
    ON revision.kind_id = kind.id AND revision.revision = kind.current_revision
  WHERE kind.id = ANY($5::integer[])
  UNION ALL
  SELECT 'trait', trait.id, trait.coiner_id, coiner.handle, NULL,
    NULL, NULL, NULL, octet_length(trait.description)::integer, trait.created_at
  FROM traits trait JOIN residents coiner ON coiner.id = trait.coiner_id
  WHERE trait.id = ANY($6::integer[])
  UNION ALL
  SELECT 'agreement', agreement.id, agreement.created_by_id, creator.handle, NULL,
    NULL, NULL,
    CASE WHEN EXISTS (
      SELECT 1 FROM agreement_parties party
      WHERE party.agreement_id = agreement.id AND party.resident_id = $9::integer
    ) THEN $9::integer END,
    octet_length(agreement.body)::integer, agreement.created_at
  FROM agreements agreement JOIN residents creator ON creator.id = agreement.created_by_id
  WHERE agreement.id = ANY($7::integer[])
  UNION ALL
  SELECT 'place', place.id, place.owner_id, owner.handle, place.id,
    NULL, NULL, place.owner_id, octet_length(place.description)::integer, place.created_at
  FROM places place LEFT JOIN residents owner ON owner.id = place.owner_id
  WHERE place.id = ANY($8::integer[])
`

function factKey(type: string, id: number): string {
  return `${type}:${id}`
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function dateText(value: unknown): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

async function loadFacts(
  set: MuteSet,
  refs: MuteRefs,
  query: FactsQuery,
): Promise<ReadonlyMap<string, Facts>> {
  const ids = (type: MuteItemType) => [...new Set((refs[type] ?? []).filter(id => Number.isSafeInteger(id) && id > 0))]
  const params = [...MUTE_ITEM_TYPES.map(ids), set.readerId]
  if (params.slice(0, MUTE_ITEM_TYPES.length).every(list => (list as number[]).length === 0)) return new Map()
  const rows = await query(FACTS_SQL, params)
  return new Map(rows.map(row => [factKey(String(row.type), Number(row.id)), Object.freeze({
    authorId: nullableNumber(row.author_id),
    author: typeof row.author === 'string' ? row.author : null,
    placeId: nullableNumber(row.place_id),
    kindId: nullableNumber(row.kind_id),
    kind: typeof row.kind === 'string' ? row.kind : null,
    ownerId: nullableNumber(row.owner_id),
    size: Number(row.size ?? 0),
    date: dateText(row.date),
  })]))
}

function shownAlways(set: MuteSet, facts: Facts): boolean {
  return isFounderResident(facts.authorId)
    || isFounderResident(facts.ownerId)
    || facts.authorId === set.readerId
    || facts.ownerId === set.readerId
}

function hiddenByFacts(set: MuteSet, type: MuteItemType, id: number, facts: Facts): boolean {
  if (shownAlways(set, facts)) return false
  const itemChoices = type === 'note' ? set.notes : type === 'thing' ? set.things : null
  if (itemChoices?.allowed.has(id)) return false
  if (itemChoices?.muted.has(id)) return true
  if (facts.authorId !== null && set.residents.has(facts.authorId)) return true
  if (facts.kindId !== null && set.kinds.has(facts.kindId)) return true
  // A ping is an invitation from a resident, so only a mute on its sender covers it.
  return type !== 'ping' && facts.placeId !== null && set.mutedPlaces.has(facts.placeId)
}

function placeMarked(set: MuteSet, placeId: number, facts: Facts | undefined): boolean {
  const ownerId = facts?.ownerId ?? null
  if (isFounderResident(ownerId) || ownerId === set.readerId) return false
  if (ownerId !== null && set.residents.has(ownerId)) return true
  return set.mutedPlaces.has(placeId)
}

function eventDetail(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const detail = row.detail
  return detail !== null && typeof detail === 'object' && !Array.isArray(detail)
    ? detail as Readonly<Record<string, unknown>>
    : {}
}

function detailId(detail: Readonly<Record<string, unknown>>, field: string): number | null {
  const value = Number(detail[field])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function eventAboutReader(set: MuteSet, detail: Readonly<Record<string, unknown>>): boolean {
  if (detailId(detail, 'resident_id') === set.readerId) return true
  if (set.readerHandle !== null && detail.to === set.readerHandle) return true
  return Array.isArray(detail.parties) && set.readerHandle !== null && detail.parties.includes(set.readerHandle)
}

function hiddenEvent(set: MuteSet, row: Readonly<Record<string, unknown>>): boolean {
  if (row.kind === 'moderation') return false
  const actor = typeof row.actor === 'string' ? row.actor : ''
  if (actor === set.readerHandle || set.founderHandles.has(actor)) return false
  const detail = eventDetail(row)
  if (eventAboutReader(set, detail)) return false
  const noteId = detailId(detail, 'note_id')
  const thingId = detailId(detail, 'thing_id')
  if ((noteId !== null && set.notes.allowed.has(noteId)) || (thingId !== null && set.things.allowed.has(thingId))) {
    return false
  }
  if ((noteId !== null && set.notes.muted.has(noteId)) || (thingId !== null && set.things.muted.has(thingId))) {
    return true
  }
  if (set.residentHandles.has(actor)) return true
  const kindId = detailId(detail, 'kind_id')
  if (kindId !== null && set.kinds.has(kindId)) return true
  const placeId = detailId(detail, 'place_id')
  if (placeId !== null && set.mutedPlaces.has(placeId)) return true
  // A changed-outcome carrier can touch several rooms or responsible actors.
  // Keep the existing whole-event rule and count one hidden carrier, not entries.
  return Array.isArray(detail.applied_public_activity) && detail.applied_public_activity.some(value => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const outcome = value as Readonly<Record<string, unknown>>
    const responsible = typeof outcome.actor === 'string' ? outcome.actor : ''
    if (responsible === set.readerHandle || set.founderHandles.has(responsible)) return false
    const destination = detailId(outcome, 'place_id')
    return set.residentHandles.has(responsible)
      || (destination !== null && set.mutedPlaces.has(destination))
  })
}

function eventOutline(row: Readonly<Record<string, unknown>>): HiddenOutline {
  const detail = eventDetail(row)
  return Object.freeze({
    id: Number(row.id),
    type: 'event',
    author: typeof row.actor === 'string' ? row.actor : null,
    kind: typeof row.kind === 'string' ? row.kind : null,
    size: Buffer.byteLength(JSON.stringify(detail), 'utf8'),
    date: dateText(row.at ?? row.created_at),
    place_id: detailId(detail, 'place_id'),
  })
}

/** What one reader's mutes hide in one read, decided once over that read's ids. */
export interface MuteJudge {
  hides(type: MuteItemType, id: number): boolean
  /**
   * Whether this item skips the reader's reading filters (decision #157): it always shows
   * (either founder's, the reader's own, a place the city itself holds), or the reader
   * allowed it with show_anyway. An item this read did not ask about is filtered.
   */
  skipsFilters(type: FilterItemType, id: number): boolean
  marksPlace(placeId: number): boolean
  hidesResident(id: number): boolean
  hidesResidentHandle(handle: unknown): boolean
  hidesEvent(row: Readonly<Record<string, unknown>>): boolean
  outline(type: MuteItemType, id: number): HiddenOutline
  eventOutline(row: Readonly<Record<string, unknown>>): HiddenOutline
  /**
   * The same judge over more ids, for a page that reads further rows after hiding some
   * (src/page-fill.ts): facts are loaded only for ids it does not know yet.
   */
  widen(refs: MuteRefs): Promise<MuteJudge>
}

/** The judge for one read, or null when the reader has no mutes or allows. */
export async function judgeMutes(
  set: MuteSet | null,
  refs: MuteRefs,
  query: FactsQuery = defaultFactsQuery,
): Promise<MuteJudge | null> {
  if (set === null) return null
  return judgeOverFacts(set, await loadFacts(set, refs, query), query)
}

function judgeOverFacts(set: MuteSet, facts: ReadonlyMap<string, Facts>, query: FactsQuery): MuteJudge {
  const factsOf = (type: MuteItemType, id: number) => facts.get(factKey(type, id))
  const judge: MuteJudge = Object.freeze({
    hides(type: MuteItemType, id: number): boolean {
      const known = factsOf(type, id)
      return known !== undefined && hiddenByFacts(set, type, id, known)
    },
    skipsFilters(type: FilterItemType, id: number): boolean {
      if (type === 'resident') return isFounderResident(id) || id === set.readerId
      const showAnyway = type === 'note' ? set.showAnyway.notes
        : type === 'thing' ? set.showAnyway.things
          : type === 'place' ? set.showAnyway.places : null
      if (showAnyway?.has(id) === true) return true
      const known = factsOf(type, id)
      if (known === undefined) return false
      return shownAlways(set, known) || (type === 'place' && known.ownerId === null)
    },
    marksPlace(placeId: number): boolean {
      return placeMarked(set, placeId, factsOf('place', placeId))
    },
    hidesResident(id: number): boolean {
      return !isFounderResident(id) && set.residents.has(id)
    },
    hidesResidentHandle(handle: unknown): boolean {
      return typeof handle === 'string' && set.residentHandles.has(handle)
    },
    hidesEvent(row: Readonly<Record<string, unknown>>): boolean {
      return hiddenEvent(set, row)
    },
    outline(type: MuteItemType, id: number): HiddenOutline {
      const known = factsOf(type, id)
      return Object.freeze({
        id,
        type,
        author: known?.author ?? null,
        kind: known?.kind ?? null,
        size: known?.size ?? 0,
        date: known?.date ?? null,
        place_id: known?.placeId ?? null,
      })
    },
    eventOutline,
    async widen(refs: MuteRefs): Promise<MuteJudge> {
      const unknown = Object.fromEntries(MUTE_ITEM_TYPES.map(type => [
        type, (refs[type] ?? []).filter(id => !facts.has(factKey(type, id))),
      ])) as MuteRefs
      const more = await loadFacts(set, unknown, query)
      return more.size === 0 ? judge : judgeOverFacts(set, new Map([...facts, ...more]), query)
    },
  })
  return judge
}
