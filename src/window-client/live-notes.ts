export type WindowLiveNote = Readonly<{
  id: number
  place_id: number
  author: string
  body: string
  created_at: Date
  moderated: boolean
  truncated: false
}>

export type WindowLiveNotesPage = Readonly<{
  rows: readonly WindowLiveNote[]
  hasMore: boolean
  nextBeforeId: number | null
}>

/** Strictly validates one exact-place, newest-first page for the Live notes panel. */
export function normalizeLiveNotesPage(
  payload: unknown,
  placeId: number,
  previousCursor: number | null,
): WindowLiveNotesPage | null {
  if (!Number.isSafeInteger(placeId) || placeId <= 0 ||
      (previousCursor !== null && (!Number.isSafeInteger(previousCursor) || previousCursor <= 0)) ||
      !payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const page = payload as Record<string, unknown>
  if (!Array.isArray(page.notes) || page.notes.length > 50 ||
      typeof page.has_more !== 'boolean') return null
  const nextBeforeId = page.next_before_id === null
    ? null
    : typeof page.next_before_id === 'number' && Number.isSafeInteger(page.next_before_id) &&
      page.next_before_id > 0
      ? page.next_before_id
      : null
  if (page.has_more !== (nextBeforeId !== null) ||
      (previousCursor !== null && nextBeforeId !== null && nextBeforeId >= previousCursor)) return null
  const seen = new Set<number>()
  const rows: WindowLiveNote[] = []
  for (const value of page.notes) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const note = value as Record<string, unknown>
    const createdAt = typeof note.created_at === 'string' ? new Date(note.created_at) : null
    if (typeof note.id !== 'number' || !Number.isSafeInteger(note.id) || note.id <= 0 ||
        seen.has(note.id) || (previousCursor !== null && note.id >= previousCursor) ||
        note.place_id !== placeId || typeof note.author !== 'string' ||
        !/^[a-z0-9][a-z0-9-]{2,31}$/u.test(note.author) ||
        typeof note.body !== 'string' || note.body.length === 0 ||
        note.truncated === true || !createdAt || Number.isNaN(createdAt.getTime())) return null
    seen.add(note.id)
    rows.push(Object.freeze({
      id: note.id,
      place_id: placeId,
      author: note.author,
      body: note.body,
      created_at: createdAt,
      moderated: note.moderated === true,
      truncated: false,
    }))
  }
  if (nextBeforeId !== null && !seen.has(nextBeforeId)) return null
  return Object.freeze({
    rows: Object.freeze(rows),
    hasMore: page.has_more,
    nextBeforeId,
  })
}
