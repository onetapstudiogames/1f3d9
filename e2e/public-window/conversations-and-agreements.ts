import { expect, test } from '@playwright/test'
import { NOTE_EXCERPT, THING_EXCERPT } from '../helpers/public-window-reading-fixtures.ts'

export function registerPublicWindowConversationsAndAgreements() {
  test('all-place conversations stay newest-first and name each room', async ({ page }) => {
    await page.goto('/window#view=conversations')
    await expect(page.locator('#window-status')).toContainText('Watching')

    const cards = page.locator('#conversation-stream .note-card')
    await expect(cards).toHaveCount(3)
    expect(await cards.locator('.note-body').allTextContents()).toEqual([
      'Newest in test square',
      'Middle in side room',
      `${NOTE_EXCERPT}…`,
    ])
    await expect(cards.nth(0).locator('.note-meta')).toContainText('test_square')
    await expect(cards.nth(1).locator('.note-meta')).toContainText('side_room')
  })

  test('the city-wide Things and Conversations feeds withhold a quiet place while naming the rest', async ({ page }) => {
    // Second review pass on row 75: neither city-wide feed scopes to any one
    // place, so a note or thing recorded in a quiet place must withhold by
    // its own place_id even though nothing about the request names that
    // place at all.
    const quietThingHeading = Object.freeze({
      id: 402,
      place_id: 13,
      name: 'hidden_lantern',
      kind_id: null,
      kind: null,
      maker_id: 48,
      made_by: 'oldwalker',
      current_owner_id: 48,
      current_owner: 'oldwalker',
      body_text_bytes: 30,
      created_at: '2026-08-13T19:06:30.000Z',
      has_drawing: false,
    })
    const ordinaryThingHeading = Object.freeze({
      id: 401,
      place_id: 11,
      name: 'field_lantern',
      kind_id: 77,
      kind: 'artifact',
      maker_id: 49,
      made_by: 'browser-resident',
      current_owner_id: 49,
      current_owner: 'browser-resident',
      body_text_bytes: THING_EXCERPT.length,
      created_at: '2026-08-13T19:02:00.000Z',
      has_drawing: true,
    })
    await page.route('**/api/window**', async route => {
      const url = new URL(route.request().url())
      const collection = url.searchParams.get('collection')
      if (collection === 'things' && url.searchParams.get('presentation') === 'headings') {
        return route.fulfill({
          json: {
            things: [quietThingHeading, ordinaryThingHeading],
            has_more: false,
            next_before_id: null,
            change_marker: '9',
          },
        })
      }
      if (collection) return route.continue()
      const response = await route.fetch()
      const body = await response.json() as Record<string, unknown>
      await route.fulfill({ response, json: {
        ...body,
        places: [...(body.places as unknown[]), {
          id: 13, parent_id: null, name: 'back_room',
          description: 'A quiet room kept out of the ordinary rooms.',
          owner: 'oldwalker', places: 0, things: 1, notes: 1,
          moderated: false, quiet: true, children: [],
        }],
        notes: [{
          id: 304, place_id: 13, author: 'oldwalker',
          body: 'Said quietly in the back room', created_at: '2026-08-13T19:06:00.000Z',
          moderated: false,
        }, ...(body.notes as unknown[])],
        totals: { ...(body.totals as Record<string, unknown>), conversations: 4, things: 2 },
      } })
    })

    await page.goto('/window#view=conversations')
    await expect(page.locator('#window-status')).toContainText('Watching')
    const conversationStream = page.locator('#conversation-stream')
    const conversationCards = conversationStream.locator('.note-card')
    await expect(conversationCards).toHaveCount(4)
    await expect(conversationCards.first().locator('.quiet-room-notice')).toContainText(
      'oldwalker prefers to keep this room private.',
    )
    await expect(conversationStream).not.toContainText('Said quietly in the back room')
    // The unrelated, non-quiet room keeps naming its own author normally on
    // the very same feed.
    await expect(conversationStream).toContainText('side_room')

    await page.getByRole('tab', { name: 'Things' }).click()
    await expect(page).toHaveURL(/\/window\/things$/u)
    const thingsList = page.locator('#things-list')
    const thingRows = thingsList.locator('.thing-index-row')
    await expect(thingRows).toHaveCount(2)
    await expect(thingRows.first().locator('.quiet-room-notice')).toContainText(
      'oldwalker prefers to keep this room private.',
    )
    await expect(thingsList).not.toContainText('hidden_lantern')
    await expect(thingsList).toContainText('field_lantern')
  })

  test('a followed resident defaults to their words and keeps room context as a second question', async ({ page }) => {
    await page.route('**/api/window**', route => {
      const url = new URL(route.request().url())
      if (url.searchParams.get('collection') !== 'notes' ||
          url.searchParams.get('resident') !== 'oldwalker' || url.searchParams.has('context')) {
        return route.fallback()
      }
      return route.fulfill({
        json: {
          notes: [{
            id: 302,
            place_id: 12,
            author: 'oldwalker',
            body: 'Middle in side room',
            created_at: '2026-08-13T19:04:00.000Z',
            moderated: false,
          }, {
            id: 300,
            place_id: 12,
            author: 'oldwalker',
            body: 'An earlier thought in the side room.',
            created_at: '2026-08-13T18:58:00.000Z',
            moderated: false,
          }],
          has_more: false,
          next_before_id: null,
          change_marker: '9',
        },
      })
    })
    const residentOnlyResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'oldwalker' &&
        !url.searchParams.has('context') && url.searchParams.get('limit') === '50' &&
        response.status() === 200
    })
    await page.goto('/window#view=conversations&resident=oldwalker')
    await expect(page.locator('#window-status')).toContainText('Watching')
    await residentOnlyResponse

    const cards = page.locator('#conversation-stream .note-card')
    await expect(cards).toHaveCount(2)
    expect(await cards.locator('.note-body').allTextContents()).toEqual([
      'Middle in side room',
      'An earlier thought in the side room.',
    ])
    await expect(page.locator('#conversation-stream .context-note')).toHaveCount(0)

    const question = page.getByRole('group', { name: 'Conversation question' })
    const residentOnly = question.getByRole('button', { name: 'What oldwalker said', exact: true })
    const roomContext = question.getByRole('button', {
      name: 'What was said around oldwalker', exact: true,
    })
    await expect(residentOnly).toHaveAttribute('aria-pressed', 'true')
    await expect(roomContext).toHaveAttribute('aria-pressed', 'false')

    const contextResponse = page.waitForResponse(response => {
      const url = new URL(response.url())
      return url.pathname === '/api/window' && url.searchParams.get('collection') === 'notes' &&
        url.searchParams.get('resident') === 'oldwalker' &&
        url.searchParams.get('context') === 'place' && url.searchParams.get('limit') === '25' &&
        response.status() === 200
    })
    await roomContext.click()
    await contextResponse

    await expect(cards).toHaveCount(3)
    expect(await cards.locator('.note-body').allTextContents()).toEqual([
      'Middle in side room',
      'An earlier thought in the side room.',
      'A neighbor answers in the side room.',
    ])
    const contextCard = page.locator('#conversation-stream .note-card.context-note')
    await expect(contextCard).toHaveCount(1)
    await expect(contextCard).toContainText('A neighbor answers in the side room.')
    await expect(contextCard).toContainText('same room · 1m earlier')
    await expect(contextCard.locator('.note-meta')).toContainText('side_room')
    await expect(roomContext).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('button', { name: /Load .*conversations/ })).toBeHidden()
  })

  test('agreements show author consent and distinguish later signers', async ({ page }) => {
    await page.goto('/window#view=agreements')
    await expect(page.locator('#window-status')).toContainText('Watching')

    const opened = page.locator('#agreement-list .agreement-card')
      .filter({ hasText: 'A public agreement opened by its author.' })
    await expect(opened).toContainText('Open to later signers')
    await expect(opened).toContainText('Awaiting signatures')
    await expect(opened.locator('.signature-chip')).toHaveText([
      '✓ browser-resident',
      '○ oldwalker',
      '+ late-signer',
    ])

    const closed = page.locator('#agreement-list .agreement-card')
      .filter({ hasText: 'An older agreement that remains closed.' })
    await expect(closed).toContainText('Closed to later signers')

  })
}
