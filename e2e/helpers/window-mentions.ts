import { expect, type Page } from '@playwright/test'
import { publicWindowFixture } from './oauth-test-server/public-window-fixtures.ts'

export type MentionNote = Readonly<{
  id: number
  place_id: number
  author: string
  body: string
  created_at: string
  moderated: boolean
  truncated?: boolean
  walk_to_read?: boolean
}>

export const mentionResidents = Object.freeze([
  ...publicWindowFixture.residents,
  { id: 901, handle: 'selene', current_place_id: 11, joined_at: '2026-08-13T17:00:00.000Z' },
  { id: 902, handle: 'north-star', current_place_id: 12, joined_at: '2026-08-13T17:00:00.000Z' },
])

export function mentionNote(id: number, body: string, extra: Partial<MentionNote> = {}): MentionNote {
  return { id, body, place_id: 11, author: 'browser-resident',
    created_at: '2026-08-13T19:03:00.000Z', moderated: false, ...extra }
}

type Options = Readonly<{
  notes?: readonly MentionNote[]
  fullBodies?: Readonly<Record<number, string>>
  rosterHandles?: readonly string[]
  hiddenPlaceIds?: readonly number[]
}>

export async function installMentionsFixture(page: Page, options: Options = {}) {
  let notes = options.notes ?? [mentionNote(301, 'Hello selene.')]
  let places = [
    ...publicWindowFixture.places.map(place => ({ ...place, quiet: false })),
    { ...publicWindowFixture.places[1], id: 99, name: 'distant_room', quiet: true },
  ]
  let marker = 9
  let mentionsFail = false
  let changesFail = false
  let changes: readonly Record<string, unknown>[] = []
  const requests: string[] = []
  const delays = new Map<string, Promise<void>>()
  const delay = (key: string) => {
    let release = () => {}
    delays.set(key, new Promise<void>(resolve => { release = resolve }))
    return release
  }
  const wait = async (key: string) => {
    const pending = delays.get(key)
    delays.delete(key)
    if (pending) await pending
  }
  const publicPlaces = () => places.filter(place => !options.hiddenPlaceIds?.includes(place.id))
  const roster = mentionResidents.filter(resident =>
    !options.rosterHandles || options.rosterHandles.includes(resident.handle))
  const orderedNotes = () => [...notes].sort((left, right) => right.id - left.id)
  const pageRows = (rows: readonly MentionNote[], url: URL) => {
    const before = Number(url.searchParams.get('before_id') || Number.MAX_SAFE_INTEGER)
    const after = Number(url.searchParams.get('after_id') || 0)
    const limit = Number(url.searchParams.get('limit') || 10)
    const matching = rows.filter(note => note.id < before && note.id > after)
    const shown = matching.slice(0, limit)
    const more = matching.length > shown.length
    return { notes: shown, has_more: more, next_before_id: more ? shown.at(-1)?.id : null,
      change_marker: String(marker) }
  }
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) requests.push(url.pathname + url.search)
  })
  await page.route('**/api/window**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') {
      await wait('directory')
      return route.fulfill({ json: { view: 'directory', places: publicPlaces(),
        residents: mentionResidents } })
    }
    const collection = url.searchParams.get('collection')
    if (collection) {
      if (collection !== 'notes') return route.fulfill({ json: {
        [collection]: [], has_more: false, next_before_id: null, change_marker: String(marker),
      } })
      const resident = url.searchParams.get('resident')
      const mentions = url.searchParams.get('mentions')
      const place = Number(url.searchParams.get('within_place_id') || url.searchParams.get('place_id'))
      const rows = orderedNotes().filter(note => (!resident || note.author === resident) &&
        (!place || note.place_id === place) && (!mentions || (!note.walk_to_read &&
          !note.moderated && new RegExp('(^|[^a-z0-9-])' + mentions + '([^a-z0-9-]|$)', 'i')
            .test(options.fullBodies?.[note.id] ?? note.body))))
      const payload = pageRows(rows, url)
      await wait(mentions ? 'mentions' : 'history')
      if (mentions && mentionsFail) return route.fulfill({ status: 503,
        json: { error: 'Public notes naming this resident are temporarily busy; retry.' } })
      return route.fulfill({ json: payload })
    }
    const pageNotes = orderedNotes().slice(0, 10)
    return route.fulfill({ json: { ...publicWindowFixture, places: publicPlaces(), residents: roster,
      notes: pageNotes, things: [], agreements: [], events: [], change_marker: String(marker),
      pages: { notes: { has_more: notes.length > pageNotes.length,
        next_before_id: notes.length > pageNotes.length ? pageNotes.at(-1)?.id : null } },
      totals: { ...publicWindowFixture.totals, conversations: notes.length, residents: mentionResidents.length },
    } })
  })
  await page.route('**/api/note/*', async route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    const note = notes.find(candidate => candidate.id === id)
    await wait('note')
    return note ? route.fulfill({ json: { note: { ...note,
      body: options.fullBodies?.[id] ?? note.body, truncated: false } } })
      : route.fulfill({ status: 404, json: { error: 'No public note was found.' } })
  })
  await page.route('**/api/map**', async route => {
    const id = Number(new URL(route.request().url()).searchParams.get('parent_id'))
    const place = places.find(candidate => candidate.id === id)
    await wait('place')
    return route.fulfill({ json: { place, subplaces: [], change_marker: String(marker),
      has_more: false, next_before_id: null } })
  })
  await page.route('**/api/place/*', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/').at(-1))
    return route.fulfill({ json: { place: places.find(candidate => candidate.id === id),
      subplaces: [], change_marker: String(marker) } })
  })
  await page.route('**/api/residents**', route => {
    const handle = new URL(route.request().url()).searchParams.get('handle')
    return route.fulfill({ json: handle
      ? { resident: mentionResidents.find(resident => resident.handle === handle), change_marker: String(marker) }
      : { residents: roster, change_marker: String(marker), has_more: false } })
  })
  await page.route('**/api/changes**', route => {
    if (changesFail) return route.fulfill({ status: 503, json: { error: 'Try again.' } })
    const since = Number(new URL(route.request().url()).searchParams.get('since'))
    return route.fulfill({ json: { change_marker: String(marker), unchanged: since === marker,
      changes: changes.filter(change => Number(change.change_id) > since), has_more: false, next_since: null } })
  })
  await page.route('**/api/events**', route => route.fulfill({ json: {
    events: [], change_marker: String(marker), has_more: false, next_before_id: null,
  } }))
  return {
    requests,
    delayDirectory: () => delay('directory'),
    delayPlace: () => delay('place'),
    delayNote: () => delay('note'),
    delayMentions: () => delay('mentions'),
    failMentions(value = true) { mentionsFail = value },
    failChanges(value = true) { changesFail = value },
    removeNote(id: number) {
      notes = notes.filter(note => note.id !== id)
      marker += 1
      changes = [...changes, { change_id: String(marker), kind: 'moderation',
        actor: 'browser-resident', created_at: '2026-08-13T19:04:00.000Z',
        detail: { target_type: 'note', target_id: id, action: 'remove' } }]
    },
    setNotes(next: readonly MentionNote[]) { notes = next; marker += 1 },
    setQuiet(id: number) {
      marker += 1
      places = places.map(place => place.id === id ? { ...place, quiet: true } : place)
      changes = [...changes, { change_id: String(marker), kind: 'place_edited', actor: 'browser-resident',
        created_at: '2026-08-13T19:04:00.000Z', detail: { place_id: id } }]
    },
    async refresh() {
      const response = page.waitForResponse(response =>
        new URL(response.url()).pathname === '/api/window' &&
        new URL(response.url()).searchParams.get('view') === 'outline')
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await response
    },
  }
}

export async function readyMentions(page: Page, path = '/window/conversations') {
  await page.goto(path)
  await expect(page.locator('#window-status')).toContainText('Watching')
}

export function mentionCard(page: Page, id = 301) {
  return page.locator('#conversation-stream [data-viewer-record-key="note:' + String(id) + '"]')
}
