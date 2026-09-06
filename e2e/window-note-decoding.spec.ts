import { expect, test, type Locator, type Page, type Request } from '@playwright/test'
import { installReadingFixture } from '../test/helpers/window-reading-fixture.ts'

const violationsByPage = new WeakMap<Page, readonly string[]>()
const LONG_ENGLISH_NOTE = 'This city has a quiet square where our neighbors can talk with their friends. '.repeat(12)
const LONG_PORTUGUESE_NOTE = 'Esta cidade tem uma praça tranquila onde você pode falar com seus vizinhos. '.repeat(12)

test.afterEach(async ({ page }) => {
  expect(violationsByPage.get(page) ?? [], 'unexpected network operations compared with []').toEqual([])
})

type NoteView = 'conversations' | 'place'

function noteSelector(view: NoteView) {
  return view === 'conversations'
    ? '#conversation-stream [data-viewer-record-key="note:301"]'
    : '#place-conversation [data-viewer-record-key="note:301"]'
}

async function openNote(page: Page, view: NoteView) {
  await page.goto(view === 'conversations' ? '/window/conversations' : '/window/place/11')
  await expect(page.locator('#window-status'), 'initial status compared with Watching')
    .toContainText('Watching', { timeout: 15_000 })
  const card = page.locator(noteSelector(view))
  await expect(card, `${view} note card visibility compared with visible`).toBeVisible()
  return card
}

async function decodeNote(card: Locator) {
  const button = card.locator('button.note-decode')
  await expect(button, 'note decode control visibility compared with visible').toBeVisible()
  await expect(button, 'note decode control label compared with Decode').toHaveText('Decode')
  await button.click()
  const decoded = card.locator('.note-decoded')
  await expect(decoded, 'decoded region visibility compared with visible').toBeVisible()
  await expect(decoded, 'decoded region label compared with Decoded').toContainText('Decoded')
  await expect.poll(() => card.evaluate(node => {
    const original = node.querySelector('.note-body.public-body')
    const region = node.querySelector('.note-decoded')
    if (!original || !region) {
      return { originalBottom: null, decodedTop: null, beneath: false }
    }
    const originalBottom = original.getBoundingClientRect().bottom
    const decodedTop = region.getBoundingClientRect().top
    return { originalBottom, decodedTop, beneath: decodedTop >= originalBottom }
  }), {
    message: 'original bottom and decoded top operands compared with decoded beneath original',
  }).toMatchObject({ beneath: true })
  return decoded.locator('.note-decoded-text')
}

test('a binary note decodes beneath its exact original without a request', async ({ page, baseURL }) => {
  const original = '01001000 01100101 01101100 01101100 01101111'
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'conversations')
  const body = card.locator('.note-body.public-body')
  await expect(body, 'binary original before decode compared with exact record').toHaveText(original)

  const requests: string[] = []
  const recordRequest = (request: Request) => { requests.push(request.method() + ' ' + request.url()) }
  page.on('request', recordRequest)
  const decoded = await decodeNote(card)
  page.off('request', recordRequest)

  await expect(decoded, 'binary decoded text compared with Hello').toHaveText('Hello')
  await expect(body, 'binary original after decode compared with exact record').toHaveText(original)
  expect(requests, 'decode-click network requests compared with []').toEqual([])
})

test('a Morse note decodes beneath its exact original in Place', async ({ page, baseURL }) => {
  const original = '.... . .-.. .-.. --- / .-- --- .-. .-.. -..'
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'place')
  const body = card.locator('.note-body.public-body')

  const decoded = await decodeNote(card)

  await expect(decoded, 'Morse decoded text compared with HELLO WORLD').toHaveText('HELLO WORLD')
  await expect(body, 'Morse original after decode compared with exact record').toHaveText(original)
})

test('a base64 note renders decoded markup as text and marks decoded English', async ({ page, baseURL }) => {
  const decodedText = 'This city has a quiet square where the residents can talk with their neighbors. ' +
    '<img src=x onerror="window.__noteDecodedHtmlRan=true">'
  const original = Buffer.from(decodedText, 'utf8').toString('base64')
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'conversations')
  const body = card.locator('.note-body.public-body')
  await page.evaluate(() => {
    Object.defineProperty(window, '__noteDecodedHtmlRan', { configurable: true, value: false })
  })

  const decoded = await decodeNote(card)

  await expect(decoded, 'base64 decoded text compared with inert exact text').toHaveText(decodedText)
  await expect(decoded, 'confident decoded English language compared with en').toHaveAttribute('lang', 'en')
  await expect(body, 'base64 original after decode compared with exact record').toHaveText(original)
  await expect(body, 'encoded original language compared with unknown').toHaveAttribute('lang', '')
  await expect(card.locator('.note-decoded img, .note-decoded script'),
    'decoded markup elements compared with none').toHaveCount(0)
  const htmlRan = await page.evaluate(() =>
    (window as Window & { __noteDecodedHtmlRan?: boolean }).__noteDecodedHtmlRan)
  expect(htmlRan, 'decoded markup execution flag compared with false').toBe(false)
})

for (const languageCase of [
  {
    name: 'English',
    body: 'This city has a quiet square where the residents can talk with their neighbors.',
    lang: 'en',
    view: 'conversations' as const,
  },
  {
    name: 'Portuguese',
    body: 'Esta cidade tem uma praça tranquila para os residentes conversarem com seus vizinhos.',
    lang: 'pt',
    view: 'place' as const,
  },
  {
    name: 'long English',
    body: LONG_ENGLISH_NOTE,
    lang: 'en',
    view: 'conversations' as const,
  },
  {
    name: 'long Portuguese',
    body: LONG_PORTUGUESE_NOTE,
    lang: 'pt',
    view: 'place' as const,
  },
  {
    name: 'English with joined emoji',
    body: 'This city has a quiet square where our neighbors 👩‍💻 can talk with their friends.',
    lang: 'en',
    view: 'conversations' as const,
  },
  {
    name: 'mixed unknown language',
    body: 'This cidade is para residents and vizinhos',
    lang: '',
    view: 'conversations' as const,
  },
]) {
  test(`${languageCase.name} is marked only when confidently detected`, async ({ page, baseURL }) => {
    const fixture = await installReadingFixture(page, baseURL, { noteBody: languageCase.body })
    violationsByPage.set(page, fixture.networkViolations)
    const card = await openNote(page, languageCase.view)
    const body = card.locator('.note-body.public-body')

    await expect(body, `${languageCase.name} body compared with exact record`)
      .toHaveText(languageCase.body)
    await expect(body, `${languageCase.name} lang compared with ${JSON.stringify(languageCase.lang)}`)
      .toHaveAttribute('lang', languageCase.lang)
    await expect(card.locator('button.note-decode'),
      `${languageCase.name} decode controls compared with none`).toHaveCount(0)
  })
}

test('an ordinary note containing zeroes and ones does not offer decoding', async ({ page, baseURL }) => {
  const original = 'Room 101 is open from 10 until 11, and this ordinary note remains plain text.'
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'place')

  await expect(card.locator('.note-body.public-body'),
    'ordinary zero-and-one body compared with exact record').toHaveText(original)
  await expect(card.locator('button.note-decode'),
    'ordinary zero-and-one decode controls compared with none').toHaveCount(0)
  await expect(card.locator('.note-decoded'),
    'ordinary zero-and-one decoded regions compared with none').toHaveCount(0)
})

test('a truncated note offers decoding only after its complete body is read', async ({ page, baseURL }) => {
  const fullBody = [
    '01000110', '01110101', '01101100', '01101100', '00100000',
    '01100010', '01101111', '01100100', '01111001',
  ].join(' ')
  const excerpt = fullBody.split(' ').slice(0, 3).join(' ')
  const fixture = await installReadingFixture(page, baseURL, {
    noteBody: excerpt,
    noteFullBody: fullBody,
    noteTruncated: true,
  })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'place')
  await expect(card.locator('button.note-decode'),
    'excerpt decode controls before completion compared with none').toHaveCount(0)

  const disclosure = card.locator('button.body-disclosure')
  await expect(disclosure, 'excerpt disclosure label compared with Show more').toHaveText('Show more')
  await disclosure.click()
  await expect(disclosure, 'expanded excerpt disclosure label compared with Read the whole note')
    .toHaveText('Read the whole note')
  await expect(card.locator('button.note-decode'),
    'expanded excerpt decode controls before completion compared with none').toHaveCount(0)
  const completeResponse = page.waitForResponse(response =>
    new URL(response.url()).pathname === '/api/note/301' && response.status() === 200)
  await disclosure.click()
  await completeResponse
  await expect(card.locator('.note-body.public-body'),
    'completed note body compared with full binary record').toHaveText(fullBody)

  const decoded = await decodeNote(card)
  await expect(decoded, 'completed binary note decoded text compared with Full body').toHaveText('Full body')
})

test('decoded text survives an unrelated refresh and clears when its note changes', async ({ page, baseURL }) => {
  const original = '01001000 01100101 01101100 01101100 01101111'
  const replacement = 'This note now contains ordinary public words after its edit.'
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  let card = await openNote(page, 'conversations')
  await card.scrollIntoViewIfNeeded()
  const decoded = await decodeNote(card)
  await decoded.evaluate(node => {
    Object.defineProperty(window, '__heldDecodedNote', { configurable: true, value: node })
  })

  await fixture.refresh()
  await expect.poll(() => page.evaluate(selector => {
    const held = (window as Window & { __heldDecodedNote?: Element }).__heldDecodedNote
    const current = document.querySelector(selector + ' .note-decoded-text')
    return {
      attached: held?.isConnected === true,
      sameNode: held === current,
      text: current?.textContent ?? null,
    }
  }, noteSelector('conversations')), {
    message: 'decoded node attachment/identity/text compared after unrelated refresh',
  }).toEqual({ attached: true, sameNode: true, text: 'Hello' })

  await fixture.refresh({ noteBody: replacement })
  card = page.locator(noteSelector('conversations'))
  await expect(card.locator('.note-body.public-body'),
    'changed note body compared with replacement record').toHaveText(replacement)
  await expect(card.locator('.note-decoded'),
    'decoded regions after record change compared with none').toHaveCount(0)
  await expect(card.locator('button.note-decode'),
    'decode controls after ordinary record change compared with none').toHaveCount(0)
  const oldDecodedAttached = await page.evaluate(() =>
    (window as Window & { __heldDecodedNote?: Element }).__heldDecodedNote?.isConnected === true)
  expect(oldDecodedAttached, 'old decoded node attachment after record change compared with false')
    .toBe(false)
})

test('moderation clears decoded text and the prior original', async ({ page, baseURL }) => {
  const original = '01001000 01100101 01101100 01101100 01101111'
  const fixture = await installReadingFixture(page, baseURL, { noteBody: original })
  violationsByPage.set(page, fixture.networkViolations)
  const card = await openNote(page, 'place')
  await decodeNote(card)

  await fixture.refresh({ moderated: true })
  const moderated = page.locator(noteSelector('place'))
  await expect(moderated.locator('.note-body.public-body'),
    'moderated note compared with its current tombstone').toHaveText('[removed by maintainer]')
  await expect(moderated, 'moderated note compared without prior encoded original').not.toContainText(original)
  await expect(moderated.locator('.note-decoded'),
    'decoded regions after moderation compared with none').toHaveCount(0)
  await expect(moderated.locator('button.note-decode'),
    'decode controls after moderation compared with none').toHaveCount(0)
})
