import { expect, test } from '@playwright/test'
import { SNAPSHOT } from './helpers/public-window-snapshot-fixtures.ts'

test('Map names and keepers keep every word on one line at phone, tablet and desktop widths', async ({ page }) => {
  const names = ['the still room', 'The Human Wiki Submission Desk', 'Lantern room']
  const owners = ['founder', 'serein', 'solward']
  const rooms = names.map((name, index) => ({
    ...SNAPSHOT.places[0],
    id: 101 + index, parent_id: index === 0 ? 11 : 100 + index, name, owner: owners[index],
    places: 0, things: 23, notes: 38, children: [],
  }))
  const places = [{ ...SNAPSHOT.places[0], places: 1, children: [
    { ...rooms[0], places: 1, children: [{ ...rooms[1], places: 1, children: [rooms[2]] }] },
  ] }]
  await page.route('**/api/window**', route => {
    const url = new URL(route.request().url())
    return route.fulfill({ json: url.searchParams.get('view') === 'directory'
      ? { view: 'directory', places: [places[0], ...rooms].map(({ id, parent_id, name }) =>
        ({ id, parent_id, name })), residents: [
          { id: 201, handle: 'founder', has_drawing: false },
          { id: 202, handle: 'serein', has_drawing: true },
        ] }
      : { ...SNAPSHOT, places, residents: [], live_survey: [places[0], ...rooms].map(
        ({ id, parent_id, things, notes }) => ({ id, parent_id, things, notes }),
      ) },
    })
  })
  await page.route('**/api/changes**', route => route.fulfill({ json: {
    change_marker: '20', unchanged: true, changes: [], has_more: false, next_since: '20',
  } }))
  await page.goto('/window/map')
  await expect(page.locator('#window-status')).toContainText('Watching')
  const cards = page.locator('#place-map .place-card')
  await expect(cards).toHaveCount(4)

  for (const width of [320, 375, 768, 830, 1024, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 })
    const measured = await cards.evaluateAll(elements => elements.map(card => {
      const cardBox = card.getBoundingClientRect()
      const factsBox = card.querySelector('.place-facts')!.getBoundingClientRect()
      const failures: string[] = []
      let words = 0
      for (const label of card.querySelectorAll('.place-name, .place-owner')) {
        const walker = document.createTreeWalker(label, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          for (const match of (node.textContent ?? '').matchAll(/\S+/gu)) {
            const range = document.createRange()
            range.setStart(node, match.index!)
            range.setEnd(node, match.index! + match[0].length)
            const boxes = Array.from(range.getClientRects()).filter(box => box.width > 0)
            words += 1
            if (!boxes.length || boxes.some(box => Math.abs(box.top - boxes[0]!.top) > 1)) {
              failures.push(`split or invisible word: ${match[0]}`)
            }
            for (const box of boxes) {
              if (box.left < cardBox.left || box.right > cardBox.right ||
                  box.left < 0 || box.right > innerWidth) failures.push(`escaped word: ${match[0]}`)
              if (box.left < factsBox.right && box.right > factsBox.left &&
                  box.top < factsBox.bottom && box.bottom > factsBox.top) {
                failures.push(`word overlaps counts: ${match[0]}`)
              }
            }
          }
        }
      }
      const nameBox = card.querySelector('.place-name')!.getBoundingClientRect()
      const ownerBox = card.querySelector('.place-owner')!.getBoundingClientRect()
      return {
        name: card.querySelector('.place-name')!.textContent, words, failures,
        countsBelow: factsBox.top >= ownerBox.bottom,
        countsBeside: factsBox.left >= Math.max(nameBox.right, ownerBox.right),
      }
    }))
    expect(measured.every(card => card.words > 0), `labels measured at ${width}px`).toBe(true)
    expect(measured.filter(card => card.failures.length), `${width}px word rectangles`).toEqual([])
    expect(await page.locator('#place-map').evaluate(node => node.scrollWidth <= node.clientWidth),
      `${width}px Map fits its panel`).toBe(true)
    if (width === 320) expect(measured.every(card => card.countsBelow)).toBe(true)
    if (width === 830) expect(measured.at(-1)!.countsBelow).toBe(true)
    if (width === 1440) expect(measured.every(card => card.countsBeside)).toBe(true)
  }
})
