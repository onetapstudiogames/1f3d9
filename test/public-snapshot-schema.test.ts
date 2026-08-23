import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
  PUBLIC_EVENT_KINDS,
} from '../src/public-events.ts'

const migrationUrl = new URL('../db/migrations/20260823_public_snapshots.sql', import.meta.url)
const schemaUrl = new URL('../db/schema.sql', import.meta.url)

for (const [name, url] of [['migration', migrationUrl], ['fresh schema', schemaUrl]] as const) {
  test(`${name} installs one explicit fail-closed public snapshot view`, async () => {
    const sql = await readFile(url, 'utf8')
    assert.match(sql, /CREATE ROLE city_snapshot_export/iu)
    assert.match(sql, /default_transaction_read_only/iu)
    assert.match(sql, /REVOKE[\s\S]+(?:TABLES|residents)[\s\S]+city_snapshot_export/iu)
    assert.match(sql, /CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    assert.match(sql, /security_barrier/iu)
    assert.match(sql, /GRANT SELECT ON city_snapshot\.public_records TO city_snapshot_export/iu)
    const viewStart = sql.search(/CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    const viewEnd = sql.indexOf('GRANT SELECT ON city_snapshot.public_records', viewStart)
    assert.ok(viewStart >= 0 && viewEnd > viewStart)
    const view = sql.slice(viewStart, viewEnd)
    assert.doesNotMatch(view, /SELECT\s+\*/iu)
    assert.match(view, /trait_hidden\.action = 'remove'[\s\S]+unnest\(revision\.traits\)/iu)
    assert.match(view, /ingredient_hidden\.action = 'remove'[\s\S]+jsonb_array_elements\(revision\.recipe\)/iu)
    assert.match(view, /'status', event\.detail->'status'/iu)
    assert.doesNotMatch(view, /status_value/iu)

    const publicKindsCte = view.match(
      /public_event_kinds\(kind\)\s+AS\s*\(\s*VALUES([\s\S]*?)\r?\n\),\r?\nplace_ancestry/iu,
    )?.[1]
    assert.ok(publicKindsCte)
    const sqlPublicKinds = [...publicKindsCte.matchAll(/\('([^']+)'\)/gu)]
      .map(match => match[1]!)
    assert.deepEqual(sqlPublicKinds, [...PUBLIC_EVENT_KINDS])
    assert.match(
      view,
      /event\.kind IN \(SELECT public_kind\.kind FROM public_event_kinds public_kind\)/iu,
    )

    const eventsStart = view.indexOf("SELECT 'events'")
    const moderationStart = view.indexOf("SELECT 'moderation'", eventsStart)
    assert.ok(eventsStart >= 0 && moderationStart > eventsStart)
    const eventProjection = view.slice(eventsStart, moderationStart)
    const sqlEventDetailFields = [...eventProjection.matchAll(
      /'([a-z_]+)',\s*event\.detail->'\1'/gu,
    )].map(match => match[1]!).sort()
    const expectedEventDetailFields = [
      ...PUBLIC_EVENT_DETAIL_ID_FIELDS,
      ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
    ].sort()
    assert.deepEqual(sqlEventDetailFields, expectedEventDetailFields)
    assert.doesNotMatch(
      eventProjection,
      /event\.detail->>'(?:body|description|reason|error|from|to|buyer)'/iu,
    )

    const worldOffersStart = view.indexOf("SELECT 'world_market_offers'")
    assert.ok(worldOffersStart >= 0)
    const worldOffersProjection = view.slice(worldOffersStart)
    assert.match(worldOffersProjection, /WHEN hidden\.action = 'remove'/iu)
    assert.match(
      worldOffersProjection,
      /hidden\.target_type = 'thing' AND hidden\.target_id = thing\.id/iu,
    )
    for (const privateTable of [
      'oauth_tokens', 'flags', 'payment_attempts', 'city_credit_entries',
      'thing_later_holder_marks',
    ]) {
      assert.equal(new RegExp(`\\bFROM\\s+(?:public\\.)?${privateTable}\\b`, 'iu').test(view), false, privateTable)
    }
    for (const className of [
      'residents', 'public_presence', 'places', 'things', 'notes', 'traits', 'kinds',
      'agreements', 'events', 'moderation', 'treasury_fees', 'world_market_offers',
    ]) assert.match(sql, new RegExp(`'${className}'`, 'u'), className)
  })
}
