import test from 'node:test'
import assert from 'node:assert/strict'
import {
  loadPublicEventCollectionRows,
  loadPublicPlaceCollectionRows,
  type PublicPage,
  type PublicPlaceTextLimits,
  type PublicQueryExecutor,
} from '../src/public-pagination.ts'

test('inside-place event history includes the selected place and its descendants', async () => {
  let statement = ''
  let values: readonly unknown[] = []
  const query: PublicQueryExecutor = async (text, params) => {
    statement = text
    values = params
    return [{ id: null, total_items: 0, total_text_bytes: 0 }]
  }

  await loadPublicEventCollectionRows(
    query,
    { kind: null, actor: null, placeId: 7, includeDescendants: true, withinSeconds: 1_800 },
    page,
  )

  assert.match(statement, /WITH RECURSIVE selected_places/i)
  assert.match(statement, /child\.parent_id = selected\.id/i)
  assert.match(statement, /thing\.place_id IN \(SELECT id FROM selected_places\)/i)
  assert.match(statement, /note\.place_id IN \(SELECT id FROM selected_places\)/i)
  assert.match(statement, /JOIN public_change_log change ON change\.event_id = event\.id/iu)
  assert.match(statement, /change\.change_id::text AS change_id/iu)
  assert.match(statement, /event\.at\s*>=\s*transaction_timestamp\(\)[\s\S]*interval '1 second'/iu)
  assert.deepEqual(values, [null, null, 7, null, 11, 1_800])
})

const page: PublicPage = Object.freeze({
  ok: true,
  cursor: null,
  limit: 10,
  fetchLimit: 11,
})

const pages = Object.freeze({ subplaces: page, things: page, notes: page })
const provenance = Object.freeze({
  maker_id: 7,
  made_by: 'first-maker',
  current_owner_id: 8,
  current_owner: 'current-holder',
  owner_id: 8,
  owner: 'current-holder',
})

function aggregateRow(budgeted: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    subplaces: [],
    things: [{
      id: 41,
      place_id: 2,
      name: 'archive lantern',
      body: 'warm light',
      ...provenance,
      open_to_use: true,
      kind_id: null,
      kind: null,
      birth_revision: null,
      current_revision: null,
      created_at: '2026-08-11T00:00:00.000Z',
    }],
    notes: [],
    subplace_items: 0,
    subplace_text_bytes: 0,
    thing_items: 1,
    thing_text_bytes: 10,
    note_items: 0,
    note_text_bytes: 0,
  }
  if (!budgeted) return base
  for (const prefix of ['subplace', 'thing', 'note'] as const) {
    base[`${prefix}_returned_text_bytes`] = prefix === 'thing' ? 10 : 0
    base[`${prefix}_has_more`] = false
    base[`${prefix}_next_cursor`] = null
    base[`${prefix}_stopped_for_text_limit`] = false
    base[`${prefix}_next_item_id`] = null
    base[`${prefix}_next_item_text_bytes`] = null
  }
  return base
}

const cases: readonly Readonly<{
  label: string
  includeCollectionText: boolean
  textLimits: PublicPlaceTextLimits
  budgeted: boolean
}>[] = [
  {
    label: 'full unbudgeted',
    includeCollectionText: true,
    textLimits: { subplaces: null, things: null, notes: null },
    budgeted: false,
  },
  {
    label: 'outline unbudgeted',
    includeCollectionText: false,
    textLimits: { subplaces: null, things: null, notes: null },
    budgeted: false,
  },
  {
    label: 'full budgeted',
    includeCollectionText: true,
    textLimits: { subplaces: null, things: 100, notes: null },
    budgeted: true,
  },
]

for (const scenario of cases) {
  test(`public place ${scenario.label} things keep immutable maker and current-owner provenance`, async () => {
    let statement = ''
    const execute: PublicQueryExecutor = async text => {
      statement = text.replace(/\s+/gu, ' ').trim()
      return [aggregateRow(scenario.budgeted)]
    }

    const result = await loadPublicPlaceCollectionRows(
      execute,
      2,
      pages,
      scenario.includeCollectionText,
      scenario.textLimits,
    )

    assert.deepEqual({
      maker_id: result.things[0]?.maker_id,
      made_by: result.things[0]?.made_by,
      current_owner_id: result.things[0]?.current_owner_id,
      current_owner: result.things[0]?.current_owner,
      owner_id: result.things[0]?.owner_id,
      owner: result.things[0]?.owner,
    }, provenance)
    assert.match(statement, /t\.maker_id, maker\.handle AS made_by/i)
    assert.match(statement, /t\.owner_id AS current_owner_id, owner\.handle AS current_owner/i)
    assert.match(statement, /t\.owner_id, owner\.handle AS owner/i)
    assert.match(statement, /JOIN residents maker ON maker\.id = t\.maker_id/i)
    assert.match(statement, /p\.retired_at IS NULL/i)
  })
}
