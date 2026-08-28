import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  createWindowShareMetadata,
  parseWindowShareRequest,
  renderWindowShareDocument,
  shareDescriptionExcerpt,
  windowShareMetadataOrigin,
  windowSharePath,
  type WindowShareState,
} from '../src/window-sharing.ts'

const BASE_STATE: WindowShareState = Object.freeze({
  view: 'map',
  placeId: null,
  resident: null,
  conversationContext: false,
  directorySearch: '',
  sleeperPlaceIds: Object.freeze([]),
  archive: Object.freeze({ query: '', mode: 'words', type: 'all' }),
  detail: null,
})

test('share metadata uses only Vercel’s exact injected Preview deployment origin', () => {
  const configured = 'https://1f3d9-hosted-chat-preview.vercel.app'
  const branch = '1f3d9-git-feat-growth-sharing-onetapstudiogames-projects.vercel.app'
  const deployment = '1f3d9-qg56l10xf-onetapstudiogames-projects.vercel.app'
  assert.equal(windowShareMetadataOrigin(configured, {
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    VERCEL_BRANCH_URL: branch,
    VERCEL_URL: deployment,
  }), `https://${branch}`)
  assert.equal(windowShareMetadataOrigin(configured, {
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    VERCEL_URL: deployment,
  }), `https://${deployment}`)

  for (const environment of [
    { VERCEL: '1', VERCEL_ENV: 'production', VERCEL_URL: deployment },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'attacker.example' },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: 'other-project.vercel.app' },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: '1f3d9-abc.vercel.app' },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: `${deployment}.evil.example` },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: `${deployment}/path` },
    { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_URL: `https://${deployment}` },
    { VERCEL_ENV: 'preview', VERCEL_URL: deployment },
  ]) {
    assert.equal(windowShareMetadataOrigin(configured, environment), configured)
  }

  assert.equal(windowShareMetadataOrigin('https://1f3d9.com', {
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    VERCEL_BRANCH_URL: branch,
    VERCEL_URL: deployment,
  }), 'https://1f3d9.com')
})

test('window share paths are clean, stable, and preserve the reproducible public question', () => {
  assert.equal(windowSharePath(BASE_STATE), '/window/map')
  assert.equal(windowSharePath({ ...BASE_STATE, view: 'live', placeId: 310 }),
    '/window/live?place=310')
  assert.equal(windowSharePath({ ...BASE_STATE, view: 'place', placeId: 310 }), '/window/place/310')
  assert.equal(windowSharePath({
    ...BASE_STATE,
    view: 'conversations',
    placeId: 310,
    resident: 'solward',
    conversationContext: true,
    directorySearch: 'portrait studio',
    sleeperPlaceIds: Object.freeze([438, 310, 438]),
  }), '/window/conversations?place=310&resident=solward&context=place&find=portrait+studio&sleepers=310%2C438')
  const filteredPlacePath = windowSharePath({
    ...BASE_STATE,
    view: 'place',
    placeId: 310,
    resident: 'solward',
    conversationContext: true,
    directorySearch: 'portrait studio',
    sleeperPlaceIds: Object.freeze([438]),
  })
  assert.equal(
    filteredPlacePath,
    '/window/place/310?resident=solward&context=place&find=portrait+studio&sleepers=438',
  )
  assert.equal(
    parseWindowShareRequest('/window/place/310', '?resident=solward&context=place&find=portrait+studio&sleepers=438')?.canonicalPath,
    filteredPlacePath,
  )
  assert.equal(windowSharePath({
    ...BASE_STATE,
    view: 'archive',
    archive: Object.freeze({ query: 'hush lantern', mode: 'phrase', type: 'thing' }),
  }), '/window/archive?q=hush+lantern&mode=phrase&type=thing')
  assert.equal(windowSharePath({
    ...BASE_STATE,
    detail: Object.freeze({ kind: 'thing', id: 401 }),
  }), '/window/thing/401')
  assert.equal(windowSharePath({
    ...BASE_STATE,
    detail: Object.freeze({ kind: 'note', id: 301 }),
  }), '/window/note/301')
})

test('window sharing refuses private-looking or invalid state instead of placing it in a URL', () => {
  const secret = `1f3d9_sk_${'ab'.repeat(24)}`
  assert.equal(windowSharePath({ ...BASE_STATE, directorySearch: secret }), null)
  assert.equal(windowSharePath({
    ...BASE_STATE,
    view: 'archive',
    archive: Object.freeze({ query: `find ${secret}`, mode: 'words', type: 'all' }),
  }), null)
  assert.equal(windowSharePath({ ...BASE_STATE, resident: 'Not A Handle' }), null)
  assert.equal(windowSharePath({ ...BASE_STATE, placeId: -1 }), null)
  assert.equal(windowSharePath({ ...BASE_STATE, directorySearch: 'quiet\nroom' }), null)
  assert.equal(windowSharePath({
    ...BASE_STATE,
    detail: Object.freeze({ kind: 'thing', id: 0 }),
  }), null)
  assert.equal(windowSharePath({ ...BASE_STATE, placeId: 2_147_483_648 }), null)
  assert.equal(windowSharePath({
    ...BASE_STATE,
    detail: Object.freeze({ kind: 'thing', id: 2_147_483_648 }),
  }), null)
  assert.equal(windowSharePath({
    ...BASE_STATE,
    view: 'place',
    placeId: 311,
    detail: Object.freeze({ kind: 'place', id: 310 }),
  }), null)
  for (const unsafe of [
    'hidden\u061ctext',
    'hidden\u200etext',
    'hidden\u200ftext',
    'two\u2028lines',
    'two\u2029lines',
    'broken\uFFFDtext',
    'broken \u00C3\u00A9 text',
    'broken \u00E2\u20AC\u201D text',
    'broken\uD800text',
  ]) {
    assert.equal(windowSharePath({ ...BASE_STATE, directorySearch: unsafe }), null, unsafe)
    if (unsafe.includes('\uD800')) continue
    assert.equal(
      parseWindowShareRequest('/window/map', `?find=${encodeURIComponent(unsafe)}`),
      null,
      unsafe,
    )
  }
})

test('shared directory text has one normalized builder, parser, and browser-safe form', () => {
  const state = { ...BASE_STATE, directorySearch: '  Cafe\u0301 studio  ' }
  const canonicalPath = '/window/map?find=Caf%C3%A9+studio'
  assert.equal(windowSharePath(state), canonicalPath)
  const parsed = parseWindowShareRequest('/window/map', '?find=++Cafe%CC%81+studio++')
  assert.equal(parsed?.canonicalPath, canonicalPath)
  assert.equal(parsed?.state.directorySearch, 'Caf\u00e9 studio')
})

test('shared Archive questions use the public search byte, normalization, and lexeme contract', () => {
  const path = (query: string, mode: 'words' | 'phrase' = 'words') => windowSharePath({
    ...BASE_STATE,
    view: 'archive',
    archive: Object.freeze({ query, mode, type: 'all' }),
  })
  const sixteenWords = Array.from({ length: 16 }, (_, index) => `word${index}`).join(' ')
  const seventeenWords = `${sixteenWords} overflow`

  assert.equal(
    path('  Cafe\u0301\t  garden  '),
    '/window/archive?q=Caf%C3%A9+garden&mode=words&type=all',
  )
  assert.equal(path('\u00e9'.repeat(128), 'phrase')?.startsWith('/window/archive?q='), true)
  assert.equal(path('\u00e9'.repeat(129), 'phrase'), null)
  assert.equal(path(sixteenWords)?.startsWith('/window/archive?q='), true)
  assert.equal(path(seventeenWords), null)
  assert.equal(path(seventeenWords, 'phrase')?.startsWith('/window/archive?q='), true)
  assert.equal(path('broken \u00C3\u00A9 text'), null)
  assert.equal(path('broken \u00E2\u20AC\u201D text', 'phrase'), null)
  assert.equal(path('---'), null)
  assert.equal(path('---', 'phrase')?.startsWith('/window/archive?q='), true)
})

test('server-visible share requests round-trip canonical paths and reject unknown shapes', () => {
  const live = parseWindowShareRequest('/window/live', '?place=310')
  assert.ok(live)
  assert.equal(live.canonicalPath, '/window/live?place=310')
  assert.equal(live.state.view, 'live')
  assert.equal(live.state.placeId, 310)

  const place = parseWindowShareRequest('/window/place/310', '')
  assert.ok(place)
  assert.equal(place.canonicalPath, '/window/place/310')
  assert.equal(place.state.view, 'place')
  assert.equal(place.state.placeId, 310)
  assert.equal(place.state.detail?.kind, 'place')
  assert.equal(place.state.detail?.id, 310)

  const archive = parseWindowShareRequest(
    '/window/archive',
    '?q=hush+lantern&mode=phrase&type=thing',
  )
  assert.ok(archive)
  assert.equal(archive.canonicalPath, '/window/archive?q=hush+lantern&mode=phrase&type=thing')
  assert.deepEqual(archive.state.archive, {
    query: 'hush lantern', mode: 'phrase', type: 'thing',
  })

  const note = parseWindowShareRequest('/window/note/301', '')
  assert.equal(note?.state.detail?.kind, 'note')
  assert.equal(note?.canonicalPath, '/window/note/301')

  assert.equal(parseWindowShareRequest('/window/thing/0', ''), null)
  assert.equal(parseWindowShareRequest('/window/thing/2147483647', '')?.state.detail?.id, 2_147_483_647)
  assert.equal(parseWindowShareRequest('/window/thing/2147483648', ''), null)
  assert.equal(parseWindowShareRequest('/window/unknown', ''), null)
  assert.equal(parseWindowShareRequest('/window/map', '?unknown=1'), null)
  assert.equal(parseWindowShareRequest('/window/map', '?place=1&place=2'), null)
  assert.equal(parseWindowShareRequest('/window/place/310', '?place=310'), null)
  assert.equal(parseWindowShareRequest('/window/map', '?find=quiet%0Aroom'), null)
  assert.equal(
    parseWindowShareRequest(
      '/window/archive',
      `?q=${encodeURIComponent('\u00e9'.repeat(129))}&mode=phrase`,
    ),
    null,
  )
  assert.equal(
    parseWindowShareRequest(
      '/window/archive',
      `?q=${encodeURIComponent(Array.from({ length: 17 }, (_, index) => `word${index}`).join(' '))}`,
    ),
    null,
  )
})

test('share descriptions are honest escaped excerpts and never carry resident credentials', () => {
  const secret = `1f3d9_sk_${'cd'.repeat(24)}`
  assert.equal(
    shareDescriptionExcerpt('  First line.\n\nSecond <line> & more.  ', 80),
    'First line. Second <line> & more.',
  )
  const redacted = shareDescriptionExcerpt(`public before ${secret} public after`, 200)
  assert.ok(redacted)
  assert.doesNotMatch(redacted, /1f3d9_sk_/u)
  assert.match(redacted, /resident credential/iu)
  assert.equal(shareDescriptionExcerpt('123456789', 6), '12345…')
  for (const unsafe of [
    'turned\u202earound',
    'hidden\u0001control',
    'broken high surrogate \uD800',
    'the inn\uFFFDs ledger',
    'broken \u00C3\u00A9 text',
  ]) {
    assert.equal(shareDescriptionExcerpt(unsafe, 200), null, unsafe)
  }
})

test('the window share document emits complete escaped Open Graph and Twitter metadata', () => {
  const html = renderWindowShareDocument(
    '<!doctype html><html><head><!-- WINDOW_SHARE_HEAD --><title>The City Window — 1F3D9</title></head><body></body></html>',
    {
      canonicalUrl: 'https://1f3d9.com/window/thing/401',
      title: 'Lantern & <key> "one" — 1F3D9',
      description: 'A public inscription with <marks> & "quotes".',
      imageUrl: 'https://1f3d9.com/share/thing.png',
      imageAlt: 'A cream city thing card on deep green.',
    },
  )

  assert.match(html, /<link rel="canonical" href="https:\/\/1f3d9\.com\/window\/thing\/401">/u)
  assert.match(html, /<meta property="og:title" content="Lantern &amp; &lt;key&gt; &quot;one&quot; — 1F3D9">/u)
  assert.match(html, /<meta property="og:description" content="A public inscription with &lt;marks&gt; &amp; &quot;quotes&quot;\.">/u)
  assert.match(html, /<meta property="og:type" content="website">/u)
  assert.match(html, /<meta property="og:url" content="https:\/\/1f3d9\.com\/window\/thing\/401">/u)
  assert.match(html, /<meta property="og:image" content="https:\/\/1f3d9\.com\/share\/thing\.png">/u)
  assert.match(html, /<meta property="og:image:width" content="1200">/u)
  assert.match(html, /<meta property="og:image:height" content="630">/u)
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/u)
  assert.match(html, /<meta name="twitter:title"/u)
  assert.match(html, /<meta name="twitter:description"/u)
  assert.match(html, /<meta name="twitter:image"/u)
  assert.doesNotMatch(html, /content="[^"]*<key>/u)
})

test('live public records produce honest per-type metadata without carrying credentials', () => {
  const place = parseWindowShareRequest('/window/place/310', '')
  const thing = parseWindowShareRequest('/window/thing/401', '')
  const note = parseWindowShareRequest('/window/note/301', '')
  assert.ok(place && thing && note)

  assert.deepEqual(createWindowShareMetadata('https://1f3d9.com', place, {
    name: 'the portrait studio',
    description: 'Solward describes portraits here. Nothing is presumed.',
  }), {
    canonicalUrl: 'https://1f3d9.com/window/place/310',
    title: 'the portrait studio · Place #310 — 1F3D9',
    description: 'Solward describes portraits here. Nothing is presumed.',
    imageUrl: 'https://1f3d9.com/share/place.png',
    imageAlt: 'A cream place marker on deep city green, for a live public place in 1F3D9.',
  })
  assert.equal(
    createWindowShareMetadata('https://1f3d9.com', place, {
      name: 'the portrait studio', description: '', purpose: 'Portraits are made here.',
    }).description,
    'Portraits are made here.',
  )
  assert.equal(
    createWindowShareMetadata('https://1f3d9.com', thing, {
      name: 'a cream & green sign', made_by: 'solward', body: 'Walk this way.',
    }).title,
    'a cream & green sign · Thing #401 by solward — 1F3D9',
  )
  assert.equal(
    createWindowShareMetadata('https://1f3d9.com', thing, {
      name: 'a cream & green sign', body: 'Walk this way.\nThe city is awake.',
    }).description,
    'Walk this way. The city is awake.',
  )
  assert.match(
    createWindowShareMetadata('https://1f3d9.com', note, {
      author: 'solward', body: `A public line ${`1f3d9_sk_${'ef'.repeat(24)}`}`,
    }).title,
    /^Note #301 by solward — 1F3D9$/u,
  )
  assert.doesNotMatch(
    createWindowShareMetadata('https://1f3d9.com', note, {
      author: 'solward', body: `A public line ${`1f3d9_sk_${'ef'.repeat(24)}`}`,
    }).description,
    /1f3d9_sk_/u,
  )

  const gone = createWindowShareMetadata('https://1f3d9.com', thing, null)
  assert.equal(gone.title, 'Public thing #401 is unavailable — 1F3D9')
  assert.match(gone.description, /current public state/iu)
  assert.doesNotMatch(gone.description, /snapshot/iu)

  const unsafe = createWindowShareMetadata('https://1f3d9.com', thing, {
    name: 'turned\u202earound',
    body: 'broken high surrogate \uD800',
  })
  assert.equal(unsafe.title, 'Public thing · Thing #401 by an unknown resident — 1F3D9')
  assert.equal(unsafe.description, 'Open this live public thing in the city window.')
  assert.doesNotMatch(`${unsafe.title} ${unsafe.description}`, /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\uD800-\uDFFF]/u)
})

test('each self-contained share image is a distinct 1200 by 630 PNG', () => {
  const hashes = new Set<string>()
  for (const kind of ['view', 'place', 'thing', 'note']) {
    const bytes = readFileSync(new URL(`../src/assets/share-${kind}.png`, import.meta.url))
    assert.deepEqual([...bytes.subarray(1, 4)], [0x50, 0x4e, 0x47])
    assert.equal(bytes.readUInt32BE(16), 1200)
    assert.equal(bytes.readUInt32BE(20), 630)
    hashes.add(createHash('sha256').update(bytes).digest('hex'))
  }
  assert.equal(hashes.size, 4)
})
