// Mutes and allows (decision #156), kept in each resident's private settings store
// (#154). A resident may mute a resident, a place (and every place inside it), a note,
// a thing or a kind, and allow one note, thing or place through a wider mute. One row
// per choice; unmuting or unallowing deletes it. Unlimited, private, and nobody is told,
// except that a muted giver learns its gift is held (decision #158).
// Neither founder account, residents #1 and #2 (src/founders.ts, decision #159), can be
// muted or allowed, and nothing either writes, makes or owns is hidden. An allow may also
// say show_anyway (decision #157), so that one note, thing or place skips the reader's
// reading filters too. A mute of a resident may also say
// let_transfers_through (decision #158): then the things, kinds and places that resident
// gives move at once instead of waiting for a yes (src/waiting-transfers.ts); the column
// is let_gifts_through. This module stores the choices and loads one reader's mute set
// once per request; src/reader-filter.ts decides what each read leaves out.
import { sql } from './db.ts'
import { FOUNDER_RESIDENT_IDS, isFounderResident } from './founders.ts'

export const MUTE_TARGET_TYPES = Object.freeze(['resident', 'place', 'note', 'thing', 'kind'] as const)
export type MuteTargetType = typeof MUTE_TARGET_TYPES[number]
export const ALLOW_TARGET_TYPES = Object.freeze(['place', 'note', 'thing'] as const)
export const MUTE_VERBS = Object.freeze(['mute', 'unmute', 'allow', 'unallow'] as const)
export type MuteVerb = typeof MUTE_VERBS[number]

export type MuteChange = Readonly<{
  verb: MuteVerb
  type: MuteTargetType
  id: number
  showAnyway?: boolean
  letTransfersThrough?: boolean
}>

export const MUTE_TARGET_REFUSAL =
  'mute, unmute, allow and unallow each take {"type": ..., "id": ...}: type is resident, place, note, thing or kind, and id is a positive whole number, like {"mute": {"type": "resident", "id": 12}}'
export const MUTE_FOUNDER_REFUSAL =
  'the founders, residents #1 and #2, cannot be muted, and the notes and things either founder writes, makes or owns always show; mute something else'
export const MUTE_SELF_REFUSAL =
  'you cannot mute yourself or your own notes and things; your own items always show to you'
export const SHOW_ANYWAY_REFUSAL =
  'show_anyway goes only with allow and must be true or false, like {"allow": {"type": "note", "id": 5, "show_anyway": true}}; it lets that one note, thing or place skip your reading filters'
export const LET_TRANSFERS_THROUGH_REFUSAL =
  'let_transfers_through goes only with a mute of a resident and must be true or false, like {"mute": {"type": "resident", "id": 12, "let_transfers_through": true}}; it lets the things, kinds and places that resident gives you move to you at once instead of waiting for your yes'
export const ALLOW_TYPE_REFUSAL =
  'allow takes a note, thing or place; a whole resident or kind cannot be allowed, so unmute it instead'

export function muteTargetNotFound(type: MuteTargetType, id: number): string {
  return `${type} ${id} was not found; read it again and send a current id`
}

const MAX_TARGET_ID = 2_147_483_647

type MuteQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<Record<string, unknown>[]>
const defaultQuery = sql as unknown as MuteQuery

type MuteTarget = Readonly<{ type: MuteTargetType; id: number; showAnyway?: boolean; letTransfersThrough?: boolean }>

/** Whether a target names show_anyway, which only an allow may carry, as true or false. */
export function hasShowAnyway(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'show_anyway')
}

/** Whether a target names let_transfers_through, which only a mute of a resident may carry. */
export function hasLetTransfersThrough(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.hasOwn(value, 'let_transfers_through')
}

/**
 * One {type, id} target, or null when it is not one. An allow may add show_anyway, true
 * or false, and a mute of a resident may add let_transfers_through, true or false; every
 * other verb takes exactly type and id.
 */
export function parseMuteTarget(value: unknown, allowShowAnyway = false, allowLetTransfersThrough = false): MuteTarget | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const withShowAnyway = allowShowAnyway && Object.hasOwn(record, 'show_anyway')
  const withLetThrough = allowLetTransfersThrough && Object.hasOwn(record, 'let_transfers_through')
  const keys = Object.keys(record).filter(key => !(withShowAnyway && key === 'show_anyway')
    && !(withLetThrough && key === 'let_transfers_through'))
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('id')) return null
  const type = record.type
  const id = record.id
  if (typeof type !== 'string' || !(MUTE_TARGET_TYPES as readonly string[]).includes(type)) return null
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1 || id > MAX_TARGET_ID) return null
  if (withShowAnyway && typeof record.show_anyway !== 'boolean') return null
  if (withLetThrough && (type !== 'resident' || typeof record.let_transfers_through !== 'boolean')) return null
  return Object.freeze({
    type: type as MuteTargetType,
    id,
    ...(withShowAnyway ? { showAnyway: record.show_anyway as boolean } : {}),
    ...(withLetThrough ? { letTransfersThrough: record.let_transfers_through as boolean } : {}),
  })
}

export type MuteChangeRefusal = Readonly<{ status: 400 | 404; error: string }>

/**
 * Write one mute or allow, or delete one. A mute or an allow replaces the other choice
 * on the same target, so the newest choice for a target is the one kept.
 */
export async function applyMuteChange(
  residentId: number,
  change: MuteChange,
  query: MuteQuery = defaultQuery,
): Promise<Readonly<{ ok: true; changed: boolean }> | Readonly<{ ok: false; refusal: MuteChangeRefusal }>> {
  if (change.verb === 'unmute' || change.verb === 'unallow') {
    const choice = change.verb === 'unmute' ? 'mute' : 'allow'
    const removed = await query`
      DELETE FROM resident_mutes
      WHERE resident_id = ${residentId} AND target_type = ${change.type}
        AND target_id = ${change.id} AND choice = ${choice}
      RETURNING id
    `
    return Object.freeze({ ok: true, changed: removed.length > 0 })
  }
  const founderRefusal = { status: 400, error: MUTE_FOUNDER_REFUSAL } as const
  // A mute or an allow naming either founder account is refused with the same sentence.
  if (change.type === 'resident' && isFounderResident(change.id)) return refused(founderRefusal)
  if (change.verb === 'allow' && !(ALLOW_TARGET_TYPES as readonly string[]).includes(change.type)) {
    return refused({ status: 400, error: ALLOW_TYPE_REFUSAL })
  }
  const selfRefusal = { status: 400, error: MUTE_SELF_REFUSAL } as const
  if (change.verb === 'mute' && change.type === 'resident' && change.id === residentId) return refused(selfRefusal)
  const target = await readTarget(change.type, change.id, query)
  if (target === null) return refused({ status: 404, error: muteTargetNotFound(change.type, change.id) })
  if (change.verb === 'mute' && (change.type === 'note' || change.type === 'thing')) {
    if (isFounderResident(target.authorId) || isFounderResident(target.ownerId)) return refused(founderRefusal)
    if (target.authorId === residentId || target.ownerId === residentId) return refused(selfRefusal)
  }
  // Only an allow carries show_anyway; a mute that replaces an allow clears it. Only a
  // mute of a resident carries let_transfers_through (#158); a mute sent without it holds
  // that resident's transfers again.
  const showAnyway = change.verb === 'allow' && change.showAnyway === true
  const letThrough = change.verb === 'mute' && change.type === 'resident' && change.letTransfersThrough === true
  const written = await query`
    INSERT INTO resident_mutes (resident_id, target_type, target_id, choice, show_anyway, let_gifts_through)
    VALUES (${residentId}, ${change.type}, ${change.id}, ${change.verb}, ${showAnyway}, ${letThrough})
    ON CONFLICT (resident_id, target_type, target_id) DO UPDATE
    SET choice = EXCLUDED.choice, show_anyway = EXCLUDED.show_anyway,
      let_gifts_through = EXCLUDED.let_gifts_through, created_at = now()
    WHERE resident_mutes.choice IS DISTINCT FROM EXCLUDED.choice
      OR resident_mutes.show_anyway IS DISTINCT FROM EXCLUDED.show_anyway
      OR resident_mutes.let_gifts_through IS DISTINCT FROM EXCLUDED.let_gifts_through
    RETURNING id
  `
  return Object.freeze({ ok: true, changed: written.length > 0 })
}

function refused(refusal: MuteChangeRefusal): Readonly<{ ok: false; refusal: MuteChangeRefusal }> {
  return Object.freeze({ ok: false, refusal: Object.freeze(refusal) })
}

async function readTarget(
  type: MuteTargetType,
  id: number,
  query: MuteQuery,
): Promise<Readonly<{ authorId: number | null; ownerId: number | null }> | null> {
  const rows = type === 'resident'
    ? await query`SELECT id AS author_id, NULL::integer AS owner_id FROM residents WHERE id = ${id}`
    : type === 'place'
      ? await query`SELECT owner_id AS author_id, owner_id FROM places WHERE id = ${id}`
      : type === 'note'
        ? await query`SELECT author_id, NULL::integer AS owner_id FROM notes WHERE id = ${id}`
        : type === 'thing'
          ? await query`SELECT maker_id AS author_id, owner_id FROM things WHERE id = ${id}`
          : await query`SELECT owner_id AS author_id, owner_id FROM kinds WHERE id = ${id}`
  const row = rows[0]
  if (row === undefined) return null
  return Object.freeze({
    authorId: row.author_id == null ? null : Number(row.author_id),
    ownerId: row.owner_id == null ? null : Number(row.owner_id),
  })
}

export type ListedMute = Readonly<{
  type: MuteTargetType
  id: number
  choice: 'mute' | 'allow'
  show_anyway?: boolean
  let_transfers_through?: boolean
  since: string
}>

/** Every mute and allow of one resident, newest first, for settings "show". */
export async function listMutes(residentId: number, query: MuteQuery = defaultQuery): Promise<readonly ListedMute[]> {
  const rows = await query`/* private:reader-mute-list */
    SELECT target_type, target_id, choice, show_anyway, let_gifts_through, created_at
    FROM resident_mutes
    WHERE resident_id = ${residentId}
    ORDER BY created_at DESC, id DESC
  `
  return Object.freeze(rows.map(row => Object.freeze({
    type: String(row.target_type) as MuteTargetType,
    id: Number(row.target_id),
    choice: row.choice === 'allow' ? 'allow' as const : 'mute' as const,
    ...(row.choice === 'allow' ? { show_anyway: row.show_anyway === true } : {}),
    ...(row.choice === 'mute' && row.target_type === 'resident'
      ? { let_transfers_through: row.let_gifts_through === true } : {}),
    since: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  })))
}

type Choices = Readonly<{ muted: ReadonlySet<number>; allowed: ReadonlySet<number> }>

/** One reader's mutes and allows, loaded once per request. */
export type MuteSet = Readonly<{
  readerId: number
  readerHandle: string | null
  /** The handles of both founder accounts, read in the same query as the reader's. */
  founderHandles: ReadonlySet<string>
  residents: ReadonlySet<number>
  residentHandles: ReadonlySet<string>
  notes: Choices
  things: Choices
  kinds: ReadonlySet<number>
  /** Places a place mute covers, after the allows inside them: computed once per request. */
  mutedPlaces: ReadonlySet<number>
  /** Notes, things and places allowed with show_anyway, which skip the reading filters. */
  showAnyway: Readonly<{ notes: ReadonlySet<number>; things: ReadonlySet<number>; places: ReadonlySet<number> }>
}>

/** A mute set with no choices, for a reader that has only reading filters. */
export function emptyMuteSet(readerId: number): MuteSet {
  const none: ReadonlySet<number> = new Set<number>()
  return Object.freeze({
    readerId,
    readerHandle: null,
    founderHandles: new Set<string>(),
    residents: none,
    residentHandles: new Set<string>(),
    notes: Object.freeze({ muted: none, allowed: none }),
    things: Object.freeze({ muted: none, allowed: none }),
    kinds: none,
    mutedPlaces: none,
    showAnyway: Object.freeze({ notes: none, things: none, places: none }),
  })
}

/**
 * The reader's mute set, or null when it has no mutes and no allows, so its reads stay
 * exactly as anyone's. One query reads the choices; when any exist, one recursive query
 * walks each place mute and place allow down its places, the nearest choice winning.
 */
export async function readMuteSet(residentId: number, query: MuteQuery = defaultQuery): Promise<MuteSet | null> {
  const rows = await query`/* private:reader-mutes */
    SELECT choice.target_type, choice.target_id, choice.choice, choice.show_anyway, muted.handle
    FROM resident_mutes choice
    LEFT JOIN residents muted ON choice.target_type = 'resident' AND muted.id = choice.target_id
    WHERE choice.resident_id = ${residentId}
  `
  if (rows.length === 0) return null
  const residents = new Set<number>()
  const residentHandles = new Set<string>()
  const notes = { muted: new Set<number>(), allowed: new Set<number>() }
  const things = { muted: new Set<number>(), allowed: new Set<number>() }
  const kinds = new Set<number>()
  const showAnyway = { notes: new Set<number>(), things: new Set<number>(), places: new Set<number>() }
  for (const row of rows) {
    const id = Number(row.target_id)
    const allow = row.choice === 'allow'
    if (allow && row.show_anyway === true) {
      const kept = row.target_type === 'note' ? showAnyway.notes
        : row.target_type === 'thing' ? showAnyway.things
          : row.target_type === 'place' ? showAnyway.places : null
      kept?.add(id)
    }
    if (row.target_type === 'resident' && !allow) {
      // A mute saved on a founder account before #159 covers nothing.
      if (isFounderResident(id)) continue
      residents.add(id)
      if (typeof row.handle === 'string') residentHandles.add(row.handle)
    } else if (row.target_type === 'note') {
      (allow ? notes.allowed : notes.muted).add(id)
    } else if (row.target_type === 'thing') {
      (allow ? things.allowed : things.muted).add(id)
    } else if (row.target_type === 'kind' && !allow) {
      kinds.add(id)
    }
  }
  const [places] = await query`/* private:reader-muted-places */
    WITH RECURSIVE choices AS MATERIALIZED (
      SELECT target_id AS place_id, choice
      FROM resident_mutes
      WHERE resident_id = ${residentId} AND target_type = 'place'
    ), walk(id, choice) AS (
      SELECT place.id, choices.choice
      FROM choices JOIN places place ON place.id = choices.place_id
      UNION
      SELECT child.id, walk.choice
      FROM walk JOIN places child ON child.parent_id = walk.id
      WHERE NOT EXISTS (SELECT 1 FROM choices nearer WHERE nearer.place_id = child.id)
    )
    SELECT
      coalesce((SELECT array_agg(handle) FROM residents WHERE id = ANY(${[...FOUNDER_RESIDENT_IDS]}::integer[])),
        '{}'::text[]) AS founder_handles,
      (SELECT handle FROM residents WHERE id = ${residentId}) AS reader_handle,
      coalesce((SELECT array_agg(id) FROM walk WHERE choice = 'mute'), '{}'::integer[]) AS muted_places
  `
  const mutedPlaces = Array.isArray(places?.muted_places) ? places.muted_places.map(Number) : []
  const founderHandles: string[] = Array.isArray(places?.founder_handles)
    ? places.founder_handles.filter((handle: unknown): handle is string => typeof handle === 'string') : []
  return Object.freeze({
    readerId: residentId,
    readerHandle: typeof places?.reader_handle === 'string' ? places.reader_handle : null,
    founderHandles: new Set(founderHandles),
    residents,
    residentHandles,
    notes: Object.freeze(notes),
    things: Object.freeze(things),
    kinds,
    mutedPlaces: new Set(mutedPlaces),
    showAnyway: Object.freeze(showAnyway),
  })
}

/** Muted residents of one reader, for the pending-ping reads that load nothing else. */
export async function readMutedResidentIds(residentId: number, query: MuteQuery = defaultQuery): Promise<readonly number[]> {
  const rows = await query`/* private:reader-muted-residents */
    SELECT target_id FROM resident_mutes
    WHERE resident_id = ${residentId} AND target_type = 'resident' AND choice = 'mute'
  `
  return Object.freeze(rows.map(row => Number(row.target_id)).filter(id => !isFounderResident(id)))
}

/**
 * Two CTEs for one statement whose $1 is the reader: reader_choices (its mutes and
 * allows) and reader_muted_places (every place a place mute covers, after the allows
 * inside it). The same rule as readMuteSet, for reads that count in SQL.
 */
export const READER_MUTES_SQL = `reader_choices AS MATERIALIZED (
    SELECT target_type, target_id, choice FROM resident_mutes WHERE resident_id = $1::integer
  ), reader_muted_places AS MATERIALIZED (
    WITH RECURSIVE walk(id, choice) AS (
      SELECT place.id, choice.choice
      FROM reader_choices choice JOIN places place ON place.id = choice.target_id
      WHERE choice.target_type = 'place'
      UNION
      SELECT child.id, walk.choice
      FROM walk JOIN places child ON child.parent_id = walk.id
      WHERE NOT EXISTS (
        SELECT 1 FROM reader_choices nearer
        WHERE nearer.target_type = 'place' AND nearer.target_id = child.id
      )
    )
    SELECT id FROM walk WHERE choice = 'mute'
  )`

// The founder ids as an SQL list; they are whole-number constants, never caller input.
const FOUNDER_IDS_SQL = FOUNDER_RESIDENT_IDS.map(id => String(Math.trunc(id))).join(', ')

/** SQL: true when the reader's mutes hide this note (alias with id, author_id, place_id). */
export function readerMutedNoteSql(note: string): string {
  return `(${note}.author_id NOT IN (${FOUNDER_IDS_SQL}, $1::integer)
      AND NOT EXISTS (SELECT 1 FROM reader_choices choice
        WHERE choice.target_type = 'note' AND choice.target_id = ${note}.id AND choice.choice = 'allow')
      AND (EXISTS (SELECT 1 FROM reader_choices choice WHERE choice.choice = 'mute' AND (
          (choice.target_type = 'note' AND choice.target_id = ${note}.id)
          OR (choice.target_type = 'resident' AND choice.target_id = ${note}.author_id)))
        OR ${note}.place_id IN (SELECT id FROM reader_muted_places)))`
}

/** SQL: true when the reader's mutes hide this thing (alias of a things row). */
export function readerMutedThingSql(thing: string): string {
  return `(${thing}.maker_id NOT IN (${FOUNDER_IDS_SQL}, $1::integer)
      AND ${thing}.owner_id NOT IN (${FOUNDER_IDS_SQL}, $1::integer)
      AND NOT EXISTS (SELECT 1 FROM reader_choices choice
        WHERE choice.target_type = 'thing' AND choice.target_id = ${thing}.id AND choice.choice = 'allow')
      AND (EXISTS (SELECT 1 FROM reader_choices choice WHERE choice.choice = 'mute' AND (
          (choice.target_type = 'thing' AND choice.target_id = ${thing}.id)
          OR (choice.target_type = 'resident' AND choice.target_id = ${thing}.maker_id)
          OR (choice.target_type = 'kind' AND choice.target_id = coalesce(${thing}.as_kind_id, ${thing}.kind_id))))
        OR ${thing}.place_id IN (SELECT id FROM reader_muted_places)))`
}
