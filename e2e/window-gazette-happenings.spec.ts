import { expect, test } from '@playwright/test'
import { WINDOW_CSS } from '../src/window-style.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

const ROOT_PLACE_ID = 1201
const KNOWN_PLACE_ID = 1202
const ABSENT_PLACE_ID = 1203
const ISSUE_HEADER = [
  'THE GAZETTE, ISSUE 7',
  'No AI editor, ranking, approval, or selection is used for entries.',
  'HAPPENINGS',
  'Written by the Gazette printer from the public record of the week ending at this print. Fixed published rules pick these few items; no person or AI chooses them, and this column is not a submission.',
  `First lines said: place #${KNOWN_PLACE_ID}, place #${ABSENT_PLACE_ID}.`,
].join('\n')

const SNAPSHOT = Object.freeze({
  view: 'outline',
  change_marker: '50',
  places: [{
    id: ROOT_PLACE_ID,
    parent_id: null,
    name: 'gazette_district',
    owner: 'gazette-owner',
    purpose: '',
    front_matter: [],
    places: 1,
    things: 0,
    notes: 0,
    quiet: false,
    children: [{
      id: KNOWN_PLACE_ID,
      parent_id: ROOT_PLACE_ID,
      name: 'known_hall',
      owner: 'gazette-owner',
      purpose: '',
      front_matter: [],
      places: 0,
      things: 0,
      notes: 0,
      quiet: false,
      children: [],
    }],
  }],
  residents: [],
  notes: [],
  things: [],
  agreements: [],
  events: [],
  live_survey: [
    { id: ROOT_PLACE_ID, parent_id: null, things: 0, notes: 0 },
    { id: KNOWN_PLACE_ID, parent_id: ROOT_PLACE_ID, things: 0, notes: 0 },
  ],
  totals: { places: 2, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
  shown: { places: 2, residents: 0, conversations: 0, things: 0, agreements: 0, events: 0 },
  limits: { places: 10, residents: 25, conversations: 10, things: 10, agreements: 10, events: 10 },
  pages: {
    places: { has_more: false, next_before_subplace_id: null },
    residents: { has_more: false, next_before_id: null },
    notes: { has_more: false, next_before_id: null },
    things: { has_more: false, next_before_id: null },
    agreements: { has_more: false, next_before_id: null },
    events: { has_more: false, next_before_id: null },
  },
  refreshed_at: '2026-09-22T12:02:00.000Z',
})

const DIRECTORY = Object.freeze({
  view: 'directory',
  places: [
    { id: ROOT_PLACE_ID, parent_id: null, name: 'gazette_district', quiet: false },
    { id: KNOWN_PLACE_ID, parent_id: ROOT_PLACE_ID, name: 'known_hall', quiet: false },
  ],
  residents: [],
})

function placeRecord(id: number) {
  return {
    place: {
      id,
      parent_id: ROOT_PLACE_ID,
      name: 'known_hall',
      description: 'A public hall.',
      purpose: '',
      owner: 'gazette-owner',
      status: 'active',
      quiet: false,
      rough_room: false,
      wake_visitors: false,
      wake_pins: [],
      wake_block_thing_ids: [],
      wake_block_residents: [],
      wake_random_cap: 8,
      last_settle: null,
    },
    front_matter: [],
    subplaces: [],
    things: [],
    notes: [],
  }
}

test('the Gazette tab shows Happenings after entries with directory place buttons', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 })
  await page.goto('/__e2e/health')
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('view') === 'directory') return route.fulfill({ json: DIRECTORY })
    const collectionName = url.searchParams.get('collection')
    if (!collectionName) return route.fulfill({ json: SNAPSHOT })
    return route.fulfill({
      json: { [collectionName]: [], has_more: false, next_before_id: null, change_marker: '50' },
    })
  })
  await page.route('**/api/place/**', route => {
    const id = Number(new URL(route.request().url()).pathname.split('/')[3])
    return route.fulfill({ json: placeRecord(id) })
  })
  await page.route('**/api/events**', route => route.fulfill({
    json: { events: [], has_more: false, next_before_id: null, change_marker: '50' },
  }))
  await page.route('**/api/residents**', route => route.fulfill({
    json: { residents: [], has_more: false, next_before_id: null, change_marker: '50' },
  }))
  await page.route('**/api/gazette**', route => {
    const url = new URL(route.request().url())
    if (url.pathname === '/api/gazette/7') {
      return route.fulfill({
        json: {
          issue: {
            issue_number: 7,
            scheduled_for: '2026-10-12T16:00:00.000Z',
            printed_at: '2026-10-12T16:00:12.193Z',
            header: ISSUE_HEADER,
            entry_count: 1,
          },
          entries: [{
            ordinal: 1,
            note_id: 8101,
            author_id: 1,
            author: 'founder',
            body: 'A public issue entry.',
            created_at: '2026-10-09T05:37:12.817Z',
          }],
          has_more: false,
          next_after_ordinal: null,
        },
      })
    }
    return route.fulfill({
      json: {
        submission_room: { place_id: 454, submissions_open: false },
        first_print_at: '2026-08-31T16:00:00.000Z',
        issues: [{
          issue_number: 7,
          scheduled_for: '2026-10-12T16:00:00.000Z',
          printed_at: '2026-10-12T16:00:12.193Z',
          entry_count: 1,
        }],
        has_more: false,
        next_before_issue_number: null,
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
  await page.evaluate(() => { window.location.hash = '#view=gazette&issue=7' })

  const happenings = page.locator('.gazette-happenings')
  await expect(happenings).toHaveCount(1)
  const provenance = page.locator('.gazette-provenance')
  await expect(provenance).toContainText('THE GAZETTE, ISSUE 7')
  await expect(provenance).not.toContainText('HAPPENINGS')
  await expect(happenings.getByRole('heading', { name: 'Happenings' })).toBeVisible()
  await expect(happenings).toContainText('the Gazette printer, from the public record')
  const knownPlace = happenings.getByRole('button', { name: 'known_hall' })
  const absentPlace = happenings.getByRole('button', { name: 'place #1203' })
  await expect(knownPlace).toHaveClass(/gazette-happenings-place resident-follow-inline/u)
  await expect(absentPlace).toBeVisible()

  await knownPlace.click()
  await expect(page.locator('#place-focus-title')).toHaveText('known_hall')
})
