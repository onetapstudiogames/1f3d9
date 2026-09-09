import { expect, test } from '@playwright/test'
import { boxesIntersect, DETACHED_READ_TIMEOUT_MS, measureRebuildableBoxes, scrollRebuildableIntoView, comparedOperands } from '../helpers/public-window-layout.ts'

export function registerPublicWindowThingsIndexLayout() {
  test('THINGS stays bounded by choice and transparent at desktop and phone widths', async ({ page }) => {
    const mostlyTransparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OMQ0AMAgAQQzVBiLw74M6YCMdepf8/nGyeiq2GTBg4PkAAADwvQtDNHMBnss7igAAAABJRU5ErkJggg==',
      'base64',
    )
    const headings = Array.from({ length: 27 }, (_, index) => {
      const id = 427 - index
      return {
        id,
        place_id: id % 2 === 0 ? 12 : 11,
        name: id === 427 ? 'transparent-beacon' : `Public thing ${id}`,
        kind_id: 77,
        kind: 'artifact',
        maker_id: 49,
        made_by: 'browser-resident',
        current_owner_id: 49,
        current_owner: 'browser-resident',
        has_drawing: id === 427,
        body_text_bytes: id === 427 ? 37 : id,
        created_at: `2026-08-13T19:${String(59 - index).padStart(2, '0')}:00.000Z`,
      }
    })
    const frontMatter = [{
      type: 'thing', id: 427, name: 'transparent-beacon', body_text_bytes: 37,
      maker_id: 49, made_by: 'browser-resident', current_owner_id: 49,
      current_owner: 'browser-resident', owner_id: 49, owner: 'browser-resident',
      has_drawing: true,
    }]
    let indexRequests = 0
    let holdNextCitywidePage = false
    let releaseHeldCitywidePage = () => {}
    let markHeldCitywideStarted = () => {}
    const heldCitywidePage = new Promise<void>(resolve => { releaseHeldCitywidePage = resolve })
    const heldCitywideStarted = new Promise<void>(resolve => { markHeldCitywideStarted = resolve })
    await page.route('**/api/drawing/thing/427/thumb.png*', route => route.fulfill({
      status: 200,
      contentType: 'image/png',
      body: mostlyTransparentPng,
    }))
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('view') === 'directory') {
        await route.fulfill({ json: {
          view: 'directory',
          places: [
            { id: 11, parent_id: null, name: 'test_square' },
            { id: 12, parent_id: 11, name: 'side_room' },
          ],
          residents: [
            { id: 49, handle: 'browser-resident', has_drawing: true },
            { id: 48, handle: 'oldwalker', has_drawing: false },
            ...Array.from({ length: 20 }, (_, index) => ({
              id: 100 + index,
              handle: `transparent-beacon-${index + 1}`,
            })),
          ],
        } })
        return
      }
      if (url.searchParams.get('collection') === 'things' &&
          url.searchParams.get('presentation') === 'headings') {
        const find = url.searchParams.get('find')
        const withinPlaceId = url.searchParams.get('within_place_id')
        if (
          holdNextCitywidePage && !find && !withinPlaceId &&
          !url.searchParams.has('before_id')
        ) {
          holdNextCitywidePage = false
          markHeldCitywideStarted()
          await heldCitywidePage
        }
        const scopedHeadings = withinPlaceId === '12'
          ? headings.filter(thing => thing.place_id === 12)
          : headings
        const rows = find
          ? headings.filter(thing => find.startsWith('#')
            ? `#${thing.id}` === find
            : thing.name.toLocaleLowerCase().includes(find.toLocaleLowerCase()))
          : url.searchParams.has('before_id')
            ? scopedHeadings.slice(25)
            : scopedHeadings.slice(0, 25)
        if (!find) indexRequests += 1
        const hasMore = !find && !url.searchParams.has('before_id') && scopedHeadings.length > 25
        await route.fulfill({ json: {
          change_marker: '9',
          things: rows,
          has_more: hasMore,
          next_before_id: hasMore ? 403 : null,
        } })
        return
      }
      if (url.searchParams.has('collection')) return route.fallback()
      const response = await route.fetch()
      const snapshot = await response.json()
      const [square, sideRoom] = snapshot.places
      const residents = [
        ...snapshot.residents.filter((resident: { id: number }) => ![48, 49].includes(resident.id)),
        {
          id: 49, handle: 'browser-resident', current_place_id: 11,
          joined_at: '2026-08-13T20:00:00.000Z', asleep: false, has_drawing: true,
        },
        {
          id: 48, handle: 'oldwalker', current_place_id: 11,
          joined_at: '2026-08-12T20:00:00.000Z', asleep: false, has_drawing: false,
        },
      ]
      await route.fulfill({ response, json: {
        ...snapshot,
        residents,
        totals: { ...snapshot.totals, things: 27 },
        places: [{
          ...square,
          places: 1,
          things: 14,
          front_matter: frontMatter,
          children: [{ ...sideRoom, parent_id: 11, things: 13, children: [] }],
        }],
        live_survey: [
          // notes mirrors the place tree above: things is deliberately
          // overridden for this test, but notes is left at whatever the
          // fetched snapshot's square/sideRoom already carried.
          { id: 11, parent_id: null, things: 14, notes: square.notes },
          { id: 12, parent_id: 11, things: 13, notes: sideRoom.notes },
        ],
      } })
    })

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      indexRequests = 0
      await page.setViewportSize(viewport)
      await page.goto('/window/things')
      await expect(page.locator('#window-status')).toContainText('Watching')
      await expect(page.locator('#things-summary')).toHaveText(
        '25 of 27 public things shown. Bodies stay closed until you choose one.',
      )
      await expect(page.locator('#things-list .thing-index-row')).toHaveCount(25)
      await expect(page.getByRole('button', { name: 'Continue things' })).toBeVisible()
      expect(indexRequests).toBe(1)
      await page.waitForTimeout(150)
      expect(indexRequests).toBe(1)

      const firstRow = page.locator('#things-list .thing-index-row').first()
      const undrawnRow = page.locator('#things-list .thing-index-row').nth(1)
      await expect(firstRow).toContainText('transparent-beacon')
      await expect(firstRow).toContainText('37 UTF-8 body bytes')
      await expect(firstRow).not.toContainText('must not cross')
      const portrait = firstRow.locator('.entity-portrait[data-portrait-type="thing"]')
      await expect(portrait).toHaveCount(1)
      await expect(undrawnRow.locator('.entity-portrait[data-portrait-type="thing"]')).toHaveCount(0)
      const [drawnTitleBeforeLoad, undrawnTitle, drawnRow, undrawnRowBox] =
        await measureRebuildableBoxes(() => [
          page.locator('#things-list .thing-index-row').first().locator('.thing-index-link'),
          page.locator('#things-list .thing-index-row').nth(1).locator('.thing-index-link'),
          page.locator('#things-list .thing-index-row').first(),
          page.locator('#things-list .thing-index-row').nth(1),
        ], 'thing title offsets before portrait load')
      expect(
        undrawnTitle.x - undrawnRowBox.x,
        comparedOperands({
          undrawnTitleX: undrawnTitle.x,
          undrawnRowX: undrawnRowBox.x,
          drawnTitleX: drawnTitleBeforeLoad.x,
          drawnRowX: drawnRow.x,
        }),
      ).toBeLessThan(
        drawnTitleBeforeLoad.x - drawnRow.x,
      )
      await scrollRebuildableIntoView(
        () => page.locator('#things-list .thing-index-row').first()
          .locator('.entity-portrait[data-portrait-type="thing"]'),
        'transparent-beacon thing portrait',
      )
      await expect(portrait).toHaveAttribute('data-portrait-state', 'loaded')
      const [drawnTitleAfterLoad] = await measureRebuildableBoxes(
        () => [page.locator('#things-list .thing-index-row').first().locator('.thing-index-link')],
        'drawn thing title after portrait load',
      )
      expect(
        Math.abs(drawnTitleAfterLoad.x - drawnTitleBeforeLoad.x),
        comparedOperands({ drawnTitleAfterLoadX: drawnTitleAfterLoad.x,
          drawnTitleBeforeLoadX: drawnTitleBeforeLoad.x }),
      ).toBeLessThan(0.5)
      let portraitPixels: {
        inkAlpha: number
        centerAlpha: number
        shellBackground: string
        rowBackground: string
      } | null = null
      await expect.poll(async () => {
        portraitPixels = await page.locator('#things-list .thing-index-row').first()
          .locator('.entity-portrait[data-portrait-type="thing"]').evaluate(shell => {
            const row = shell.closest('.thing-index-row')
            if (!row) return null
            const image = shell.querySelector('img')
            const canvas = document.createElement('canvas')
            canvas.width = 32
            canvas.height = 32
            const context = canvas.getContext('2d')
            if (!image || !context) return null
            context.drawImage(image, 0, 0, 32, 32)
            return {
              inkAlpha: context.getImageData(2, 2, 1, 1).data[3],
              centerAlpha: context.getImageData(16, 16, 1, 1).data[3],
              shellBackground: getComputedStyle(shell).backgroundColor,
              rowBackground: getComputedStyle(row).backgroundColor,
            }
          })
        return portraitPixels !== null
      }, {
        message: 'transparent-beacon pixels and backgrounds must come from an attached thing row',
        timeout: DETACHED_READ_TIMEOUT_MS,
      }).toBe(true)
      expect(portraitPixels).toEqual({
        inkAlpha: 255,
        centerAlpha: 0,
        shellBackground: 'rgba(0, 0, 0, 0)',
        rowBackground: 'rgb(255, 249, 232)',
      })
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)

      await page.getByRole('button', { name: 'Continue things' }).click()
      await expect(page.locator('#things-summary')).toHaveText(
        '27 of 27 public things shown. Bodies stay closed until you choose one.',
      )
      await expect(page.locator('#things-list .thing-index-row')).toHaveCount(27)
      expect(indexRequests).toBe(2)

      await page.getByRole('tab', { name: 'Map', exact: true }).click()
      const drawnResident = page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'browser-resident' })
      const undrawnResident = page.locator('#resident-roster .resident-row')
        .filter({ hasText: 'oldwalker' })
      await expect(drawnResident.locator('.entity-portrait')).toHaveCount(1)
      await expect(undrawnResident.locator('.entity-portrait')).toHaveCount(0)
      const [drawnHandle, undrawnHandle, drawnResidentBox, undrawnResidentBox] =
        await measureRebuildableBoxes(() => [
          page.locator('#resident-roster .resident-row')
            .filter({ hasText: 'browser-resident' }).locator('.resident-follow'),
          page.locator('#resident-roster .resident-row')
            .filter({ hasText: 'oldwalker' }).locator('.resident-follow'),
          page.locator('#resident-roster .resident-row').filter({ hasText: 'browser-resident' }),
          page.locator('#resident-roster .resident-row').filter({ hasText: 'oldwalker' }),
        ], 'roster handle offsets')
      expect(
        undrawnHandle.x - undrawnResidentBox.x,
        comparedOperands({
          undrawnHandleX: undrawnHandle.x,
          undrawnResidentX: undrawnResidentBox.x,
          drawnHandleX: drawnHandle.x,
          drawnResidentX: drawnResidentBox.x,
        }),
      ).toBeLessThan(
        drawnHandle.x - drawnResidentBox.x,
      )
      if (viewport.width <= 390) {
        const [drawnMeta, undrawnMeta] = await measureRebuildableBoxes(() => [
          page.locator('#resident-roster .resident-row')
            .filter({ hasText: 'browser-resident' }).locator('.resident-number'),
          page.locator('#resident-roster .resident-row')
            .filter({ hasText: 'oldwalker' }).locator('.resident-number'),
        ], 'phone roster metadata')
        expect(
          boxesIntersect(drawnHandle, drawnMeta),
          comparedOperands({ drawnHandle, drawnMeta }),
        ).toBe(false)
        expect(
          boxesIntersect(undrawnHandle, undrawnMeta),
          comparedOperands({ undrawnHandle, undrawnMeta }),
        ).toBe(false)
      }
    }

    await page.goto('/window/place/11')
    const placeHeading = page.locator('#place-front-matter .front-matter-heading')
      .filter({ hasText: 'transparent-beacon' })
    await scrollRebuildableIntoView(
      () => page.locator('#place-front-matter .front-matter-heading').filter({ hasText: 'transparent-beacon' }),
      'transparent-beacon place portrait',
    )
    await expect(placeHeading.locator(
      '.entity-portrait[data-portrait-type="thing"] img',
    )).toHaveAttribute(
      'src',
      /\/api\/drawing\/thing\/427\/thumb\.png\?rev=9$/u,
    )
    await page.getByRole('tab', { name: 'Map', exact: true }).click()
    await expect(page.locator('#place-map .place-card-thing')).toHaveCount(0)

    const search = page.getByRole('combobox', { name: 'Search places, residents, and things' })
    await search.fill('transparent-beacon')
    await expect(page.getByRole('option', { name: /transparent-beacon · Thing #427/u })).toBeVisible()
    await expect(page.locator('#directory-search-status')).toContainText(
      'Showing the first 20 of 21 exact matches',
    )
    await search.fill('#427')
    await expect(page.getByRole('option', { name: /transparent-beacon · Thing #427/u })).toBeVisible()

    await page.goto('/window/things?place=11')
    await expect(page.locator('#things-list .thing-index-row')).toHaveCount(25)
    holdNextCitywidePage = true
    await page.locator('#place-filter').selectOption('')
    await heldCitywideStarted
    await page.locator('#place-filter').selectOption('12')
    await expect(page).toHaveURL(/\/window\/things\?place=12$/u)
    await expect(page.locator('#things-summary')).toHaveText(
      '13 of 13 public things shown. Bodies stay closed until you choose one.',
    )
    releaseHeldCitywidePage()
    await page.waitForTimeout(100)
    await expect(page.locator('#things-summary')).toHaveText(
      '13 of 13 public things shown. Bodies stay closed until you choose one.',
    )
  })
}
