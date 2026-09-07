import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as windowModule from '../../src/window.ts'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'

export function registerWindowRouteAndPaginationTests(): void {
  test('the /api/window route carries honest bounded causes without exporting its private shaper', () => {
    assert.equal(Object.hasOwn(windowModule, 'publicWindowEvent'), false)
    const rows = [
      { id: 15, kind: 'gazette_printed', actor: 'the Gazette printer', detail: {
        issue_number: 7, place_id: 454, entry_count: 3,
        body: 'must not leak from the Gazette event',
      } },
      { id: 14, kind: 'payment_repair', detail: {
        action: 'credit_dispute_seller_favour', resident_id: 1,
        dispute_id: 'PP-D-PRIVATE', purchase_id: 77, reason: 'private operator context',
      } },
      { id: 13, kind: 'payment_repair', detail: {
        action: 'credit_dispute_buyer_favour', resident_id: 1,
        dispute_id: 'PP-D-PRIVATE', purchase_id: 77, reason: 'private operator context',
      } },
      { id: 12, kind: 'action', detail: {
        action_id: 112, action: 'use', status: 'failed', error: 'y'.repeat(500),
      } },
      { id: 11, kind: 'effect_resolved', detail: {
        effect_id: 111, status: 'skipped', error: 'the stored source thing no longer exists',
      } },
      { id: 10, kind: 'action', detail: {
        action_id: 110, action: 'use', status: 'failed',
        error: '  the recipe needs a lit trait here  ',
      } },
      { id: 9, kind: 'action', detail: {
        action_id: 109, action: 'move', status: 'blocked',
        error: 'a local law blocks entry into this place',
      } },
      { id: 8, kind: 'effect_resolved', detail: {
        effect_id: 108, status: 'failed', error: 'the stored target thing no longer exists',
      } },
      { id: 7, kind: 'action', detail: {
        action_id: 107, action: 'use', status: 'failed', error: 'x'.repeat(700),
      } },
      { id: 6, kind: 'action', detail: {
        action_id: 106, action: 'use', status: 'failed', error: 'unsafe\u0007cause',
      } },
      { id: 5, kind: 'action', detail: {
        action_id: 105, action: 'use', status: 'failed',
      } },
      { id: 4, kind: 'action', detail: {
        action_id: 104, action: 'use', status: 'applied', error: 'successful action leak',
      } },
      { id: 3, kind: 'action', detail: {
        action_id: 103, action: 'use', status: 'noop', error: 'no-op leak',
      } },
      { id: 2, kind: 'effect_resolved', detail: {
        effect_id: 102, status: 'applied', error: 'resolved effect leak',
      } },
      { id: 1, kind: 'note', detail: { error: 'unrelated event leak' } },
    ].map(row => ({
      ...row,
      at: `2026-08-26T12:00:${String(row.id).padStart(2, '0')}.000Z`,
      actor: 'actor' in row ? row.actor : 'tiny-lantern',
    }))
    const databaseUrl = new URL('../../src/db.ts', import.meta.url).href
    const windowUrl = new URL('../../src/window.ts', import.meta.url).href
    const script = `
      import { mock } from 'node:test'
      import { Hono } from 'hono'
      const eventRows = ${JSON.stringify(rows)}
      const query = async text => {
        const source = String(text)
        if (source.includes('/* public:window-events */') && source.includes('FROM events event')) return eventRows
        if (source.includes('AS conversations') && source.includes('AS events')) {
          return [{ places: 0, residents: 0, conversations: 0, things: 0,
            agreements: 0, events: eventRows.length }]
        }
        return []
      }
      const tagged = async (strings, ...values) => query(Array.from(strings).join(' '), values)
      const sql = Object.assign(tagged, { query })
      mock.module(${JSON.stringify(databaseUrl)}, {
        namedExports: { sql, runtimeDatabaseUrl: () => 'postgresql://window.test/fixture' },
      })
      const { windowSnapshot } = await import(${JSON.stringify(windowUrl)})
      const app = new Hono()
      app.get('/api/window', windowSnapshot)
      const response = await app.request('http://city.test/api/window')
      if (response.status !== 200) throw new Error('window route returned ' + response.status)
      const body = await response.json()
      process.stdout.write(JSON.stringify(body.events))
    `
    const events = JSON.parse(execFileSync(process.execPath, [
      '--no-warnings',
      '--experimental-strip-types',
      '--experimental-test-module-mocks',
      '--input-type=module',
      '--eval',
      script,
    ], { cwd: new URL('../..', import.meta.url), encoding: 'utf8' })) as Array<{
      id: number
      actor: string
      kind: string
      detail: Record<string, unknown>
    }>
    const detail = (id: number) => events.find(event => event.id === id)?.detail ?? {}

    assert.deepEqual(events.find(event => event.id === 15), {
      id: 15,
      at: '2026-08-26T12:00:15.000Z',
      kind: 'gazette_printed',
      actor: 'the Gazette printer',
      detail: { place_id: 454, issue_number: 7, entry_count: 3 },
    })
    assert.deepEqual(detail(14), { action: 'credit_dispute_seller_favour' })
    assert.deepEqual(detail(13), { action: 'credit_dispute_buyer_favour' })
    assert.equal(detail(10).error, 'the recipe needs a lit trait here')
    assert.equal(detail(11).error, 'the stored source thing no longer exists')
    assert.equal(detail(9).error, 'a local law blocks entry into this place')
    assert.equal(detail(8).error, 'the stored target thing no longer exists')
    assert.equal(String(detail(7).error).length, 500)
    assert.equal(String(detail(7).error).endsWith('…'), true)
    assert.equal(detail(7).error, `${'x'.repeat(499)}…`)
    assert.equal(detail(7).error_truncated, true)
    assert.equal(detail(12).error, 'y'.repeat(500))
    assert.equal(detail(12).error_truncated, undefined)
    assert.equal(detail(6).error, 'the recorded cause could not be shown safely')
    assert.equal(detail(5).error, undefined)
    for (const id of [4, 3, 2, 1]) assert.equal(detail(id).error, undefined)
  })

  test('map branches expose accessible lazy-load and collapse controls', () => {
    assert.match(WINDOW_JS, /collapsedPlaceIds:\s*\[\]/)
    assert.match(WINDOW_JS, /element\('button', 'place-disclosure'/)
    assert.match(WINDOW_JS, /setAttribute\('aria-expanded'/)
    assert.match(WINDOW_JS, /setAttribute\('aria-controls'/)
    assert.match(WINDOW_JS, /place\.places\s*>\s*0/)
    assert.match(WINDOW_JS, /children\.hidden = !expanded/)
    assert.match(WINDOW_JS, /collapsedPlaceIds\.filter\(/)
    assert.match(WINDOW_JS, /\[\.\.\.state\.collapsedPlaceIds, placeId\]/)
    assert.doesNotMatch(WINDOW_JS, /collapsedPlaceIds\.(?:add|delete|push|splice)\(/)
    assert.match(WINDOW_CSS, /\.place-disclosure:focus-visible/)
  })

  test('the shipped window requests bounded map and resident pages', () => {
    assert.match(WINDOW_JS, /searchParams\.set\('view', 'outline'\)/)
    assert.match(WINDOW_JS, /new URL\('\/api\/map'/)
    assert.match(WINDOW_JS, /searchParams\.set\('parent_id', String\(/)
    assert.match(WINDOW_JS, /searchParams\.set\('subplace_limit', '25'\)/)
    assert.match(WINDOW_JS, /searchParams\.set\('before_subplace_id'/)
    assert.match(WINDOW_JS, /new URL\('\/api\/residents'/)
    assert.match(WINDOW_JS, /searchParams\.set\('view', 'presence'\)/)
    assert.match(WINDOW_JS, /searchParams\.set\('limit', '25'\)/)
    assert.match(WINDOW_JS, /searchParams\.set\('before_id'/)
  })

  test('partial navigation is explicit, retryable, and keyboard-readable', () => {
    assert.match(WINDOW_HTML, /id="resident-page"/)
    assert.match(WINDOW_JS, /currently loaded/i)
    assert.match(WINDOW_JS, /Load more residents/)
    assert.match(WINDOW_JS, /Retry loading residents/)
    assert.match(WINDOW_JS, /Retry loading places inside/)
    assert.match(WINDOW_JS, /No (?:more )?(?:places|residents)[^\n]*loaded/i)
    assert.match(WINDOW_JS, /aria-busy/)
    assert.match(WINDOW_JS, /data-focus-key/)
  })

  test('window history queries accept only one safe value for each supported filter', () => {
    const exports = windowModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.parseWindowHistoryQuery, 'function')
    const parse = exports.parseWindowHistoryQuery as (
      queries: Record<string, string[]>,
    ) => Record<string, unknown> | null

    assert.deepEqual(parse({ collection: ['notes'] }), {
      collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: null,
      context: false, includeDescendants: false,
    })
    assert.deepEqual(parse({
      collection: ['things'], before_id: ['91'], limit: ['12'],
      place_id: ['7'], resident: ['tiny-lantern'],
    }), {
      collection: 'things', beforeId: 91, limit: 12, placeId: 7, resident: 'tiny-lantern',
      context: false, includeDescendants: false,
    })
    assert.deepEqual(parse({
      collection: ['things'], within_place_id: ['7'], resident: ['tiny-lantern'],
    }), {
      collection: 'things', beforeId: null, limit: 10, placeId: 7, resident: 'tiny-lantern',
      context: false, includeDescendants: true,
    })
    assert.deepEqual(parse({
      collection: ['things'], presentation: ['headings'], within_place_id: ['7'],
    }), {
      collection: 'things', beforeId: null, limit: 10, placeId: 7, resident: null,
      context: false, includeDescendants: true, presentation: 'headings', find: null,
    })
    assert.deepEqual(parse({
      collection: ['things'], presentation: ['headings'], find: ['  Signal Lamp  '],
    }), {
      collection: 'things', beforeId: null, limit: 10, placeId: null, resident: null,
      context: false, includeDescendants: false, presentation: 'headings', find: 'Signal Lamp',
    })
    assert.deepEqual(parse({
      collection: ['things'], presentation: ['headings'], find: ['#401'],
    }), {
      collection: 'things', beforeId: null, limit: 10, placeId: null, resident: null,
      context: false, includeDescendants: false, presentation: 'headings', find: '#401',
    })
    assert.deepEqual(parse({ collection: ['agreements'], resident: ['tiny-lantern'] }), {
      collection: 'agreements', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
      context: false, includeDescendants: false,
    })
    assert.deepEqual(parse({
      collection: ['notes'], resident: ['tiny-lantern'], context: ['place'],
    }), {
      collection: 'notes', beforeId: null, limit: 10, placeId: null, resident: 'tiny-lantern',
      context: true, includeDescendants: false,
    })
    assert.deepEqual(parse({
      collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], place_id: ['7'],
    }), {
      collection: 'notes', beforeId: null, limit: 10, placeId: 7, resident: 'tiny-lantern',
      context: true, includeDescendants: false,
    })
    // A context page carries neighbors as well as own notes, so its page size
    // is bounded to keep the whole page inside the public row cap.
    assert.deepEqual(parse({
      collection: ['notes'], resident: ['tiny-lantern'], context: ['place'], limit: ['200'],
    }), {
      collection: 'notes', beforeId: null, limit: 39, placeId: null, resident: 'tiny-lantern',
      context: true, includeDescendants: false,
    })
    assert.deepEqual(parse({
      collection: ['notes'], limit: ['200'],
    }), {
      collection: 'notes', beforeId: null, limit: 200, placeId: null, resident: null,
      context: false, includeDescendants: false,
    })

    for (const unsafe of [
      { collection: ['events'] },
      { collection: ['notes', 'things'] },
      { collection: ['notes'], limit: ['0'] },
      { collection: ['notes'], limit: ['201'] },
      { collection: ['notes'], before_id: ['1.5'] },
      { collection: ['notes'], place_id: ['-2'] },
      { collection: ['notes'], place_id: ['2147483648'] },
      { collection: ['notes'], resident: ['not safe!'] },
      { collection: ['agreements'], place_id: ['7'] },
      { collection: ['agreements'], within_place_id: ['7'] },
      { collection: ['notes'], place_id: ['7'], within_place_id: ['7'] },
      { collection: ['notes'], within_place_id: ['-2'] },
      { collection: ['notes'], within_place_id: ['2147483648'] },
      { collection: ['notes'], nonce: ['cache-bust'] },
      { collection: ['notes'], context: ['place'] },
      { collection: ['notes'], resident: ['tiny-lantern'], context: ['thread'] },
      { collection: ['notes'], resident: ['tiny-lantern'], context: ['place', 'place'] },
      { collection: ['things'], resident: ['tiny-lantern'], context: ['place'] },
      { collection: ['agreements'], resident: ['tiny-lantern'], context: ['place'] },
      { collection: ['notes'], presentation: ['headings'] },
      { collection: ['things'], find: ['signal'] },
      { collection: ['things'], presentation: ['full'] },
      { collection: ['things'], presentation: ['headings'], find: ['line\nbreak'] },
      { collection: ['things'], presentation: ['headings'], find: ['#2147483648'] },
      { collection: ['things'], presentation: ['headings'], find: [
        `1f3d9_sk_${'ab'.repeat(24)}`,
      ] },
    ]) assert.equal(parse(unsafe), null)
  })
}
