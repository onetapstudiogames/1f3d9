import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../../src/window.ts'
import { WINDOW_JS, PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'

export function registerWindowOperationsTests(): void {
  function hexRgb(value: string): [number, number, number] {
    const match = /^#([0-9a-f]{6})$/iu.exec(value)
    assert.ok(match, `expected a six-digit hex color, received ${value}`)
    const hex = match[1]!
    return [0, 2, 4].map(offset => Number.parseInt(hex.slice(offset, offset + 2), 16)) as
      [number, number, number]
  }

  function colorContrast(left: string, right: string): number {
    const luminance = (value: string) => {
      const channels = hexRgb(value).map(channel => {
        const normalized = channel / 255
        return normalized <= 0.04045
          ? normalized / 12.92
          : ((normalized + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
    }
    const leftLuminance = luminance(left)
    const rightLuminance = luminance(right)
    const bright = Math.max(leftLuminance, rightLuminance)
    const dark = Math.min(leftLuminance, rightLuminance)
    return (bright + 0.05) / (dark + 0.05)
  }

  function cssVariable(name: string): string {
    const match = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'iu').exec(WINDOW_CSS)
    assert.ok(match, `expected --${name} in the window stylesheet`)
    return match[1]!
  }

  test('every active panel has one shared page heading and compliant window primitives', () => {
    const main = WINDOW_HTML.match(/<main id="city-main"[\s\S]*?<\/main>/u)?.[0] ?? ''
    assert.match(main, /<h1 class="window-title">The City Window<\/h1>/)
    assert.equal((main.match(/<h1\b/gu) ?? []).length, 1)
    for (const panel of [
      'map', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
    ]) {
      const content = main.match(new RegExp(`<section id="${panel}-panel"[\\s\\S]*?<\\/section>`))?.[0] ?? ''
      assert.match(content, /<h2\b/)
      assert.doesNotMatch(content, /<h1\b/)
    }

    assert.ok(colorContrast(cssVariable('muted'), cssVariable('paper')) >= 4.5)
    const focusBands = [cssVariable('focus'), cssVariable('focus-dark')]
    const palette = new Set(
      [...WINDOW_CSS.matchAll(/#[0-9a-f]{3}(?:[0-9a-f]{3})?\b/giu)].map(match => {
        const color = match[0].toLowerCase()
        return color.length === 4
          ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
          : color
      }),
    )
    for (const surface of palette) {
      assert.ok(
        Math.max(...focusBands.map(indicator => colorContrast(indicator, surface))) >= 3,
        `one focus band must meet 3:1 against ${surface}`,
      )
    }
    assert.match(WINDOW_CSS, /:focus-visible\s*\{[\s\S]*?outline:[\s\S]*?box-shadow:/)
    assert.match(WINDOW_CSS, /\.place-watch, \.resident-follow\s*\{[\s\S]*?min-width:\s*24px;[\s\S]*?min-height:\s*24px;/)
    assert.match(WINDOW_CSS, /\.window-title\s*\{[\s\S]*?clip-path:\s*inset\(50%\)/)
  })

  test('the status live region changes only when its state changes', () => {
    assert.match(WINDOW_JS, /if \(nodes\.status\.textContent !== message\) nodes\.status\.textContent = message/)
    assert.match(WINDOW_JS, /if \(nodes\.status\.dataset\.tone !== tone\) nodes\.status\.dataset\.tone = tone/)
    assert.match(WINDOW_JS, /Watching the public streets/)
    assert.doesNotMatch(WINDOW_JS, /Watching · (?:checked|no persisted changes)/)
    assert.doesNotMatch(WINDOW_JS, /setStatus\([^)]*Loading an updated public city view/)
  })

  test('the live window distinguishes its current bounded view from dated public snapshots', () => {
    assert.match(WINDOW_HTML, /The current bounded public view is loading\./)
    assert.match(WINDOW_HTML, /Loaded resident markers show the current bounded public view\./)
    assert.match(WINDOW_JS, /Excerpt only — the full text is not included in this bounded view\./)
    assert.match(WINDOW_JS, /Current bounded public view shows/)
    assert.match(WINDOW_JS, /The current public city view could not be read\./)
    assert.match(WINDOW_JS, /Retry reading the public city view/)
    assert.match(WINDOW_JS, /No public happening matches this selection\./)
    assert.match(WINDOW_JS, /No public agreement matches this resident selection\./)
    assert.doesNotMatch(WINDOW_JS, /No agreement in the current bounded public view matches/)
    assert.doesNotMatch(WINDOW_JS, /No happening in the current bounded public view matches/)
    assert.doesNotMatch(WINDOW_HTML, /Reading the luggage tags/iu)

    const oldVisibleCopy = [
      'latest public snapshot',
      'not included in this snapshot',
      'not currently loaded in this bounded snapshot',
      'fetched past that snapshot',
      'public city snapshot could not be read',
    ]
    for (const phrase of oldVisibleCopy) {
      assert.doesNotMatch(`${WINDOW_HTML}\n${WINDOW_JS}`, new RegExp(phrase, 'iu'), phrase)
    }

    const routeSource = windowModule.windowSnapshot.toString()
    assert.match(routeSource, /public window query was rejected because its fields or values are not supported/iu)
    assert.doesNotMatch(routeSource, /invalid public window snapshot query/iu)
  })

  test('global read retry keeps total failure and stale refresh visibly distinct', () => {
    assert.match(WINDOW_JS, /function renderGlobalReadRetry\(message, tone\)/)
    assert.match(WINDOW_JS, /nodes\.status\.dataset\.tone = tone/)
    assert.match(WINDOW_JS, /renderGlobalReadRetry\(message, 'error'\)/)
    assert.match(WINDOW_JS, /Showing the previous completed view\.',\s*'stale'/)
    assert.match(WINDOW_CSS, /\.watch-state \[data-tone="error"\]::before\s*\{/)
    assert.match(WINDOW_CSS, /\.global-read-retry\s*\{/)
    assert.match(WINDOW_CSS, /\.global-read-retry:focus-visible\s*\{/)
  })

  test('deliberate navigation makes canonical history and refresh keeps reading state', () => {
    // Tabs, place and resident choices, and filter changes push a history
    // entry; an unchanged canonical path does not add another entry.
    assert.match(WINDOW_JS, /function navigate\(next\)/)
    assert.match(WINDOW_JS, /history\.pushState/)
    assert.match(WINDOW_JS, /if \(current === path && !window\.location\.hash\) return true/)
    assert.match(WINDOW_JS, /window\.addEventListener\('popstate', syncStateFromLocation\)/)
    assert.match(WINDOW_JS, /navigate\(\{ view, placeId, detail: null \}\)/)
    assert.match(WINDOW_JS, /placeId: safeId\(nodes\.placeFilter\.value\)[\s\S]{0,120}directorySearch: ''/)
    assert.match(WINDOW_JS, /resident: safeHandle\(nodes\.residentFilter\.value\)[\s\S]{0,120}directorySearch: ''/)
    // Expanded bodies load browser-local choices; focus still has a fallback
    // for controls whose content changed and therefore had to be replaced.
    assert.match(WINDOW_JS, /expandedBodies: readViewerOpenKeys\(\)/)
    assert.match(WINDOW_JS, /state\.expandedBodies\.includes\(bodyKey\)/)
    assert.match(WINDOW_JS, /function restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
    assert.match(WINDOW_JS, /focus\(\{ preventScroll: true \}\)/)
    assert.match(WINDOW_JS, /data-focus-key/)
  })

  test('filtered happenings fetch their real slice from the server', () => {
    assert.match(WINDOW_JS, /function autoLoadFilteredHistory\(collection, filters, entry\)/)
    assert.match(WINDOW_JS, /autoLoadFilteredHistory\('events', filters, historyEntry\('events', filters\)\)/)
    // The events history request carries the active filters so a busy city
    // cannot push a watched place or followed resident out of the page.
    assert.match(WINDOW_JS, /url\.searchParams\.set\('within_place_id', String\(filters\.placeId\)\)/)
    assert.match(WINDOW_JS, /url\.searchParams\.set\('actor', filters\.resident\)/)
    // An initialized filtered view keeps learning: each snapshot refresh
    // silently refetches the newest filtered page and merges it.
    assert.match(WINDOW_JS, /function forwardRefreshHistory\(collection, filters\)/)
    assert.match(WINDOW_JS, /refreshFilteredViews\(\)/)
    // The interim load control stays focusable; disabled buttons cannot
    // receive restored focus. Arrow-key tab roving must not flood history.
    assert.match(WINDOW_JS, /aria-busy/)
    const historyControl = WINDOW_JS.match(
      /function renderHistoryControl\([\s\S]*?function historyRequestUrl/u,
    )?.[0] ?? ''
    assert.doesNotMatch(historyControl, /button\.disabled = entry\.loading/)
    assert.match(WINDOW_JS, /rovingTabActivation = true/)
  })

  test('every event kind an emitter writes is advertised public window life', async () => {
    // The world_* kinds went missing because nothing tied emitters to the
    // label list; this scan fails the moment a new INSERT INTO events kind
    // is not also public window vocabulary.
    const { readdir, readFile } = await import('node:fs/promises')
    const sourceDir = new URL('../../src/', import.meta.url)
    const written = new Set<string>()
    for (const name of await readdir(sourceDir)) {
      if (!name.endsWith('.ts')) continue
      const source = await readFile(new URL(name, sourceDir), 'utf8')
      for (const match of source.matchAll(
        /INSERT INTO events \(kind, actor, detail\)\s*(?:SELECT\s*'([a-z_]+)'|VALUES \(\s*'([a-z_]+)')/g,
      )) {
        written.add(match[1] ?? match[2] ?? '')
      }
    }
    written.delete('')
    assert.ok(written.size >= 15, `the emitter scan must find real kinds, saw ${written.size}`)
    const advertised = new Set(PUBLIC_EVENT_KINDS)
    const hidden = [...written].filter(kind => !advertised.has(kind))
    assert.deepEqual(hidden, [], 'every written event kind must be public window life')
  })

  test('the window covers the whole public life of the city', () => {
    assert.ok(PUBLIC_EVENT_KINDS.includes('home_set'))
    assert.ok(PUBLIC_EVENT_KINDS.includes('agreement_accession'))
    assert.ok(PUBLIC_EVENT_KINDS.includes('payment_repair'))
    assert.ok(PUBLIC_EVENT_KINDS.includes('gazette_printed'))
    assert.equal(
      PUBLIC_EVENT_LABELS.payment_repair,
      'recorded a host payment correction',
    )
    // The full enumeration is a truth surface: every kind the city writes for a
    // public act must be listed, or the window silently hides that life. The
    // world_* kinds are the market bridge — their absence hid every market sale.
    assert.deepEqual(PUBLIC_EVENT_KINDS, [
      'register', 'rotate', 'resident_edited', 'home_set', 'place_created', 'place_edited',
      'place_renamed', 'place_retired', 'place_restored',
      'kind_invented', 'kind_revised', 'trait_coined', 'thing_created',
      'thing_crafted', 'thing_edited', 'thing_moved', 'thing_upgraded', 'thing_withdrawn',
      'laws_changed', 'action', 'effect_scheduled', 'effect_resolved', 'note', 'gazette_printed',
      'agreement', 'agreement_accession', 'agreement_sign', 'transfer',
      'transfer_offer', 'sale', 'transfer_cancel', 'world_listed', 'world_sale',
      'world_cancel', 'payment_repair', 'flag', 'moderation',
    ])
    for (const phrase of [
      'Who is standing where',
      'Conversations by place',
      'Things inside this place',
      'Recent happenings',
      'Agreements and signatures',
    ]) assert.match(WINDOW_HTML, new RegExp(phrase, 'i'))

    const source = WINDOW_JS.toLowerCase()
    for (const field of ['residents', 'notes', 'things', 'traits', 'agreements', 'signatures']) {
      assert.ok(source.includes(field), `client should render ${field}`)
    }
    assert.match(WINDOW_CSS, /@media \(max-width:/)
    assert.match(WINDOW_CSS, /prefers-reduced-motion/)
  })

  test('long public bodies share one honest, accessible disclosure', () => {
    assert.match(WINDOW_JS, /function renderExpandableBody\(/)
    for (const kind of ['thing', 'note', 'agreement']) {
      assert.match(WINDOW_JS, new RegExp(`renderExpandableBody\\(\\s*'${kind}'`))
    }
    assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
    assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
    assert.match(WINDOW_JS, /Excerpt only — this bounded view carries only the first part\./)
    // Notes and things complete through the existing anonymous single-item read;
    // agreements remain terminal because no matching complete read exists.
    assert.match(WINDOW_JS, /fullBodies:\s*\{\}/)
    assert.match(WINDOW_JS, /function bodyDisclosureLabel\(/)
    assert.match(WINDOW_JS, /async function loadFullBody\(/)
    assert.match(WINDOW_JS, /'\/api\/' \+ kind \+ '\/' \+ String\(id\)/)
    assert.match(WINDOW_JS, /credentials:\s*'omit'/)
    assert.match(WINDOW_JS, /kind === 'note' \? 4000 : 65536/)
    assert.match(WINDOW_JS, /Read the whole ' \+ kind/)
    assert.match(WINDOW_JS, /The complete public ' \+ kind \+ ' could not be read\./)
    assert.match(WINDOW_JS, /The full text is not served through the glass\./)
    assert.doesNotMatch(WINDOW_JS, /element\('a', 'body-full-link'/)
    assert.match(WINDOW_CSS, /\.body-full-link/)
    assert.match(WINDOW_CSS, /\.public-body\[data-expanded="false"\]/)
    assert.match(WINDOW_CSS, /-webkit-line-clamp:/)
    assert.match(WINDOW_CSS, /\.body-disclosure:focus-visible/)
  })

  test('public action happenings preserve meaning and collapse only consecutive repeats', () => {
    assert.match(WINDOW_JS, /SAFE_ACTIONS/)
    assert.match(WINDOW_JS, /SAFE_ACTION_STATUSES/)
    assert.match(WINDOW_JS, /tried to ' \+ actionAttempt/)
    assert.match(WINDOW_JS, /function collapseActivity\(/)
    assert.match(WINDOW_JS, /group\.count > 1/)
    assert.match(WINDOW_JS, /String\(group\.count\) \+ ' times'/)
    assert.match(WINDOW_JS, /element\('span', 'activity-count'/)
    assert.match(WINDOW_CSS, /\.activity-count\s*\{/)
  })
}
