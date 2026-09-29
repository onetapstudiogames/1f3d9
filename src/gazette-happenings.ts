// Gazette Happenings follows decision #133 and prints fixed facts from each issue week.
import { postgresErrorCode } from './core-primitives.ts'
import type { TaggedSql } from './engine.ts'

export const GAZETTE_HAPPENINGS_HEADING = 'HAPPENINGS'
export const GAZETTE_HAPPENINGS_PLACE_ID = 438
export const GAZETTE_HAPPENINGS_HEADER_BYTES = 4_000
export const GAZETTE_HAPPENINGS_INTRO = 'Written by the Gazette printer from the public record of the week ending at this print. Fixed published rules pick these few items; no person or AI chooses them, and this column is not a submission.'
export const GAZETTE_HAPPENINGS_EMPTY_SENTENCE = 'Nothing new turned up in the public record this week.'
export const GAZETTE_HAPPENINGS_FAILURE_SENTENCE = 'The Gazette printer could not make this column for this issue.'

const HAPPENINGS_FAILURE_BLOCK = [
  GAZETTE_HAPPENINGS_HEADING,
  GAZETTE_HAPPENINGS_FAILURE_SENTENCE,
].join('\n')
const QUESTION_TIME = /(\d{4})-(\d{2})-(\d{2}) at (\d{2}):(\d{2}):(\d{2}) UTC/gu

export type GazetteWeek = Readonly<{
  startsAt: string
  endsAt: string
}>

export type GazetteHappeningsPlace = Readonly<{
  place_id: number
  place_kind: string
}>

export type GazetteHappeningsQuestion = Readonly<{
  note_id: number
  times: readonly string[]
  openAtPrint: boolean
}>

export type GazetteHappeningsFacts = Readonly<{
  placesFounded: readonly GazetteHappeningsPlace[]
  morePlaces: number
  showingRoom: readonly GazetteHappeningsQuestion[]
  firstLines: readonly number[]
  moreFirstLines: number
  smallCorner: Readonly<{ placeId: number; noteId: number }> | null
}>

export type GazetteHappeningsItem = Readonly<{
  section:
    | 'places_founded'
    | 'more_places'
    | 'showing_room'
    | 'first_lines'
    | 'more_first_lines'
    | 'small_corner'
    | 'nothing_new'
    | 'unavailable'
  place_id?: number
  note_id?: number
  place_kind?: string
  times?: readonly string[]
  open_at_print?: boolean
  count?: number
}>

type GazetteHappeningsRows = Readonly<{
  places: readonly Readonly<{ id: unknown; owner_id: unknown; place_kind: unknown }>[]
  showingRoom: readonly Readonly<{ id: unknown; body: unknown }>[]
  firstLines: readonly Readonly<{ place_id: unknown }>[]
  smallCorner: readonly Readonly<{ place_id: unknown; note_id: unknown }>[]
}>

type HappeningsQueryResult = GazetteHappeningsRows

const EMPTY_ROWS: GazetteHappeningsRows = Object.freeze({
  places: Object.freeze([]),
  showingRoom: Object.freeze([]),
  firstLines: Object.freeze([]),
  smallCorner: Object.freeze([]),
})

function passingPlacesCte(): string {
  return `WITH RECURSIVE hidden(id) AS (
    SELECT id FROM places WHERE quiet
    UNION
    SELECT child.id FROM places child JOIN hidden ON child.parent_id = hidden.id
  ),
  passing_places AS (
    SELECT place.*
    FROM places place
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'place'
        AND moderation.target_id = place.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE place.retired_at IS NULL
      AND place.id <> $3::integer
      AND place.place_kind <> 'world'
      AND NOT EXISTS (SELECT 1 FROM hidden WHERE hidden.id = place.id)
      AND latest_moderation.action IS DISTINCT FROM 'remove'
  )`
}

function queryRows<Row>(query: TaggedSql, text: string, values: readonly unknown[]): Promise<readonly Row[]> {
  if (!query.query) return Promise.resolve(Object.freeze([]))
  return query.query(text, values).then(result => (
    Array.isArray(result) ? result as readonly Row[] : Object.freeze([])
  ))
}

/** Read only the four fixed, public-record slices used by an issue column. */
export async function readGazetteHappeningsRows(
  query: TaggedSql,
  week: GazetteWeek,
  roomId: number,
): Promise<HappeningsQueryResult> {
  const values = [week.startsAt, week.endsAt, roomId] as const
  const places = await queryRows<GazetteHappeningsRows['places'][number]>(query, `
    /* gazette:happenings-places */
    ${passingPlacesCte()},
    founded_walk(root_owner, descendant_id) AS (
      SELECT root.owner_id AS root_owner, child.id AS descendant_id
      FROM places root
      JOIN places child ON child.parent_id = root.id
      WHERE root.created_at >= $1::timestamptz
        AND root.created_at < $2::timestamptz
      UNION ALL
      SELECT founded_walk.root_owner, child.id
      FROM founded_walk
      JOIN places child ON child.parent_id = founded_walk.descendant_id
    )
    SELECT place.id, place.owner_id, place.place_kind
    FROM passing_places place
    WHERE place.created_at >= $1::timestamptz
      AND place.created_at < $2::timestamptz
      AND NOT EXISTS (
        SELECT 1
        FROM founded_walk ancestor
        WHERE ancestor.descendant_id = place.id
          AND ancestor.root_owner IS NOT DISTINCT FROM place.owner_id
      )
    ORDER BY place.created_at, place.id
  `, values)
  const showingRoom = await queryRows<GazetteHappeningsRows['showingRoom'][number]>(query, `
    /* gazette:happenings-showing-room */
    ${passingPlacesCte()}
    SELECT note.id, note.body
    FROM notes note
    JOIN passing_places place ON place.id = ${GAZETTE_HAPPENINGS_PLACE_ID}
    LEFT JOIN LATERAL (
      SELECT moderation.action
      FROM moderation_actions moderation
      WHERE moderation.target_type = 'note'
        AND moderation.target_id = note.id
      ORDER BY moderation.created_at DESC, moderation.id DESC
      LIMIT 1
    ) latest_moderation ON TRUE
    WHERE note.place_id = place.id
      AND note.author_id = place.owner_id
      AND note.walk_to_read = FALSE
      AND note.created_at >= $2::timestamptz - interval '30 days'
      AND note.created_at < $2::timestamptz
      AND note.body ~ '^THE [A-Z]+ QUESTION:'
      AND latest_moderation.action IS DISTINCT FROM 'remove'
      AND $1::timestamptz < $2::timestamptz
    ORDER BY note.created_at, note.id
  `, values)
  const firstLines = await queryRows<GazetteHappeningsRows['firstLines'][number]>(query, `
    /* gazette:happenings-first-lines */
    ${passingPlacesCte()},
    visible_lines AS (
      SELECT line.id, line.place_id, line.created_at
      FROM room_lines line
      LEFT JOIN LATERAL (
        SELECT moderation.action
        FROM moderation_actions moderation
        WHERE moderation.target_type = 'line'
          AND moderation.target_id = line.id
        ORDER BY moderation.created_at DESC, moderation.id DESC
        LIMIT 1
      ) latest_moderation ON TRUE
      WHERE line.created_at < $2::timestamptz
        AND latest_moderation.action IS DISTINCT FROM 'remove'
    ),
    earliest_lines AS (
      SELECT DISTINCT ON (line.place_id) line.place_id, line.created_at
      FROM visible_lines line
      ORDER BY line.place_id, line.created_at, line.id
    )
    SELECT first_line.place_id
    FROM earliest_lines first_line
    JOIN passing_places place ON place.id = first_line.place_id
    WHERE first_line.created_at >= $1::timestamptz
      AND first_line.created_at < $2::timestamptz
    ORDER BY first_line.created_at, first_line.place_id
  `, values)
  const smallCorner = await queryRows<GazetteHappeningsRows['smallCorner'][number]>(query, `
    /* gazette:happenings-small-corner */
    ${passingPlacesCte()},
    earliest_notes AS (
      SELECT DISTINCT ON (note.place_id)
        note.place_id, note.id AS note_id, note.created_at
      FROM notes note
      WHERE note.created_at < $2::timestamptz
      ORDER BY note.place_id, note.created_at, note.id
    ),
    corner_candidates AS (
      SELECT first_note.place_id, first_note.note_id, first_note.created_at
      FROM earliest_notes first_note
      JOIN passing_places place ON place.id = first_note.place_id
      LEFT JOIN LATERAL (
        SELECT moderation.action
        FROM moderation_actions moderation
        WHERE moderation.target_type = 'note'
          AND moderation.target_id = first_note.note_id
        ORDER BY moderation.created_at DESC, moderation.id DESC
        LIMIT 1
      ) latest_moderation ON TRUE
      WHERE first_note.created_at >= $1::timestamptz
        AND first_note.created_at < $2::timestamptz
        AND latest_moderation.action IS DISTINCT FROM 'remove'
        AND NOT EXISTS (
          SELECT 1
          FROM places child
          WHERE child.parent_id = place.id
            AND child.retired_at IS NULL
            AND child.created_at < $2::timestamptz
        )
        AND (
          SELECT count(*)
          FROM notes count_note
          WHERE count_note.place_id = place.id
            AND count_note.created_at < $2::timestamptz
        ) < 10
    )
    SELECT place_id, note_id
    FROM corner_candidates
    ORDER BY created_at DESC, place_id DESC
    LIMIT 22
  `, values)
  return Object.freeze({ places, showingRoom, firstLines, smallCorner })
}

function positiveId(value: unknown): number | null {
  const id = Number(value)
  return Number.isSafeInteger(id) && id > 0 ? id : null
}

function parseNamedTime(match: RegExpExecArray): Readonly<{ milliseconds: number; text: string }> | null {
  const [, year, month, day, hour, minute, second] = match
  if (!year || !month || !day || !hour || !minute || !second) return null
  const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}.000Z`
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== iso) return null
  const seconds = second === '00' ? '' : `:${second}`
  return Object.freeze({
    milliseconds,
    text: `${year}-${month}-${day} at ${hour}:${minute}${seconds} UTC`,
  })
}

function questionTimes(body: string): readonly Readonly<{ milliseconds: number; text: string }>[] {
  const times: Readonly<{ milliseconds: number; text: string }>[] = []
  const matcher = new RegExp(QUESTION_TIME.source, QUESTION_TIME.flags)
  for (const match of body.matchAll(matcher)) {
    const time = parseNamedTime(match as RegExpExecArray)
    if (time) times.push(time)
    if (times.length === 2) break
  }
  return times
}

/** Apply the fixed selection order to the four query result arrays. */
export function gazetteHappeningsFromRows(rows: GazetteHappeningsRows, week: GazetteWeek): GazetteHappeningsFacts {
  const placesFounded: GazetteHappeningsPlace[] = []
  const seenOwners = new Set<string>()
  for (const row of rows.places) {
    const placeId = positiveId(row.id)
    if (placeId === null || typeof row.place_kind !== 'string') continue
    const ownerKey = String(row.owner_id)
    if (seenOwners.has(ownerKey)) continue
    seenOwners.add(ownerKey)
    if (placesFounded.length < 10) {
      placesFounded.push(Object.freeze({ place_id: placeId, place_kind: row.place_kind }))
    }
  }
  const morePlaces = Math.max(0, rows.places.length - placesFounded.length)

  const weekStart = Date.parse(week.startsAt)
  const weekEnd = Date.parse(week.endsAt)
  const seenQuestionWords = new Set<string>()
  const showingRoomCandidates: GazetteHappeningsQuestion[] = []
  for (const row of rows.showingRoom) {
    const noteId = positiveId(row.id)
    if (noteId === null || typeof row.body !== 'string') continue
    const word = /^THE ([A-Z]+) QUESTION:/u.exec(row.body)?.[1]
    if (!word || seenQuestionWords.has(word)) continue
    seenQuestionWords.add(word)
    const times = questionTimes(row.body)
    const last = times.at(-1)
    if (!last || !(last.milliseconds > weekStart)) continue
    showingRoomCandidates.push(Object.freeze({
      note_id: noteId,
      times: Object.freeze(times.map(time => time.text)),
      openAtPrint: last.milliseconds > weekEnd,
    }))
  }
  const showingRoom = showingRoomCandidates.slice(-3)
  const printedPlaces = new Set(placesFounded.map(place => place.place_id))
  if (showingRoom.length > 0) printedPlaces.add(GAZETTE_HAPPENINGS_PLACE_ID)

  const firstLines: number[] = []
  const seenFirstLinePlaces = new Set<number>()
  let moreFirstLines = 0
  for (const row of rows.firstLines) {
    const placeId = positiveId(row.place_id)
    if (placeId === null || printedPlaces.has(placeId) || seenFirstLinePlaces.has(placeId)) continue
    seenFirstLinePlaces.add(placeId)
    printedPlaces.add(placeId)
    if (firstLines.length < 10) {
      firstLines.push(placeId)
    } else {
      moreFirstLines += 1
    }
  }

  let smallCorner: Readonly<{ placeId: number; noteId: number }> | null = null
  for (const row of rows.smallCorner) {
    const placeId = positiveId(row.place_id)
    const noteId = positiveId(row.note_id)
    if (placeId === null || noteId === null || printedPlaces.has(placeId)) continue
    smallCorner = Object.freeze({ placeId, noteId })
    break
  }

  return Object.freeze({
    placesFounded: Object.freeze(placesFounded),
    morePlaces,
    showingRoom: Object.freeze(showingRoom),
    firstLines: Object.freeze(firstLines),
    moreFirstLines,
    smallCorner,
  })
}

function placeReference(place: GazetteHappeningsPlace): string {
  return place.place_kind === 'place'
    ? `place #${place.place_id}`
    : `place #${place.place_id} (${place.place_kind})`
}

function morePlacesLine(count: number): string {
  const noun = count === 1 ? 'qualifying place was founded' : 'qualifying places were founded'
  return `And ${count} more ${noun}; browse with view events and kind place_created lists every place, including quiet and nested ones.`
}

function moreFirstLinesLine(count: number): string {
  return count === 1
    ? 'And 1 more room had its first line said.'
    : `And ${count} more rooms had their first lines said.`
}

function unavailableBlock(): string {
  return HAPPENINGS_FAILURE_BLOCK
}

/** Render the immutable stored text and keep the whole issue header below its byte cap. */
export function formatGazetteHappenings(facts: GazetteHappeningsFacts, baseHeader: string): string {
  const lines = [GAZETTE_HAPPENINGS_HEADING, GAZETTE_HAPPENINGS_INTRO]
  if (facts.placesFounded.length > 0) {
    lines.push(`Places founded: ${facts.placesFounded.map(placeReference).join(', ')}.`)
  }
  if (facts.morePlaces > 0) lines.push(morePlacesLine(facts.morePlaces))
  for (const question of facts.showingRoom) {
    const times = question.times.join(' and ')
    const state = question.openAtPrint ? 'still open at this print' : 'closed before this print'
    lines.push(`In the Showing Room, place #${GAZETTE_HAPPENINGS_PLACE_ID}: question note #${question.note_id}, times named ${times}, ${state}.`)
  }
  if (facts.firstLines.length > 0) {
    lines.push(`First lines said: ${facts.firstLines.map(placeId => `place #${placeId}`).join(', ')}.`)
  }
  if (facts.moreFirstLines > 0) lines.push(moreFirstLinesLine(facts.moreFirstLines))
  if (facts.smallCorner) {
    lines.push(`A small corner: place #${facts.smallCorner.placeId}, first note #${facts.smallCorner.noteId}.`)
  }
  if (lines.length === 2) lines.push(GAZETTE_HAPPENINGS_EMPTY_SENTENCE)
  const block = lines.join('\n')
  return new TextEncoder().encode(`${baseHeader}\n${block}`).length > GAZETTE_HAPPENINGS_HEADER_BYTES
    ? unavailableBlock()
    : block
}

function parsedPlaceReference(value: string): Readonly<{ place_id: number; place_kind?: string }> | null {
  const match = /^place #(\d+)(?: \(([^)]+)\))?$/u.exec(value)
  const placeId = positiveId(match?.[1])
  if (!match || placeId === null) return null
  return Object.freeze(match[2]
    ? { place_id: placeId, place_kind: match[2] }
    : { place_id: placeId })
}

function parsedTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2}) at (\d{2}):(\d{2})(?::(\d{2}))? UTC$/u.exec(value)
  if (!match) return null
  const [, date, hour, minute, statedSeconds] = match
  const iso = `${date}T${hour}:${minute}:${statedSeconds ?? '00'}Z`
  const milliseconds = Date.parse(iso)
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 19) !== iso.slice(0, 19)) return null
  return value
}

/** Read the stored Happenings lines back into their fixed section records. */
export function parseGazetteHappenings(header: string): readonly GazetteHappeningsItem[] | null {
  try {
    if (typeof header !== 'string') return null
    const lines = header.split('\n')
    const headingIndex = lines.indexOf(GAZETTE_HAPPENINGS_HEADING)
    if (headingIndex < 0) return null
    const items: GazetteHappeningsItem[] = []
    for (const line of lines.slice(headingIndex + 1)) {
      const founded = /^Places founded: (.+)\.$/u.exec(line)
      if (founded) {
        for (const reference of founded[1]!.split(', ')) {
          const place = parsedPlaceReference(reference)
          if (place) items.push(Object.freeze({ section: 'places_founded', ...place }))
        }
        continue
      }
      const morePlaces = /^And (\d+) more qualifying places? (?:were|was) founded; browse with view events and kind place_created lists every place, including quiet and nested ones\.$/u.exec(line)
      if (morePlaces) {
        const count = positiveId(morePlaces[1])
        if (count !== null) items.push(Object.freeze({ section: 'more_places', count }))
        continue
      }
      const question = /^In the Showing Room, place #(\d+): question note #(\d+), times named (.+), (still open at this print|closed before this print)\.$/u.exec(line)
      if (question) {
        const placeId = positiveId(question[1])
        const noteId = positiveId(question[2])
        const times = question[3]!.split(' and ').map(parsedTime)
        if (placeId !== null && noteId !== null && times.length > 0 && times.every(time => time !== null)) {
          items.push(Object.freeze({
            section: 'showing_room',
            place_id: placeId,
            note_id: noteId,
            times: Object.freeze(times as string[]),
            open_at_print: question[4] === 'still open at this print',
          }))
        }
        continue
      }
      const firstLines = /^First lines said: (.+)\.$/u.exec(line)
      if (firstLines) {
        for (const reference of firstLines[1]!.split(', ')) {
          const place = parsedPlaceReference(reference)
          if (place) items.push(Object.freeze({ section: 'first_lines', place_id: place.place_id }))
        }
        continue
      }
      const moreFirstLines = /^And (\d+) more rooms had their first lines said\.$/u.exec(line)
        ?? /^And (\d+) more room had its first line said\.$/u.exec(line)
      if (moreFirstLines) {
        const count = positiveId(moreFirstLines[1])
        if (count !== null) items.push(Object.freeze({ section: 'more_first_lines', count }))
        continue
      }
      const corner = /^A small corner: place #(\d+), first note #(\d+)\.$/u.exec(line)
      if (corner) {
        const placeId = positiveId(corner[1])
        const noteId = positiveId(corner[2])
        if (placeId !== null && noteId !== null) {
          items.push(Object.freeze({ section: 'small_corner', place_id: placeId, note_id: noteId }))
        }
        continue
      }
      if (line === GAZETTE_HAPPENINGS_EMPTY_SENTENCE) items.push(Object.freeze({ section: 'nothing_new' }))
      if (line === GAZETTE_HAPPENINGS_FAILURE_SENTENCE) items.push(Object.freeze({ section: 'unavailable' }))
    }
    return Object.freeze(items)
  } catch {
    return null
  }
}

function logFailure(error: unknown): void {
  const code = postgresErrorCode(error)
  console.error(
    'gazette_happenings_failure',
    error instanceof Error ? error.name : typeof error,
    typeof code === 'string' && code.length === 5 ? code : null,
  )
}

/** Build one slot's block, rolling atomic reads and their timeout back to a savepoint. */
export async function composeGazetteHappenings(
  transaction: TaggedSql,
  atomic: boolean,
  week: GazetteWeek,
  baseHeader: string,
  roomId: number,
): Promise<string> {
  if (!atomic) {
    try {
      return formatGazetteHappenings(
        gazetteHappeningsFromRows(await readGazetteHappeningsRows(transaction, week, roomId), week),
        baseHeader,
      )
    } catch (error) {
      logFailure(error)
      return unavailableBlock()
    }
  }

  const query = transaction.query
  if (!query) return unavailableBlock()
  let block: string | null = null
  let failure: unknown = null
  try {
    await query('/* gazette:happenings-savepoint */ SAVEPOINT gazette_happenings')
    await query("/* gazette:happenings-timeout */ SET LOCAL statement_timeout = '5s'")
    const rows = await readGazetteHappeningsRows(transaction, week, roomId)
    block = formatGazetteHappenings(gazetteHappeningsFromRows(rows, week), baseHeader)
  } catch (error) {
    failure = error
    logFailure(error)
  }
  try {
    await query('/* gazette:happenings-rollback */ ROLLBACK TO SAVEPOINT gazette_happenings')
  } catch (error) {
    if (failure === null) {
      failure = error
      logFailure(error)
    }
  }
  try {
    await query('/* gazette:happenings-release */ RELEASE SAVEPOINT gazette_happenings')
  } catch (error) {
    if (failure === null) {
      failure = error
      logFailure(error)
    }
  }
  return failure === null ? block ?? unavailableBlock() : unavailableBlock()
}
