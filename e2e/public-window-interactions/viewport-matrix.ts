import { expect, test } from '@playwright/test'
import { LONG_NOTE, WINDOW_BEHAVIOR_MATRIX, contrastRatio, FAR_WALKER_ACTION_EVENTS } from '../helpers/public-window-snapshot-fixtures.ts'

export function registerPublicWindowViewportMatrix() {
  test('clean view URL restores the directory filter and sleeper visibility', async ({ page }) => {
    const sleeper = page.locator('.sleeper-toggle').first()
    await expect(sleeper).toBeVisible()
    await sleeper.click()
    await expect(sleeper).toHaveAttribute('aria-expanded', 'true')

    const directorySearch = page.locator('#directory-search')
    await directorySearch.fill('quiet annex')
    const cleanUrl = new URL(page.url())
    expect(cleanUrl.pathname).toBe('/window/map')
    expect(cleanUrl.searchParams.get('find')).toBe('quiet annex')
    expect(cleanUrl.searchParams.get('sleepers')).toMatch(/^\d+(?:,\d+)*$/u)
    expect(cleanUrl.hash).toBe('')

    await page.reload()
    await expect(directorySearch).toHaveValue('quiet annex')
    await expect(page.locator('.sleeper-toggle[aria-expanded="true"]').first()).toBeVisible()
  })

  for (const environment of WINDOW_BEHAVIOR_MATRIX) {
    test(`all four observation fixes hold in the window behavior matrix: ${environment.name}`, async ({ page }) => {
      await page.setViewportSize({ width: environment.width, height: environment.height })
      await page.emulateMedia({ colorScheme: environment.colorScheme })

      await expect(page.getByRole('heading', { level: 1, name: 'The City Window' })).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 2, name: 'Who is standing where' })).toBeVisible()

      const placeWatch = page.locator('.place-watch').first()
      const residentFollow = page.locator('#resident-roster .resident-follow').first()
      for (const target of [placeWatch, residentFollow]) {
        const box = await target.boundingBox()
        expect.soft(Math.round((box?.width ?? 0) * 100) / 100).toBeGreaterThanOrEqual(24)
        expect.soft(Math.round((box?.height ?? 0) * 100) / 100).toBeGreaterThanOrEqual(24)
      }
      await placeWatch.focus()
      const lightFocusColors = await placeWatch.evaluate(element => ({
        indicator: getComputedStyle(element).outlineColor,
        innerBand: getComputedStyle(element).boxShadow,
        surface: getComputedStyle(element.closest('.place-card') as Element).backgroundColor,
      }))
      expect.soft(Math.max(
        contrastRatio(lightFocusColors.indicator, lightFocusColors.surface),
        contrastRatio(lightFocusColors.innerBand, lightFocusColors.surface),
      ))
        .toBeGreaterThanOrEqual(3)
      await residentFollow.focus()
      const darkFocusColors = await residentFollow.evaluate(element => ({
        indicator: getComputedStyle(element).outlineColor,
        innerBand: getComputedStyle(element).boxShadow,
        surface: getComputedStyle(element.closest('.roster-board') as Element).backgroundColor,
      }))
      expect.soft(Math.max(
        contrastRatio(darkFocusColors.indicator, darkFocusColors.surface),
        contrastRatio(darkFocusColors.innerBand, darkFocusColors.surface),
      ))
        .toBeGreaterThanOrEqual(3)
      const mutedColors = await page.evaluate(() => {
        const target = document.querySelector('.place-map')
        if (!target) throw new Error('place map is missing')
        const textProbe = document.createElement('p')
        textProbe.className = 'empty-row'
        const surfaceProbe = document.createElement('span')
        surfaceProbe.style.color = 'var(--paper)'
        target.append(textProbe, surfaceProbe)
        const colors = {
          text: getComputedStyle(textProbe).color,
          surface: getComputedStyle(surfaceProbe).color,
        }
        textProbe.remove()
        surfaceProbe.remove()
        return colors
      })
      expect.soft(contrastRatio(mutedColors.text, mutedColors.surface)).toBeGreaterThanOrEqual(4.5)

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
          return route.fulfill({ status: 503, json: { error: 'matrix agreement failure' } })
        }
        return route.fulfill({
          json: { agreements: [], has_more: false, next_before_id: null, change_marker: '20' },
        })
      })
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
      const completeNote = `${LONG_NOTE} Matrix complete note remainder.`
      await page.route('**/api/note/21', route => route.fulfill({
        json: { note: { id: 21, body: completeNote } },
      }))

      await page.locator('#resident-filter').selectOption('far-walker')
      const quietAnnex = page.locator('.place-card').filter({
        has: page.getByRole('button', { name: 'quiet_annex', exact: true }),
      })
      await expect(quietAnnex).toBeVisible()
      const shownResidents = quietAnnex.locator('.occupant-chip')
      await expect(shownResidents).toHaveCount(1)
      await expect(shownResidents).toContainText('far-walker')
      const quietAnnexFacts = quietAnnex.locator('.place-facts')
      await expect.soft(quietAnnexFacts).toContainText(/\b0 places inside\b/u)
      await expect.soft(quietAnnexFacts).toContainText(/\b1 resident shown inside\b/u)

      await page.getByRole('tab', { name: 'Conversations' }).click()
      const pressedConversationMode = page.locator(
        '.conversation-mode-button[aria-pressed="true"]',
      )
      await expect(pressedConversationMode).toBeVisible()
      const unfocusedConversationBands = await page.locator('#conversation-mode').evaluate(surface => {
        const element = surface.querySelector('.conversation-mode-button[aria-pressed="true"]')
        if (!element) throw new Error('pressed conversation mode is missing')
        return getComputedStyle(element).boxShadow.match(/rgba?\([^)]*\)/gu) ?? []
      })
      await page.keyboard.press('Tab')
      const conversationFocusColors = await page.locator('#conversation-mode').evaluate(surface => {
        const element = surface.querySelector('.conversation-mode-button[aria-pressed="true"]')
        if (!element) throw new Error('pressed conversation mode is missing')
        ;(element as HTMLElement).focus()
        const style = getComputedStyle(element)
        return {
          indicator: style.outlineColor,
          shadowBands: style.boxShadow.match(/rgba?\([^)]*\)/gu) ?? [],
          surface: getComputedStyle(surface).backgroundColor,
        }
      })
      expect.soft(conversationFocusColors.shadowBands.length)
        .toBeGreaterThan(unfocusedConversationBands.length)
      expect.soft(Math.max(
        contrastRatio(conversationFocusColors.indicator, conversationFocusColors.surface),
        ...conversationFocusColors.shadowBands.slice(unfocusedConversationBands.length).map(color =>
          contrastRatio(color, conversationFocusColors.surface)),
      )).toBeGreaterThanOrEqual(3)

      await page.getByRole('tab', { name: 'Happenings' }).click()
      await expect(page.getByRole('heading', { level: 1, name: 'The City Window' })).toHaveCount(1)
      await expect(page.getByRole('heading', { level: 2, name: 'Recent happenings' })).toBeVisible()
      const activity = page.locator('#activity-list')
      await expect(activity).toContainText(/far-walker.*\buse(?:d)?\b.*(?:3\s+times|×\s*3)/i)
      await expect(activity).toContainText(
        /far-walker.*\bmove(?:d)?\b.*from .*inner_hall.*to .*quiet_annex/i,
      )
      await expect(activity.locator('.activity-row')).toHaveCount(11)
      const repeatCount = activity.locator('.activity-count')
      await expect(repeatCount).toHaveCount(1)
      await expect(repeatCount).toHaveText('· 3 times')
      expect(await repeatCount.evaluate(element => {
        const style = getComputedStyle(element)
        return { fontFamily: style.fontFamily, whiteSpace: style.whiteSpace }
      })).toEqual(expect.objectContaining({
        fontFamily: expect.stringContaining('ui-monospace'),
        whiteSpace: 'nowrap',
      }))

      const agreementRequest = page.waitForRequest(request => {
        const url = new URL(request.url())
        return url.pathname === '/api/window' && url.searchParams.get('collection') === 'agreements' &&
          url.searchParams.get('resident') === 'far-walker'
      })
      await page.getByRole('tab', { name: 'Agreements' }).click()
      await agreementRequest
      await expect(page.locator('#agreement-list')).toHaveText(
        'Fetching agreements that match this resident…',
      )
      releaseAgreements()
      await expect(page.locator('#agreement-list')).toHaveText(
        'Agreements could not be loaded. Retry below.',
      )
      const agreementRetry = page.getByRole('button', {
        name: 'Retry loading agreements', exact: true,
      })
      await agreementRetry.click()
      await expect(page.locator('#agreement-list')).toHaveText(
        'No public agreement matches this resident selection.',
      )

      await page.locator('#resident-filter').selectOption('')
      await page.locator('#place-filter').selectOption('11')
      await page.getByRole('tab', { name: 'Place' }).click()
      const note = page.locator('#place-conversation .note-card').filter({ hasText: 'Opening note.' })
      await note.getByRole('button', { name: 'Show more' }).click()
      await expect(note.getByRole('button', { name: 'Read the whole note' })).toBeVisible()
      await note.getByRole('button', { name: 'Read the whole note' }).click()
      await expect(note).toContainText('Matrix complete note remainder.')

      expect(await page.evaluate(() => (
        document.documentElement.scrollWidth <= window.innerWidth
      ))).toBe(true)
    })
  }
}
