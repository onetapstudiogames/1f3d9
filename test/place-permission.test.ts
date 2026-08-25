import test from 'node:test'
import assert from 'node:assert/strict'

import {
  placePermission,
  withPlacePermission,
} from '../src/place-permission.ts'

type Call = Readonly<{ text: string; values: readonly unknown[] }>

function recordingSql(calls: Call[]) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join('?').replace(/\s+/gu, ' ').trim(), values })
    return []
  }
}

test('one place-permission fragment preserves SQL parameter order for every switch', async () => {
  const calls: Call[] = []
  const query = withPlacePermission(recordingSql(calls))

  await query`
    SELECT ${placePermission('place', 'open_to_building', 7)} AS permitted
    FROM places place
    WHERE place.id = ${2}
      AND ${placePermission('place', 'open_to_things', 7)}
      AND ${placePermission('place', 'open_to_notes', 7)}
  `

  assert.deepEqual(calls, [{
    text: 'SELECT (place.owner_id = ? OR place.open_to_building) AS permitted FROM places place WHERE place.id = ? AND (place.owner_id = ? OR place.open_to_things) AND (place.owner_id = ? OR place.open_to_notes)',
    values: [7, 2, 7, 7],
  }])
})

test('place-permission SQL accepts only audited aliases and columns', () => {
  assert.throws(
    () => placePermission('unsafe' as never, 'open_to_notes', 7),
    /unsupported place SQL alias/u,
  )
  assert.throws(
    () => placePermission('constructor' as never, 'open_to_notes', 7),
    /unsupported place SQL alias/u,
  )
  assert.throws(
    () => placePermission('place', 'unsafe' as never, 7),
    /unsupported place permission/u,
  )
})
