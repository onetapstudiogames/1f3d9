// Decisions #112 and #114: a thing's detail in the window says when it is a copy and of
// which thing, its generation, and what a converted thing was born as, from the exact
// thing shape the city serves; an ordinary thing shows none of those words.
import { expect, test } from '@playwright/test'

const THING_ID = 401

function thingRecord(overrides: Readonly<Record<string, unknown>>) {
  return {
    thing: {
      id: THING_ID,
      place_id: 11,
      name: 'field_lantern',
      body: 'A lantern that learned to grow.',
      made_by: 'lamp-keeper',
      current_owner: 'lamp-keeper',
      owner: 'lamp-keeper',
      kind_id: 7,
      kind: 'ash',
      birth_revision: 1,
      current_revision: 2,
      has_drawing: false,
      generation: 0,
      parent_thing_id: null,
      family_id: THING_ID,
      family_maker: 'lamp-keeper',
      copies_made: 0,
      born_as: { kind: 'ash', kind_id: 7, revision: 1 },
      was: [],
      was_total: 0,
      state: { version: 0, values: {}, last_write: null },
      ...overrides,
    },
  }
}

async function openThing(page: import('@playwright/test').Page, record: unknown): Promise<string> {
  await page.route(`**/api/thing/${THING_ID}`, route => route.fulfill({ json: record }))
  await page.goto(`/window/thing/${THING_ID}`)
  const meta = page.locator('#record-detail .record-detail-meta')
  await expect(meta).toContainText('made by lamp-keeper')
  return (await meta.textContent()) ?? ''
}

test('a copied and converted thing names its parent, generation, and birth kind', async ({ page }) => {
  const meta = await openThing(page, thingRecord({
    generation: 2,
    parent_thing_id: 400,
    family_id: 390,
    born_as: { kind: 'oak', kind_id: 5, revision: 1 },
    was: [{ kind: 'oak', kind_id: 5, revision: 1, changed_by_thing_id: 398, changed_by_law: null, changed_by: 'fire-keeper', at: '2026-09-22T12:00:00.000Z' }],
    was_total: 1,
  }))
  expect(meta).toContain('copy of thing #400')
  expect(meta).toContain('generation 2')
  expect(meta).toContain('now ash, born as oak')
  expect(meta).toContain('converted 1 time')
})

test('an ordinary thing shows no copy or conversion words', async ({ page }) => {
  const meta = await openThing(page, thingRecord({}))
  expect(meta).not.toContain('copy of thing')
  expect(meta).not.toContain('generation')
  expect(meta).not.toContain('born as')
  expect(meta).not.toContain('converted')
})
