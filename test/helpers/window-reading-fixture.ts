import { expect, type Page } from '@playwright/test'

type Row = Readonly<Record<string, unknown>>
type ReadingSnapshot = Readonly<{
  places: readonly Row[]
  residents: readonly Row[]
  notes: readonly Row[]
  things: readonly Row[]
  agreements: readonly Row[]
  events: readonly Row[]
  totals: Readonly<Record<string, number>>
  pages?: Readonly<Record<string, unknown>>
  change_marker: string
}>
type ReadingFixtureOptions = Readonly<{
  olderNote?: boolean
  noteBody?: string
  noteFullBody?: string
  noteTruncated?: boolean
}>
type ReadingRefreshOptions = Readonly<{
  moderated?: boolean
  moderateOlderNote?: boolean
  noteModerationTargetId?: number
  residentDrawingAppeared?: boolean
  thingBody?: string
  thingMissing?: boolean
  historyUnavailable?: boolean
  noteBody?: string
  // How many notes arrive at once. Enough of them push the city's own newest
  // page past the records a reader had loaded, which is the only way a gap
  // larger than one page can open.
  arrivingNotes?: number
  gapMarkerAhead?: boolean
}>

export const READING_NOTE = 'A reader can keep this note open while the public city refreshes. '.repeat(20)
export const READING_AGREEMENT = 'The parties agree that this long public record remains readable. '.repeat(25)
export const READING_OLDER_NOTE = 'This older note was loaded deliberately and remains in the reader history. '
  .repeat(12)

// Reuse the existing local server's records; never create a resident or contact a live site.
export async function installReadingFixture(
  page: Page,
  baseURL: string | undefined,
  options: ReadingFixtureOptions = {},
) {
  if (!baseURL) throw new Error('The reading fixture requires a loopback baseURL')
  const base = new URL(baseURL)
  if (base.hostname !== '127.0.0.1' || base.protocol !== 'https:') {
    throw new Error('The reading fixture refuses a non-loopback baseURL')
  }
  const response = await page.request.get(new URL('/api/window', base).href)
  expect(response.status(), 'local fixture response status compared with 200').toBe(200)
  const baseline = await response.json() as ReadingSnapshot
  const noteBody = options.noteBody ?? READING_NOTE
  let fullNoteBody = options.noteFullBody ?? noteBody
  const thingResponse = await page.request.get(new URL('/api/thing/401', base).href)
  expect(thingResponse.status(), 'local full-thing response status compared with 200').toBe(200)
  let fullThing = (await thingResponse.json() as { thing: Row }).thing
  let thingMissing = false
  let thingReadCount = 0
  let delayedThingRead: { started: () => void, released: Promise<void> } | null = null
  let delayedNoteRead: { started: () => void, released: Promise<void> } | null = null
  let delayedHistoryRead: { started: () => void, released: Promise<void> } | null = null
  let delayedOutlineRead: {
    started: (minimumMarker: string | null) => void
    released: Promise<void>
  } | null = null
  let forceNextChangeCheck = false
  let historyUnavailable = false
  let gapResponseMarker: string | null = null
  const olderNoteTemplate = baseline.notes.find(note => note.id === 301)
  if (options.olderNote && !olderNoteTemplate) {
    throw new Error('The reading fixture requires note 301 to derive its older note')
  }
  const olderNote = olderNoteTemplate
    ? { ...olderNoteTemplate, id: 299, body: READING_OLDER_NOTE, truncated: false }
    : null
  let olderNoteModerated = false
  let pendingChanges: readonly Row[] = []
  // Notes that arrived all at once. They are the city's own newest page while
  // they exist, which is how a page stops reaching the records a reader loaded.
  const ARRIVAL_PAGE = 3
  let arrivedNotes: Row[] = []
  let nextArrivalId = 400
  let snapshot: ReadingSnapshot = {
    ...baseline,
    residents: baseline.residents.map(resident => resident.id === 49
      ? { ...resident, has_drawing: false } : resident),
    notes: baseline.notes.map(note => note.id === 301
      ? { ...note, body: noteBody, truncated: options.noteTruncated ?? false } : note),
    things: baseline.things.map(thing => ({ ...thing,
      maker_id: 49, made_by: 'browser-resident', current_owner_id: 49,
      current_owner: 'browser-resident', body_text_bytes: 123, has_drawing: false,
    })),
    agreements: baseline.agreements.map(agreement => agreement.id === 601
      ? { ...agreement, body: READING_AGREEMENT } : agreement),
    totals: options.olderNote
      ? { ...baseline.totals, conversations: Number(baseline.totals.conversations) + 1 }
      : baseline.totals,
  }
  const everyNote = () => [
    ...arrivedNotes,
    ...snapshot.notes,
    ...(olderNote && !olderNoteModerated ? [olderNote] : []),
  ].sort((left, right) => Number(right.id) - Number(left.id))
  // The window reads the city's own newest page, not the whole list, so the
  // fixture serves a page and says honestly that older records remain.
  const windowSnapshotPayload = () => {
    const notes = everyNote()
    const page = arrivedNotes.length ? arrivedNotes.slice(0, ARRIVAL_PAGE) : snapshot.notes
    const oldestServed = Number(page.at(-1)?.id ?? 0)
    const hasMore = notes.some(note => Number(note.id) < oldestServed)
    return {
      ...snapshot,
      notes: page,
      pages: {
        ...(snapshot.pages ?? {}),
        notes: { has_more: hasMore, next_before_id: hasMore ? oldestServed : null },
      },
    }
  }
  const networkViolations: string[] = []
  const origin = new URL(response.url()).origin
  await page.route('**/api/changes**', route => {
    const since = new URL(route.request().url()).searchParams.get('since')
    const forcedChanged = forceNextChangeCheck
    forceNextChangeCheck = false
    return route.fulfill({ json: {
      change_marker: snapshot.change_marker,
      unchanged: !forcedChanged && since === snapshot.change_marker,
      changes: pendingChanges, has_more: false, next_since: null,
    } })
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await route.fulfill({ json: { view: 'directory',
        places: snapshot.places, residents: snapshot.residents,
      } })
      return
    }
    const collection = url.searchParams.get('collection')
    if (collection && ['notes', 'things', 'agreements'].includes(collection)) {
      const delayed = delayedHistoryRead
      delayedHistoryRead = null
      if (delayed) {
        delayed.started()
        await delayed.released
      }
      if (historyUnavailable) {
        await route.fulfill({ status: 503, json: { error: 'history unavailable' } })
        return
      }
      // One bounded read of one list: a newer end, an optional older end, and an
      // honest has_more for whatever range the two describe.
      const beforeId = url.searchParams.get('before_id')
      const afterId = url.searchParams.get('after_id')
      const placeId = url.searchParams.get('within_place_id')
      const limit = Number(url.searchParams.get('limit') ?? '10')
      const everyRow = collection === 'notes'
        ? everyNote()
        : snapshot[collection as 'things' | 'agreements']
      const matching = (placeId
        ? everyRow.filter(row => String(row.place_id) === placeId)
        : everyRow
      ).filter(row => (beforeId === null || Number(row.id) < Number(beforeId)) &&
        (afterId === null || Number(row.id) > Number(afterId)))
      // A place list of a busy room is longer than one page, so a reader of one
      // place has to ask for its older records the same way.
      const rows = matching.slice(0, placeId ? Math.min(limit, 2) : limit)
      const hasMore = matching.length > rows.length
      await route.fulfill({ json: {
        [collection]: rows,
        change_marker: gapResponseMarker && afterId !== null
          ? gapResponseMarker : snapshot.change_marker,
        has_more: hasMore,
        next_before_id: hasMore ? Number(rows.at(-1)?.id) : null,
      } })
      return
    }
    const delayed = url.searchParams.get('view') === 'outline' ? delayedOutlineRead : null
    if (delayed) {
      delayedOutlineRead = null
      delayed.started(url.searchParams.get('after_change_marker'))
      await delayed.released
    }
    await route.fulfill({ json: windowSnapshotPayload() })
  })
  await page.route('**/api/events**', route => route.fulfill({ json: {
    events: snapshot.events, change_marker: snapshot.change_marker,
    has_more: false, next_before_id: null,
  } }))
  await page.route('**/api/note/*', async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const snapshotNote: Row | null | undefined = id === 299
      ? olderNoteModerated ? null : olderNote
      : snapshot.notes.find(candidate => candidate.id === id)
    const note = id === 301 && snapshotNote && snapshotNote.moderated !== true
      ? { ...snapshotNote, body: fullNoteBody, truncated: false }
      : snapshotNote
    const delayed = delayedNoteRead
    delayedNoteRead = null
    if (delayed) {
      delayed.started()
      await delayed.released
    }
    return note
      ? route.fulfill({ json: { note } })
      : route.fulfill({ status: 404, json: { error: 'note not found' } })
  })
  await page.route('**/api/thing/401', async route => {
    thingReadCount += 1
    const record = fullThing
    const missing = thingMissing
    const delayed = delayedThingRead
    delayedThingRead = null
    if (delayed) {
      delayed.started()
      await delayed.released
    }
    await route.fulfill(missing
      ? { status: 404, json: { error: 'thing not found' } }
      : { json: { thing: record } })
  })
  await page.route('**/api/place/11**', route => route.fulfill({ json: {
    place: snapshot.places[0], change_marker: snapshot.change_marker,
  } }))
  const portraitRequests: string[] = []
  const transparentPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
    'base64',
  )
  await page.route('**/api/drawing/resident/49/thumb.png*', route => {
    const url = new URL(route.request().url())
    portraitRequests.push(url.pathname + url.search)
    return route.fulfill({ status: 200, contentType: 'image/png', body: transparentPng })
  })
  // Registered last so Playwright runs this guard first, then falls back to
  // the narrower fixture routes above only after the request proves safe.
  await page.route('**/*', async route => {
    const request = route.request()
    if (new URL(request.url()).origin !== origin || request.method() !== 'GET' ||
        request.headers().authorization) {
      networkViolations.push(`${request.method()} ${new URL(request.url()).pathname}`)
      await route.abort()
      return
    }
    await route.fallback()
  })

  return {
    networkViolations,
    portraitRequests,
    get thingReadCount() { return thingReadCount },
    delayNextThingRead() {
      let started = () => {}
      let release = () => {}
      const began = new Promise<void>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      delayedThingRead = { started, released }
      return { started: began, release }
    },
    // Lets a test load a seam the refresh could not check, without starting a
    // second refresh that would reconcile the seam by itself.
    allowHistoryReads() {
      historyUnavailable = false
    },
    // Every note id the fixture serves, newest first, so a test can compare a
    // loaded list with the whole record instead of only its two ends.
    get servedNoteIds() {
      return everyNote().map(note => Number(note.id))
    },
    delayNextNoteRead() {
      let started = () => {}
      let release = () => {}
      const began = new Promise<void>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      delayedNoteRead = { started, released }
      return { started: began, release }
    },
    delayNextHistoryRead() {
      let started = () => {}
      let release = () => {}
      const began = new Promise<void>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      delayedHistoryRead = { started, released }
      return { started: began, release }
    },
    async beginOldMarkerOutlineRead() {
      let started = (_minimumMarker: string | null) => {}
      let release = () => {}
      const began = new Promise<string | null>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      delayedOutlineRead = { started, released }
      forceNextChangeCheck = true
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      return { minimumMarker: await began, release }
    },
    async refresh(refreshOptions: ReadingRefreshOptions = {}) {
      historyUnavailable = refreshOptions.historyUnavailable === true
      if (refreshOptions.thingBody !== undefined) fullThing = { ...fullThing, body: refreshOptions.thingBody }
      if (refreshOptions.thingMissing !== undefined) thingMissing = refreshOptions.thingMissing
      if (refreshOptions.noteBody !== undefined) {
        fullNoteBody = refreshOptions.noteBody
      }
      const alreadyHasNewNote = snapshot.notes.some(note => note.id === 304)
      const nextMarker = String(Number(snapshot.change_marker) + 1)
      gapResponseMarker = refreshOptions.gapMarkerAhead
        ? String(Number(nextMarker) + 1) : null
      const arrivals = Array.from({ length: refreshOptions.arrivingNotes ?? 0 }, (_, index) => ({
        ...baseline.notes[0], id: nextArrivalId + index, body: `An arriving note ${index}.`,
      })).reverse()
      nextArrivalId += refreshOptions.arrivingNotes ?? 0
      arrivedNotes = [...arrivals, ...arrivedNotes]
      if (refreshOptions.moderateOlderNote) olderNoteModerated = true
      snapshot = { ...snapshot,
        change_marker: nextMarker,
        places: snapshot.places.map(place => place.id === 11
          ? { ...place, notes: 3, things: 2 } : place),
        residents: snapshot.residents.map(resident => resident.id === 49 &&
          refreshOptions.residentDrawingAppeared
          ? { ...resident, has_drawing: true } : resident),
        notes: [{ ...baseline.notes[0], id: 304, body: 'A newly arrived note.' },
          ...snapshot.notes.filter(note => note.id !== 304).map(note => {
            if (refreshOptions.moderated && note.id === 301) {
              return { ...note, moderated: true, body: '[removed by maintainer]' }
            }
            return refreshOptions.noteBody !== undefined && note.id === 301
              ? { ...note, body: refreshOptions.noteBody }
              : note
          })],
        things: [{ ...snapshot.things[0], id: 402, name: 'new_lantern' },
          ...snapshot.things.filter(thing => thing.id !== 402)],
        events: [{ ...baseline.events[0], id: 504, actor: 'oldwalker', kind: 'place_edited' },
          ...baseline.events],
        agreements: [{ ...baseline.agreements[0], id: 602, body: 'A newly arrived agreement.' },
          ...snapshot.agreements.filter(agreement => agreement.id !== 602)],
        totals: { ...snapshot.totals,
          conversations: Number(snapshot.totals.conversations) + arrivals.length +
            (alreadyHasNewNote ? 0 : 1),
          things: 2, agreements: 3,
        },
      }
      const moderationTargetId = refreshOptions.moderateOlderNote
        ? 299
        : refreshOptions.noteModerationTargetId ?? (refreshOptions.moderated ? 301 : null)
      pendingChanges = [
        ...(moderationTargetId ? [{
          change_id: nextMarker,
          actor: 'browser-resident',
          created_at: '2026-08-13T19:07:00.000Z',
          kind: 'moderation',
          detail: { target_type: 'note', target_id: moderationTargetId },
        }] : []),
        ...(refreshOptions.residentDrawingAppeared ? [{
          change_id: nextMarker,
          actor: 'browser-resident',
          created_at: '2026-08-13T19:07:00.000Z',
          kind: 'resident_edited',
          detail: { resident_id: 49 },
        }] : []),
      ]
      const refreshed = page.waitForResponse(async result => {
        const url = new URL(result.url())
        if (url.pathname !== '/api/window' || url.searchParams.get('view') !== 'outline' ||
            !result.ok()) return false
        try {
          const payload = await result.json() as { change_marker?: unknown }
          return payload.change_marker === nextMarker
        } catch {
          return false
        }
      })
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await refreshed
      await expect(page.locator('#city-counts'),
        `completed refresh note count compared with ${snapshot.totals.conversations}`)
        .toContainText(`${snapshot.totals.conversations} notes`)
      await expect(page.locator('#window-status'), 'completed refresh status compared with Watching')
        .toContainText('Watching', { timeout: 15_000 })
      return snapshot.change_marker
    },
  }
}
