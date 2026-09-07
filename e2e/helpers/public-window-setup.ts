import { expect, test } from '@playwright/test'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'
import { LONG_PLACE_NAME, SNAPSHOT, DIRECTORY, FALLBACK_SEARCH_RESIDENTS, FOCUSED_PLACE, FOCUSED_RESIDENT } from './public-window-snapshot-fixtures.ts'
import { FIRST_BRANCH_PAGE, SECOND_BRANCH_PAGE, RESIDENT_PAGE, API_REQUESTS, OLDER_NOTE, OLDER_GLOBAL_NOTE, OLDER_THING, OLDER_AGREEMENT, OLDER_EVENT } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowSetup() {
  test.beforeEach(async ({ page }, testInfo) => {
    API_REQUESTS.set(page, [])
    if (testInfo.title.includes('fully visible long note')) {
      await page.setViewportSize({ width: 1080, height: 1000 })
    }
    page.on('request', request => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) API_REQUESTS.get(page)?.push(url.toString())
    })
    await page.goto('/__e2e/health')
    if (testInfo.title.includes('cold deep link') || testInfo.title.includes('focused selection retry')) {
      await page.evaluate(() => { window.location.hash = '#view=place&place=77' })
    }
    if (testInfo.title.includes('missing directory selection')) {
      await page.evaluate(() => { window.location.hash = '#view=place&place=999' })
    }
    let directoryAttempts = 0
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('view') === 'directory') {
        directoryAttempts += 1
        if (testInfo.title.includes('cold deep link')) {
          await new Promise(resolve => setTimeout(resolve, 250))
        }
        if (testInfo.title.includes('directory failure') && directoryAttempts === 1) {
          return route.fulfill({ status: 503, json: { error: 'test directory failure' } })
        }
        if (testInfo.title.includes('Rooms view withholds a quiet descendant')) {
          return route.fulfill({
            json: {
              ...DIRECTORY,
              places: [...DIRECTORY.places, { id: 79, parent_id: 11, name: 'hidden_nook', quiet: true }],
            },
          })
        }
        return route.fulfill({ json: DIRECTORY })
      }
      const collection = url.searchParams.get('collection')
      if (!collection) {
        const snapshot = testInfo.title.includes('Rooms view withholds a quiet descendant')
          ? {
              ...SNAPSHOT,
              residents: [...SNAPSHOT.residents, {
                id: 50,
                handle: 'nook-keeper',
                current_place_id: 79,
                asleep: false,
                has_drawing: false,
                joined_at: '2026-08-14T12:00:30.000Z',
              }],
              shown: { ...SNAPSHOT.shown, residents: 2 },
            }
          : testInfo.title.includes('fallback search as incomplete')
          ? {
              ...SNAPSHOT,
              residents: FALLBACK_SEARCH_RESIDENTS,
              totals: { ...SNAPSHOT.totals, residents: 30 },
              shown: { ...SNAPSHOT.shown, residents: FALLBACK_SEARCH_RESIDENTS.length },
              pages: {
                ...SNAPSHOT.pages,
                residents: { has_more: true, next_before_id: FALLBACK_SEARCH_RESIDENTS.at(-1)?.id },
              },
            }
          : testInfo.title.includes('focused resident completes presence')
          ? { ...SNAPSHOT, totals: { ...SNAPSHOT.totals, residents: 2 } }
          : testInfo.title.includes('directory filter and sleeper visibility')
            ? {
                ...SNAPSHOT,
                residents: [...SNAPSHOT.residents, RESIDENT_PAGE.residents[1]],
                shown: { ...SNAPSHOT.shown, residents: 2 },
              }
            : SNAPSHOT
        return route.fulfill({ json: snapshot })
      }
      if (collection === 'notes') {
        const note = url.searchParams.has('within_place_id') ? OLDER_NOTE : OLDER_GLOBAL_NOTE
        return route.fulfill({
          json: {
            notes: [note], has_more: false, next_before_id: null, change_marker: '20',
          },
        })
      }
      if (collection === 'things') {
        return route.fulfill({
          json: {
            things: [OLDER_THING], has_more: false, next_before_id: null, change_marker: '20',
          },
        })
      }
      return route.fulfill({
        json: {
          agreements: [OLDER_AGREEMENT], has_more: false, next_before_id: null,
          change_marker: '20',
        },
      })
    })
    let focusedPlaceAttempts = 0
    await page.route('**/api/map**', route => {
      const url = new URL(route.request().url())
      const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
      if (url.searchParams.get('parent_id') === '998') {
        return route.fulfill({ status: 503, json: { error: 'test focused place failure' } })
      }
      if (url.searchParams.get('parent_id') === '77') {
        focusedPlaceAttempts += 1
        if (testInfo.title.includes('focused selection retry') && focusedPlaceAttempts === 1) {
          return route.fulfill({ status: 503, json: { error: 'test focused place failure' } })
        }
        if (testInfo.title.includes('focused name source')) {
          return route.fulfill({
            json: {
              ...FOCUSED_PLACE,
              place: { ...FOCUSED_PLACE.place, name: 'focus_fresh_annex' },
            },
          })
        }
        if (testInfo.title.includes('long selected place heading')) {
          return route.fulfill({
            json: {
              ...FOCUSED_PLACE,
              place: { ...FOCUSED_PLACE.place, name: LONG_PLACE_NAME },
            },
          })
        }
        return route.fulfill({ json: FOCUSED_PLACE })
      }
      if (url.searchParams.get('parent_id') !== '12') {
        return route.fulfill({
          status: 404,
          json: { error: 'unknown test branch', change_marker: changeMarker },
        })
      }
      return route.fulfill({
        json: url.searchParams.get('before_subplace_id') === '14'
          ? SECOND_BRANCH_PAGE
          : FIRST_BRANCH_PAGE,
      })
    })
    await page.route('**/api/residents**', route => {
      const url = new URL(route.request().url())
      const changeMarker = url.searchParams.get('after_change_marker') ?? '20'
      if (url.searchParams.get('handle') === 'missing-reader') {
        return route.fulfill({
          status: 404,
          json: { error: 'unknown resident', change_marker: changeMarker },
        })
      }
      if (url.searchParams.get('handle') === 'failing-reader') {
        return route.fulfill({ status: 503, json: { error: 'test focused resident failure' } })
      }
      if (url.searchParams.get('handle') === 'far-walker') {
        return route.fulfill({ json: { ...FOCUSED_RESIDENT, change_marker: changeMarker } })
      }
      return route.fulfill({ json: { ...RESIDENT_PAGE, change_marker: changeMarker } })
    })
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('before_id') === '51') {
        return route.fulfill({
          json: {
            events: [OLDER_EVENT], has_more: false, next_before_id: null, change_marker: '20',
          },
        })
      }
      return route.fulfill({
        json: {
          events: SNAPSHOT.events, has_more: true, next_before_id: 51, change_marker: '20',
        },
      })
    })

    const htmlWithoutAutomaticClient = WINDOW_HTML.replace(
      /\s*<script src="\/window\.js" defer><\/script>/,
      '',
    )
    await page.setContent(htmlWithoutAutomaticClient)
    await page.addStyleTag({ content: WINDOW_CSS })
    await page.addScriptTag({ content: WINDOW_JS })
    await expect(page.locator('#window-status')).toContainText('Watching')
  })
}
