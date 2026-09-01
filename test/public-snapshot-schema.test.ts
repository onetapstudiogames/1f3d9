import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_DETAIL_SCALAR_FIELDS,
  PUBLIC_EVENT_KINDS,
} from '../src/public-events.ts'
import { PUBLIC_SNAPSHOT_DELIBERATELY_OMITTED_LIVE_DETAIL_FIELDS } from '../src/public-snapshot-format.ts'
import {
  AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS,
  AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS_BY_KIND,
} from './fixtures/public-snapshot-event-detail-contract.ts'
import {
  assertEveryEventDetailFieldClassified,
  readRepositoryEventWriterSources,
  scanEventDetailWriters,
} from './helpers/public-event-detail-writer-scan.ts'

const migrationUrl = new URL('../db/migrations/20260823_public_snapshots.sql', import.meta.url)
const drawingsMigrationUrl = new URL('../db/migrations/20260827_drawings.sql', import.meta.url)
const drawingContractMigrationUrl = new URL(
  '../db/migrations/20260828_drawing_contract.sql',
  import.meta.url,
)
const gazetteMigrationUrl = new URL('../db/migrations/20260827_gazette.sql', import.meta.url)
const gazetteActivationUrl = new URL(
  '../db/migrations/20260827_gazette_room_activation.sql',
  import.meta.url,
)
const gazetteWithdrawalMigrationUrl = new URL(
  '../db/migrations/20260901_gazette_withdrawal.sql',
  import.meta.url,
)
const eventDetailMigrationUrl = new URL(
  '../db/migrations/20260901_public_snapshot_event_details.sql',
  import.meta.url,
)
const schemaUrl = new URL('../db/schema.sql', import.meta.url)
const currentPublicEventKinds = PUBLIC_EVENT_KINDS.includes('resident_edited')
  ? [...PUBLIC_EVENT_KINDS]
  : [...PUBLIC_EVENT_KINDS.slice(0, 2), 'resident_edited', ...PUBLIC_EVENT_KINDS.slice(2)]

const V1_PUBLIC_EVENT_KINDS = currentPublicEventKinds.filter(kind => kind !== 'gazette_printed')
const V1_PUBLIC_EVENT_DETAIL_FIELDS = [
  ...PUBLIC_EVENT_DETAIL_ID_FIELDS,
  ...PUBLIC_EVENT_DETAIL_SCALAR_FIELDS.filter(field =>
    field !== 'issue_number' && field !== 'entry_count'),
].sort()
const CURRENT_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS = [
  ...V1_PUBLIC_EVENT_DETAIL_FIELDS,
  'effects_applied',
  'due_at',
  'generation',
].sort()
const EFFECTIVE_V2_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS = [
  ...CURRENT_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS.filter(field => field !== 'error'),
  'issue_number',
  'entry_count',
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
    const expectedKinds = name === 'migration'
      ? V1_PUBLIC_EVENT_KINDS.filter(kind => kind !== 'resident_edited')
      : V1_PUBLIC_EVENT_KINDS
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
    const expectedEventDetailFields = name === 'fresh schema'
      ? CURRENT_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS
      : V1_PUBLIC_EVENT_DETAIL_FIELDS.filter(field => field !== 'source_thing_id')
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

for (const [name, url] of [
  ['drawing contract migration', drawingContractMigrationUrl],
  ['fresh schema', schemaUrl],
] as const) {
  test(`${name} exports current drawing state and separate immutable revisions`, async () => {
    const sql = await readFile(url, 'utf8')
    const viewStart = sql.search(/CREATE OR REPLACE VIEW city_snapshot\.public_records/iu)
    assert.ok(viewStart >= 0, `${name}: snapshot view`)
    const view = sql.slice(viewStart)

    for (const key of [
      'drawing', 'drawing_state', 'drawing_description', 'drawing_rows', 'drawing_source',
    ]) assert.match(view, new RegExp(`'${key}'`, 'u'), `${name}: ${key}`)
    for (const source of [
      'none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant',
    ]) assert.match(view, new RegExp(`'${source}'`, 'u'), `${name}: ${source}`)
    for (const provenance of ['kind_id', 'kind_name', 'revision', 'variant_name']) {
      assert.match(view, new RegExp(`'${provenance}'`, 'u'), `${name}: ${provenance}`)
    }

    const revisionsStart = view.indexOf("SELECT 'drawing_revisions'")
    assert.ok(revisionsStart >= 0, `${name}: drawing revisions class`)
    const revisions = view.slice(revisionsStart)
    for (const key of [
      'target_type', 'target_id', 'previous', 'current', 'source', 'author_relation',
      'created_at',
    ]) assert.match(revisions, new RegExp(`'${key}'`, 'u'), `${name}: revision ${key}`)
    assert.match(revisions, /moderation_actions/iu)
    assert.match(revisions, /target_type/iu)
    assert.match(revisions, /target_id/iu)
    assert.doesNotMatch(view, /resident_drawing_rate_limits/iu)
    assert.doesNotMatch(view, /'drawing_history'|'history'\s*,/iu)
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
      V1_PUBLIC_EVENT_KINDS,
    )
    const eventsStart = view.indexOf("SELECT 'events'")
    const moderationStart = view.indexOf("SELECT 'moderation'", eventsStart)
    const eventProjection = view.slice(eventsStart, moderationStart)
    assert.deepEqual(
      [...eventProjection.matchAll(/'([a-z_]+)',\s*event\.detail->'\1'/gu)]
        .map(match => match[1]!).sort(),
      name === 'fresh schema'
        ? CURRENT_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS
        : V1_PUBLIC_EVENT_DETAIL_FIELDS,
    )
  })
}

for (const [name, url] of [
  ['Gazette migration', gazetteMigrationUrl],
  ['drawing contract migration', drawingContractMigrationUrl],
  ['fresh schema', schemaUrl],
] as const) {
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
      /public_event_kinds_v2\(kind\)\s+AS\s*\(\s*VALUES([\s\S]*?)\r?\n\s*\)\r?\n\s*SELECT/iu,
    )?.[1]
    assert.ok(v2KindsCte)
    const v2PublicKinds = [...v2KindsCte.matchAll(/\('([^']+)'\)/gu)]
      .map(match => match[1]!)
    const expectedV2Kinds = name === 'Gazette migration'
      ? currentPublicEventKinds.filter(kind => kind !== 'resident_edited')
      : currentPublicEventKinds
    assert.deepEqual(v2PublicKinds, expectedV2Kinds)
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
    } else if (name === 'drawing contract migration') {
      assert.match(sql, /gazette_submission_room_is_open\(\)/iu)
      assert.match(
        sql,
        /REVOKE SELECT ON city_snapshot\.public_records FROM city_snapshot_export/iu,
      )
      assert.match(
        sql,
        /GRANT SELECT ON city_snapshot\.public_records TO city_snapshot_export/iu,
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

for (const [name, url] of [
  ['Gazette withdrawal migration', gazetteWithdrawalMigrationUrl],
  ['fresh schema', schemaUrl],
] as const) {
  test(`${name} adds a body-free withdrawal ledger without changing dormant entries`, async () => {
    const sql = await readFile(url, 'utf8')
    const viewStart = sql.lastIndexOf('CREATE OR REPLACE VIEW city_snapshot.public_records_v2')
    const viewEnd = sql.indexOf('GRANT SELECT ON city_snapshot.public_records_v2', viewStart)
    assert.ok(viewStart >= 0 && viewEnd > viewStart, `${name}: current snapshot v2 view`)
    const view = sql.slice(viewStart, viewEnd)

    const entriesStart = view.indexOf("SELECT 'gazette_issue_entries'")
    const withdrawalsStart = view.indexOf("SELECT 'gazette_withdrawals'", entriesStart)
    assert.ok(entriesStart >= 0 && withdrawalsStart > entriesStart)
    const entries = view.slice(entriesStart, withdrawalsStart)
    assert.match(
      entries,
      /LEFT JOIN public\.gazette_withdrawals withdrawal\s+ON withdrawal\.target_note_id = entry\.note_id/iu,
    )
    assert.match(entries, /WHEN withdrawal\.target_note_id IS NULL\s+THEN '\{\}'::jsonb/iu)
    assert.match(entries, /'withdrawn',\s*TRUE/iu)
    assert.match(entries, /'withdrawal_note_id',\s*withdrawal\.command_note_id/iu)
    assert.match(entries, /'withdrawn_at',\s*withdrawal\.withdrawn_at/iu)
    assert.doesNotMatch(entries, /'body'/iu)

    const withdrawals = view.slice(withdrawalsStart)
    assert.match(withdrawals, /withdrawal\.target_note_id::TEXT AS record_id/iu)
    assert.match(withdrawals, /withdrawal\.target_note_id::BIGINT AS sort_key/iu)
    for (const field of [
      'id', 'status', 'target_note_id', 'withdrawal_note_id',
      'author_id', 'author', 'withdrawn_at',
    ]) assert.match(withdrawals, new RegExp(`'${field}'`, 'u'), field)
    assert.match(withdrawals, /'withdrawal_note_id',\s*withdrawal\.command_note_id/iu)
    assert.match(withdrawals, /JOIN public\.notes target_note ON target_note\.id = withdrawal\.target_note_id/iu)
    assert.match(withdrawals, /JOIN public\.residents author ON author\.id = target_note\.author_id/iu)
    assert.doesNotMatch(withdrawals, /'body'/iu)
  })
}

test('the audited live-detail inventory exactly names fields absent from format v2 events', () => {
  assert.equal(AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS.length, 39)
  assert.deepEqual(
    [...new Set(Object.values(AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS_BY_KIND).flat())].sort(),
    AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS,
  )
  const publicKinds = new Set<string>(PUBLIC_EVENT_KINDS)
  assert.deepEqual(
    Object.keys(AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS_BY_KIND)
      .filter(kind => !publicKinds.has(kind)),
    [],
  )
  const effectiveV2Fields = new Set(EFFECTIVE_V2_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS)
  assert.deepEqual(
    AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS.filter(field => effectiveV2Fields.has(field)),
    [],
    'a field exported by effective format v2 must not remain in the omission disclosure',
  )
  const omittedFields = new Set<string>(AUDITED_OMITTED_LIVE_EVENT_DETAIL_FIELDS)
  for (const required of [
    'reason', 'gazette_submission_room_opened', 'gazette_withdrawals_opened',
    'attempt_id', 'moderated', 'moderation',
  ]) assert.ok(omittedFields.has(required), required)
})

test('every source-written event-detail field has an export or disclosure disposition', async () => {
  const sources = await readRepositoryEventWriterSources(new URL('../', import.meta.url))
  const sourceWriterCount = sources.reduce((count, source) => (
    count + [...source.source.matchAll(
      /\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)(?=\s|\()/giu,
    )].length
  ), 0)
  const scan = scanEventDetailWriters(sources)
  assert.equal(scan.writerCount, sourceWriterCount, 'every event INSERT must be parsed')
  assert.ok(scan.writerCount >= 46, `the source scan must find real writers, saw ${scan.writerCount}`)

  assertEveryEventDetailFieldClassified(scan.fields, [
    ...EFFECTIVE_V2_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS,
    ...PUBLIC_SNAPSHOT_DELIBERATELY_OMITTED_LIVE_DETAIL_FIELDS.events,
  ])
})

for (const [name, url, viewName] of [
  ['event-detail migration', eventDetailMigrationUrl, 'public_records_without_drawing_contract'],
  ['fresh schema', schemaUrl, 'public_records'],
] as const) {
  test(`${name} exports every approved live scalar needed to audit action effects`, async () => {
    const sql = await readFile(url, 'utf8')
    const viewStart = sql.search(new RegExp(
      `CREATE OR REPLACE VIEW city_snapshot\\.${viewName}\\b`,
      'iu',
    ))
    assert.ok(viewStart >= 0, `${name}: snapshot base view`)
    const view = sql.slice(viewStart)
    const eventsStart = view.indexOf("SELECT 'events'")
    const moderationStart = view.indexOf("SELECT 'moderation'", eventsStart)
    assert.ok(eventsStart >= 0 && moderationStart > eventsStart, `${name}: events projection`)
    const eventProjection = view.slice(eventsStart, moderationStart)
    const fields = [...eventProjection.matchAll(
      /'([a-z_]+)',\s*event\.detail->'\1'/gu,
    )].map(match => match[1]!).sort()
    assert.deepEqual(fields, CURRENT_PUBLIC_SNAPSHOT_EVENT_DETAIL_FIELDS)
  })
}
