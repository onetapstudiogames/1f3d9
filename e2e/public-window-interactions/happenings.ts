import { expect, test } from '@playwright/test'
import { FAR_WALKER_ACTION_EVENTS } from '../helpers/public-window-snapshot-fixtures.ts'

export function registerPublicWindowHappenings() {
  test('action happenings keep their verb and movement and collapse only consecutive copies', async ({ page }) => {
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      return route.fulfill({
        json: {
          events: FAR_WALKER_ACTION_EVENTS,
          has_more: false,
          next_before_id: null,
          change_marker: '20',
        },
      })
    })

    await page.locator('#resident-filter').selectOption('far-walker')
    const happeningsRequest = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        response.status() === 200
    })
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await happeningsRequest

    const activity = page.locator('#activity-list')
    await expect.soft(activity).toContainText(
      /far-walker.*\buse(?:d)?\b.*(?:3\s+times|×\s*3)/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*\bmove(?:d)?\b.*from .*inner_hall.*to .*quiet_annex/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*tried to move from .*inner_hall.*to .*quiet_annex.*blocked.*local law quiet-hours blocks movement into this place/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*tried to go home from .*quiet_annex.*to .*root_plaza.*no change/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*tried to use.*failed.*this recipe needs a lit trait in this place/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*tried to use.*failed.*the target thing is missing from this place/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*tried to use.*failed.*no cause was recorded/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*resolved a stored effect.*failed.*the stored target thing no longer exists/i,
    )
    await expect.soft(activity).toContainText(
      /far-walker.*resolved a stored effect.*skipped.*the stored source thing no longer exists/i,
    )
    await expect.soft(activity).not.toContainText('must not appear for an applied stored effect')
    await expect.soft(activity).not.toContainText('acted in the city')
    await expect.soft(activity.locator('.activity-row')).toHaveCount(11)
    await expect.soft(activity.locator('.activity-count')).toHaveText('· 3 times')
  })

  test('carry happenings name the owner move and the thing movement', async ({ page }) => {
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      return route.fulfill({ json: {
        events: [{
          id: 502,
          at: '2026-08-15T12:07:00.000Z',
          kind: 'action',
          actor: 'far-walker',
          detail: {
            action_id: 302,
            action: 'move',
            status: 'applied',
            mode: 'carry',
            thing_id: 33,
            from_place_id: 12,
            to_place_id: 77,
          },
        }, {
          id: 501,
          at: '2026-08-15T12:07:00.000Z',
          kind: 'thing_moved',
          actor: 'far-walker',
          detail: {
            action_id: 302,
            mode: 'carry',
            thing_id: 33,
            from_place_id: 12,
            place_id: 77,
          },
        }],
        has_more: false,
        next_before_id: null,
        change_marker: '20',
      } })
    })

    await page.locator('#resident-filter').selectOption('far-walker')
    await page.getByRole('tab', { name: 'Happenings' }).click()

    const activity = page.locator('#activity-list')
    await expect(activity).toContainText(
      /far-walker.*moved.*from .*inner_hall.*to .*quiet_annex.*carrying Thing #33/i,
    )
    await expect(activity).toContainText(
      /far-walker.*carried Thing #33 with them.*from .*inner_hall.*to .*quiet_annex/i,
    )
    await expect(activity.locator('.activity-row')).toHaveCount(2)
  })

  test('Gazette print happening names its system actor, issue, submissions, and room', async ({ page }) => {
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('before_id') !== '51') return route.fallback()
      return route.fulfill({
        json: {
          events: [{
            id: 50,
            at: '2026-10-12T16:00:02.000Z',
            kind: 'gazette_printed',
            actor: 'the Gazette printer',
            detail: { issue_number: 7, place_id: 454, entry_count: 3 },
          }],
          has_more: false,
          next_before_id: null,
          change_marker: '20',
        },
      })
    })

    await page.getByRole('tab', { name: 'Happenings' }).click()
    await page.getByRole('button', { name: 'Load older happenings' }).click()

    const activity = page.locator('#activity-list')
    await expect(activity).toContainText(
      /the Gazette printer.*printed The Gazette.*issue 7.*3 submissions.*Room #454/i,
    )
    await expect(page.getByRole('button', { name: 'the Gazette printer' })).toHaveCount(0)
  })

  test('unsafe and overlong recorded causes stay distinct and honest in the window', async ({ page }) => {
    const overlongCause = `${'x'.repeat(500)}hidden cause tail`
    const exactCause = 'y'.repeat(500)
    await page.route('**/api/events**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      return route.fulfill({
        json: {
          events: [{
            id: 303,
            at: '2026-08-15T12:13:00.000Z',
            kind: 'action',
            actor: 'far-walker',
            detail: {
              action_id: 403, action: 'use', status: 'failed', place_id: 77,
              error: exactCause,
            },
          }, {
            id: 302,
            at: '2026-08-15T12:12:00.000Z',
            kind: 'action',
            actor: 'far-walker',
            detail: {
              action_id: 402, action: 'use', status: 'failed', place_id: 77,
              error: overlongCause,
            },
          }, {
            id: 301,
            at: '2026-08-15T12:11:00.000Z',
            kind: 'action',
            actor: 'far-walker',
            detail: {
              action_id: 401, action: 'use', status: 'failed', place_id: 77,
              error: 'unsafe\u0007cause',
            },
          }, {
            id: 300,
            at: '2026-08-15T12:10:00.000Z',
            kind: 'action',
            actor: 'far-walker',
            detail: { action_id: 400, action: 'use', status: 'failed', place_id: 77 },
          }],
          has_more: false,
          next_before_id: null,
          change_marker: '20',
        },
      })
    })

    await page.locator('#resident-filter').selectOption('far-walker')
    const happeningsRequest = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        response.status() === 200
    })
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await happeningsRequest

    const activity = page.locator('#activity-list')
    await expect(activity.locator('.activity-row')).toHaveCount(4)
    await expect(activity).toContainText('the recorded cause could not be shown safely')
    await expect(activity).toContainText('no cause was recorded')
    const truncatedRow = activity.locator('.activity-row').filter({ hasText: 'x'.repeat(40) })
    await expect(truncatedRow).toHaveCount(1)
    await expect(truncatedRow).toContainText('cause excerpt; the rest is not shown in this window')
    await expect(truncatedRow).toContainText(`${'x'.repeat(499)}…`)
    await expect(truncatedRow).not.toContainText('hidden cause tail')
    const exactRow = activity.locator('.activity-row').filter({ hasText: 'y'.repeat(40) })
    await expect(exactRow).toHaveCount(1)
    await expect(exactRow).toContainText(exactCause)
    await expect(exactRow).not.toContainText('cause excerpt')
  })

  test('Decision 46 separates loading, retryable failure, and completed empty reads', async ({ page }) => {
    let releaseHappenings!: () => void
    const heldHappenings = new Promise<void>(resolve => { releaseHappenings = resolve })
    let happeningAttempts = 0
    await page.route('**/api/events**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('actor') !== 'far-walker') return route.fallback()
      happeningAttempts += 1
      if (happeningAttempts === 1) {
        await heldHappenings
        return route.fulfill({ status: 503, json: { error: 'test filtered happenings failure' } })
      }
      return route.fulfill({
        json: { events: [], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })

    let releaseAgreements!: () => void
    const heldAgreements = new Promise<void>(resolve => { releaseAgreements = resolve })
    let agreementAttempts = 0
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'agreements' ||
          url.searchParams.get('resident') !== 'far-walker') {
        return route.fallback()
      }
      agreementAttempts += 1
      if (agreementAttempts === 1) {
        await heldAgreements
        return route.fulfill({ status: 503, json: { error: 'test filtered agreements failure' } })
      }
      return route.fulfill({
        json: { agreements: [], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })

    await page.locator('#resident-filter').selectOption('far-walker')

    const happeningRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker'
    }, { timeout: 5_000 })
    await page.getByRole('tab', { name: 'Happenings' }).click()
    await happeningRequest
    await expect(page.locator('#activity-list')).toHaveText('Fetching happenings that match this view…')
    releaseHappenings()

    const happeningsPanel = page.locator('#happenings-panel')
    await expect(page.locator('#activity-list')).toHaveText('Happenings could not be loaded. Retry below.')
    await expect(page.locator('#activity-list')).not.toContainText(/no happening .*matches/i)
    const happeningsRetry = happeningsPanel.getByRole('button', {
      name: 'Retry loading happenings', exact: true,
    })
    await expect(happeningsRetry).toBeVisible()
    const successfulHappenings = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('actor') === 'far-walker' &&
        response.status() === 200
    }, { timeout: 5_000 })
    await happeningsRetry.click()
    await successfulHappenings
    await expect(page.locator('#activity-list')).toHaveText('No public happening matches this selection.')
    await expect(page.locator('#activity-list')).not.toContainText(/bounded|currently loaded|may be omitted/i)

    const agreementRequest = page.waitForRequest(request => {
      const url = new URL(request.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
        url.searchParams.get('resident') === 'far-walker'
    }, { timeout: 5_000 })
    await page.getByRole('tab', { name: 'Agreements' }).click()
    await agreementRequest
    await expect(page.locator('#agreement-list')).toHaveText('Fetching agreements that match this resident…')
    releaseAgreements()

    const agreementsPanel = page.locator('#agreements-panel')
    await expect(page.locator('#agreement-list')).toHaveText('Agreements could not be loaded. Retry below.')
    await expect(page.locator('#agreement-list')).not.toContainText(/no agreement .*matches/i)
    const agreementsRetry = agreementsPanel.getByRole('button', {
      name: 'Retry loading agreements', exact: true,
    })
    await expect(agreementsRetry).toBeVisible()
    const successfulAgreements = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
        url.searchParams.get('resident') === 'far-walker' && response.status() === 200
    }, { timeout: 5_000 })
    await agreementsRetry.click()
    await successfulAgreements
    await expect(page.locator('#agreement-list')).toHaveText(
      'No public agreement matches this resident selection.',
    )
    await expect(page.locator('#agreement-list')).not.toContainText(/bounded|currently loaded|may be omitted/i)
  })

  test('conversation scope names loading, failure, and completed empty without inventing zero', async ({ page }) => {
    let releaseConversation!: () => void
    const heldConversation = new Promise<void>(resolve => { releaseConversation = resolve })
    let attempts = 0
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'notes' ||
          url.searchParams.get('resident') !== 'far-walker') {
        return route.fallback()
      }
      attempts += 1
      if (attempts === 1) {
        await heldConversation
        return route.fulfill({ status: 503, json: { error: 'test conversation failure' } })
      }
      return route.fulfill({
        json: { notes: [], has_more: false, next_before_id: null, change_marker: '20' },
      })
    })

    await page.locator('#resident-filter').selectOption('far-walker')
    await page.getByRole('tab', { name: 'Conversations' }).click()
    const scope = page.locator('#city-facts #view-scope')
    await expect(scope).toContainText('Loading that public read.')
    await expect(scope).not.toContainText('Showing 0 fetched notes')
    await expect(scope).not.toContainText('0 of 3 conversations')
    releaseConversation()
    await expect(scope).toContainText('That public read failed')
    await expect(scope).not.toContainText('Showing 0 fetched notes')
    await expect(scope).not.toContainText('0 of 3 conversations')

    const successfulRetry = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'far-walker' && response.status() === 200
    })
    await page.getByRole('button', { name: 'Retry loading conversations', exact: true }).click()
    await successfulRetry
    await expect(scope).toContainText('Nothing was found.')
    await expect(scope).not.toContainText(
      /Nothing was found[^.]{0,80}(?:bounded|currently loaded)|Showing 0 fetched notes/i,
    )
    await expect(scope).not.toContainText('0 of 3 conversations')
  })
}
