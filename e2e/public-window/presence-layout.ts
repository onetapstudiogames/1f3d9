import { expect, test } from '@playwright/test'
import { boxesIntersect, DETACHED_READ_TIMEOUT_MS, measureRebuildableBoxes, comparedOperands } from '../helpers/public-window-layout.ts'

export function registerPublicWindowPresenceLayout() {
  test('presence rows keep handles and long locations separate at phone and desktop widths', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.route('**/api/window*', async route => {
      const response = await route.fetch()
      const body = await response.json() as {
        readonly places?: ReadonlyArray<Record<string, unknown>>
        readonly [key: string]: unknown
      }
      if (!body.places) {
        await route.fulfill({ response })
        return
      }
      const residents = Array.isArray(body.residents)
        ? body.residents.map(resident => resident && typeof resident === 'object'
          ? {
              ...resident,
              handle: Number((resident as { id?: unknown }).id) === 49
                ? 'fable-lyrebird'
                : Number((resident as { id?: unknown }).id) === 48
                  ? 'off-by-one'
                  : (resident as { handle?: unknown }).handle,
              current_place_id: Number((resident as { id?: unknown }).id) === 48
                ? 11
                : (resident as { current_place_id?: unknown }).current_place_id,
              has_drawing: Number((resident as { id?: unknown }).id) === 49,
            }
          : resident)
        : []
      await route.fulfill({
        response,
        json: {
          ...body,
          residents,
          things: Array.isArray(body.things)
            ? body.things.map(thing => thing && typeof thing === 'object'
              ? { ...thing, has_drawing: Number((thing as { id?: unknown }).id) === 401 }
              : thing)
            : body.things,
          places: body.places.map(place => place.id === 11 ? {
            ...place,
            name: 'frontier valley / the corrigenda room / the long lantern gallery',
          } : place),
        },
      })
    })

    await page.goto('/window/place/11')
    await expect(page.locator('#window-status')).toContainText('Watching')

    const placeRow = page.locator('#place-occupants .person-card')
      .filter({ hasText: 'fable-lyrebird' })
    await expect(placeRow).toBeVisible()
    const [placeHandleBox, placeMetaBox] = await measureRebuildableBoxes(() => [
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-follow'),
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-number'),
    ], 'phone drawn place row')
    expect(
      boxesIntersect(placeHandleBox, placeMetaBox),
      comparedOperands({ placeHandleBox, placeMetaBox }),
    ).toBe(false)
    expect(
      placeMetaBox.y,
      comparedOperands({ placeMetaY: placeMetaBox.y,
        placeHandleBottomMinusHalf: placeHandleBox.y + placeHandleBox.height - 0.5 }),
    ).toBeGreaterThanOrEqual(
      placeHandleBox.y + placeHandleBox.height - 0.5,
    )
    await expect.poll(() => page.locator('#place-occupants .person-card')
      .filter({ hasText: 'fable-lyrebird' }).locator('.resident-number').evaluate(element => {
        if (!element.isConnected) return null
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getClientRects().length
      }), {
      message: 'phone place metadata line count: actual and minimum are compared below',
      timeout: DETACHED_READ_TIMEOUT_MS,
    }).toBeGreaterThanOrEqual(2)

    const [placePortraitBox] = await measureRebuildableBoxes(
      () => [page.locator('#place-occupants .person-card')
        .filter({ hasText: 'fable-lyrebird' }).locator('.entity-portrait')],
      'phone place portrait',
    )
    expect(
      placePortraitBox.y,
      comparedOperands({ placePortraitY: placePortraitBox.y,
        placeHandleBottom: placeHandleBox.y + placeHandleBox.height }),
    ).toBeLessThan(placeHandleBox.y + placeHandleBox.height)
    expect(
      placePortraitBox.y + placePortraitBox.height,
      comparedOperands({ placePortraitBottom: placePortraitBox.y + placePortraitBox.height,
        placeHandleY: placeHandleBox.y }),
    ).toBeGreaterThan(placeHandleBox.y)

    const undrawnPlaceRow = page.locator('#place-occupants .person-card')
      .filter({ hasText: 'off-by-one' })
    await expect(undrawnPlaceRow).toHaveCount(1)
    await expect(undrawnPlaceRow.locator('.entity-portrait')).toHaveCount(0)
    const [phoneUndrawnHandleBox, phoneUndrawnMetaBox] = await measureRebuildableBoxes(() => [
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'off-by-one' }).locator('.resident-follow'),
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'off-by-one' }).locator('.resident-number'),
    ], 'phone undrawn place row')
    expect(
      boxesIntersect(phoneUndrawnHandleBox, phoneUndrawnMetaBox),
      comparedOperands({ phoneUndrawnHandleBox, phoneUndrawnMetaBox }),
    ).toBe(false)
    expect(
      phoneUndrawnMetaBox.y,
      comparedOperands({ phoneUndrawnMetaY: phoneUndrawnMetaBox.y,
        phoneUndrawnHandleBottomMinusHalf:
          phoneUndrawnHandleBox.y + phoneUndrawnHandleBox.height - 0.5 }),
    ).toBeGreaterThanOrEqual(
      phoneUndrawnHandleBox.y + phoneUndrawnHandleBox.height - 0.5,
    )
    expect(
      phoneUndrawnHandleBox.x,
      comparedOperands({ phoneUndrawnHandleX: phoneUndrawnHandleBox.x,
        placeHandleX: placeHandleBox.x }),
    ).toBeLessThan(placeHandleBox.x)

    await page.setViewportSize({ width: 1280, height: 900 })
    for (const row of [placeRow, undrawnPlaceRow]) {
      const rowLabel = row === placeRow ? 'drawn' : 'undrawn'
      const [handleBox, metaBox] = await measureRebuildableBoxes(() => [
        row.locator('.resident-follow'),
        row.locator('.resident-number'),
      ], `desktop ${rowLabel} place row`)
      expect(
        boxesIntersect(handleBox, metaBox),
        comparedOperands({ rowLabel, handleBox, metaBox }),
      ).toBe(false)
    }
    const [desktopDrawnHandleBox, desktopUndrawnHandleBox] = await measureRebuildableBoxes(() => [
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-follow'),
      page.locator('#place-occupants .person-card')
        .filter({ hasText: 'off-by-one' }).locator('.resident-follow'),
    ], 'desktop place handle offsets')
    expect(
      desktopUndrawnHandleBox.x,
      comparedOperands({ desktopUndrawnHandleX: desktopUndrawnHandleBox.x,
        desktopDrawnHandleX: desktopDrawnHandleBox.x }),
    ).toBeLessThan(desktopDrawnHandleBox.x)

    await page.setViewportSize({ width: 390, height: 844 })

    const [thingNameBox, thingMetaBox] = await measureRebuildableBoxes(() => [
      page.locator('#place-things .thing-card').filter({ hasText: 'field_lantern' }).locator('h4'),
      page.locator('#place-things .thing-card')
        .filter({ hasText: 'field_lantern' }).locator('.thing-meta'),
    ], 'phone place thing row')
    expect(
      boxesIntersect(thingNameBox, thingMetaBox),
      comparedOperands({ thingNameBox, thingMetaBox }),
    ).toBe(false)
    expect(
      thingMetaBox.y,
      comparedOperands({ thingMetaY: thingMetaBox.y,
        thingNameBottomMinusHalf: thingNameBox.y + thingNameBox.height - 0.5 }),
    ).toBeGreaterThanOrEqual(thingNameBox.y + thingNameBox.height - 0.5)

    await page.getByRole('tab', { name: 'Map', exact: true }).click()
    const rosterRow = page.locator('#resident-roster .resident-row')
      .filter({ hasText: 'fable-lyrebird' })
    await expect(rosterRow).toBeVisible()
    const rosterMeta = rosterRow.locator('.resident-number')
    await rosterMeta.evaluate(element => {
      element.textContent =
        'resident #49 · at frontier valley / the corrigenda room / the long lantern gallery'
    })
    const [rosterHandleBox, rosterMetaBox] = await measureRebuildableBoxes(() => [
      page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-follow'),
      page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-number'),
    ], 'phone roster row')
    expect(
      boxesIntersect(rosterHandleBox, rosterMetaBox),
      comparedOperands({ rosterHandleBox, rosterMetaBox }),
    ).toBe(false)
    expect(
      rosterMetaBox.y,
      comparedOperands({ rosterMetaY: rosterMetaBox.y,
        rosterHandleBottomMinusHalf: rosterHandleBox.y + rosterHandleBox.height - 0.5 }),
    ).toBeGreaterThanOrEqual(
      rosterHandleBox.y + rosterHandleBox.height - 0.5,
    )
    await expect.poll(() => page.locator('#resident-roster .resident-row')
      .filter({ hasText: 'fable-lyrebird' }).locator('.resident-number').evaluate(element => {
        if (!element.isConnected) return null
        const range = document.createRange()
        range.selectNodeContents(element)
        return range.getClientRects().length
      }), {
      message: 'phone roster metadata line count: actual and minimum are compared below',
      timeout: DETACHED_READ_TIMEOUT_MS,
    }).toBeGreaterThanOrEqual(2)

    await page.setViewportSize({ width: 1280, height: 900 })
    const [desktopRosterHandleBox, desktopRosterMetaBox] = await measureRebuildableBoxes(() => [
      page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-follow'),
      page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'fable-lyrebird' }).locator('.resident-number'),
    ], 'desktop roster row')
    expect(
      boxesIntersect(desktopRosterHandleBox, desktopRosterMetaBox),
      comparedOperands({ desktopRosterHandleBox, desktopRosterMetaBox }),
    ).toBe(false)
  })
}
