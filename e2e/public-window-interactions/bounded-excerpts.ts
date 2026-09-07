import { expect, test } from '@playwright/test'
import { LONG_NOTE, LONG_THING } from '../helpers/public-window-snapshot-fixtures.ts'
import { API_REQUESTS } from '../helpers/public-window-pagination-fixtures.ts'

export function registerPublicWindowBoundedExcerpts() {
  test('bounded note and thing excerpts offer completion while agreements remain collapsible', async ({ page }) => {

    await page.getByRole('tab', { name: 'Place' }).click()

    const thingCard = page.locator('.thing-card').filter({ hasText: 'record_lantern' })
    await expect(thingCard).toContainText('open to shared use')
    const thingBody = thingCard.locator('.thing-body')
    const thingToggle = thingCard.getByRole('button', { name: 'Show more' })
    await expect(thingBody).toHaveAttribute('data-expanded', 'false')
    await expect(thingToggle).toHaveAttribute('aria-controls', await thingBody.getAttribute('id') ?? '')
    await thingToggle.click()
    await expect(thingBody).toHaveAttribute('data-expanded', 'true')
    await expect(thingCard.getByRole('button', { name: 'Read the whole thing' })).toBeVisible()

    const placeNote = page.locator('#place-conversation .note-card')
      .filter({ hasText: 'Opening note.' })
    await expect(placeNote).toContainText('Excerpt only — the full text is not included in this bounded view.')
    await placeNote.getByRole('button', { name: 'Show more' }).click()
    await expect(placeNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')

    await page.getByRole('tab', { name: 'Conversations' }).click()
    // The same note was expanded on the place panel; its reading state
    // survives the re-render into this view. The watched place's real slice
    // loads by itself now, so scope to the long note among its neighbors.
    const conversationNote = page.locator('#conversation-stream .note-card')
      .filter({ hasText: 'Opening note.' })
    await expect(conversationNote.locator('.note-body')).toHaveAttribute('data-expanded', 'true')
    await expect(conversationNote.getByRole('button', { name: 'Read the whole note' })).toBeVisible()

    await page.getByRole('tab', { name: 'Agreements' }).click()
    const agreement = page.locator('.agreement-card')
    await expect(agreement).toContainText('Excerpt only — the full text is not included in this bounded view.')
    await agreement.getByRole('button', { name: 'Show more' }).click()
    await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'true')
    await agreement.getByRole('button', { name: 'Show less' }).click()
    await expect(agreement.locator('.agreement-body')).toHaveAttribute('data-expanded', 'false')
    await expect(agreement.getByRole('button', { name: /Read the whole agreement/u })).toHaveCount(0)
  })

  test('the second note expansion completes the bounded excerpt in place', async ({ page }) => {
    const completeNote = `${LONG_NOTE} Complete note remainder marker.`
    let releaseFailedRead!: () => void
    const heldFailedRead = new Promise<void>(resolve => { releaseFailedRead = resolve })
    let detailAttempts = 0
    await page.route('**/api/note/21', async route => {
      detailAttempts += 1
      if (detailAttempts === 1) {
        await heldFailedRead
        return route.fulfill({ status: 503, json: { error: 'test complete note failure' } })
      }
      return route.fulfill({ json: { note: { id: 21, body: completeNote } } })
    })

    await page.getByRole('tab', { name: 'Place' }).click()
    const noteCard = page.locator('#place-conversation .note-card')
      .filter({ hasText: 'Opening note.' })
    await noteCard.getByRole('button', { name: 'Show more' }).click()
    await expect(noteCard.getByRole('button', { name: 'Read the whole note' })).toBeVisible()

    const failedDetail = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/api/note/21' && response.status() === 503
    })
    await noteCard.getByRole('button', { name: 'Read the whole note' }).click()
    await expect(noteCard).toContainText('Loading the complete public note…')
    releaseFailedRead()
    await failedDetail
    await expect(noteCard).toContainText('The complete public note could not be read.')

    const successfulDetail = page.waitForResponse(response => {
      return new URL(response.url()).pathname === '/api/note/21' && response.status() === 200
    })
    await noteCard.getByRole('button', { name: 'Retry reading the whole note' }).click()
    await successfulDetail

    await expect(noteCard.locator('.note-body')).toHaveText(completeNote)
    await expect(noteCard).not.toContainText(/Excerpt only/u)
    expect((API_REQUESTS.get(page) ?? []).filter(value => {
      return new URL(value).pathname === '/api/note/21'
    })).toHaveLength(2)

    await page.getByRole('tab', { name: 'Conversations' }).click()
    const repeatedNote = page.locator('#conversation-stream .note-card')
      .filter({ hasText: 'Opening note.' })
    await expect(repeatedNote.locator('.note-body')).toHaveText(completeNote)
    expect((API_REQUESTS.get(page) ?? []).filter(value => {
      return new URL(value).pathname === '/api/note/21'
    })).toHaveLength(2)
  })

  test('the second thing expansion completes the bounded excerpt in place', async ({ page }) => {
    const completeThing = `${LONG_THING} Complete thing remainder marker.`
    await page.route('**/api/thing/31', route => route.fulfill({
      json: { thing: { id: 31, body: completeThing } },
    }))

    await page.getByRole('tab', { name: 'Place' }).click()
    const thingCard = page.locator('#place-things .thing-card').filter({ hasText: 'record_lantern' })
    await thingCard.getByRole('button', { name: 'Show more' }).click()
    await expect(thingCard.getByRole('button', { name: 'Read the whole thing' })).toBeVisible()

    const detailRequest = page.waitForRequest(request => {
      return new URL(request.url()).pathname === '/api/thing/31'
    })
    await thingCard.getByRole('button', { name: 'Read the whole thing' }).click()
    await detailRequest

    await expect(thingCard.locator('.thing-body')).toHaveText(completeThing)
    await expect(thingCard).not.toContainText(/Excerpt only/u)
    expect((API_REQUESTS.get(page) ?? []).filter(value => {
      return new URL(value).pathname === '/api/thing/31'
    })).toHaveLength(1)
  })

  test('a fully visible long note does not offer a useless Show more button', async ({ page }) => {
    await page.getByRole('tab', { name: 'Conversations' }).click()

    const doctorsNote = page.locator('#conversation-stream .note-card')
      .filter({ hasText: 'Doctors Note — Dr. Glass Pacific Hospital' })
    const body = doctorsNote.locator('.note-body')

    await expect(body).toBeVisible()
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(false)
    await expect(doctorsNote.getByRole('button', { name: /Show (?:more|less)/u })).toHaveCount(0)
    await expect(body).toHaveAttribute('data-expanded', 'true')

    await page.setViewportSize({ width: 390, height: 851 })
    await expect(doctorsNote.getByRole('button', { name: 'Show more' })).toBeVisible()
    await expect(body).toHaveAttribute('data-expanded', 'false')
    expect(await body.evaluate(element => element.scrollHeight > element.clientHeight + 1)).toBe(true)
  })
}
