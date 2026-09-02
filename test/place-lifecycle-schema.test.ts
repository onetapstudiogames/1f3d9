import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { prepareMigrationExecution, resolveMigrationRun } from '../scripts/migrate.ts'

const migrationFile = 'db/migrations/20260901_place_lifecycle.sql' as const
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function lifecycleOperations(ddl: string): void {
  for (const operation of ['place_rename', 'place_retire', 'place_restore']) {
    assert.match(ddl, new RegExp(`['"]${operation}['"]`, 'u'), operation)
  }
}

test('place lifecycle migration preserves founding names and append-only name spans', () => {
  const migration = read(`../${migrationFile}`)

  assert.match(migration, /^BEGIN;\s*$/mu)
  assert.match(migration, /COMMIT;\s*$/u)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS founding_name TEXT/iu)
  assert.match(migration, /ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ/iu)
  assert.match(migration, /UPDATE places[\s\S]*SET founding_name = name[\s\S]*WHERE founding_name IS NULL/iu)
  assert.match(
    migration,
    /DISABLE TRIGGER gazette_submission_room_lifecycle[\s\S]*UPDATE places SET founding_name = name[\s\S]*ENABLE (?:ALWAYS )?TRIGGER gazette_submission_room_lifecycle/iu,
  )
  assert.match(migration, /gazette_submission_room_has_no_forbidden_contents\(\)/u)
  assert.match(migration, /gazette_submission_room_guards_ready\(\)/u)
  assert.match(migration, /room_state = 'withdrawals_open'[\s\S]*withdrawal_events = 1/u)
  assert.match(migration, /ALTER COLUMN founding_name SET NOT NULL/iu)
  assert.match(migration, /founding name is immutable/iu)

  assert.match(migration, /CREATE TABLE IF NOT EXISTS place_name_history/iu)
  assert.match(migration, /place_id\s+INTEGER NOT NULL REFERENCES places\(id\) ON DELETE CASCADE/iu)
  assert.match(migration, /event_id\s+BIGINT(?:\s+UNIQUE)?\s+REFERENCES events\(id\) ON DELETE RESTRICT/iu)
  assert.match(migration, /INSERT INTO place_name_history\s*\(place_id, name, started_at, event_id\)[\s\S]*SELECT place\.id, place\.name, place\.created_at, NULL/iu)
  assert.match(migration, /CREATE (?:OR REPLACE )?VIEW place_name_spans[\s\S]*lead\(started_at\)[\s\S]*PARTITION BY place_id/iu)
  assert.match(migration, /place_name_history_append_only[\s\S]*BEFORE UPDATE OR DELETE/iu)
  assert.match(migration, /place_name_history_no_truncate[\s\S]*BEFORE TRUNCATE/iu)
  assert.match(migration, /IF TG_OP = 'DELETE'[\s\S]*NOT EXISTS \([\s\S]*FROM places[\s\S]*OLD\.place_id/iu)
  assert.doesNotMatch(migration, /CREATE INDEX IF NOT EXISTS place_name_history_name_search/iu)
  assert.match(migration, /CREATE OR REPLACE VIEW city_snapshot\.public_records_without_drawing_contract/iu)
  assert.match(migration, /place_renamed[\s\S]*place_retired[\s\S]*place_restored/iu)
  assert.match(migration, /public_records_v2_without_place_lifecycle/iu)
  assert.match(migration, /'founding_name', CASE WHEN place_hidden\.action = 'remove'[\s\S]*place\.founding_name END/iu)
  assert.match(migration, /'status', CASE WHEN place\.retired_at IS NULL THEN 'active' ELSE 'retired' END/iu)
  assert.match(migration, /'name_history'[\s\S]*FROM place_name_spans/iu)
  assert.match(migration, /place_hidden\.action = 'remove'[\s\S]*\[removed by maintainer\]/iu)
  assert.match(migration, /event_place_hidden\.action = 'remove'[\s\S]*former_name/iu)
  for (const trigger of [
    'places_reject_retired_parent', 'things_reject_retired_place',
    'notes_reject_retired_place', 'resident_presence_reject_retired_place',
  ]) assert.match(migration, new RegExp(`CREATE TRIGGER ${trigger}`, 'u'))
  assert.match(migration, /FROM places\s+WHERE parent_id IS NOT NULL AND retired_at IS NULL/iu)
  assert.match(migration, /UPDATE OF parent_id, description, purpose, retired_at ON places/iu)
  assert.match(migration, /places_reject_retired_parent[\s\S]*UPDATE OF parent_id, retired_at ON places/iu)
  assert.match(migration, /OLD\.retired_at IS NULL[\s\S]*NEW\.retired_at IS NULL/iu)
})

test('every lifecycle contract states the protected-place refusal before use', () => {
  for (const path of [
    '../src/frontdoor.txt',
    '../src/llms.txt',
    '../src/door.ts',
    '../src/mcp.ts',
    '../docs/published/FRONTDOOR.md',
    '../docs/SYSTEM_DESIGN.md',
  ]) {
    assert.match(
      read(path),
      /protected\s+places? cannot be renamed, retired, or restored/iu,
      path,
    )
  }

  const operation = read('../src/place-lifecycle-operation.ts')
  assert.match(
    operation,
    /WHEN state\.protected_city_service[\s\S]*WHEN state\.owner_id IS NULL/iu,
  )
})

test('fresh schema has the same lifecycle and exact-credit constraints', () => {
  const schema = read('../db/schema.sql')

  assert.match(schema, /founding_name\s+TEXT/iu)
  assert.match(schema, /retired_at\s+TIMESTAMPTZ/iu)
  assert.match(schema, /CREATE TABLE IF NOT EXISTS place_name_history/iu)
  assert.match(schema, /CREATE (?:OR REPLACE )?VIEW place_name_spans/iu)
  assert.match(schema, /'name_history'[\s\S]*FROM place_name_spans/iu)
  assert.match(schema, /place_hidden\.action = 'remove'[\s\S]*\[removed by maintainer\]/iu)
  assert.match(schema, /event_place_hidden\.action = 'remove'[\s\S]*former_name/iu)
  lifecycleOperations(schema)
  assert.match(schema, /operation IN \([\s\S]*place_rename[\s\S]*place_retire[\s\S]*place_restore/iu)
  assert.match(schema, /method IS DISTINCT FROM 'credit' OR \([\s\S]*amount_units = 1000000/iu)
  assert.match(schema, /operation IN \('place_rename', 'place_retire', 'place_restore'\)[\s\S]*asset_type = 'place'[\s\S]*asset_id IS NOT NULL/iu)
})

test('migration widens credit validation without removing PayPal dispute branches', () => {
  const migration = read(`../${migrationFile}`)

  lifecycleOperations(migration)
  assert.match(migration, /ADD CONSTRAINT payment_attempts_operation_check CHECK/iu)
  assert.match(migration, /ADD CONSTRAINT payment_attempts_credit_facts CHECK/iu)
  assert.match(migration, /amount_units = 1000000/iu)
  assert.match(migration, /operation IN \('place_rename', 'place_retire', 'place_restore'\)[\s\S]*asset_type = 'place'[\s\S]*asset_id IS NOT NULL/iu)
  assert.match(migration, /CREATE OR REPLACE FUNCTION validate_city_credit_entry/iu)
  assert.match(migration, /paypal_dispute_reviewed/iu)
  assert.match(migration, /paypal_dispute_created[\s\S]*paypal_dispute_updated[\s\S]*paypal_dispute_resolved/iu)
})

test('place lifecycle migration is explicitly selectable for preview and production', () => {
  const migration = read(`../${migrationFile}`)
  assert.equal(prepareMigrationExecution(migrationFile, migration).mode, 'transactional')

  const baseEnvironment = {
    NEON_API_KEY: 'test-neon-key',
    NEON_PROJECT_ID: 'test-project',
    NEON_PRODUCTION_BRANCH_ID: 'production-branch',
  }
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'place-lifecycle'],
    {
      ...baseEnvironment,
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_PREVIEW_BRANCH_ID: 'preview-branch',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, migrationFile)

  const packageJson = JSON.parse(read('../package.json')) as { scripts: Record<string, string> }
  assert.match(packageJson.scripts['migrate:preview:place-lifecycle'] ?? '', /--migration place-lifecycle$/u)
  assert.match(packageJson.scripts['migrate:production:place-lifecycle'] ?? '', /--migration place-lifecycle$/u)

  const runbook = read('../docs/runbooks/ENVIRONMENT.md')
  assert.match(runbook, /place lifecycle migration is a pre-deploy prerequisite/iu)
  assert.match(
    runbook,
    /migrate:preview:place-lifecycle[\s\S]*migrate:preview:public-search-indexes/iu,
  )
  assert.match(
    runbook,
    /migrate:production:place-lifecycle[\s\S]*migrate:production:public-search-indexes/iu,
  )
})
