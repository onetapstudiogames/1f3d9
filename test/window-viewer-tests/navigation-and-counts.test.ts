import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../../src/window.ts'
import { WINDOW_JS } from '../../src/window-client.ts'

export function registerWindowNavigationAndCountsTests(): void {
  test('the bounded window keeps loaded navigation while fresh outline pages merge immutably', () => {
    assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*residents/i)
    assert.match(WINDOW_JS, /mergeWindowRows\([^\n]*(?:children|subplaces)/i)
    assert.match(WINDOW_JS, /collapsedPlaceIds/)
    assert.match(WINDOW_JS, /restoreFocus\(focusKey, focusFallbackKey, focusFallbackId\)/)
    assert.match(WINDOW_JS, /data-focus-key/u)
    assert.doesNotMatch(WINDOW_JS, /(?:residents|subplaces|children)\.(?:push|splice|sort)\(/)
  })

  test('bounded navigation stays honest and keyboard-safe at page boundaries', () => {
    assert.doesNotMatch(WINDOW_JS, /nodes\.status\?\.removeAttribute\('role'\)/)
    assert.match(WINDOW_JS, /no public place was found/i)
    assert.match(WINDOW_JS, /Retry loading this place/)
    assert.match(WINDOW_JS, /no narrow place-specific presence read/i)
    assert.doesNotMatch(WINDOW_JS, /focused metadata loaded; contents are not currently loaded/i)
    assert.match(WINDOW_JS, /seenBeforeIds/)
    assert.match(WINDOW_JS, /seenBeforeSubplaceIds/)
    assert.match(WINDOW_JS, /focusFallbackKey/)
    assert.match(WINDOW_JS, /forwardReconcile/i)
  })

  test('the ownerless world remains visible without admitting ownerless ordinary places', () => {
    const places = windowModule.publicPlaceTree([{
      id: 1,
      parent_id: null,
      name: 'the world',
      owner: null,
      places: 2,
      things: 0,
      notes: 0,
    }, {
      id: 2,
      parent_id: 1,
      name: 'possibility',
      owner: 'tiny-lantern',
      places: 0,
      things: 0,
      notes: 0,
    }, {
      id: 3,
      parent_id: 1,
      name: 'ownerless-room',
      owner: null,
      places: 0,
      things: 0,
      notes: 0,
    }, {
      id: 4,
      parent_id: null,
      name: 'ownerless-impostor',
      owner: null,
      places: 0,
      things: 0,
      notes: 0,
    }])

    assert.equal(places.length, 1)
    assert.equal(places[0]?.name, 'the world')
    assert.equal(places[0]?.owner, null)
    assert.deepEqual(places[0]?.children.map(place => place.id), [2])

    const legacyRoots = windowModule.publicPlaceTree([{
      id: 5, parent_id: null, name: 'the-mainland', owner: 'founder',
      places: 0, things: 0, notes: 0,
    }])
    assert.equal(legacyRoots[0]?.owner, 'founder')

    assert.match(WINDOW_JS, /unowned · transit only/)
    assert.match(WINDOW_JS, /nobody owns it · transit only/)
  })

  test('thing traits stay pinned to each thing current kind revision', () => {
    const exports = windowModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.mergeWindowThingTraits, 'function')
    const merge = exports.mergeWindowThingTraits as (
      things: Array<Record<string, unknown>>,
      facets: Array<Record<string, unknown>>,
    ) => Array<Record<string, unknown>>
    const things = merge([
      { id: 41, kind_id: 3, current_revision: 1, traits: ['wrong'] },
      { id: 42, kind_id: 3, current_revision: 2, traits: ['wrong'] },
    ], [
      { id: 3, revision: 1, traits: ['glowing'] },
      { id: 3, revision: 2, traits: ['glowing', 'weatherproof'] },
    ])
    assert.deepEqual(things.map(thing => thing.traits), [
      ['glowing'],
      ['glowing', 'weatherproof'],
    ])
  })

  test('snapshot totals preserve city-wide counts beyond the displayed caps', () => {
    const exports = windowModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.publicWindowTotals, 'function')
    const totals = (exports.publicWindowTotals as (
      row: Record<string, unknown>,
      shown: Record<string, number>,
    ) => Record<string, number>)({
      places: 1_200,
      residents: 2_100,
      conversations: 8_000,
      things: 1_400,
      agreements: 180,
      events: 9_000,
    }, {
      places: 1_000,
      residents: 2_000,
      conversations: 1_000,
      things: 1_000,
      agreements: 100,
      events: 100,
    })
    assert.deepEqual(totals, {
      places: 1_200,
      residents: 2_100,
      conversations: 8_000,
      things: 1_400,
      agreements: 180,
      events: 9_000,
    })
    assert.match(WINDOW_JS, /payload\.totals/)
    assert.match(WINDOW_JS, /current bounded public view/i)
  })
}
