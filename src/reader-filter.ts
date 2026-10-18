// One home for shaping a read by its own reader's settings (decisions #154 and #155).
// A read that carries the resident's own key or sign-in may look up that resident's
// reading settings; it still changes nothing, binds nobody for ping summaries, and
// never fails because a credential is missing or wrong. Each read path applies this
// right after its moderation overlay, so later reading settings land in the same place.
// Focus mode is the first setting: while it is on, a read that can send many bodies
// sends outlines, unless that one read asks for show_everything. Mutes and allows are
// the second (decision #156): a read drops what the reader muted, counts it, and on
// request lists it by outline; src/reader-mutes.ts holds the one rule. The reading
// filters are the third (decision #157): the bodies a read still sends go through the
// reader's filters (src/reading-filters.ts), never either founder's, the reader's own, or
// an item it allowed with show_anyway, and the read counts what they described or hid.
import type { Context } from 'hono'
import { readerForShaping } from './core.ts'
import { sql } from './db.ts'
import type { Drawing } from './drawing.ts'
import { judgeMutes, type FilterItemType, type HiddenOutline, type MuteItemType, type MuteJudge, type MuteRefs } from './reader-mutes.ts'
import {
  DEFAULT_READING_FILTERS,
  filterText,
  READING_FILTER_MARKERS,
  textFilter,
  type FilteredText,
  type FilterOutcome,
  type ReadingFilterSetting,
  type TextFilter,
} from './reading-filters.ts'
import { noteFirstLine } from './note-first-line.ts'
import { emptyMuteSet, readMuteSet, type MuteSet } from './resident-mutes.ts'
import { readReadingSettings, type ReadingSettings } from './resident-settings.ts'

export type { FilterItemType, HiddenOutline, MuteItemType, MuteJudge } from './reader-mutes.ts'

export const SHOW_EVERYTHING_REFUSAL =
  'show_everything must be true or false; send true to see every body in this one read'

export const NOTE_VIEW_REFUSAL =
  'note_view must be outline or full; outline sends each of your notes with its size instead of its body'

export const FOCUS_OUTLINE_NEXT_STEP =
  'Focus mode sent outlines only. Read one item by its id for its body, or send show_everything: true with this same read to see every body just this once.'
export const FOCUS_SET_ASIDE_NEXT_STEP =
  'Focus mode is on; show_everything set it aside for this one read only.'

/** The 8 by 8 square every pixel drawing uses. */
const DRAWING_SIDE = 8

/** The reader's reading filters: the text filter, null when no body would change, and drawings. */
export type ReaderFilters = Readonly<{ text: TextFilter | null; drawings: ReadingFilterSetting }>

export type ReaderShape = Readonly<{
  residentId: number
  focus: boolean
  showEverything: boolean
  /** The reader's mutes and allows, or null when it has none. */
  mutes: MuteSet | null
  /** The reader's reading filters, or null when every kind shows and it has no muted words. */
  filters: ReaderFilters | null
}>

/** The filters one reader's saved settings make, or null when nothing would change. */
export function readerFilters(settings: ReadingSettings): ReaderFilters | null {
  const filters = settings.filters ?? DEFAULT_READING_FILTERS
  const text = textFilter(filters, settings.muted_words ?? [])
  if (text === null && filters.drawings === 'show') return null
  return Object.freeze({ text, drawings: filters.drawings })
}

export const HIDDEN_REFUSAL =
  'hidden must be outline; it lists the items your mutes hid on this page by outline (id, type, author, kind, size, date, place)'

export const HIDDEN_NEXT_STEP =
  'Your mutes hid some items here, and the totals still count them. Add hidden=outline to this same read to list them by outline, then let one note, thing or place through with me settings {"allow": {"type": "note", "id": 123}}.'

type QueryValues = Record<string, readonly string[] | undefined>

/** show_everything is absent (false), or exactly true or false once. */
export function parseShowEverything(query: QueryValues): { ok: true; value: boolean } | { ok: false } {
  const values = query.show_everything
  if (!values || values.length === 0) return { ok: true, value: false }
  if (values.length !== 1 || (values[0] !== 'true' && values[0] !== 'false')) return { ok: false }
  return { ok: true, value: values[0] === 'true' }
}

/**
 * Who is reading and how they chose to read. Null for an anonymous read, an invalid
 * credential, or settings that cannot be read now: that read is answered as anyone's.
 */
export async function readerShape(
  c: Context,
  showEverything: boolean,
  readSettings: (residentId: number) => Promise<ReadingSettings> = readReadingSettings,
  readMutes: (residentId: number) => Promise<MuteSet | null> = readMuteSet,
): Promise<ReaderShape | null> {
  const reader = await readerForShaping(c)
  if (!reader) return null
  return residentReaderShape(reader.id, showEverything, readSettings, readMutes)
}

/**
 * The same shape for a read that has already signed its resident in, like me. Settings or
 * mutes that cannot be read fail the read, so a read never sends what its reader muted
 * or chose to have described or hidden.
 */
export async function residentReaderShape(
  residentId: number,
  showEverything: boolean,
  readSettings: (residentId: number) => Promise<ReadingSettings> = readReadingSettings,
  readMutes: (residentId: number) => Promise<MuteSet | null> = readMuteSet,
): Promise<ReaderShape | null> {
  const settings = await readSettings(residentId)
  const mutes = await readMutes(residentId)
  return Object.freeze({
    residentId,
    focus: settings.focus_mode === true,
    showEverything,
    mutes,
    filters: readerFilters(settings),
  })
}

/** hidden is absent, or exactly outline once. */
export function parseHidden(query: QueryValues): { ok: true; outline: boolean } | { ok: false } {
  const values = query.hidden
  if (!values || values.length === 0) return { ok: true, outline: false }
  if (values.length !== 1 || values[0] !== 'outline') return { ok: false }
  return { ok: true, outline: true }
}

/**
 * The judge for one read over the ids it is about to send; null when the reader has no
 * mutes and no reading filters. A reader with filters only gets a judge that hides
 * nothing and knows which items always show.
 */
export async function judgeRead(shape: ReaderShape | null, refs: MuteRefs): Promise<MuteJudge | null> {
  if (shape == null || (shape.mutes == null && shape.filters == null)) return null
  return judgeMutes(shape.mutes ?? emptyMuteSet(shape.residentId), refs)
}

/** Ids of rows, skipping any row without a positive id. */
export function rowIds(rows: readonly unknown[], field = 'id'): number[] {
  return rows.flatMap(row => {
    const value = row !== null && typeof row === 'object' ? Number((row as Record<string, unknown>)[field]) : NaN
    return Number.isSafeInteger(value) && value > 0 ? [value] : []
  })
}

function moderatedOutline(type: string, id: number): HiddenOutline {
  return Object.freeze({ id, type, author: null, kind: null, size: 0, date: null, place_id: null })
}

/**
 * Drop the rows the reader's mutes cover. Hidden rows are dropped, not tombstoned, and
 * come back as outlines for the count and for hidden=outline.
 */
export function splitMuted<T>(
  judge: MuteJudge | null,
  type: MuteItemType,
  rows: readonly T[],
  field = 'id',
): Readonly<{ shown: T[]; hidden: HiddenOutline[]; hiddenRows: T[] }> {
  if (judge === null) return { shown: [...rows], hidden: [], hiddenRows: [] }
  const shown: T[] = []
  const hidden: HiddenOutline[] = []
  const hiddenRows: T[] = []
  for (const row of rows) {
    const id = rowIds([row], field)[0]
    if (id === undefined || !judge.hides(type, id)) {
      shown.push(row)
      continue
    }
    hiddenRows.push(row)
    hidden.push((row as Record<string, unknown>).moderated === true ? moderatedOutline(type, id) : judge.outline(type, id))
  }
  return { shown, hidden, hiddenRows }
}

/** Residents the reader muted, left out of a presence or directory list. */
export function splitMutedResidents<T>(
  judge: MuteJudge | null,
  rows: readonly T[],
  placeId: number | null = null,
): Readonly<{ shown: T[]; hidden: HiddenOutline[] }> {
  if (judge === null) return { shown: [...rows], hidden: [] }
  const shown: T[] = []
  const hidden: HiddenOutline[] = []
  for (const row of rows) {
    const record = row as unknown as Readonly<Record<string, unknown>>
    const id = rowIds([record])[0]
    if ((id !== undefined && judge.hidesResident(id)) || judge.hidesResidentHandle(record.handle)) {
      hidden.push(Object.freeze({
        id: id ?? 0,
        type: 'resident',
        author: typeof record.handle === 'string' ? record.handle : null,
        kind: null,
        size: 0,
        date: null,
        place_id: placeId,
      }))
    } else {
      shown.push(row)
    }
  }
  return { shown, hidden }
}

/** The same for public event rows, which carry their own actor, place and record ids. */
export function splitMutedEvents<T>(
  judge: MuteJudge | null,
  rows: readonly T[],
): Readonly<{ shown: T[]; hidden: HiddenOutline[] }> {
  if (judge === null) return { shown: [...rows], hidden: [] }
  const shown: T[] = []
  const hidden: HiddenOutline[] = []
  for (const row of rows) {
    const record = row as unknown as Readonly<Record<string, unknown>>
    if (judge.hidesEvent(record)) hidden.push(judge.eventOutline(record))
    else shown.push(row)
  }
  return { shown, hidden }
}

/** A front matter heading whose thing the reader's mutes cover. */
function hidesHeading(judge: MuteJudge, heading: unknown): boolean {
  const id = rowIds([heading])[0]
  return id !== undefined && judge.hides('thing', id)
}

/**
 * A place row the reader muted, or one owned by a muted resident, stays listed so the
 * reader can still walk through, marked muted and without its description, purpose or
 * front matter. Any other row keeps its words and loses only the front matter headings
 * the reader's mutes cover; mutedFrontMatter counts those.
 */
export function markMutedPlace<T>(judge: MuteJudge | null, row: T): T {
  if (judge === null || row === null || typeof row !== 'object') return row
  const record = row as unknown as Record<string, unknown>
  const children = Array.isArray(record.children)
    ? Object.freeze(record.children.map(child => markMutedPlace(judge, child)))
    : null
  const id = rowIds([record])[0]
  if (id === undefined || !judge.marksPlace(id)) {
    const headings = Array.isArray(record.front_matter) ? record.front_matter : null
    const kept = headings === null ? null : headings.filter(heading => !hidesHeading(judge, heading))
    const dropsHeadings = headings !== null && kept !== null && kept.length !== headings.length
    if (children === null && !dropsHeadings) return row
    return Object.freeze({
      ...record,
      ...(dropsHeadings ? { front_matter: Object.freeze(kept) } : {}),
      ...(children === null ? {} : { children }),
    }) as unknown as T
  }
  const { description: _description, purpose: _purpose, ...rest } = record
  return Object.freeze({
    ...rest,
    ...(Object.hasOwn(record, 'front_matter') ? { front_matter: Object.freeze([]) } : {}),
    ...(children === null ? {} : { children }),
    muted: true,
  }) as unknown as T
}

/** Every place id in a nested map tree, for one judge over the whole map. */
export function treePlaceIds(rows: readonly unknown[]): number[] {
  return rows.flatMap(row => {
    if (row === null || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    return [...rowIds([record]), ...(Array.isArray(record.children) ? treePlaceIds(record.children) : [])]
  })
}

/** Every front matter thing id in a nested map tree, so the same judge covers them. */
export function treeFrontMatterIds(rows: readonly unknown[]): number[] {
  return rows.flatMap(row => {
    if (row === null || typeof row !== 'object') return []
    const record = row as Record<string, unknown>
    return [
      ...(Array.isArray(record.front_matter) ? rowIds(record.front_matter) : []),
      ...(Array.isArray(record.children) ? treeFrontMatterIds(record.children) : []),
    ]
  })
}

/**
 * The front matter headings markMutedPlace drops from rows it leaves unmarked, once each,
 * as outlines for the count and for hidden=outline. A marked row's front matter goes with
 * its words and is not counted, like its description.
 */
export function mutedFrontMatter(judge: MuteJudge | null, rows: readonly unknown[]): HiddenOutline[] {
  if (judge === null) return []
  const hidden = new Map<number, HiddenOutline>()
  const walk = (list: readonly unknown[]): void => {
    for (const row of list) {
      if (row === null || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const id = rowIds([record])[0]
      if ((id === undefined || !judge.marksPlace(id)) && Array.isArray(record.front_matter)) {
        for (const thingId of rowIds(record.front_matter)) {
          if (judge.hides('thing', thingId) && !hidden.has(thingId)) hidden.set(thingId, judge.outline('thing', thingId))
        }
      }
      if (Array.isArray(record.children)) walk(record.children)
    }
  }
  walk(rows)
  return [...hidden.values()]
}

/**
 * The count every signed-in list answer carries once its reader has any mutes: how many
 * items this page hid, a next step when any were hidden, and the outlines on request.
 * Empty for every other reader, so its answer stays exactly as before.
 */
export function mutesFields(
  shape: ReaderShape | null,
  hidden: readonly HiddenOutline[],
  wantOutline: boolean,
): Readonly<Record<string, unknown>> {
  if (shape?.mutes == null) return {}
  return Object.freeze({
    hidden_by_your_mutes: hidden.length,
    ...(hidden.length > 0 ? { hidden_next_step: HIDDEN_NEXT_STEP } : {}),
    ...(wantOutline ? { hidden_items: Object.freeze([...hidden]) } : {}),
  })
}

const ALLOWABLE: readonly string[] = ['note', 'thing', 'place']

/** What a direct read of one muted item says instead of its body. */
export function mutedItemNextStep(type: string, id: number): string {
  return ALLOWABLE.includes(type)
    ? `Your mutes hide this ${type}, so only its outline was sent. To read it, let it through with me settings {"allow": {"type": "${type}", "id": ${id}}}, or unmute what covers it.`
    : `Your mutes hide this ${type}, so only its outline was sent. To read it, unmute what covers it with me settings {"unmute": {"type": ..., "id": ...}}; settings "show" lists your mutes.`
}

/** The answer to a direct read of one muted item: its outline and the way to see it. */
export function mutedReadAnswer(key: string, outline: HiddenOutline): Readonly<Record<string, unknown>> {
  return Object.freeze({
    [key]: outline,
    hidden_by_your_mutes: 1,
    next_step: mutedItemNextStep(outline.type, outline.id),
  })
}

/** An answer made for one reader is never shared from a cache. */
export function markReaderShaped(c: Context, shape: ReaderShape | null): void {
  if (shape === null) return
  c.header('Cache-Control', 'private, no-store')
  c.header('Vary', 'Authorization')
}

/** Focus mode is on and this read did not ask to see everything. */
export function sendsOutlinesOnly(shape: ReaderShape | null): boolean {
  return shape !== null && shape.focus && !shape.showEverything
}

function sentBody(row: unknown, bodyFields: readonly string[]): boolean {
  if (row === null || typeof row !== 'object') return false
  const record = row as Record<string, unknown>
  return bodyFields.some(field => record[field] !== undefined && record[field] !== null)
}

/**
 * What focus mode did in this one answer: how many items it covers and how many
 * bodies it sent. Counted inside the answer only; the city keeps no record of it.
 * Null when focus mode is off, so the answer stays exactly as before.
 */
export function readingBlock(
  shape: ReaderShape | null,
  rows: readonly unknown[],
  bodyFields: readonly string[],
): Readonly<Record<string, unknown>> | null {
  if (shape === null || !shape.focus) return null
  return Object.freeze({
    focus_mode: true,
    items: rows.length,
    bodies_sent: rows.filter(row => sentBody(row, bodyFields)).length,
    show_everything: shape.showEverything,
    next_step: shape.showEverything ? FOCUS_SET_ASIDE_NEXT_STEP : FOCUS_OUTLINE_NEXT_STEP,
  })
}

/** One body-carrying row as its outline: the body becomes its UTF-8 size. */
export function bodyOutline<T extends Readonly<Record<string, unknown>>>(
  row: T,
  bodyField = 'body',
): Readonly<Record<string, unknown>> {
  const { [bodyField]: body, ...rest } = row
  if (typeof body !== 'string') return row
  return Object.freeze({ ...rest, [`${bodyField}_text_bytes`]: Buffer.byteLength(body, 'utf8') })
}

type DrawingCarrier = Readonly<{ drawing: Drawing | null; rows: readonly string[] | null }>

/**
 * A drawing as its outline: its size and the colours it uses, never its cells.
 * Undrawn and refused drawings carry no cells and stay as they are.
 */
export function drawingOutline<T extends DrawingCarrier>(snapshot: T): Readonly<Record<string, unknown>> {
  if (snapshot.drawing === null) return snapshot
  const { drawing, rows: _rows, ...rest } = snapshot
  const used = new Set(drawing.indices.filter((index): index is number => index !== null))
  return Object.freeze({
    ...rest,
    outline: Object.freeze({
      width: DRAWING_SIDE,
      height: DRAWING_SIDE,
      colours_used: Object.freeze(drawing.palette.filter((_colour, index) => used.has(index))),
    }),
  })
}

/**
 * A drawing of a record the reader muted: its outline without the words its author wrote
 * about it (description) or a variant's name, so a muted drawing read sends no body.
 */
export function mutedDrawingOutline<T extends DrawingCarrier>(snapshot: T): Readonly<Record<string, unknown>> {
  const { description: _description, variant_name: _variantName, ...rest } = drawingOutline(snapshot) as Record<string, unknown>
  return Object.freeze(rest)
}

const OUTCOME_RANK: Readonly<Record<FilterOutcome, number>> = Object.freeze({ shown: 0, described: 1, hidden: 2 })

/** What one read's reading filters did, and how to run them over its bodies. */
export interface ReadFilter {
  /**
   * One row's text fields through the reader's filters, unless the row always shows. A
   * row whose text a filter hides sends a marker in each of those fields, with its size.
   */
  row<T>(type: FilterItemType, row: T, fields: readonly string[], idField?: string): T
  /** One drawing: its cells through the drawings filter, its description through the text filters. */
  drawing(type: FilterItemType, id: number, snapshot: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>>
  /** covered_by_your_filters: how many items this answer's filters described and hid. */
  fields(): Readonly<Record<string, unknown>>
}

function stringField(row: Readonly<Record<string, unknown>>, field: string): string | null {
  const value = row[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

type BodiesQuery = (text: string, params: readonly unknown[]) => Promise<Record<string, unknown>[]>
const defaultBodiesQuery: BodiesQuery = async (text, params) => (
  await sql.query(text, [...params]) as Record<string, unknown>[]
)

const NO_BODIES: ReadonlyMap<number, string> = new Map()

/**
 * The stored bodies of the notes a read sends only a first line of (a walk-to-read note
 * read remotely, a Gazette headline), so the reader's filters judge the whole body, not a
 * line cut at 200 characters. A body is kept only when the row's first line is exactly
 * that body's first line, so a city line in its place (a removal or withdrawal notice) is
 * never replaced. Empty, with no query, when the reader has no text filters on.
 */
export async function firstLineBodies(
  shape: ReaderShape | null,
  rows: readonly unknown[],
  idField = 'id',
  query: BodiesQuery = defaultBodiesQuery,
): Promise<ReadonlyMap<number, string>> {
  if (shape?.filters?.text == null) return NO_BODIES
  const lines = new Map<number, string>()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const source = row as Readonly<Record<string, unknown>>
    if (source.moderated === true || typeof source.body === 'string') continue
    const id = rowIds([source], idField)[0]
    if (id !== undefined && typeof source.first_line === 'string' && source.first_line.length > 0) {
      lines.set(id, source.first_line)
    }
  }
  if (lines.size === 0) return NO_BODIES
  const found = await query(
    '/* private:reader-filter-first-line-bodies */ SELECT id, body FROM notes WHERE id = ANY($1::integer[])',
    [[...lines.keys()]],
  )
  return new Map(found.flatMap(row => {
    const id = Number(row.id)
    return typeof row.body === 'string' && noteFirstLine(row.body) === lines.get(id) ? [[id, row.body] as const] : []
  }))
}

/**
 * A note's first line through the reader's filters, judged on its whole body: hidden when
 * the body is hidden, else the first line of the described body.
 */
function firstLineThroughFilter(filter: TextFilter, line: string, body: string): FilteredText {
  const whole = filterText(filter, body)
  if (whole.outcome === 'hidden') return whole
  if (whole.outcome === 'shown') return { text: line, outcome: 'shown' }
  const described = noteFirstLine(whole.text)
  return described === line ? { text: line, outcome: 'shown' } : { text: described, outcome: 'described' }
}

/**
 * The filter for one read, or null when its reader has no reading filters on. A note row
 * that sends only its first line is judged on the whole body in noteBodies (see
 * firstLineBodies), or on its own body when the row carries one.
 */
export function readFilter(
  shape: ReaderShape | null,
  judge: MuteJudge | null,
  noteBodies: ReadonlyMap<number, string> = NO_BODIES,
): ReadFilter | null {
  const filters = shape?.filters ?? null
  if (filters === null) return null
  const outcomes = new Map<string, FilterOutcome>()
  let unnamed = 0
  const record = (key: string, outcome: FilterOutcome): void => {
    const before = outcomes.get(key)
    if (before === undefined || OUTCOME_RANK[outcome] > OUTCOME_RANK[before]) outcomes.set(key, outcome)
  }
  const skips = (type: FilterItemType, id: number | undefined): boolean => (
    id !== undefined && judge !== null && judge.skipsFilters(type, id)
  )
  const filterRow = <T>(type: FilterItemType, row: T, fields: readonly string[], idField = 'id'): T => {
    if (filters.text === null || row === null || typeof row !== 'object') return row
    const source = row as unknown as Readonly<Record<string, unknown>>
    if (source.moderated === true) return row
    const id = rowIds([source], idField)[0]
    if (skips(type, id)) return row
    const ownBody = stringField(source, 'body')
    const wholeBody = (id === undefined ? undefined : noteBodies.get(id))
      ?? (ownBody !== null && noteFirstLine(ownBody) === source.first_line ? ownBody : undefined)
    const results = fields.flatMap(field => {
      const text = stringField(source, field)
      if (text === null) return []
      const result = type === 'note' && field === 'first_line' && wholeBody !== undefined
        ? firstLineThroughFilter(filters.text!, text, wholeBody)
        : filterText(filters.text!, text)
      return [{ field, text, result }]
    })
    const changed = results.filter(entry => entry.result.outcome !== 'shown')
    if (changed.length === 0) return row
    const key = id === undefined ? `unnamed:${unnamed++}` : `${type}:${id}`
    const hidden = changed.find(entry => entry.result.outcome === 'hidden')
    if (hidden !== undefined) {
      record(key, 'hidden')
      const replaced = Object.fromEntries(results.flatMap(entry => [
        [entry.field, hidden.result.text],
        ...(Object.hasOwn(source, `${entry.field}_text_bytes`)
          ? []
          : [[`${entry.field}_text_bytes`, Buffer.byteLength(entry.text, 'utf8')]]),
      ]))
      return Object.freeze({ ...source, ...replaced }) as unknown as T
    }
    record(key, 'described')
    return Object.freeze({
      ...source,
      ...Object.fromEntries(changed.map(entry => [entry.field, entry.result.text])),
    }) as unknown as T
  }
  return Object.freeze({
    row: filterRow,
    drawing(type: FilterItemType, id: number, snapshot: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
      if (skips(type, id)) return snapshot
      const key = `${type}:${id}:drawing:${unnamed++}`
      let shown: Readonly<Record<string, unknown>> = snapshot
      // Only a drawing that still carries its cells is filtered; an outline has none.
      if (snapshot.drawing != null && filters.drawings !== 'show') {
        if (filters.drawings === 'describe') {
          shown = drawingOutline(snapshot as unknown as DrawingCarrier)
          record(key, 'described')
        } else {
          const { drawing: _drawing, rows: _rows, ...rest } = snapshot
          shown = Object.freeze({ ...rest, filter_marker: READING_FILTER_MARKERS.drawings })
          record(key, 'hidden')
        }
      }
      const description = stringField(shown, 'description')
      if (filters.text === null || description === null) return shown
      const result = filterText(filters.text, description)
      if (result.outcome === 'shown') return shown
      record(key, result.outcome)
      return Object.freeze({ ...shown, description: result.text })
    },
    fields(): Readonly<Record<string, unknown>> {
      const counted = [...outcomes.values()]
      return Object.freeze({
        covered_by_your_filters: Object.freeze({
          described: counted.filter(outcome => outcome === 'described').length,
          hidden: counted.filter(outcome => outcome === 'hidden').length,
        }),
      })
    },
  })
}

/** The count block of a read's filters, or nothing when its reader has none on. */
export function filterFields(filter: ReadFilter | null): Readonly<Record<string, unknown>> {
  return filter === null ? {} : filter.fields()
}

/** The resident-written text fields each kind of row carries. Names and labels are not bodies. */
export const FILTERED_FIELDS = Object.freeze({
  place: Object.freeze(['description', 'purpose']),
  note: Object.freeze(['body', 'first_line']),
  thing: Object.freeze(['body']),
  line: Object.freeze(['body']),
  kind: Object.freeze(['description']),
  trait: Object.freeze(['description']),
  agreement: Object.freeze(['body']),
})

/** Rows through a read's filters; the rows themselves when its reader has none on. */
export function filterRows<T>(
  filter: ReadFilter | null,
  type: keyof typeof FILTERED_FIELDS,
  rows: readonly T[],
  idField = 'id',
): T[] {
  return filter === null ? [...rows] : rows.map(row => filter.row(type, row, FILTERED_FIELDS[type], idField))
}

/** One row through a read's filters; the row itself when its reader has none on. */
export function filterOne<T>(filter: ReadFilter | null, type: keyof typeof FILTERED_FIELDS, row: T, idField = 'id'): T {
  return filter === null ? row : filter.row(type, row, FILTERED_FIELDS[type], idField)
}

/** A place row and every nested child, as the map sends them, through a read's filters. */
export function filterPlaceTree<T>(filter: ReadFilter | null, row: T): T {
  if (filter === null || row === null || typeof row !== 'object') return row
  const filtered = filter.row('place', row, FILTERED_FIELDS.place) as unknown as Record<string, unknown>
  if (!Array.isArray(filtered.children)) return filtered as unknown as T
  return Object.freeze({
    ...filtered,
    children: Object.freeze(filtered.children.map(child => filterPlaceTree(filter, child))),
  }) as unknown as T
}

const HIDDEN_MARKERS: ReadonlySet<unknown> = new Set(Object.values(READING_FILTER_MARKERS))

/** Whether the reader's filters hid this row's body, so a piece of it means nothing. */
export function filtersHidBody(row: unknown, field = 'body'): boolean {
  return row !== null && typeof row === 'object' && HIDDEN_MARKERS.has((row as Record<string, unknown>)[field])
}
