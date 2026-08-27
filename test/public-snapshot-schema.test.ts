import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
  PUBLIC_EVENT_KINDS,
} from '../src/public-events.ts'

const migrationUrl = new URL('../db/migrations/20260823_public_snapshots.sql', import.meta.url)
const drawingsMigrationUrl = new URL('../db/migrations/20260827_drawings.sql', import.meta.url)
const schemaUrl = new URL('../db/schema.sql', import.meta.url)
const currentPublicEventKinds = PUBLIC_EVENT_KINDS.includes('resident_edited')
  ? [...PUBLIC_EVENT_KINDS]
  : [...PUBLIC_EVENT_KINDS.slice(0, 2), 'resident_edited', ...PUBLIC_EVENT_KINDS.slice(2)]

for (const [name, url] of [['migration', migrationUrl], ['fresh schema', schemaUrl]] as const) {
  test(`${name} installs one explicit fail-closed public snapshot view`, async () => {
    const sql = await readFile(url, 'utf8')
    assert.match(sql, /CREATE ROLE city_snapshot_export/iu)
    assert.doesNotMatch(
      sql,
      /ALTER ROLE city_snapshot_export\s+NOSUPERUSER/iu,
      'a managed Postgres role without BYPASSRLS may create the safe role but cannot repeat its attributes',
    )
    assert.match(
      sql,
      /rolname = 'city_snapshot_export'[\s\S]+rolsuper[\s\S]+rolcreatedb[\s\S]+rolcreaterole[\s\S]+rolinherit[\s\S]+rolreplication[\s\S]+rolbypassrls[\s\S]+rolcanlogin/iu,
      'reruns must fail closed if the existing export role has unsafe attributes',
    )
    assert.match(sql, /default_transaction_read_only/iu)
    assert.match(sql, /REVOKE[\s\S]+(?:TABLES|residents)[\s\S]+city_snapshot_export/iu)
    assert.match(sql, /CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    assert.match(sql, /security_barrier/iu)
    assert.match(sql, /GRANT SELECT ON city_snapshot\.public_records TO city_snapshot_export/iu)
    assert.doesNotMatch(
      sql,
      /CREATE OR REPLACE FUNCTION city_snapshot\.safe_(?:text|json)|redacted: this text contained|public JSON contained/iu,
      'the database must return already-public text unchanged so the exporter can fail closed',
    )
    const viewStart = sql.search(/CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    const viewEnd = sql.indexOf('GRANT SELECT ON city_snapshot.public_records', viewStart)
    assert.ok(viewStart >= 0 && viewEnd > viewStart)
    const view = sql.slice(viewStart, viewEnd)
    assert.doesNotMatch(view, /SELECT\s+\*/iu)
    assert.doesNotMatch(view, /city_snapshot\.safe_(?:text|json)/iu)
    assert.match(view, /'body',\s*note\.body/iu)
    assert.match(view, /'recipe',\s*trait\.recipe/iu)
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
    const expectedKinds = name === 'migration'
      ? currentPublicEventKinds.filter(kind => kind !== 'resident_edited')
      : currentPublicEventKinds
    assert.deepEqual(sqlPublicKinds, expectedKinds)
    assert.ok(sqlPublicKinds.includes('payment_repair'))
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
    ].filter(field => name !== 'migration' || field !== 'source_thing_id').sort()
    assert.deepEqual(sqlEventDetailFields, expectedEventDetailFields)
    assert.ok(sqlEventDetailFields.includes('action'))
    assert.doesNotMatch(
      eventProjection,
      /event\.detail->>'(?:body|description|reason|from|to|buyer)'/iu,
    )
    assert.doesNotMatch(
      eventProjection,
      /event\.detail->>?'(?:dispute_id|capture_id|purchase_id|gift_id|paypal_status|reason|buyer)'/iu,
      'public dispute decisions may expose only their safe action literal',
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

for (const [name, url] of [['drawings migration', drawingsMigrationUrl], ['fresh schema', schemaUrl]] as const) {
  test(`${name} exports exact drawings with moderated resident and resolved thing provenance`, async () => {
    const sql = await readFile(url, 'utf8')
    const viewStart = sql.search(/CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    assert.ok(viewStart >= 0, `${name}: snapshot view`)
    const view = sql.slice(viewStart)

    assert.match(view, /'drawing',\s*CASE[\s\S]{0,240}resident_hidden\.action\s*=\s*'remove'[\s\S]{0,120}resident\.drawing/iu)
    assert.match(view, /resident_hidden\.target_type\s*=\s*'resident'/iu)
    assert.match(view, /'drawing',\s*place\.drawing/iu)
    assert.match(view, /'drawing',\s*CASE[\s\S]{0,320}thing\.drawing[\s\S]{0,320}revision\.drawing/iu)
    assert.match(view, /'drawing_source',\s*CASE[\s\S]{0,500}'type',\s*'thing'[\s\S]{0,500}'type',\s*'kind_revision'/iu)
    assert.match(view, /revision\.kind_id\s*=\s*thing\.kind_id\s+AND\s+revision\.revision\s*=\s*thing\.current_revision/iu)
    assert.match(view, /'drawing',\s*revision\.drawing/iu)
    assert.match(view, /\('resident_edited'\)/u)
    assert.match(view, /'source_thing_id',\s*event\.detail->'source_thing_id'/u)

    const publicKindsCte = view.match(
      /public_event_kinds\(kind\)\s+AS\s*\(\s*VALUES([\s\S]*?)\r?\n\),\r?\nplace_ancestry/iu,
    )?.[1]
    assert.ok(publicKindsCte)
    assert.deepEqual(
      [...publicKindsCte.matchAll(/\('([^']+)'\)/gu)].map(match => match[1]!),
      currentPublicEventKinds,
    )
    const eventsStart = view.indexOf("SELECT 'events'")
    const moderationStart = view.indexOf("SELECT 'moderation'", eventsStart)
    const eventProjection = view.slice(eventsStart, moderationStart)
    assert.deepEqual(
      [...eventProjection.matchAll(/'([a-z_]+)',\s*event\.detail->'\1'/gu)]
        .map(match => match[1]!).sort(),
      [...PUBLIC_EVENT_DETAIL_ID_FIELDS, ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS].sort(),
    )
  })
}
