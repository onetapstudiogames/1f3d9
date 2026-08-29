import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'

import { splitSqlStatements } from '../scripts/migrate.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const schema = read('../db/schema.sql')
const migrationUrl = new URL('../db/migrations/20260827_gazette.sql', import.meta.url)
const migration = existsSync(migrationUrl) ? read('../db/migrations/20260827_gazette.sql') : ''
const activationUrl = new URL(
  '../db/migrations/20260827_gazette_room_activation.sql',
  import.meta.url,
)
const activation = existsSync(activationUrl)
  ? read('../db/migrations/20260827_gazette_room_activation.sql')
  : ''

function tableBody(ddl: string, table: string): string {
  return new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`, 'u')
    .exec(ddl)?.[1] ?? ''
}

test('fresh and upgraded databases carry the same immutable weekly issue ledger', () => {
  assert.equal(existsSync(migrationUrl), true, 'add the additive Gazette migration')
  for (const ddl of [schema, migration]) {
    const table = tableBody(ddl, 'gazette_issues')
    assert.match(table, /issue_number\s+INTEGER\s+PRIMARY\s+KEY/iu)
    assert.match(table, /scheduled_for\s+TIMESTAMPTZ\s+NOT\s+NULL\s+UNIQUE/iu)
    assert.match(table, /printed_at\s+TIMESTAMPTZ\s+NOT\s+NULL/iu)
    assert.match(table, /header\s+TEXT\s+NOT\s+NULL/iu)
    assert.match(table, /entry_count\s+INTEGER\s+NOT\s+NULL/iu)
    assert.match(table, /event_id\s+BIGINT\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+events\(id\)/iu)
    assert.match(
      table,
      /scheduled_for\s*=\s*TIMESTAMPTZ\s*'2026-08-31 16:00:00\+00'[\s\S]*issue_number\s*-\s*1[\s\S]*interval\s*'7 days'/iu,
      'the database must reject an issue number assigned to the wrong weekly tick',
    )
    assert.match(ddl, /CREATE TRIGGER gazette_issues_append_only[\s\S]*ON gazette_issues/iu)
  }
})

test('issue entries permanently consume note membership without copying or deleting speech', () => {
  for (const ddl of [schema, migration]) {
    const entries = tableBody(ddl, 'gazette_issue_entries')
    assert.match(
      entries,
      /issue_number\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+gazette_issues\(issue_number\)\s+ON\s+DELETE\s+RESTRICT/iu,
    )
    assert.match(entries, /ordinal\s+INTEGER\s+NOT\s+NULL[\s\S]*CHECK\s*\(ordinal\s*>\s*0\)/iu)
    assert.match(
      entries,
      /note_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+notes\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
    )
    assert.match(entries, /PRIMARY\s+KEY\s*\(issue_number,\s*ordinal\)/iu)
    assert.doesNotMatch(entries, /\b(?:body|author_handle|created_at)\b/iu)
    assert.match(ddl, /CREATE TRIGGER gazette_issue_entries_append_only[\s\S]*ON gazette_issue_entries/iu)
    assert.match(
      ddl,
      /CREATE CONSTRAINT TRIGGER gazette_issue_entries_membership_complete\s+AFTER INSERT ON gazette_issue_entries\s+DEFERRABLE INITIALLY DEFERRED[\s\S]*verify_gazette_issue_membership/iu,
      'a later entry insert must recheck the permanently stored issue count and order',
    )
    assert.match(
      ddl,
      /SELECT issue\.entry_count[\s\S]*FROM gazette_issues issue[\s\S]*issue\.issue_number = NEW\.issue_number/iu,
      'membership validation must read the parent issue instead of trusting the trigger row shape',
    )
  }

  const noteTable = tableBody(schema, 'notes')
  assert.match(noteTable, /created_at\s+TIMESTAMPTZ\s+NOT\s+NULL/iu)
  assert.match(schema, /CREATE TRIGGER notes_append_only BEFORE UPDATE OR DELETE ON notes/iu)
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE)\s+(?:FROM\s+)?notes\b/iu)
})

test('schema installation stays dormant and a separate activation opens only the verified room shell', () => {
  assert.equal(existsSync(activationUrl), true, 'add the post-deploy Gazette room activation')
  const uncommented = migration.replace(/^\s*--.*$/gmu, '')
  assert.match(migration, /^BEGIN;/u)
  assert.match(migration, /COMMIT;\s*$/u)
  assert.doesNotMatch(uncommented, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/imu)
  assert.ok(splitSqlStatements(migration).length >= 3)
  assert.doesNotMatch(migration, /UPDATE\s+places\s+SET/iu)
  assert.doesNotMatch(
    migration,
    /INSERT\s+INTO\s+events[\s\S]*gazette_submission_room_opened/iu,
    'the dormant schema may recognize the activation record but must not create it',
  )

  const activationSql = activation.replace(/^\s*--.*$/gmu, '')
  assert.match(activation, /^BEGIN;/u)
  assert.match(activation, /COMMIT;\s*$/u)
  assert.doesNotMatch(activationSql, /^\s*(?:DROP\s+TABLE|DELETE|TRUNCATE)\b/imu)
  assert.ok(splitSqlStatements(activation).length >= 3)
  assert.match(activation, /to_regclass\('public\.gazette_issues'\)/iu)
  assert.match(activation, /to_regclass\('public\.gazette_issue_entries'\)/iu)
  assert.match(activation, /to_regprocedure\('public\.gazette_submission_room_state\(places\)'\)/iu)
  assert.match(activation, /NOT gazette_submission_room_guards_ready\(\)/iu)
  assert.match(activation, /FROM\s+places[\s\S]*WHERE\s+id\s*=\s*454[\s\S]*FOR\s+UPDATE/iu)
  assert.match(
    activation,
    /kind\s*=\s*'place_edited'[\s\S]*actor\s*=\s*'the city'[\s\S]*detail\s*=\s*'\{"place_id":454,"gazette_submission_room_opened":true\}'::jsonb/iu,
  )

  const roomUpdate = /UPDATE\s+places\s+SET([\s\S]*?)WHERE([\s\S]*?);/iu.exec(activation)
  if (!roomUpdate) assert.fail('open the existing live Gazette room only in the activation')
  const changed = roomUpdate[1]!
  const guarded = roomUpdate[2]!
  assert.match(changed, /open_to_notes\s*=\s*TRUE/iu)
  assert.match(changed, /description\s*=/iu)
  assert.match(changed, /purpose\s*=/iu)
  assert.doesNotMatch(changed, /open_to_(?:building|things)\s*=/iu)
  assert.match(guarded, /id\s*=\s*454/iu)
  assert.match(guarded, /gazette_submission_room_state\(places\)\s*=\s*'closed'/iu)
  assert.match(activation, /GET DIAGNOSTICS[\s\S]*ROW_COUNT/iu)
  assert.match(activation, /RAISE EXCEPTION[\s\S]*Gazette room/iu)
  assert.match(
    activation,
    /IF EXISTS\s*\(\s*SELECT 1\s+FROM notes\s+WHERE place_id = 454\s*\)[\s\S]*RAISE EXCEPTION/iu,
    'pre-feature notes must stop activation before the room changes',
  )
  assert.match(activation, /gazette_submission_room_opened/iu)
})

test('fresh and upgraded databases reject Gazette notes until one canonical activation exists', () => {
  for (const ddl of [schema, migration]) {
    assert.match(ddl, /CREATE OR REPLACE FUNCTION gazette_submission_room_is_open\(\)/iu)
    assert.match(
      ddl,
      /gazette_submission_room_is_open\(\)[\s\S]*gazette_submission_room_state\(place\)\s*=\s*'open'[\s\S]*kind\s*=\s*'place_edited'[\s\S]*actor\s*=\s*'the city'[\s\S]*gazette_submission_room_opened/iu,
    )
    assert.match(ddl, /CREATE OR REPLACE FUNCTION enforce_gazette_submission_limit\(\)/iu)
    assert.match(ddl, /gazette_submission_room_closed/iu)
    assert.match(
      ddl,
      /Gazette submission room #454 is not open; read GET \/api\/gazette and submit only when submission_room\.submissions_open is true/u,
    )
    assert.match(ddl, /IF\s+NOT\s+gazette_submission_room_is_open\(\)/iu)
    assert.match(
      ddl,
      /NEW\.created_at\s*:=\s*clock_timestamp\(\)/iu,
      'the database clock must own every Gazette submission time',
    )
  }
})

test('the database owns the Gazette room lifecycle across every place write path', () => {
  for (const ddl of [schema, migration]) {
    assert.match(
      ddl,
      /CREATE OR REPLACE FUNCTION gazette_submission_room_state\(candidate places\)/iu,
    )
    for (const requiredShape of [
      /candidate\.id\s*=\s*454/iu,
      /candidate\.parent_id\s*=\s*2/iu,
      /candidate\.place_kind\s*=\s*'place'/iu,
      /candidate\.owner_id\s*=\s*1/iu,
      /candidate\.name\s*=\s*'the gazette submission room'/iu,
      /cardinality\(candidate\.front_matter_thing_ids\)\s*=\s*0/iu,
      /candidate\.active_offer_id\s+IS\s+NULL/iu,
      /candidate\.open_to_building\s*=\s*FALSE/iu,
      /candidate\.open_to_things\s*=\s*FALSE/iu,
      /The Gazette submission room is being prepared\./u,
      /Leave a note here for The Gazette\./u,
      /Residents may submit up to three notes per Gazette week/u,
    ]) assert.match(ddl, requiredShape)

    assert.match(
      ddl,
      /CREATE TRIGGER gazette_submission_room_lifecycle\s+BEFORE INSERT OR UPDATE OR DELETE ON places[\s\S]*protect_gazette_submission_room/iu,
    )
    assert.match(ddl, /NEW IS NOT DISTINCT FROM OLD/iu)
    assert.match(
      ddl,
      /gazette_submission_room_state\(OLD\)\s*=\s*'closed'[\s\S]*gazette_submission_room_state\(NEW\)\s*=\s*'open'/iu,
    )
    assert.match(
      ddl,
      /gazette_submission_room_opened[\s\S]*gazette_submission_room_state/iu,
      'the one activation event must authorize the only mutable room transition',
    )
    assert.match(
      ddl,
      /gazette_submission_room_is_open\(\)[\s\S]*gazette_submission_room_state\(place\)\s*=\s*'open'/iu,
      'the public gate must prove the complete verified-open row, not one permission bit',
    )
  }

  const eventPosition = activation.indexOf('INSERT INTO events')
  const updatePosition = activation.indexOf('UPDATE places SET')
  assert.ok(eventPosition >= 0 && updatePosition >= 0 && eventPosition < updatePosition,
    'the canonical event must authorize the row transition in the same atomic activation')
})

test('the protected Gazette room cannot carry laws, child places, or things', () => {
  for (const ddl of [schema, migration]) {
    assert.match(
      ddl,
      /CREATE OR REPLACE FUNCTION gazette_submission_room_has_no_forbidden_contents\(\)/iu,
    )
    for (const table of ['place_law_changes', 'places', 'things']) {
      assert.match(
        ddl,
        new RegExp(
          `CREATE TRIGGER gazette_submission_room_reject_[a-z_]+[\\s\\S]*ON ${table}[\\s\\S]*protect_gazette_submission_room_dependents`,
          'iu',
        ),
        table,
      )
    }
    for (const constraint of [
      'gazette_submission_room_laws',
      'gazette_submission_room_children',
      'gazette_submission_room_things',
    ]) assert.match(ddl, new RegExp(constraint, 'u'))
    assert.match(
      ddl,
      /gazette_submission_room_is_open\(\)[\s\S]*gazette_submission_room_has_no_forbidden_contents\(\)[\s\S]*gazette_submission_room_guards_ready\(\)/iu,
      'the live submission gate must fail closed over dependent state and disabled guards',
    )
  }

  assert.match(
    activation,
    /gazette_submission_room_has_no_forbidden_contents\(\)[\s\S]*Gazette room #454 cannot open while it has local laws, child places, or things/iu,
  )
  assert.match(activation, /gazette_submission_room_guards_ready\(\)/iu)

  for (const [name, ddl] of [
    ['fresh schema', schema],
    ['dormant migration', migration],
  ] as const) {
    assert.doesNotMatch(
      ddl,
      /trigger\.tgenabled\s*<>\s*'D'/iu,
      `${name}: replica-only triggers are not active for normal city writes`,
    )
    assert.match(
      ddl,
      /trigger\.tgenabled\s+IN\s*\(\s*'O'\s*,\s*'A'\s*\)/iu,
      `${name}: only origin or always triggers count as ready`,
    )
    assert.match(
      ddl,
      /\('notes'\s*,\s*'gazette_note_submission_limit'\)/iu,
      `${name}: weekly submission enforcement is part of live readiness`,
    )
  }
  assert.doesNotMatch(
    activation,
    /trigger\.tgenabled/iu,
    'activation must use the shared readiness predicate instead of remaking trigger rules',
  )
})

test('the note quota guard exists before either SQL path validates room readiness', () => {
  for (const [label, ddl] of [
    ['fresh schema', schema],
    ['dormant migration', migration],
  ] as const) {
    const triggerOffset = ddl.indexOf('CREATE TRIGGER gazette_note_submission_limit')
    const validationOffset = ddl.indexOf(
      "RAISE EXCEPTION 'Gazette room #454 is not the verified closed shell or verified-open room",
    )

    assert.ok(triggerOffset >= 0, `${label} must install the note quota trigger`)
    assert.ok(validationOffset >= 0, `${label} must validate the existing room state`)
    assert.ok(
      triggerOffset < validationOffset,
      `${label} must install the note quota trigger before validating guard readiness`,
    )
  }
})
