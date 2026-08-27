import {
  containsCredentialLikeInput,
  PUBLIC_CREDENTIAL_PATTERN_SOURCE,
} from './credential-safety.ts'
import { HANDLE_RE } from './core.ts'
import {
  allowedPublicQuery,
  singlePublicQueryValue,
  type PublicQueryExecutor,
} from './public-pagination.ts'
import { parsePublicChangeMarker } from './public-changes.ts'
import { containsMalformedPublicText } from './input.ts'

export type PublicSearchMode = 'words' | 'phrase'
export type PublicSearchType = 'all' | 'note' | 'thing'
export type PublicSearchItemType = 'note' | 'thing'

const PUBLIC_SEARCH_DEFAULT_LIMIT = 10
export const PUBLIC_SEARCH_MAX_LIMIT = 200
export const PUBLIC_SEARCH_QUERY_MAX_BYTES = 256
export const PUBLIC_SEARCH_WORD_MAX = 16
const POSTGRES_INTEGER_MAX = 2_147_483_647
const SAFE_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{1,6})Z$/u

function safeTimestamp(value: string): boolean {
  const match = SAFE_TIMESTAMP.exec(value)
  if (!match) return false
  const year = Number(match[1]!)
  const month = Number(match[2]!)
  const day = Number(match[3]!)
  const hour = Number(match[4]!)
  const minute = Number(match[5]!)
  const second = Number(match[6]!)
  const fractionText = match[7]!
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return false
  }
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(hour, minute, second, Number(fractionText.padEnd(6, '0').slice(0, 3)))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
}

export interface PublicSearchCursorRecord {
  readonly q: string
  readonly mode: PublicSearchMode
  readonly type: PublicSearchType
  readonly maker?: string | null
  readonly createdAt: string
  readonly itemType: PublicSearchItemType
  readonly id: number
  readonly changeMarker: string
}

export interface PublicSearchBoundary {
  readonly createdAt: string
  readonly itemType: PublicSearchItemType
  readonly id: number
  readonly changeMarker: string
  readonly maker?: string
}

export interface PublicSearchQuery {
  readonly ok: true
  readonly q: string
  readonly mode: PublicSearchMode
  readonly type: PublicSearchType
  readonly maker: string | null
  readonly limit: number
  readonly fetchLimit: number
  readonly before: PublicSearchBoundary | null
}

export type PublicSearchQueryResult = PublicSearchQuery | Readonly<{
  ok: false
  error: string
}>

function normalizeQuery(value: string): string | null {
  if (
    containsMalformedPublicText(value) ||
    /[\u0000-\u0008\u000a-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(value)
  ) {
    return null
  }
  const normalized = value.normalize('NFC').trim().replace(/[\t\p{Zs}]+/gu, ' ')
  if (
    normalized.length === 0 ||
    Buffer.byteLength(normalized, 'utf8') > PUBLIC_SEARCH_QUERY_MAX_BYTES ||
    containsCredentialLikeInput(normalized)
  ) return null
  return normalized
}

function wordLexemeCount(value: string): number {
  return value.match(/[\p{L}\p{N}_]+/gu)?.length ?? 0
}

function positiveInteger(value: string | null, maximum: number): number | null {
  if (value === null || !/^[0-9]+$/u.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : null
}

export function encodePublicSearchCursor(record: PublicSearchCursorRecord): string {
  const value = JSON.stringify(record.maker == null
    ? [
        2, record.q, record.mode, record.type,
        record.createdAt, record.itemType, record.id, record.changeMarker,
      ]
    : [
        3, record.q, record.mode, record.type, record.maker,
        record.createdAt, record.itemType, record.id, record.changeMarker,
      ])
  return Buffer.from(value, 'utf8').toString('base64url')
}

export function decodePublicSearchCursor(value: string): PublicSearchCursorRecord | null {
  if (!/^[A-Za-z0-9_-]{8,2048}$/u.test(value)) return null
  try {
    const decoded = Buffer.from(value, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(decoded)
    if (!Array.isArray(parsed)) return null
    const version = parsed[0]
    if ((version !== 2 || parsed.length !== 8) && (version !== 3 || parsed.length !== 9)) {
      return null
    }
    const [, q, mode, type, ...tail] = parsed
    const [maker, createdAt, itemType, id, changeMarker] = version === 3
      ? tail
      : [null, ...tail]
    if (
      typeof q !== 'string' || normalizeQuery(q) !== q ||
      !['words', 'phrase'].includes(String(mode)) ||
      !['all', 'note', 'thing'].includes(String(type)) ||
      (maker !== null && (typeof maker !== 'string' || !HANDLE_RE.test(maker))) ||
      typeof createdAt !== 'string' || !safeTimestamp(createdAt) ||
      !['note', 'thing'].includes(String(itemType)) ||
      !Number.isSafeInteger(id) || Number(id) < 1 || Number(id) > POSTGRES_INTEGER_MAX ||
      parsePublicChangeMarker(changeMarker) === null
    ) return null
    const common = {
      q,
      mode: mode as PublicSearchMode,
      type: type as PublicSearchType,
      createdAt,
      itemType: itemType as PublicSearchItemType,
      id: Number(id),
      changeMarker: String(changeMarker),
    }
    const record = Object.freeze(maker === null ? common : { ...common, maker })
    return encodePublicSearchCursor(record) === value ? record : null
  } catch {
    return null
  }
}

export function parsePublicSearchQuery(
  query: Readonly<Record<string, readonly string[] | undefined>>,
): PublicSearchQueryResult {
  const allowed = allowedPublicQuery(query, ['q', 'mode', 'type', 'maker', 'limit', 'before'])
  if (!allowed.ok) return allowed

  const qValue = singlePublicQueryValue(query, 'q')
  if (!qValue.ok) return qValue
  const q = qValue.value === null ? null : normalizeQuery(qValue.value)
  if (q === null) {
    return { ok: false, error: `q must be one safe line of 1 to ${PUBLIC_SEARCH_QUERY_MAX_BYTES} UTF-8 bytes` }
  }

  const modeValue = singlePublicQueryValue(query, 'mode')
  if (!modeValue.ok) return modeValue
  const mode = modeValue.value ?? 'words'
  if (mode !== 'words' && mode !== 'phrase') {
    return { ok: false, error: 'mode must be words or phrase' }
  }
  const wordCount = mode === 'words' ? wordLexemeCount(q) : 0
  if (mode === 'words' && (wordCount === 0 || wordCount > PUBLIC_SEARCH_WORD_MAX)) {
    return {
      ok: false,
      error: `q in words mode must contain 1 to ${PUBLIC_SEARCH_WORD_MAX} word lexemes`,
    }
  }

  const typeValue = singlePublicQueryValue(query, 'type')
  if (!typeValue.ok) return typeValue
  const type = typeValue.value ?? 'all'
  if (type !== 'all' && type !== 'note' && type !== 'thing') {
    return { ok: false, error: 'type must be all, note, or thing' }
  }

  const makerValue = singlePublicQueryValue(query, 'maker')
  if (!makerValue.ok) return makerValue
  const maker = makerValue.value
  if (maker !== null && !HANDLE_RE.test(maker)) {
    return { ok: false, error: 'maker must be one valid resident handle' }
  }
  if (maker !== null && type === 'note') {
    return { ok: false, error: 'maker filters active things; type must be all or thing' }
  }

  const limitValue = singlePublicQueryValue(query, 'limit')
  if (!limitValue.ok) return limitValue
  const limit = limitValue.value === null
    ? PUBLIC_SEARCH_DEFAULT_LIMIT
    : positiveInteger(limitValue.value, PUBLIC_SEARCH_MAX_LIMIT)
  if (limit === null) {
    return { ok: false, error: `limit must be between 1 and ${PUBLIC_SEARCH_MAX_LIMIT}` }
  }

  const beforeValue = singlePublicQueryValue(query, 'before')
  if (!beforeValue.ok) return beforeValue
  const cursor = beforeValue.value === null ? null : decodePublicSearchCursor(beforeValue.value)
  if (
    beforeValue.value !== null &&
    (
      cursor === null || cursor.q !== q || cursor.mode !== mode || cursor.type !== type
      || (cursor.maker ?? null) !== maker
    )
  ) {
    return { ok: false, error: 'before cursor does not belong to this search query' }
  }

  return Object.freeze({
    ok: true,
    q,
    mode,
    type,
    maker,
    limit,
    fetchLimit: limit + 1,
    before: cursor === null ? null : Object.freeze({
      createdAt: cursor.createdAt,
      itemType: cursor.itemType,
      id: cursor.id,
      changeMarker: cursor.changeMarker,
      ...(cursor.maker == null ? {} : { maker: cursor.maker }),
    }),
  })
}

function matchExpression(mode: PublicSearchMode): string {
  return mode === 'words'
    ? `to_tsvector('simple', candidate.search_text) @@ plainto_tsquery('simple', $1::text)`
    : `strpos(lower(candidate.search_text), lower($1::text)) > 0`
}

function indexedMatchExpression(
  mode: PublicSearchMode,
  sourceText: string,
): string {
  return mode === 'words'
    ? `to_tsvector('simple', ${sourceText}) @@ plainto_tsquery('simple', $8::text)`
    : `lower(${sourceText}) LIKE lower($8::text) ESCAPE E'\\\\'`
}

function literalPhrasePattern(value: string): string {
  return `%${value.replace(/[\\%_]/gu, character => `\\${character}`)}%`
}

function publicSearchSql(mode: PublicSearchMode): string {
  return `
    /* public:search */
    WITH note_candidates AS MATERIALIZED (
      SELECT 'note'::text AS result_type,
        note.id, note.place_id,
        NULL::text AS name,
        NULL::integer AS maker_id, NULL::text AS made_by,
        NULL::integer AS current_owner_id, NULL::text AS current_owner,
        NULL::integer AS owner_id, NULL::text AS owner,
        NULL::boolean AS open_to_use,
        note.author_id, author.handle AS author,
        note.body,
        CASE WHEN note.body !~* $3::text THEN note.body ELSE '' END AS search_text,
        note.created_at
      FROM notes note
      JOIN residents author ON author.id = note.author_id
      WHERE $2::text IN ('all', 'note')
        AND $9::text IS NULL
        AND ${indexedMatchExpression(mode, 'note.body')}
        AND coalesce((
          SELECT moderation.action
          FROM moderation_actions moderation
          WHERE moderation.target_type = 'note' AND moderation.target_id = note.id
          ORDER BY moderation.created_at DESC, moderation.id DESC
          LIMIT 1
        ), 'restore') <> 'remove'
    ), thing_candidates AS MATERIALIZED (
      SELECT 'thing'::text AS result_type,
        thing.id, thing.place_id,
        thing.name,
        thing.maker_id, maker.handle AS made_by,
        thing.owner_id AS current_owner_id, owner.handle AS current_owner,
        thing.owner_id, owner.handle AS owner,
        thing.open_to_use,
        NULL::integer AS author_id, NULL::text AS author,
        thing.body,
        concat_ws(' ',
          CASE WHEN thing.name !~* $3::text THEN thing.name ELSE '' END,
          CASE WHEN thing.body !~* $3::text THEN thing.body ELSE '' END
        ) AS search_text,
        thing.created_at
      FROM things thing
      JOIN residents maker ON maker.id = thing.maker_id
      JOIN residents owner ON owner.id = thing.owner_id
      WHERE $2::text IN ('all', 'thing')
        AND thing.withdrawn_at IS NULL
        AND ($9::text IS NULL OR maker.handle = $9::text)
        AND ${indexedMatchExpression(mode, "thing.name || ' ' || thing.body")}
        AND coalesce((
          SELECT moderation.action
          FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing' AND moderation.target_id = thing.id
          ORDER BY moderation.created_at DESC, moderation.id DESC
          LIMIT 1
        ), 'restore') <> 'remove'
    ), candidate AS MATERIALIZED (
      SELECT * FROM note_candidates
      UNION ALL
      SELECT * FROM thing_candidates
    ), matched AS MATERIALIZED (
      SELECT candidate.*
      FROM candidate
      WHERE ${matchExpression(mode)}
    ), totals AS MATERIALIZED (
      SELECT count(*)::integer AS total_items,
        coalesce(sum(octet_length(matched.body)), 0)::bigint AS total_body_bytes
      FROM matched
    ), checkpoint AS MATERIALIZED (
      SELECT current_change_id::text AS change_marker
      FROM public_change_state
      WHERE singleton = true
    )
    SELECT page.result_type, page.id, page.place_id,
      page.name, page.maker_id, page.made_by,
      page.current_owner_id, page.current_owner,
      page.owner_id, page.owner, page.open_to_use,
      page.author_id, page.author,
      octet_length(page.body)::integer AS body_text_bytes,
      to_char(page.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
      totals.total_items, totals.total_body_bytes, checkpoint.change_marker
    FROM totals
    CROSS JOIN checkpoint
    LEFT JOIN LATERAL (
      SELECT matched.*
      FROM matched
      WHERE (
        $4::timestamptz IS NULL
        OR matched.created_at < $4::timestamptz
        OR (matched.created_at = $4::timestamptz AND matched.result_type > $5::text)
        OR (
          matched.created_at = $4::timestamptz
          AND matched.result_type = $5::text
          AND matched.id < $6::integer
        )
      )
      ORDER BY matched.created_at DESC, matched.result_type ASC, matched.id DESC
      LIMIT $7::integer
    ) page ON true
    ORDER BY page.created_at DESC NULLS LAST,
      page.result_type ASC NULLS LAST, page.id DESC NULLS LAST
  `
}

function safeCount(value: unknown, name: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${name} is invalid`)
  return count
}

function outline(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  if (row.result_type !== 'note' && row.result_type !== 'thing') return null
  const common = {
    type: row.result_type,
    id: safeCount(row.id, 'search result id'),
    place_id: safeCount(row.place_id, 'search result place id'),
  }
  if (common.id < 1 || common.place_id < 1) throw new Error('search result identifiers are invalid')
  const bodyTextBytes = safeCount(row.body_text_bytes, 'search result body size')
  if (typeof row.created_at !== 'string' || !safeTimestamp(row.created_at)) {
    throw new Error('search result timestamp is invalid')
  }
  if (row.result_type === 'note') {
    return Object.freeze({
      ...common,
      author_id: safeCount(row.author_id, 'search result author id'),
      author: row.author,
      body_text_bytes: bodyTextBytes,
      created_at: row.created_at,
    })
  }
  return Object.freeze({
    ...common,
    name: row.name,
    maker_id: safeCount(row.maker_id, 'search result maker id'),
    made_by: row.made_by,
    current_owner_id: safeCount(row.current_owner_id, 'search result current owner id'),
    current_owner: row.current_owner,
    owner_id: safeCount(row.owner_id, 'search result owner id'),
    owner: row.owner,
    open_to_use: row.open_to_use === true,
    body_text_bytes: bodyTextBytes,
    created_at: row.created_at,
  })
}

export interface PublicSearchResults {
  readonly items: readonly Readonly<Record<string, unknown>>[]
  readonly totalItems: number
  readonly totalBodyBytes: number
  readonly hasMore: boolean
  readonly nextBefore: string | null
  readonly changeMarker: string
}

export class PublicSearchFutureMarkerError extends Error {
  constructor(marker: string, checkpoint: string) {
    super(`search marker ${marker} is ahead of checkpoint ${checkpoint}`)
    this.name = 'PublicSearchFutureMarkerError'
  }
}

export async function loadPublicSearchResults(
  execute: PublicQueryExecutor,
  query: PublicSearchQuery,
): Promise<PublicSearchResults> {
  const rows = await execute(publicSearchSql(query.mode), [
    query.q,
    query.type,
    PUBLIC_CREDENTIAL_PATTERN_SOURCE,
    query.before?.createdAt ?? null,
    query.before?.itemType ?? null,
    query.before?.id ?? null,
    query.fetchLimit,
    query.mode === 'phrase' ? literalPhrasePattern(query.q) : query.q,
    query.maker,
  ])
  if (rows.length === 0) throw new Error('public search totals are unavailable')
  const fetched = rows.flatMap(row => {
    const item = outline(row)
    return item === null ? [] : [item]
  })
  const totalItems = safeCount(rows[0]?.total_items, 'public search total')
  const totalBodyBytes = safeCount(rows[0]?.total_body_bytes, 'public search body total')
  const currentChangeMarker = parsePublicChangeMarker(rows[0]?.change_marker)
  if (currentChangeMarker === null) throw new Error('public search change marker is invalid')
  if (
    query.before?.changeMarker
    && BigInt(query.before.changeMarker) > BigInt(currentChangeMarker)
  ) {
    throw new PublicSearchFutureMarkerError(
      query.before.changeMarker,
      currentChangeMarker,
    )
  }
  // A continuation keeps the first page's marker. Even if results change
  // while the caller walks older pages, polling from this conservative
  // baseline still reports every concurrent edit, move, or withdrawal.
  const changeMarker = query.before?.changeMarker ?? currentChangeMarker
  const hasMore = fetched.length > query.limit
  const items = Object.freeze(fetched.slice(0, query.limit))
  const last = items.at(-1)
  const nextBefore = hasMore && last
    ? encodePublicSearchCursor({
      q: query.q,
      mode: query.mode,
      type: query.type,
      ...(query.maker === null ? {} : { maker: query.maker }),
      createdAt: String(last.created_at),
      itemType: last.type as PublicSearchItemType,
      id: Number(last.id),
      changeMarker,
    })
    : null
  return Object.freeze({
    items, totalItems, totalBodyBytes, hasMore, nextBefore, changeMarker,
  })
}
