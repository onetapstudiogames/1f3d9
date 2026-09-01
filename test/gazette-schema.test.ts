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
const withdrawalMigrationUrl = new URL(
  '../db/migrations/20260901_gazette_withdrawal.sql',
  import.meta.url,
)
const withdrawalMigration = existsSync(withdrawalMigrationUrl)
  ? read('../db/migrations/20260901_gazette_withdrawal.sql')
  : ''
const withdrawalActivationUrl = new URL(
  '../db/migrations/20260901_gazette_withdrawal_activation.sql',
  import.meta.url,
)
const withdrawalActivation = existsSync(withdrawalActivationUrl)
  ? read('../db/migrations/20260901_gazette_withdrawal_activation.sql')
  : ''

function tableBody(ddl: string, table: string): string {
  return new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`, 'u')
    .exec(ddl)?.[1] ?? ''
}

function functionBody(ddl: string, name: string): string {
  return new RegExp(
    `CREATE OR REPLACE FUNCTION ${name}\\([^)]*\\)[\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
    'u',
  ).exec(ddl)?.[1] ?? ''
}

function normalizedFunctionBody(ddl: string, name: string): string {
  return functionBody(ddl, name)
    .replace(/^\s*--.*$/gmu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

test('the withdrawal migration installs the fresh-schema room lifecycle guard', () => {
  const migrationGuard = normalizedFunctionBody(
    withdrawalMigration,
    'protect_gazette_submission_room',
  )
  const schemaGuard = normalizedFunctionBody(schema, 'protect_gazette_submission_room')
  assert.notEqual(migrationGuard, '', 'the production migration must replace the lifecycle guard')
  assert.notEqual(schemaGuard, '', 'the fresh schema must define the lifecycle guard')
  assert.equal(
    migrationGuard,
    schemaGuard,
    'every production CREATE OR REPLACE must preserve the complete fresh-schema guard',
  )
})

test('fresh and upgraded databases carry one append-only author withdrawal relation', () => {
  assert.equal(existsSync(withdrawalMigrationUrl), true, 'add the dormant withdrawal migration')
  for (const ddl of [schema, withdrawalMigration]) {
    const table = tableBody(ddl, 'gazette_withdrawals')
    assert.match(
      table,
      /target_note_id\s+INTEGER\s+PRIMARY\s+KEY\s+REFERENCES\s+notes\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
    )
    assert.match(
      table,
      /command_note_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+notes\(id\)\s+ON\s+DELETE\s+RESTRICT/iu,
    )
    assert.match(table, /withdrawn_at\s+TIMESTAMPTZ\s+NOT\s+NULL/iu)
    assert.match(table, /CHECK\s*\(target_note_id\s*<>\s*command_note_id\)/iu)
    assert.match(
      ddl,
      /CREATE TRIGGER gazette_withdrawals_append_only[\s\S]*ON gazette_withdrawals/iu,
    )
    assert.match(
      ddl,
      /CREATE TRIGGER gazette_withdrawals_no_truncate\s+BEFORE TRUNCATE ON gazette_withdrawals\s+FOR EACH STATEMENT/iu,
    )
    assert.match(
      ddl,
      /\('gazette_withdrawals',\s*'gazette_withdrawals_no_truncate'\)/iu,
      'the live gate must require the statement-level truncate denial',
    )
    assert.match(
      ddl,
      /\('gazette_issue_entries',\s*'gazette_issue_entry_source'\)/iu,
      'withdrawal activation must require the database command-exclusion guard',
    )
    assert.match(
      ddl,
      /CREATE TRIGGER gazette_issues_no_truncate\s+BEFORE TRUNCATE ON gazette_issues\s+FOR EACH STATEMENT/iu,
    )
    assert.match(
      ddl,
      /CREATE TRIGGER gazette_issue_entries_no_truncate\s+BEFORE TRUNCATE ON gazette_issue_entries\s+FOR EACH STATEMENT/iu,
    )
    assert.match(ddl, /\('gazette_issues',\s*'gazette_issues_no_truncate'\)/iu)
    assert.match(
      ddl,
      /\('gazette_issue_entries',\s*'gazette_issue_entries_no_truncate'\)/iu,
    )
    const finalRoomValidation = ddl.lastIndexOf(
      'IF gazette_submission_room_has_no_forbidden_contents()',
    )
    assert.ok(finalRoomValidation > 0, 'the installed contract must validate room state')
    for (const trigger of [
      'CREATE TRIGGER gazette_issue_entry_source',
      'CREATE TRIGGER gazette_issues_no_truncate',
      'CREATE TRIGGER gazette_issue_entries_no_truncate',
    ]) {
      assert.ok(
        ddl.lastIndexOf(trigger) < finalRoomValidation,
        `${trigger} must exist before the final room-state validation`,
      )
    }
    assert.match(
      ddl,
      /CREATE TRIGGER gazette_note_record_withdrawal\s+AFTER INSERT ON notes[\s\S]*record_gazette_withdrawal/iu,
    )
  }
})

test('the database alone enforces exact author-only pre-tick withdrawal semantics', () => {
  for (const ddl of [schema, withdrawalMigration]) {
    assert.match(ddl, /\^WITHDRAW #\[1-9\]\[0-9\]\*\$/u)
    assert.match(
      ddl,
      /\^WITHDRAW\[\[:space:\]\]\*#/u,
      'only WITHDRAW followed by optional whitespace and # is reserved',
    )
    assert.doesNotMatch(
      ddl,
      /\^WITHDRAW\(\[\[:space:\]\]\|#\|\$\)/u,
      'bare WITHDRAW prose must remain an ordinary printable submission',
    )
    assert.match(ddl, /gazette_withdrawals_are_open\(\)/iu)
    assert.match(ddl, /gazette_withdrawal_command_invalid/iu)
    assert.match(ddl, /gazette_withdrawals_closed/iu)
    assert.match(ddl, /gazette_withdrawal_no_such_submission/iu)
    assert.match(ddl, /gazette_withdrawal_author_mismatch/iu)
    assert.match(ddl, /gazette_withdrawal_already_printed/iu)
    assert.match(ddl, /gazette_withdrawal_tick_passed/iu)
    assert.match(ddl, /gazette_withdrawal_already_withdrawn/iu)
    assert.match(
      ddl,
      /target_author_id\s*<>\s*command_author_id/iu,
      'founder status must not create an administrative override',
    )
    assert.match(ddl, /NEW\.created_at\s*:=\s*clock_timestamp\(\)/iu)
    assert.match(
      ddl,
      /print_tick\s*:=\s*gazette_cycle_start\(target_created_at\)\s*\+\s*interval\s*'7 days'/iu,
      'withdrawal must reuse the target submission cycle and PostgreSQL clock',
    )
    assert.match(
      ddl,
      /pg_advisory_xact_lock\([^;]*524128261[^;]*454/iu,
      'withdrawal and printing must use the one Gazette lock',
    )
    assert.match(
      ddl,
      /count\(\*\)[\s\S]*NOT EXISTS\s*\([\s\S]*command_note_id\s*=\s*existing\.id/iu,
      'withdrawal commands use no weekly slot while the target remains counted',
    )
  }
})

test('room-note interception begins only at the canonical withdrawal activation', () => {
  for (const [label, ddl] of [
    ['fresh schema', schema],
    ['dormant migration', withdrawalMigration],
  ] as const) {
    const submissionGuard = functionBody(ddl, 'enforce_gazette_submission_limit')
    assert.match(
      submissionGuard,
      /IF\s+gazette_withdrawals_are_open\(\)\s+AND\s+gazette_withdrawal_command_reserved\(NEW\.body\)\s+THEN/iu,
      `${label}: the BEFORE trigger must not recognize commands while withdrawals are closed`,
    )
    assert.doesNotMatch(
      submissionGuard,
      /gazette_withdrawals_closed/iu,
      `${label}: a dormant room note is never refused as a withdrawal command`,
    )

    const recorder = functionBody(ddl, 'record_gazette_withdrawal')
    const commandParseOffset = recorder.indexOf('gazette_withdrawal_target(NEW.body)')
    assert.ok(commandParseOffset >= 0, `${label}: the AFTER trigger must retain exact command parsing`)
    assert.match(
      recorder.slice(0, commandParseOffset),
      /IF\s+NOT\s+gazette_withdrawals_are_open\(\)\s+THEN\s+RETURN NEW;\s+END IF;/iu,
      `${label}: the AFTER trigger must return before parsing while withdrawals are closed`,
    )
  }
})

test('dormant installation and activation never reinterpret room-note history', () => {
  for (const [label, ddl] of [
    ['dormant migration', withdrawalMigration],
    ['withdrawal activation', withdrawalActivation],
  ] as const) {
    assert.doesNotMatch(
      ddl,
      /WHERE\s+note\.place_id\s*=\s*454\s+AND\s+gazette_withdrawal_command_reserved\(note\.body\)/iu,
      `${label}: notes accepted before activation stay ordinary and cannot block rollout`,
    )
  }
})

test('only ledger membership makes a note a command and self-targets stay caller-safe', () => {
  for (const [label, ddl] of [
    ['fresh schema', schema],
    ['dormant migration', withdrawalMigration],
  ] as const) {
    const validation = functionBody(ddl, 'validate_gazette_withdrawal')
    assert.doesNotMatch(
      validation,
      /gazette_withdrawal_target\(target_body\)/iu,
      `${label}: a dormant exact-shaped submission is not retroactively a command`,
    )
    assert.match(
      validation,
      /FROM\s+gazette_withdrawals\s+withdrawal\s+WHERE\s+withdrawal\.command_note_id\s*=\s*NEW\.target_note_id/iu,
      `${label}: committed ledger membership is the command-note identity`,
    )
    assert.match(
      validation,
      /NEW\.target_note_id\s*(?:=\s*NEW\.command_note_id|IS\s+NOT\s+DISTINCT\s+FROM\s+NEW\.command_note_id)[\s\S]*gazette_withdrawal_no_such_submission/iu,
      `${label}: a predicted self-target must receive the caller-safe no-such refusal`,
    )
    assert.match(
      validation,
      /pg_trigger_depth\(\)\s*<>\s*2[\s\S]*gazette_withdrawal_command_not_note_insert/iu,
      `${label}: the ledger must be created only by the newly inserted command note`,
    )
    assert.doesNotMatch(
      validation,
      /command_created_at\s*[<>]=?\s*withdrawals_opened_at/iu,
      `${label}: activation provenance must not depend on wall-clock ordering`,
    )
  }
})

test('withdrawal activation has one exact city provenance and precedes the room transition', () => {
  assert.match(
    withdrawalActivation,
    /WHERE\s+kind\s*=\s*'place_edited'\s+AND\s+actor\s*=\s*'the city'\s+AND\s+detail\s*=\s*'\{"place_id":454,"gazette_withdrawals_opened":true\}'::jsonb/iu,
  )
  assert.match(
    withdrawalActivation,
    /IF\s+gazette_withdrawals_are_open\(\)\s+AND\s+activation_events\s*=\s*1\s+THEN\s+RETURN;/iu,
    'an exact completed activation is the only replay-safe early return',
  )
  assert.match(
    withdrawalActivation,
    /IF\s+activation_events\s*<>\s*0\s+THEN[\s\S]*activation record is not the one verified state/iu,
    'an orphaned or forged exact-looking event must block rather than bless activation',
  )
  const lockOffset = withdrawalActivation.indexOf('pg_advisory_xact_lock(524128261, 454)')
  const stateCheckOffset = withdrawalActivation.indexOf('gazette_withdrawals_are_open()')
  const eventOffset = withdrawalActivation.indexOf('INSERT INTO events')
  const roomOffset = withdrawalActivation.indexOf('UPDATE places SET')
  assert.ok(lockOffset >= 0, 'activation must share the one Gazette transaction lock')
  assert.ok(stateCheckOffset > lockOffset, 'activation state is decided only while holding that lock')
  assert.ok(eventOffset >= 0, 'activation must create its exact provenance event')
  assert.ok(roomOffset > eventOffset, 'the lifecycle trigger must see provenance before room activation')

  for (const [label, ddl] of [
    ['fresh schema', schema],
    ['dormant migration', withdrawalMigration],
  ] as const) {
    assert.match(
      functionBody(ddl, 'gazette_withdrawals_are_open'),
      /event\.kind\s*=\s*'place_edited'[\s\S]*event\.actor\s*=\s*'the city'[\s\S]*event\.detail\s*=\s*'\{"place_id":454,"gazette_withdrawals_opened":true\}'::jsonb[\s\S]*\)\s*=\s*1/iu,
      `${label}: the canonical gate requires exactly one exact city activation event`,
    )
  }
})

test('withdrawal rollout is dormant before an exact post-deploy contract activation', () => {
  assert.equal(existsSync(withdrawalActivationUrl), true, 'add withdrawal activation migration')
  const dormantSql = withdrawalMigration.replace(/^\s*--.*$/gmu, '')
  assert.match(withdrawalMigration, /^BEGIN;/u)
  assert.match(withdrawalMigration, /COMMIT;\s*$/u)
  assert.doesNotMatch(dormantSql, /UPDATE\s+places\s+SET/iu)
  assert.doesNotMatch(
    dormantSql,
    /INSERT\s+INTO\s+events[\s\S]*gazette_withdrawals_opened/iu,
    'the dormant migration may recognize but must not create the activation record',
  )

  assert.match(withdrawalActivation, /^BEGIN;/u)
  assert.match(withdrawalActivation, /COMMIT;\s*$/u)
  assert.match(withdrawalActivation, /to_regclass\('public\.gazette_withdrawals'\)/iu)
  assert.match(withdrawalActivation, /NOT gazette_withdrawal_guards_ready\(\)/iu)
  assert.match(
    withdrawalActivation,
    /kind\s*=\s*'place_edited'[\s\S]*actor\s*=\s*'the city'[\s\S]*gazette_withdrawals_opened/iu,
  )
  assert.match(
    withdrawalActivation,
    /FROM\s+places[\s\S]*WHERE\s+id\s*=\s*454[\s\S]*FOR\s+UPDATE/iu,
  )
  assert.match(withdrawalActivation, /UPDATE\s+places\s+SET[\s\S]*description\s*=[\s\S]*purpose\s*=/iu)
  assert.match(withdrawalActivation, /GET DIAGNOSTICS[\s\S]*ROW_COUNT/iu)
  assert.match(withdrawalActivation, /gazette_withdrawals_are_open\(\)/iu)
})

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
    const validationOffset = ddl.indexOf('DECLARE\n  room_state TEXT;', triggerOffset)

    assert.ok(triggerOffset >= 0, `${label} must install the note quota trigger`)
    assert.ok(validationOffset >= 0, `${label} must validate the existing room state`)
    assert.ok(
      triggerOffset < validationOffset,
      `${label} must install the note quota trigger before validating guard readiness`,
    )
  }
})
