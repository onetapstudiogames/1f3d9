// Pure helpers for the window's Talk tab (decisions 129 and 130). The browser
// program injects each with Function.prototype.toString, so none reads an
// import or a module constant.

export function talkLinesPath({
  placeId,
  resident,
  beforeId,
  marker,
  limit,
}: {
  placeId: number | null
  resident: string | null
  beforeId: number | null
  marker: string
  limit: number
}): string {
  const query = new URLSearchParams()
  query.set('collection', 'lines')
  if (beforeId !== null) query.set('before_id', String(beforeId))
  query.set('limit', String(limit))
  if (placeId !== null) query.set('within_place_id', String(placeId))
  if (resident !== null) query.set('resident', resident)
  query.set('after_change_marker', marker)
  return '/api/window?' + query.toString()
}

export function talkCheckMs(value: unknown, minMs: number, maxMs: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) return minMs
  return Math.min(maxMs, Math.max(minMs, value))
}

export function normalizeTalkNow(
  value: unknown,
  { minMs, maxMs }: { minMs: number; maxMs: number },
): { lineMarker: string; checkMs: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const lineMarker = source.line_marker
  if (typeof lineMarker !== 'string' ||
      !/^(?:0|[1-9][0-9]{0,18})$/u.test(lineMarker)) return null
  return {
    lineMarker,
    checkMs: talkCheckMs(source.check_interval_ms, minMs, maxMs),
  }
}

export function normalizeTalkLines(value: unknown): {
  rows: readonly Readonly<Record<string, unknown>>[]
  hasMore: boolean
  nextBeforeId: number | null
  changeMarker: string | null
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.lines)) return null
  const rows = source.lines.flatMap((raw): Readonly<Record<string, unknown>>[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
    const line = raw as Record<string, unknown>
    const id = line.id
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) return []
    if (line.moderated === true) {
      return [Object.freeze({ id, removed: true })]
    }
    const placeId = line.place_id
    const author = line.author
    const body = line.body
    const createdAt = typeof line.created_at === 'string'
      ? new Date(line.created_at)
      : null
    if (typeof placeId !== 'number' || !Number.isSafeInteger(placeId) || placeId <= 0 ||
        typeof author !== 'string' || !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(author) ||
        typeof body !== 'string' || body.length > 240 ||
        /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(body) ||
        !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) return []
    return [Object.freeze({ id, placeId, author, body, createdAt })]
  })
  const nextBeforeId = typeof source.next_before_id === 'number' &&
    Number.isSafeInteger(source.next_before_id) && source.next_before_id > 0
    ? source.next_before_id
    : null
  const changeMarker = typeof source.change_marker === 'string' &&
    /^(?:0|[1-9][0-9]{0,18})$/u.test(source.change_marker)
    ? source.change_marker
    : null
  return Object.freeze({
    rows: Object.freeze(rows),
    hasMore: source.has_more === true,
    nextBeforeId,
    changeMarker,
  })
}

export function talkPane<T extends { id: number; createdAt?: Date | string }>(
  rows: readonly T[],
  {
    newestPage,
    nowMs,
    paneMs,
    hasMore,
  }: {
    newestPage: boolean
    nowMs: number
    paneMs: number
    hasMore: boolean
  },
): { shown: readonly T[]; olderBeforeId: number | null } {
  let visibleNewestFirst = [...rows]
  let cut = false
  if (newestPage) {
    const cutoff = nowMs - paneMs
    const firstOlder = rows.findIndex(row => {
      if (row.createdAt === undefined) return false
      const createdAtMs = row.createdAt instanceof Date
        ? row.createdAt.getTime()
        : Date.parse(row.createdAt)
      return !Number.isFinite(createdAtMs) || createdAtMs < cutoff
    })
    if (firstOlder !== -1) {
      visibleNewestFirst = rows.slice(0, firstOlder)
      cut = true
    }
  }
  const shown = [...visibleNewestFirst].reverse()
  let olderBeforeId: number | null = null
  if (cut && shown.length === 0) {
    const newestId = rows[0]?.id
    if (typeof newestId === 'number' && Number.isSafeInteger(newestId) &&
        newestId < Number.MAX_SAFE_INTEGER) olderBeforeId = newestId + 1
  } else if ((cut || hasMore) && shown.length > 0) {
    olderBeforeId = Math.min(...shown.map(row => row.id))
  }
  return { shown: Object.freeze(shown), olderBeforeId }
}

export function talkRenderRows(
  rows: readonly Readonly<Record<string, unknown>>[],
  quietPlaceIds: ReadonlySet<number>,
): readonly (
  | { type: 'line'; row: Readonly<Record<string, unknown>> }
  | { type: 'removed'; id: number }
  | { type: 'quiet'; placeId: number; ids: readonly number[] }
)[] {
  const rendered: (
    | { type: 'line'; row: Readonly<Record<string, unknown>> }
    | { type: 'removed'; id: number }
    | { type: 'quiet'; placeId: number; ids: number[] }
  )[] = []
  for (const row of rows) {
    const id = row.id
    if (row.removed === true) {
      rendered.push({ type: 'removed', id: id as number })
      continue
    }
    const placeId = row.placeId
    if (typeof placeId === 'number' && quietPlaceIds.has(placeId)) {
      const previous = rendered.at(-1)
      if (previous?.type === 'quiet' && previous.placeId === placeId) {
        previous.ids.push(id as number)
      } else {
        rendered.push({ type: 'quiet', placeId, ids: [id as number] })
      }
    } else {
      rendered.push({ type: 'line', row })
    }
  }
  return Object.freeze(rendered.map(row =>
    row.type === 'quiet'
      ? Object.freeze({ ...row, ids: Object.freeze(row.ids) })
      : Object.freeze(row)))
}

export function talkCheckDelay({
  failures,
  idleMs,
  checkMs,
  retryMaxMs,
  idleAfterMs,
  idleCheckMs,
}: {
  failures: number
  idleMs: number
  checkMs: number
  retryMaxMs: number
  idleAfterMs: number
  idleCheckMs: number
}): number {
  if (failures > 0) return Math.min(Math.max(retryMaxMs, checkMs), checkMs * 2 ** failures)
  if (idleAfterMs > 0 && idleMs >= idleAfterMs) return Math.max(idleCheckMs, checkMs)
  return checkMs
}
