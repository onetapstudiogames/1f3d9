import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { redactResidentCredentialText } from './credential-safety.ts'
import { MODERATED_TEXT } from './moderation.ts'

export const LATER_HOLDER_PAGE_DEFAULT = 10
export const LATER_HOLDER_PAGE_MAX = 200
export const LATER_HOLDER_CURSOR_PATTERN = '^lh1_[A-Za-z0-9_-]{48}$'
export const LATER_HOLDER_CURSOR_LENGTH = 52
export const LATER_HOLDER_SINGULAR_QUESTION =
  'An earlier holder of this resident identity marked 1 public item for later holders. View the index?'
const MAX_BIGINT = 9_223_372_036_854_775_807n
const CURSOR_PREFIX = 'lh1_'
const CURSOR_IV_BYTES = 12
const CURSOR_TAG_BYTES = 16
const CURSOR_PAYLOAD_BYTES = 8
const CURSOR_RE = new RegExp(LATER_HOLDER_CURSOR_PATTERN, 'u')

export type LaterHolderQueryExecutor = (
  query: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>

export type LaterHolderReadRequest =
  | Readonly<{ mode: 'later_holder_notice' }>
  | Readonly<{
    mode: 'later_holder_index'
    before: string | null
    limit: number
  }>

export type LaterHolderReadParseResult =
  | Readonly<{ ok: true; request: LaterHolderReadRequest }>
  | Readonly<{ ok: false; error: string }>

export type LaterHolderMarkParseResult =
  | Readonly<{ ok: true; action: 'mark' | 'unmark' }>
  | Readonly<{ ok: false; error: string }>

export interface LaterHolderIndex {
  readonly count: number
  readonly items: readonly Readonly<{
    id: number
    type: 'thing'
    title: string
    place: Readonly<{ id: number; title: string }>
    date: string
    body_text_bytes: number
  }>[]
  readonly has_more: boolean
  readonly next_before: string | null
}

export interface LaterHolderCursorCodec {
  readonly encode: (markId: string) => string
  readonly decode: (cursor: string) => string | null
}

export class LaterHolderMarkEligibilityError extends Error {
  constructor() {
    super('only an active public thing you made and currently own can be marked')
    this.name = 'LaterHolderMarkEligibilityError'
  }
}

export class LaterHolderCursorError extends Error {
  constructor() {
    super('before is not a valid later-holder cursor')
    this.name = 'LaterHolderCursorError'
  }
}

function markId(value: unknown): bigint | null {
  const text = typeof value === 'bigint' ? value.toString() : value
  if (typeof text !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(text)) return null
  try {
    const parsed = BigInt(text)
    return parsed <= MAX_BIGINT ? parsed : null
  } catch {
    return null
  }
}

export function isLaterHolderCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length === LATER_HOLDER_CURSOR_LENGTH && CURSOR_RE.test(value)
}

export function createLaterHolderCursorCodec(
  secretHex: string,
  residentId: number,
): LaterHolderCursorCodec {
  if (!/^[0-9a-f]{64}$/u.test(secretHex)) {
    throw new Error('later-holder cursor key must be 32 lowercase hexadecimal bytes')
  }
  if (!Number.isSafeInteger(residentId) || residentId < 1 || residentId > 2_147_483_647) {
    throw new Error('later-holder cursor resident is invalid')
  }
  const key = Buffer.from(secretHex, 'hex')
  const additionalData = Buffer.from(`1f3d9:later-holder-cursor:v1:${residentId}`, 'utf8')
  return Object.freeze({
    encode(value: string): string {
      const parsed = markId(value)
      if (parsed === null) throw new Error('later-holder mark cursor boundary is invalid')
      const iv = randomBytes(CURSOR_IV_BYTES)
      const payload = Buffer.alloc(CURSOR_PAYLOAD_BYTES)
      payload.writeBigUInt64BE(parsed)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      cipher.setAAD(additionalData)
      const encrypted = Buffer.concat([cipher.update(payload), cipher.final()])
      return `${CURSOR_PREFIX}${Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString('base64url')}`
    },
    decode(cursor: string): string | null {
      if (!isLaterHolderCursor(cursor)) return null
      try {
        const encoded = Buffer.from(cursor.slice(CURSOR_PREFIX.length), 'base64url')
        const iv = encoded.subarray(0, CURSOR_IV_BYTES)
        const encrypted = encoded.subarray(CURSOR_IV_BYTES, CURSOR_IV_BYTES + CURSOR_PAYLOAD_BYTES)
        const tag = encoded.subarray(CURSOR_IV_BYTES + CURSOR_PAYLOAD_BYTES)
        if (
          iv.length !== CURSOR_IV_BYTES || encrypted.length !== CURSOR_PAYLOAD_BYTES ||
          tag.length !== CURSOR_TAG_BYTES
        ) return null
        const decipher = createDecipheriv('aes-256-gcm', key, iv)
        decipher.setAAD(additionalData)
        decipher.setAuthTag(tag)
        const payload = Buffer.concat([decipher.update(encrypted), decipher.final()])
        if (payload.length !== CURSOR_PAYLOAD_BYTES) return null
        const parsed = payload.readBigUInt64BE()
        return parsed > 0n && parsed <= MAX_BIGINT ? parsed.toString() : null
      } catch {
        return null
      }
    },
  })
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function hasOnly(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const names = new Set(allowed)
  return Object.keys(value).every(key => names.has(key))
}

function pageLimit(value: unknown): number | null {
  if (value === undefined) return LATER_HOLDER_PAGE_DEFAULT
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= LATER_HOLDER_PAGE_MAX
    ? Number(value)
    : null
}

function beforeCursor(value: unknown): string | null | undefined {
  if (value === undefined) return null
  return isLaterHolderCursor(value) ? value : undefined
}

export function parseLaterHolderReadInput(value: unknown): LaterHolderReadParseResult {
  const input = object(value)
  if (!input || typeof input.mode !== 'string') {
    return Object.freeze({ ok: false, error: 'body must name a later-holder mode' })
  }
  if (input.mode === 'later_holder_notice') {
    return hasOnly(input, ['mode'])
      ? Object.freeze({
        ok: true,
        request: Object.freeze({ mode: 'later_holder_notice' as const }),
      })
      : Object.freeze({ ok: false, error: 'notice body contains an unsupported field' })
  }
  if (input.mode !== 'later_holder_index') {
    return Object.freeze({ ok: false, error: 'mode must be later_holder_notice or later_holder_index' })
  }
  if (!hasOnly(input, ['mode', 'before', 'limit'])) {
    return Object.freeze({ ok: false, error: 'index body contains an unsupported field' })
  }
  const before = beforeCursor(input.before)
  if (before === undefined) {
    return Object.freeze({
      ok: false,
      error: 'before must be the opaque next_before cursor returned by this index',
    })
  }
  const limit = pageLimit(input.limit)
  if (limit === null) {
    return Object.freeze({
      ok: false,
      error: `limit must be an integer from 1 to ${LATER_HOLDER_PAGE_MAX}`,
    })
  }
  return Object.freeze({
    ok: true,
    request: Object.freeze({ mode: 'later_holder_index' as const, before, limit }),
  })
}

export function parseLaterHolderMarkInput(value: unknown): LaterHolderMarkParseResult {
  const input = object(value)
  if (!input || !hasOnly(input, ['action'])) {
    return Object.freeze({ ok: false, error: 'mark body must contain only action' })
  }
  if (input.action !== 'mark' && input.action !== 'unmark') {
    return Object.freeze({ ok: false, error: 'action must be mark or unmark' })
  }
  return Object.freeze({ ok: true, action: input.action })
}

function safeCount(value: unknown, label: string): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`${label} is invalid`)
  return count
}

export function laterHolderNotice(count: number): Readonly<{
  count: number
  question?: string
}> {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('later-holder count is invalid')
  if (count === 0) return Object.freeze({ count: 0 })
  const item = count === 1 ? 'item' : 'items'
  return Object.freeze({
    count,
    question: count === 1
      ? LATER_HOLDER_SINGULAR_QUESTION
      : `An earlier holder of this resident identity marked ${count} public ${item} for later holders. View the index?`,
  })
}

const ELIGIBLE_PREDICATE = `
  mark.resident_id = $1::integer
  AND thing.maker_id = $1::integer
  AND thing.owner_id = $1::integer
  AND thing.withdrawn_at IS NULL
  AND coalesce((
    SELECT moderation.action
    FROM moderation_actions moderation
    WHERE moderation.target_type = 'thing'
      AND moderation.target_id = thing.id
    ORDER BY moderation.created_at DESC, moderation.id DESC
    LIMIT 1
  ), 'restore') <> 'remove'
`

export async function readLaterHolderNotice(
  execute: LaterHolderQueryExecutor,
  residentId: number,
): Promise<ReturnType<typeof laterHolderNotice>> {
  const rows = await execute(`
    SELECT /* private:later-holder-notice */ count(*)::integer AS count
    FROM thing_later_holder_marks mark
    JOIN things thing ON thing.id = mark.thing_id
    WHERE ${ELIGIBLE_PREDICATE}
  `, [residentId])
  return laterHolderNotice(safeCount(rows[0]?.count ?? 0, 'later-holder count'))
}

export async function readLaterHolderIndex(
  execute: LaterHolderQueryExecutor,
  residentId: number,
  request: Extract<LaterHolderReadRequest, { mode: 'later_holder_index' }>,
  cursorCodec: LaterHolderCursorCodec,
): Promise<LaterHolderIndex> {
  const beforeMarkId = request.before === null ? null : cursorCodec.decode(request.before)
  if (request.before !== null && beforeMarkId === null) throw new LaterHolderCursorError()
  const rows = await execute(`
    /* private:later-holder-index */
    WITH eligible AS MATERIALIZED (
      SELECT mark.id AS mark_id, thing.id, thing.name AS title,
        place.id AS place_id,
        CASE WHEN place_moderation.action = 'remove'
          THEN $4::text ELSE place.name END AS place_title,
        thing.created_at, octet_length(thing.body)::integer AS body_text_bytes
      FROM thing_later_holder_marks mark
      JOIN things thing ON thing.id = mark.thing_id
      JOIN places place ON place.id = thing.place_id
      LEFT JOIN LATERAL (
        SELECT moderation.action
        FROM moderation_actions moderation
        WHERE moderation.target_type = 'place'
          AND moderation.target_id = place.id
        ORDER BY moderation.created_at DESC, moderation.id DESC
        LIMIT 1
      ) place_moderation ON true
      WHERE ${ELIGIBLE_PREDICATE}
    ), totals AS MATERIALIZED (
      SELECT count(*)::integer AS total_count FROM eligible
    ), page AS MATERIALIZED (
      SELECT * FROM eligible
      WHERE ($2::bigint IS NULL OR mark_id < $2::bigint)
      ORDER BY mark_id DESC
      LIMIT $3::integer
    )
    SELECT page.mark_id::text, page.id, page.title,
      page.place_id, page.place_title,
      to_char(page.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date,
      page.body_text_bytes, totals.total_count
    FROM totals
    LEFT JOIN page ON TRUE
    ORDER BY page.mark_id DESC NULLS LAST
  `, [residentId, beforeMarkId, request.limit + 1, MODERATED_TEXT])
  const count = safeCount(rows[0]?.total_count ?? 0, 'later-holder count')
  const available = rows.filter(row => row.id != null)
  const hasMore = available.length > request.limit
  const selected = available.slice(0, request.limit)
  const items = selected.map(row => {
    const id = safeCount(row.id, 'later-holder thing id')
    const placeId = safeCount(row.place_id, 'later-holder place id')
    const bodyTextBytes = safeCount(row.body_text_bytes, 'later-holder body size')
    const title = redactResidentCredentialText(row.title)
    const placeTitle = redactResidentCredentialText(row.place_title)
    if (id < 1 || placeId < 1 || title === null || placeTitle === null) {
      throw new Error('later-holder index heading is invalid')
    }
    if (typeof row.date !== 'string' || !Number.isFinite(Date.parse(row.date))) {
      throw new Error('later-holder index date is invalid')
    }
    return Object.freeze({
      id,
      type: 'thing' as const,
      title,
      place: Object.freeze({ id: placeId, title: placeTitle }),
      date: row.date,
      body_text_bytes: bodyTextBytes,
    })
  })
  return Object.freeze({
    count,
    items: Object.freeze(items),
    has_more: hasMore,
    next_before: hasMore
      ? cursorCodec.encode(String(selected.at(-1)!.mark_id))
      : null,
  })
}

export async function setLaterHolderMark(
  execute: LaterHolderQueryExecutor,
  residentId: number,
  thingId: number,
  marked: boolean,
): Promise<Readonly<{ thing_id: number; marked: boolean; changed: boolean }>> {
  if (!marked) {
    const rows = await execute(`
      DELETE FROM thing_later_holder_marks
      /* private:later-holder-unmark */
      WHERE resident_id = $1::integer AND thing_id = $2::integer
      RETURNING thing_id
    `, [residentId, thingId])
    return Object.freeze({ thing_id: thingId, marked: false, changed: rows.length > 0 })
  }

  const rows = await execute(`
    /* private:later-holder-mark */
    WITH existing AS MATERIALIZED (
      SELECT thing_id
      FROM thing_later_holder_marks
      WHERE resident_id = $1::integer AND thing_id = $2::integer
    ), eligible AS MATERIALIZED (
      SELECT thing.id
      FROM things thing
      WHERE thing.id = $2::integer
        AND thing.maker_id = $1::integer
        AND thing.owner_id = $1::integer
        AND thing.withdrawn_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM existing)
        AND coalesce((
          SELECT moderation.action
          FROM moderation_actions moderation
          WHERE moderation.target_type = 'thing'
            AND moderation.target_id = thing.id
          ORDER BY moderation.created_at DESC, moderation.id DESC
          LIMIT 1
        ), 'restore') <> 'remove'
      FOR UPDATE
    ), inserted AS (
      INSERT INTO thing_later_holder_marks (resident_id, thing_id)
      SELECT $1::integer, eligible.id FROM eligible
      ON CONFLICT (thing_id) DO NOTHING
      RETURNING thing_id
    )
    SELECT thing_id, true AS changed FROM inserted
    UNION ALL
    SELECT thing_id, false AS changed FROM existing
    LIMIT 1
  `, [residentId, thingId])
  let row = rows[0]
  if (!row) {
    const concurrent = await execute(`
      SELECT /* private:later-holder-mark-existing */ thing_id, false AS changed
      FROM thing_later_holder_marks
      WHERE resident_id = $1::integer AND thing_id = $2::integer
    `, [residentId, thingId])
    row = concurrent[0]
  }
  if (!row) throw new LaterHolderMarkEligibilityError()
  return Object.freeze({
    thing_id: thingId,
    marked: true,
    changed: row.changed === true,
  })
}
