import { expect, test } from '@playwright/test'
import { scrollRebuildableIntoView } from '../helpers/public-window-layout.ts'

export function registerPublicWindowEntryAndPortraits() {
  test('public window links to the dated public snapshot archive', async ({ page }) => {
    await page.goto('/window')
    const link = page.getByRole('link', { name: 'Public snapshots' })
    await expect(link).toHaveAttribute(
      'href',
      'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-',
    )
  })

  test('public window shows lazy thumbnail portraits beside roster and room names', async ({ page }) => {
    const thumbnailPaths: string[] = []
    const transparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGklEQVR42u3BAQEAAACCIP+vbkhAAQAAAO8GECAAAcm1w7EAAAAASUVORK5CYII=',
      'base64',
    )
    const eventOnlyAt = new Date().toISOString()
    const eventOnlyReferences = [
      {
        id: 9_401, at: eventOnlyAt, kind: 'thing_created', actor: 'browser-resident',
        detail: { thing_id: 9_401, place_id: 11 }, thing_has_drawing: true,
      },
      {
        id: 9_402, at: eventOnlyAt, kind: 'thing_created', actor: 'browser-resident',
        detail: { thing_id: 9_402, place_id: 11 }, thing_has_drawing: false,
      },
    ]
    await page.route('**/api/drawing/*/*/thumb.png*', async route => {
      const url = new URL(route.request().url())
      thumbnailPaths.push(url.pathname + url.search)
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: { 'cache-control': 'public, max-age=31536000, immutable' },
        body: transparentPng,
      })
    })
    await page.route('**/api/events**', async route => {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      const events = Array.isArray(body.events) ? body.events : []
      await route.fulfill({ response, json: {
        ...body,
        events: [
          ...eventOnlyReferences,
          ...events,
        ],
      } })
    })
    await page.route('**/api/window**', async route => {
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      const markResidents = (value: unknown) => Array.isArray(value)
        ? value.map(resident => resident && typeof resident === 'object'
          ? { ...resident, has_drawing: Number((resident as { id?: unknown }).id) === 49 }
          : resident)
        : value
      const markThings = (value: unknown) => Array.isArray(value)
        ? value.map(thing => thing && typeof thing === 'object'
          ? { ...thing, has_drawing: Number((thing as { id?: unknown }).id) === 401 }
          : thing)
        : value
      await route.fulfill({ response, json: {
        ...body,
        residents: markResidents(body.residents),
        things: markThings(body.things),
        events: [...eventOnlyReferences, ...(Array.isArray(body.events) ? body.events : [])],
      } })
    })

    await page.goto('/window/map')
    await expect(page.locator('#window-status')).toContainText('Watching')
    const rosterRow = page.locator('#resident-roster .resident-row')
      .filter({ hasText: 'browser-resident' })
    await scrollRebuildableIntoView(
      () => page.locator('#resident-roster .resident-row').filter({ hasText: 'browser-resident' }),
      'browser-resident roster portrait',
    )
    const rosterPortrait = rosterRow.locator('.entity-portrait img')
    await expect(rosterPortrait).toHaveAttribute('loading', 'lazy')
    await expect(rosterPortrait).toHaveAttribute('width', '32')
    await expect(rosterPortrait).toHaveAttribute('height', '32')
    await expect(rosterPortrait).toHaveAttribute(
      'src',
      /\/api\/drawing\/resident\/49\/thumb\.png\?rev=9$/u,
    )
    const rosterPortraitShell = rosterRow.locator('.entity-portrait')
    await expect(rosterPortraitShell).toBeVisible()
    await expect(rosterPortraitShell).toHaveAttribute('data-portrait-state', 'loaded')
    expect(await rosterPortraitShell.evaluate(shell => {
      const shellStyle = getComputedStyle(shell)
      const placeholder = shell.querySelector('.entity-portrait-placeholder')
      const placeholderStyle = placeholder ? getComputedStyle(placeholder) : null
      return {
        shellBackgroundColor: shellStyle.backgroundColor,
        shellBackgroundImage: shellStyle.backgroundImage,
        shellBorderStyle: shellStyle.borderStyle,
        placeholderBackgroundColor: placeholderStyle?.backgroundColor ?? null,
        placeholderBackgroundImage: placeholderStyle?.backgroundImage ?? null,
      }
    })).toEqual({
      shellBackgroundColor: 'rgba(0, 0, 0, 0)',
      shellBackgroundImage: 'none',
      shellBorderStyle: 'none',
      placeholderBackgroundColor: 'rgba(0, 0, 0, 0)',
      placeholderBackgroundImage: 'none',
    })

    await page.getByRole('tab', { name: 'Place', exact: true }).click()
    await expect(page).toHaveURL(/\/window\/place\/11$/u)
    const occupant = page.locator('#place-occupants .person-card')
      .filter({ hasText: 'browser-resident' })
    await scrollRebuildableIntoView(
      () => page.locator('#place-occupants .person-card').filter({ hasText: 'browser-resident' }),
      'browser-resident place portrait',
    )
    await expect(occupant.locator('.entity-portrait img')).toHaveAttribute(
      'src',
      /\/api\/drawing\/resident\/49\/thumb\.png\?rev=9$/u,
    )
    const thing = page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' })
    await scrollRebuildableIntoView(
      () => page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' }),
      'field_lantern place portrait',
    )
    await expect(thing.locator('.entity-portrait img[data-portrait-type="thing"]')).toHaveAttribute(
      'src',
      /\/api\/drawing\/thing\/401\/thumb\.png\?rev=9$/u,
    )
    await expect(thing.locator('.kind-portrait img[data-portrait-type="kind"]')).toHaveAttribute(
      'src',
      /\/api\/drawing\/kind\/77\/thumb\.png\?rev=9$/u,
    )
    await expect(page.locator(
      '#place-notes .note-card .entity-portrait[data-portrait-type="note"]',
    )).toHaveCount(0)

    const happeningsResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/events' && url.searchParams.get('within_place_id') === '11' &&
        !url.searchParams.has('before_id') && response.status() === 200
    })
    await page.getByRole('tab', { name: 'Happenings', exact: true }).click()
    await happeningsResponse
    const madeThing = page.locator('#activity-list .activity-row').filter({ hasText: 'field_lantern' })
    await expect(madeThing).toBeVisible()
    const madeThingPortrait = madeThing.locator(
      '.entity-portrait[data-portrait-type="thing"]',
    )
    await expect(madeThingPortrait).toHaveCount(1)
    await scrollRebuildableIntoView(
      () => page.locator('#activity-list .activity-row')
        .filter({ hasText: 'field_lantern' })
        .locator('.entity-portrait[data-portrait-type="thing"]'),
      'field_lantern happening portrait',
    )
    const madeThingPortraitImage = madeThingPortrait.locator('img')
    await expect(madeThingPortraitImage).toHaveCount(1)
    await expect(madeThingPortraitImage).toHaveAttribute(
      'src',
      /\/api\/drawing\/thing\/401\/thumb\.png\?rev=9$/u,
    )
    const eventOnlyDrawn = page.locator('#activity-list .activity-thing-reference')
      .filter({ hasText: 'Thing #9401' })
    const eventOnlyUndrawn = page.locator('#activity-list .activity-thing-reference')
      .filter({ hasText: 'Thing #9402' })
    await expect(eventOnlyDrawn.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(1)
    await expect(eventOnlyUndrawn.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(0)

    expect(thumbnailPaths).toContain('/api/drawing/resident/49/thumb.png?rev=9')
    expect(thumbnailPaths).toContain('/api/drawing/thing/401/thumb.png?rev=9')
    expect(thumbnailPaths).toContain('/api/drawing/kind/77/thumb.png?rev=9')
  })
}
