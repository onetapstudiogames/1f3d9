import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Hono } from 'hono'

type Issue = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  header: string
  entry_count: number
}>

type IssueFacts = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  entry_count: number
  resident_count: number
}>

type Entry = Readonly<{
  ordinal: number
  note_id: number
  author_id: number
  author: string
  body: string
  created_at: string
  withdrawn?: boolean
  withdrawal_note_id?: number | null
  withdrawn_at?: string | null
}>

type CompleteIssue = Readonly<{
  issue: Issue
  entries: readonly Entry[]
}>

type ReadingDependencies = Readonly<{
  readIssue(issueNumber: number): Promise<CompleteIssue | null>
  readIssueFacts(issueNumber: number): Promise<IssueFacts | null>
  origin: string
  robots: 'index, follow' | 'noindex, nofollow, noarchive'
}>

const routeModule = await import('../src/gazette-reading.ts').catch(() => ({})) as {
  mountGazetteReadingRoutes?: (app: Hono, dependencies: ReadingDependencies) => void
}

function createApp(overrides: Partial<ReadingDependencies> = {}): Hono {
  assert.equal(
    typeof routeModule.mountGazetteReadingRoutes,
    'function',
    'export mountGazetteReadingRoutes(app, dependencies) from src/gazette-reading.ts',
  )
  const app = new Hono()
  routeModule.mountGazetteReadingRoutes!(app, {
    readIssue: async issueNumber => issueNumber === 7 ? { issue, entries } : null,
    readIssueFacts: async issueNumber => issueNumber === 7 ? issueFacts : null,
    origin: 'https://1f3d9.com',
    robots: 'noindex, nofollow, noarchive',
    ...overrides,
  })
  return app
}

const issue = Object.freeze({
  issue_number: 7,
  scheduled_for: '2026-10-12T16:00:00.000Z',
  printed_at: '2026-10-12T16:00:12.193Z',
  header: [
    'THE GAZETTE — ISSUE 7',
    'Automatic weekly print for Monday, 12 October 2026 at 16:00 UTC.',
    'Source: ordinary notes submitted in the Gazette submission room, place #454.',
    'Entries follow oldest first and preserve each source note verbatim with its resident, note ID, and time, unless its author withdrew it strictly before the print tick.',
    'A withdrawn submission keeps its place and spent weekly slot but prints only: note #<note-id>, withdrawn by its author before the tick.',
    'Printing consumes a submission by permanently assigning its note ID to this issue; the source note is never edited or deleted, and is never moved or copied.',
    'No AI editor, ranking, approval, or selection is used. Moderation may hide public body display but never changes issue membership.',
  ].join('\n'),
  entry_count: 5,
} satisfies Issue)

const issueFacts = Object.freeze({
  issue_number: 7,
  scheduled_for: issue.scheduled_for,
  printed_at: issue.printed_at,
  entry_count: issue.entry_count,
  resident_count: 4,
} satisfies IssueFacts)

const entries = Object.freeze([
  {
    ordinal: 1,
    note_id: 8101,
    author_id: 71,
    author: 'zenith-bard',
    body: 'Part 2 arrived before Part 1.\nThat order stays because submission order is the record.',
    created_at: '2026-10-09T05:37:12.817Z',
  },
  {
    ordinal: 2,
    note_id: 8102,
    author_id: 71,
    author: 'zenith-bard',
    body: 'Part 3 was filed next.',
    created_at: '2026-10-09T06:37:12.817Z',
  },
  {
    ordinal: 3,
    note_id: 8103,
    author_id: 71,
    author: 'zenith-bard',
    body: 'Part 1 was filed last.',
    created_at: '2026-10-09T07:37:12.817Z',
  },
  {
    ordinal: 4,
    note_id: 8104,
    author_id: 72,
    author: 'ferro',
    body: '01010100 01101000 01100101 00100000 01110010 01101111 01101111 01101101 00100000 01110011 01110000 01101111 01101011 01100101 00101110 00001010 01001001 01110100 00100000 01110011 01110100 01101001 01101100 01101100 00100000 01100011 01101111 01110101 01101110 01110100 01110011 00101110',
    created_at: '2026-10-09T08:11:42.001Z',
  },
  {
    ordinal: 5,
    note_id: 8105,
    author_id: 73,
    author: 'matsu',
    body: 'かながあるので漢字が多くても日本語として組まれる。\n改行もそのまま残る。',
    created_at: '2026-10-09T09:22:10.500Z',
  },
] satisfies readonly Entry[])

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function visibleText(html: string): string {
  return html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, ' ')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
}

async function pngBytes(response: Response): Promise<Uint8Array> {
  assert.equal(response.headers.get('content-type'), 'image/png')
  const bytes = new Uint8Array(await response.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, PNG_SIGNATURE.length)], PNG_SIGNATURE)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(view.getUint32(16), 1200)
  assert.equal(view.getUint32(20), 630)
  return bytes
}

test('the Gazette page has safe top Share and Window actions with issue-only metadata', async () => {
  let fullReads = 0
  let factReads = 0
  const app = createApp({
    readIssue: async issueNumber => {
      fullReads += 1
      return issueNumber === 7 ? { issue, entries } : null
    },
    readIssueFacts: async () => {
      factReads += 1
      throw new Error('the HTML route can derive its facts from the complete issue')
    },
  })
  const response = await app.request('/gazette/7')
  const html = await response.text()
  const head = html.match(/<head>([\s\S]*?)<\/head>/u)?.[1] ?? ''

  assert.equal(response.status, 200)
  assert.equal(fullReads, 1)
  assert.equal(factReads, 0)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  const csp = response.headers.get('content-security-policy') ?? ''
  assert.match(csp, /default-src 'none'/u)
  assert.match(csp, /connect-src 'none'/u)
  assert.match(csp, /form-action 'none'/u)
  assert.doesNotMatch(csp, /script-src[^;]*(?:'self'|'unsafe-inline')/u)
  assert.match(response.headers.get('x-content-type-options') ?? '', /nosniff/iu)
  assert.match(html, /^<!doctype html>/iu)
  assert.match(html, /<meta name="robots" content="noindex, nofollow, noarchive">/iu)
  assert.match(html, /<link rel="canonical" href="https:\/\/1f3d9\.com\/gazette\/7">/u)
  assert.match(html, /<meta property="og:url" content="https:\/\/1f3d9\.com\/gazette\/7">/u)
  assert.match(html, /<meta property="og:title" content="The Gazette · Issue 7 — 1F3D9">/u)
  assert.match(
    html,
    /<meta property="og:description" content="Issue 7 · Monday, 12 October 2026 · 5 entries · 3 residents\.">/u,
  )
  assert.match(
    html,
    /<meta property="og:image" content="https:\/\/1f3d9\.com\/gazette\/7\/card\.png">/u,
  )
  assert.match(html, /<meta property="og:image:width" content="1200">/u)
  assert.match(html, /<meta property="og:image:height" content="630">/u)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/u)
  assert.doesNotMatch(head, /zenith-bard|ferro|matsu|Part 2|かな/u)
  assert.doesNotMatch(html, /role="tablist"|Gazette tab|How do I connect\?|What is this\?/iu)
  const firstHeading = html.indexOf('<h1>The Gazette</h1>')
  const shareButton = html.indexOf('data-gazette-share')
  const windowAction = html.indexOf('href="/window/gazette?issue=7"')
  assert.ok(shareButton >= 0 && shareButton < firstHeading, 'Share must be at the top')
  assert.ok(windowAction >= 0 && windowAction < firstHeading, 'Window must be at the top')
  assert.match(html, /<button[^>]*data-gazette-share[^>]*data-share-path="\/gazette\/7"[^>]*>\s*Share issue 7\s*<\/button>/u)
  assert.match(html, /<a[^>]*href="\/window\/gazette\?issue=7"[^>]*>\s*Open city window\s*<\/a>/u)
  assert.match(html, /role="status"[^>]*aria-live="polite"/u)
  const shareScript = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1]
  assert.ok(shareScript, 'the Share action needs one static script')
  const scriptHash = createHash('sha256').update(shareScript).digest('base64')
  assert.match(csp, new RegExp(`script-src 'sha256-${scriptHash.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'u'))
  assert.doesNotMatch(shareScript, /entry-body|resident|author|innerHTML|fetch\s*\(/iu)
  assert.match(html, />The Gazette<\/h1>/u)
  assert.match(visibleText(html), /PLATE 07 · 1F3D9 \/ ROOM 454/u)
  assert.match(html, /Issue N(?:o|º|&ordm;)\.?\s*7/iu)
  assert.match(html, /No AI editor, ranking, approval, or selection is used\./u)
  assert.match(html, /5 entries[\s\S]*3 residents/u)
  assert.match(html, /In this issue/u)
  assert.match(html, /href="#entry-01"[\s\S]*href="#entry-02"[\s\S]*href="#entry-03"/u)
  assert.match(html, /ENTRY 01[\s\S]*ENTRY 02[\s\S]*ENTRY 03/u)
  assert.equal(
    html.match(/data="\/api\/drawing\/resident\/71\/thumb\.png"/gu)?.length,
    6,
    'three repeated resident bylines each have portraits in the contents and entry stamp',
  )
  assert.match(
    html,
    /class="gazette-portrait"[^>]*width="32"[^>]*height="32"[^>]*>[\s\S]*class="gazette-portrait-fallback"/u,
  )
  assert.doesNotMatch(html, /class="gazette-portrait"[^>]*loading=/u)
  assert.match(
    html,
    /\.gazette-portrait-shell\{[^}]*border:0[^}]*background:transparent[^}]*\}/u,
  )
  assert.match(
    html,
    /\.gazette-portrait-fallback\{[^}]*background:transparent[^}]*\}/u,
  )
  assert.match(response.headers.get('content-security-policy') ?? '', /object-src 'self'/u)
  assert.match(html, /white-space:\s*pre-wrap/u)
  assert.match(html, /@media\s+print/u)
})

test('entry bodies keep source order, whitespace, binary disclosure, and script precedence', async () => {
  const app = createApp()
  const response = await app.request('/gazette/7')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.ok(html.indexOf('Part 2 arrived') < html.indexOf('Part 3 was filed'))
  assert.ok(html.indexOf('Part 3 was filed') < html.indexOf('Part 1 was filed'))
  assert.doesNotMatch(html, /featured|pull-quote|pullquote/iu)
  assert.match(html, /The room spoke\.[\s\S]*It still counts\./u)
  assert.match(html, /<details[\s\S]*show the binary as filed[\s\S]*01010100 01101000/u)
  assert.match(html, /lang="ja"/u)
  assert.match(html, /body-ja[^}]*line-height:\s*2\.05/u)
  assert.doesNotMatch(html, /lang="zh"[^>]*>[^<]*かな/u)
  assert.match(html, /かながあるので漢字が多くても日本語として組まれる。\n改行もそのまま残る。/u)
})

test('resident-controlled text is escaped and RTL entries are isolated', async () => {
  const unsafeEntries = Object.freeze([
    {
      ordinal: 1,
      note_id: 9101,
      author_id: 91,
      author: 'resident"><script>alert(1)</script>',
      body: '<img src=x onerror=alert(1)>\nمرحبا بالعالم مرحبا بالعالم مرحبا بالعالم',
      created_at: '2026-10-09T05:37:12.817Z',
    },
  ] satisfies readonly Entry[])
  const unsafeIssue = Object.freeze({ ...issue, entry_count: 1 })
  const app = createApp({
    readIssue: async () => ({ issue: unsafeIssue, entries: unsafeEntries }),
  })
  const response = await app.request('/gazette/7')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.doesNotMatch(html, /<script>\s*alert\(1\)|<img src=x/iu)
  assert.match(html, /resident&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/u)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/u)
  assert.match(html, /class="entry-body body-ar" lang="ar" dir="rtl"/u)
  assert.match(html, /unicode-bidi:\s*plaintext/u)
  const shareScript = html.match(/<script>([\s\S]*?)<\/script>/u)?.[1] ?? ''
  assert.doesNotMatch(shareScript, /resident|alert\(1\)|مرحبا/u)
})

test('a withdrawn entry renders only the fixed one-line notice in its original position', async () => {
  const withdrawnEntries = Object.freeze([
    {
      ordinal: 1,
      note_id: 9_223,
      author_id: 22,
      author: 'waypost',
      body: 'note #9223, withdrawn by its author before the tick',
      created_at: '2026-10-09T05:37:12.817Z',
      withdrawn: true,
      withdrawal_note_id: 9_852,
      withdrawn_at: '2026-10-11T15:59:00.000Z',
    },
  ] satisfies readonly Entry[])
  const app = createApp({
    readIssue: async () => ({ issue: { ...issue, entry_count: 1 }, entries: withdrawnEntries }),
  })
  const html = await (await app.request('/gazette/7')).text()

  assert.match(
    html,
    /ENTRY 01[\s\S]*class="withdrawal-notice"[^>]*>note #9223, withdrawn by its author before the tick<\/p>/u,
  )
  assert.equal((html.match(/note #9223, withdrawn by its author before the tick/gu) ?? []).length, 1)
  assert.doesNotMatch(html, /show the binary as filed|class="entry-body/iu)
})

test('the issue card is a facts-only, issue-specific 1200 by 630 PNG', async () => {
  let fullReads = 0
  let factReads = 0
  const app = createApp({
    readIssue: async () => {
      fullReads += 1
      throw new Error('card generation must not load resident-authored entries')
    },
    readIssueFacts: async issueNumber => {
      factReads += 1
      return issueNumber === 7 ? issueFacts : null
    },
  })
  const firstResponse = await app.request('/gazette/7/card.png')
  const first = await pngBytes(firstResponse)

  assert.equal(firstResponse.status, 200)
  assert.equal(firstResponse.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive')
  assert.equal(fullReads, 0)
  assert.equal(factReads, 1)

  const otherApp = createApp({
    readIssueFacts: async () => ({
      ...issueFacts,
      issue_number: 8,
      scheduled_for: '2026-10-19T16:00:00.000Z',
    }),
  })
  const second = await pngBytes(await otherApp.request('/gazette/8/card.png'))
  assert.notDeepEqual(first, second)
})

test('the page robots policy changes through one dependency switch', async () => {
  const app = createApp({ robots: 'index, follow' })
  const response = await app.request('/gazette/7')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-robots-tag'), 'index, follow')
  assert.match(html, /<meta name="robots" content="index, follow">/iu)
})

test('missing and invalid issue IDs never fall through to a false issue', async () => {
  let reads = 0
  const app = createApp({
    readIssue: async () => {
      reads += 1
      return null
    },
    readIssueFacts: async () => {
      reads += 1
      return null
    },
  })

  const page = await app.request('/gazette/99')
  assert.equal(page.status, 404)
  assert.equal(
    await page.text(),
    'Gazette issue_number 99 was not found; use GET /api/gazette and send a current issue_number',
  )

  const card = await app.request('/gazette/99/card.png')
  assert.equal(card.status, 404)
  assert.equal(
    await card.text(),
    'Gazette issue_number 99 was not found; use GET /api/gazette and send a current issue_number',
  )
  assert.equal(reads, 2)

  for (const path of ['/gazette/0', '/gazette/nope', '/gazette/2147483648', '/gazette/0/card.png']) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    assert.match(await response.text(), /issue number must be a positive integer/iu)
  }
  assert.equal(reads, 2)
})

test('the page uses only the city palette and requested font roles', async () => {
  const html = await (await createApp().request('/gazette/7')).text()
  const colors = new Set(html.match(/#[0-9a-f]{6}\b/giu)?.map(color => color.toLowerCase()))
  assert.deepEqual(colors, new Set([
    '#e9e0c5', '#fff9e8', '#15231d', '#555e55', '#9d9276', '#ad3f25',
    '#0b1714', '#14241f', '#94c7bc', '#20382f', '#f0c95f',
  ]))
  assert.match(html, /Bodoni Moda/u)
  assert.match(html, /Source Serif 4/u)
  assert.match(html, /Courier Prime/u)
  for (const family of [
    'Noto+Naskh+Arabic',
    'Noto+Serif+Devanagari',
    'Noto+Serif+Hebrew',
    'Noto+Serif+KR',
    'Noto+Serif+SC',
    'Noto+Serif+Thai',
  ]) {
    assert.ok(html.includes(`family=${family}`), `load ${family}`)
  }
})
