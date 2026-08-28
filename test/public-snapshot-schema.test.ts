import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
  PUBLIC_EVENT_KINDS,
} from '../src/public-events.ts'

const migrationUrl = new URL('../db/migrations/20260823_public_snapshots.sql', import.meta.url)
const gazetteMigrationUrl = new URL('../db/migrations/20260827_gazette.sql', import.meta.url)
const gazetteActivationUrl = new URL(
  '../db/migrations/20260827_gazette_room_activation.sql',
  import.meta.url,
)
const schemaUrl = new URL('../db/schema.sql', import.meta.url)

const V1_PUBLIC_EVENT_KINDS = PUBLIC_EVENT_KINDS.filter(kind => kind !== 'gazette_printed')
const V1_PUBLIC_EVENT_DETAIL_FIELDS = [
  ...PUBLIC_EVENT_DETAIL_ID_FIELDS,
  ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS.filter(field =>
    field !== 'issue_number' && field !== 'entry_count'),
].sort()

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
    assert.deepEqual(sqlPublicKinds, V1_PUBLIC_EVENT_KINDS)
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
    assert.deepEqual(sqlEventDetailFields, V1_PUBLIC_EVENT_DETAIL_FIELDS)
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
      'thing_later_holder_marks', 'resident_refusal_state',
    ]) {
      assert.equal(new RegExp(`\\bFROM\\s+(?:public\\.)?${privateTable}\\b`, 'iu').test(view), false, privateTable)
    }
    for (const className of [
      'residents', 'public_presence', 'places', 'things', 'notes', 'traits', 'kinds',
      'agreements', 'events', 'moderation', 'treasury_fees', 'world_market_offers',
    ]) assert.match(sql, new RegExp(`'${className}'`, 'u'), className)
  })
}

for (const [name, url] of [['Gazette migration', gazetteMigrationUrl], ['fresh schema', schemaUrl]] as const) {
  test(`${name} installs the restricted format-v2 Gazette projection`, async () => {
    const sql = await readFile(url, 'utf8')
    const viewStart = sql.search(/CREATE OR REPLACE VIEW city_snapshot\.public_records_v2/iu)
    const viewEnd = sql.indexOf('GRANT SELECT ON city_snapshot.public_records_v2', viewStart)
    assert.ok(viewStart >= 0 && viewEnd > viewStart)
    const view = sql.slice(viewStart, viewEnd)

    assert.match(view, /WITH \(security_barrier = true\)/iu)
    assert.match(view, /FROM city_snapshot\.public_records base_record/iu)
    assert.doesNotMatch(view, /SELECT\s+\*/iu)
    const v2KindsCte = view.match(
      /public_event_kinds_v2\(kind\)\s+AS\s*\(\s*VALUES([\s\S]*?)\r?\n\)\r?\nSELECT/iu,
    )?.[1]
    assert.ok(v2KindsCte)
    const v2PublicKinds = [...v2KindsCte.matchAll(/\('([^']+)'\)/gu)]
      .map(match => match[1]!)
    assert.deepEqual(v2PublicKinds, [...PUBLIC_EVENT_KINDS])
    assert.match(
      view,
      /base_record\.class_name = 'events'[\s\S]+NOT EXISTS \([\s\S]+public_event_kinds_v2[\s\S]+jsonb_build_object\(\s*'id',\s*base_record\.payload->'id',\s*'status',\s*'not_public_or_sequence_gap'\s*\)/iu,
    )
    assert.match(
      view,
      /base_record\.class_name = 'events'[\s\S]+base_record\.payload->>'kind' = 'gazette_printed'[\s\S]+gazette_issue\.event_id/iu,
    )
    assert.match(
      view,
      /base_record\.class_name = 'events'[\s\S]+base_record\.payload\s*#-\s*'\{detail,error\}'/iu,
      'format v2 must remove inherited event error text without changing v1',
    )
    assert.match(view, /'issue_number',\s*gazette_issue\.issue_number/iu)
    assert.match(view, /'entry_count',\s*gazette_issue\.entry_count/iu)

    const issuesStart = view.indexOf("SELECT 'gazette_issues'")
    const entriesStart = view.indexOf("SELECT 'gazette_issue_entries'", issuesStart)
    assert.ok(issuesStart >= 0 && entriesStart > issuesStart)
    const issuesProjection = view.slice(issuesStart, entriesStart)
    for (const field of [
      'id', 'status', 'issue_number', 'scheduled_for', 'printed_at', 'header', 'entry_count', 'event_id',
    ]) assert.match(issuesProjection, new RegExp(`'${field}'`, 'u'), field)
    assert.match(issuesProjection, /issue\.issue_number::TEXT AS record_id/iu)
    assert.match(issuesProjection, /issue\.issue_number::BIGINT AS sort_key/iu)

    const entriesProjection = view.slice(entriesStart)
    for (const field of [
      'id', 'status', 'issue_number', 'ordinal', 'note_id', 'author_id', 'author', 'created_at',
    ]) assert.match(entriesProjection, new RegExp(`'${field}'`, 'u'), field)
    assert.match(entriesProjection, /entry\.note_id::TEXT AS record_id/iu)
    assert.match(entriesProjection, /entry\.note_id::BIGINT AS sort_key/iu)
    assert.match(entriesProjection, /JOIN public\.notes note ON note\.id = entry\.note_id/iu)
    assert.match(entriesProjection, /JOIN public\.residents author ON author\.id = note\.author_id/iu)
    assert.doesNotMatch(entriesProjection, /'body'/iu)

    assert.match(
      sql,
      /GRANT SELECT ON city_snapshot\.public_records_v2 TO city_snapshot_export/iu,
    )
    if (name === 'Gazette migration') {
      assert.doesNotMatch(
        sql,
        /REVOKE SELECT ON city_snapshot\.public_records FROM city_snapshot_export/iu,
        'the dormant migration must leave the still-deployed v1 exporter working',
      )
    } else {
      assert.match(
        sql,
        /REVOKE SELECT ON city_snapshot\.public_records FROM city_snapshot_export/iu,
      )
    }
  })
}

test('exact post-deploy Gazette activation completes the snapshot v2 privilege cutover', async () => {
  const sql = await readFile(gazetteActivationUrl, 'utf8')
  assert.match(
    sql,
    /REVOKE SELECT ON city_snapshot\.public_records FROM city_snapshot_export/iu,
  )
  assert.match(
    sql,
    /GRANT SELECT ON city_snapshot\.public_records_v2 TO city_snapshot_export/iu,
  )
})
