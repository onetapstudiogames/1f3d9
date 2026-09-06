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
  change_marker: string
}>
type ReadingFixtureOptions = Readonly<{ olderNote?: boolean }>
type ReadingRefreshOptions = Readonly<{
  moderated?: boolean
  moderateOlderNote?: boolean
  noteModerationTargetId?: number
  residentDrawingAppeared?: boolean
  thingBody?: string
  thingMissing?: boolean
  historyUnavailable?: boolean
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
  const thingResponse = await page.request.get(new URL('/api/thing/401', base).href)
  expect(thingResponse.status(), 'local full-thing response status compared with 200').toBe(200)
  let fullThing = (await thingResponse.json() as { thing: Row }).thing
  let thingMissing = false
  let thingReadCount = 0
  let delayedThingRead: { started: () => void, released: Promise<void> } | null = null
  let delayedNoteRead: { started: () => void, released: Promise<void> } | null = null
  let delayedOutlineRead: {
    started: (minimumMarker: string | null) => void
    released: Promise<void>
  } | null = null
  let forceNextChangeCheck = false
  let historyUnavailable = false
  const olderNoteTemplate = baseline.notes.find(note => note.id === 301)
  if (options.olderNote && !olderNoteTemplate) {
    throw new Error('The reading fixture requires note 301 to derive its older note')
  }
  const olderNote = olderNoteTemplate
    ? { ...olderNoteTemplate, id: 299, body: READING_OLDER_NOTE, truncated: false }
    : null
  let olderNoteModerated = false
  let pendingChanges: readonly Row[] = []
  let snapshot: ReadingSnapshot = {
    ...baseline,
    residents: baseline.residents.map(resident => resident.id === 49
      ? { ...resident, has_drawing: false } : resident),
    notes: baseline.notes.map(note => note.id === 301
      ? { ...note, body: READING_NOTE, truncated: false } : note),
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
      if (historyUnavailable) {
        await route.fulfill({ status: 503, json: { error: 'history unavailable' } })
        return
      }
      const beforeId = url.searchParams.get('before_id')
      const isOlderNotePage = collection === 'notes' && options.olderNote && beforeId !== null
      const rows = isOlderNotePage
        ? olderNote && !olderNoteModerated ? [olderNote] : []
        : snapshot[collection as 'notes' | 'things' | 'agreements']
      const placeId = url.searchParams.get('within_place_id')
      const hasMore = collection === 'notes' && options.olderNote && !beforeId && !olderNoteModerated
      await route.fulfill({ json: {
        [collection]: placeId ? rows.filter(row => String(row.place_id) === placeId) : rows,
        change_marker: snapshot.change_marker,
        has_more: hasMore,
        next_before_id: hasMore ? Math.min(...snapshot.notes.map(note => Number(note.id))) : null,
      } })
      return
    }
    const delayed = url.searchParams.get('view') === 'outline' ? delayedOutlineRead : null
    if (delayed) {
      delayedOutlineRead = null
      delayed.started(url.searchParams.get('after_change_marker'))
      await delayed.released
    }
    await route.fulfill({ json: snapshot })
  })
  await page.route('**/api/events**', route => route.fulfill({ json: {
    events: snapshot.events, change_marker: snapshot.change_marker,
    has_more: false, next_before_id: null,
  } }))
  await page.route('**/api/note/*', async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const note = id === 299
      ? olderNoteModerated ? null : olderNote
      : snapshot.notes.find(candidate => candidate.id === id)
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
    delayNextNoteRead() {
      let started = () => {}
      let release = () => {}
      const began = new Promise<void>(resolve => { started = resolve })
      const released = new Promise<void>(resolve => { release = resolve })
      delayedNoteRead = { started, released }
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
      const alreadyHasNewNote = snapshot.notes.some(note => note.id === 304)
      const nextMarker = String(Number(snapshot.change_marker) + 1)
      if (refreshOptions.moderateOlderNote) olderNoteModerated = true
      snapshot = { ...snapshot,
        change_marker: nextMarker,
        places: snapshot.places.map(place => place.id === 11
          ? { ...place, notes: 3, things: 2 } : place),
        residents: snapshot.residents.map(resident => resident.id === 49 &&
          refreshOptions.residentDrawingAppeared
          ? { ...resident, has_drawing: true } : resident),
        notes: [{ ...baseline.notes[0], id: 304, body: 'A newly arrived note.' },
          ...snapshot.notes.filter(note => note.id !== 304).map(note =>
            refreshOptions.moderated && note.id === 301
              ? { ...note, moderated: true, body: '[removed by maintainer]' } : note)],
        things: [{ ...snapshot.things[0], id: 402, name: 'new_lantern' },
          ...snapshot.things.filter(thing => thing.id !== 402)],
        events: [{ ...baseline.events[0], id: 504, actor: 'oldwalker', kind: 'place_edited' },
          ...baseline.events],
        agreements: [{ ...baseline.agreements[0], id: 602, body: 'A newly arrived agreement.' },
          ...snapshot.agreements.filter(agreement => agreement.id !== 602)],
        totals: { ...snapshot.totals,
          conversations: Number(snapshot.totals.conversations) + (alreadyHasNewNote ? 0 : 1),
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
      if (historyUnavailable) {
        await expect(page.locator('#window-status'), 'failed history check compared with explicit stale view')
          .toContainText('updated public city view could not be read', { timeout: 15_000 })
        return snapshot.change_marker
      }
      await expect(page.locator('#city-counts'),
        `completed refresh note count compared with ${snapshot.totals.conversations}`)
        .toContainText(`${snapshot.totals.conversations} notes`)
      await expect(page.locator('#window-status'), 'completed refresh status compared with Watching')
        .toContainText('Watching', { timeout: 15_000 })
      return snapshot.change_marker
    },
  }
}
