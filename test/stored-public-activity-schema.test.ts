import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { resolveMigrationRun } from '../scripts/migrate.ts'
import { earlierStoredActivityMigration } from './helpers/earlier-stored-activity-migration.ts'

test('stored public activity selects the reviewed additive migration', () => {
  const run = resolveMigrationRun(['--target', 'preview', '--migration', 'stored-public-activity'], {
    CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
    NEON_API_KEY: 'test-key', NEON_PROJECT_ID: 'test-project', NEON_PREVIEW_BRANCH_ID: 'test-preview',
    NEON_PRODUCTION_BRANCH_ID: 'test-production', PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://test@fixture.neon.tech/db',
  })
  assert.equal(run.migrationFile, 'db/migrations/20261028_stored_public_activity.sql')
  assert.equal(run.executionMode, 'transactional')
})

test('migration and full schema carry identical stored activity bodies after prepared guards', () => {
  const migration = readFileSync(new URL('../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
  const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const marker = '-- Stored public activity summaries, decision #166.'
  const functions = [...migration.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/gu)].map(match => match[1])
  assert.equal(functions.length, 16)
  assert.equal(new Set(functions).size, functions.length)
  assert.equal([...migration.matchAll(/^COMMIT;/gmu)].length, 1)
  const showing = readFileSync(new URL('../db/migrations/20261027_showing_room.sql', import.meta.url), 'utf8')
  assert.ok(schema.endsWith(showing), 'the subsequent showing migration is an exact suffix')
  const markerSchema = schema.slice(0, -showing.length)
  assert.equal(markerSchema.slice(markerSchema.indexOf(marker)).trim(), migration.slice(migration.indexOf(marker)).replace(/\nCOMMIT;\s*$/u, '').trim())
  assert.match(migration, /CREATE CONSTRAINT TRIGGER events_stamp_public_activity[\s\S]*DEFERRABLE INITIALLY DEFERRED/u)
  assert.match(migration, /LOCK TABLE events IN SHARE ROW EXCLUSIVE MODE/u)
  assert.ok(migration.indexOf('FUNCTION protect_place_topology') < migration.indexOf('ADD COLUMN IF NOT EXISTS last_public_action_at'))
  assert.ok(migration.indexOf('FUNCTION protect_gazette_submission_room') < migration.indexOf('ADD COLUMN IF NOT EXISTS last_public_action_at'))
  const presenceGuard = /CREATE OR REPLACE FUNCTION reject_retired_place_target\(\)[\s\S]*?END\n\$\$;/u
  assert.equal(migration.match(presenceGuard)?.[0], schema.match(presenceGuard)?.[0])
  assert.ok(migration.indexOf('FUNCTION reject_retired_place_target') < migration.indexOf('ADD COLUMN IF NOT EXISTS last_public_action_at'))
  assert.doesNotMatch(migration, /ALTER TABLE resident_settings ADD COLUMN.*show_activity/u)
})

test('backfill computes history before resident/place locks and writes only the saved summaries', () => {
  const migration = readFileSync(new URL('../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
  const computesFirst = (sql: string) => {
    const computed = sql.indexOf('CREATE TEMP TABLE public_activity_backfill ON COMMIT DROP AS')
    const altered = sql.indexOf('ALTER TABLE residents ADD COLUMN')
    return computed >= 0 && computed < altered
  }
  assert.equal(computesFirst(earlierStoredActivityMigration(migration)), false, 'the earlier migration held locks while computing')
  assert.equal(computesFirst(migration), true)
  const updates = migration.slice(migration.indexOf('-- The expensive work is complete;'), migration.indexOf('REVOKE ALL ON FUNCTION'))
  assert.doesNotMatch(updates, /public_activity_(?:history|summaries|candidates)\(/u)
  assert.match(updates, /UPDATE residents[\s\S]*FROM public_activity_backfill/u)
  assert.match(updates, /UPDATE places[\s\S]*FROM public_activity_backfill/u)
})
