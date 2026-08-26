import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  eventsPresenceIndexRecoveryStatements,
  publicSearchIndexRecoveryStatements,
  prepareMigrationExecution,
  prepareMigrationStatements,
  resolveMigrationRun,
  splitSqlStatements,
} from '../scripts/migrate.ts'

const schemaDdl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
const affordableReadingMigrationFile = 'db/migrations/20260820_affordable_reading_totals.sql' as const
const eventsPresenceIndexMigrationFile = 'db/migrations/20260821_events_presence_index.sql' as const
const publicSearchIndexesMigrationFile = 'db/migrations/20260821_public_search_indexes.sql' as const
const publicChangeMarkersMigrationFile = 'db/migrations/20260821_public_change_markers.sql' as const
const thingMakerMigrationFile = 'db/migrations/20260822_thing_maker.sql' as const
const laterHolderMarksMigrationFile = 'db/migrations/20260822_later_holder_marks.sql' as const
const worldRootDescriptionMigrationFile =
  'db/migrations/20260823_world_root_description.sql' as const
const paymentRecoveryTriggerRepairMigrationFile =
  'db/migrations/20260823_payment_recovery_trigger_repair.sql' as const
const paymentLateFinalityRecheckMigrationFile =
  'db/migrations/20260825_payment_late_finality_recheck.sql' as const

function migrationDdl(file: string): string {
  return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
}

function schemaStatement(table: string): string {
  const statement = splitSqlStatements(schemaDdl).find(candidate =>
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i').test(candidate)
  )
  assert.ok(statement, `missing idempotent ${table} table`)
  return statement
}

test('PL/pgSQL dollar-quoted bodies stay inside one migration statement', () => {
  const ddl = `
    CREATE OR REPLACE FUNCTION keep_history() RETURNS trigger
    LANGUAGE plpgsql AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'history; cannot be deleted';
      END IF;
      RETURN NEW;
    END
    $function$;

    CREATE TABLE audit_log (id integer);
  `

  const statements = splitSqlStatements(ddl)

  assert.equal(statements.length, 2)
  assert.match(statements[0]!, /RAISE EXCEPTION 'history; cannot be deleted';/)
  assert.match(statements[0]!, /END IF;/)
  assert.match(statements[0]!, /\$function\$/)
  assert.equal(statements[1], 'CREATE TABLE audit_log (id integer)')
})

test('schema migration reconnects valid legacy open offers to their asset mutex', () => {
  const statements = splitSqlStatements(schemaDdl)

  for (const [table, type] of [['places', 'place'], ['things', 'thing'], ['kinds', 'kind']] as const) {
    assert.ok(statements.some(statement =>
      new RegExp(`UPDATE\\s+${table}\\b`, 'i').test(statement) &&
      /FROM\s+transfer_offers/i.test(statement) &&
      new RegExp(`asset_type\\s*=\\s*'${type}'`, 'i').test(statement) &&
      /status\s*=\s*'open'/i.test(statement) &&
      /active_offer_id\s+IS\s+NULL/i.test(statement)
    ), `missing legacy ${type} offer backfill`)
  }
})

test('world offers extend direct transfers without weakening their buyer binding', () => {
  const offers = schemaStatement('transfer_offers')

  assert.match(offers, /channel\s+TEXT\s+NOT NULL\s+DEFAULT\s+'direct'/i)
  assert.match(offers, /channel\s+IN\s*\(\s*'direct'\s*,\s*'world'\s*\)/i)
  assert.doesNotMatch(offers, /buyer_id\s+INTEGER\s+NOT NULL/i)
  assert.match(offers, /market_origin\s+TEXT\s+NOT NULL\s+DEFAULT\s+'https:\/\/1f3ea\.com'/i)
  for (const column of ['market_draft_id', 'market_listing_id', 'market_checkout_id']) {
    assert.match(offers, new RegExp(`\\b${column}\\b`, 'i'))
  }
  assert.match(offers, /channel\s*=\s*'direct'[\s\S]*buyer_id\s+IS\s+NOT\s+NULL/i)
  assert.match(offers, /channel\s*=\s*'world'[\s\S]*asset_type\s*=\s*'thing'/i)
  assert.match(schemaDdl, /ALTER\s+TABLE\s+transfer_offers\s+ALTER\s+COLUMN\s+buyer_id\s+DROP\s+NOT\s+NULL/i)
  assert.match(offers, /market_buyer\s+TEXT/i)
  assert.match(schemaDdl, /NEW\.market_buyer\s+IS\s+DISTINCT\s+FROM\s+OLD\.market_buyer/i)
})

test('world market identifiers are unique public bindings, not arbitrary origins', () => {
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+transfer_offers_world_draft[\s\S]*market_draft_id[\s\S]*channel\s*=\s*'world'/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+transfer_offers_world_checkout[\s\S]*market_checkout_id[\s\S]*IS\s+NOT\s+NULL/i,
  )
  assert.match(schemaDdl, /market_origin\s*=\s*'https:\/\/1f3ea\.com'/i)
})

test('offer history trigger rejects claims without an active buyer reservation', () => {
  assert.match(
    schemaDdl,
    /NEW\.status\s*=\s*'claimed'[\s\S]*OLD\.reserved_by\s+IS\s+DISTINCT\s+FROM\s+OLD\.buyer_id[\s\S]*OLD\.reserved_until\s*<=\s*clock_timestamp\(\)/i,
  )
  assert.match(
    schemaDdl,
    /NEW\.status\s*=\s*'canceled'[\s\S]*OLD\.reserved_until\s*[^\n]*>\s*clock_timestamp\(\)/i,
  )
  assert.match(
    schemaDdl,
    /OLD\.pending_x402_tx_hash\s+IS\s+NOT\s+NULL\s+AND\s+reservation_changed[\s\S]*pending x402 reservation is immutable/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+sale_payments_match_world_offer\s+BEFORE\s+INSERT\s+ON\s+sale_payments/i,
  )
  assert.match(
    schemaDdl,
    /NEW\.block_time\s+IS\s+NULL[\s\S]*date_trunc\('second',\s*world_offer\.reserved_at\)[\s\S]*NEW\.block_time\s+>=\s+date_trunc\('second',\s*world_offer\.reserved_until\)/i,
  )
})

test('fresh and upgraded world constraints use one stable set of names', () => {
  for (const name of [
    'transfer_offers_channel_allowed',
    'transfer_offers_market_origin_fixed',
    'transfer_offers_market_ids_positive',
    'transfer_offers_reservation_complete',
    'transfer_offers_distinct_parties',
    'transfer_offers_reserved_buyer',
    'transfer_offers_five_minute_reservation',
    'transfer_offers_status_timestamps',
    'transfer_offers_reservation_wallet_state',
    'transfer_offers_channel_state',
    'transfer_offers_pending_x402_state',
  ]) {
    assert.match(schemaDdl, new RegExp(`CONSTRAINT\\s+${name}\\b`, 'i'))
  }
})

test('x402 payment attempts are durable before settlement or final product writes', () => {
  const attempts = schemaStatement('payment_attempts')

  assert.match(attempts, /public_id\s+TEXT\s+PRIMARY KEY/i)
  assert.match(attempts, /actor_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\(id\)/i)
  assert.match(attempts, /operation\s+TEXT\s+NOT NULL/i)
  assert.match(attempts, /request_hash\s+TEXT/i)
  assert.match(attempts, /request_json\s+JSONB/i)
  assert.match(attempts, /method\s+TEXT/i)
  assert.match(attempts, /token\s+TEXT/i)
  assert.match(attempts, /amount_units\s+BIGINT/i)
  assert.match(attempts, /x402_nonce\s+TEXT/i)
  assert.match(attempts, /x402_payload_digest\s+TEXT/i)
  assert.match(attempts, /tx_hash\s+TEXT\s+UNIQUE/i)
  assert.match(attempts, /finalized_block_number\s+BIGINT/i)
  assert.match(attempts, /response_status\s+SMALLINT/i)
  assert.match(schemaDdl, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_x402_nonce/i)
  assert.match(schemaDdl, /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+payment_attempts_one_live_target/i)
})

test('round-two state tables are created idempotently', () => {
  for (const table of [
    'resident_presence',
    'place_law_changes',
    'active_labels',
    'active_blocks',
    'action_runs',
    'action_resolutions',
    'pending_effects',
    'effect_resolutions',
    'moderation_actions',
    'payment_attempts',
  ]) {
    schemaStatement(table)
  }
})

test('resident presence permits residents without a current place or home', () => {
  const presence = schemaStatement('resident_presence')

  assert.match(presence, /resident_id\s+INTEGER\s+PRIMARY KEY\s+REFERENCES\s+residents\s*\(id\)/i)
  assert.match(presence, /current_place_id\s+INTEGER\s+REFERENCES\s+places\s*\(id\)/i)
  assert.match(presence, /home_place_id\s+INTEGER\s+REFERENCES\s+places\s*\(id\)/i)
  assert.doesNotMatch(presence, /current_place_id\s+INTEGER\s+NOT NULL/i)
  assert.doesNotMatch(presence, /home_place_id\s+INTEGER\s+NOT NULL/i)
})

test('blocks expire and the database cannot represent a blocked go-home action', () => {
  const blocks = schemaStatement('active_blocks')

  assert.match(blocks, /action_name\s+TEXT\s+NOT NULL\s+CHECK\s*\([^)]*action_name\s+IN\s*\([^)]*'move'[^)]*\)\s*\)/is)
  assert.doesNotMatch(blocks, /action_name\s+IN\s*\([^)]*'go_home'/is)
  assert.match(blocks, /expires_at\s+TIMESTAMPTZ\s+NOT NULL/i)
  assert.match(blocks, /CHECK\s*\(expires_at\s*>\s*created_at\)/i)
  assert.match(blocks, /CHECK\s*\(expires_at\s*<=\s*created_at\s*\+\s*INTERVAL\s*'24 hours'\)/i)
})

test('laws and labels retain ordered, typed effect state', () => {
  const laws = schemaStatement('place_law_changes')
  const labels = schemaStatement('active_labels')

  assert.match(laws, /change_type\s+TEXT\s+NOT NULL\s+CHECK\s*\(change_type\s+IN\s*\('add',\s*'remove'\)\)/i)
  assert.match(laws, /position\s+SMALLINT/i)
  assert.match(laws, /change_type\s*=\s*'add'[\s\S]*position\s+IS\s+NOT\s+NULL[\s\S]*position\s*>=\s*0/i)
  assert.match(labels, /label\s+TEXT\s+NOT NULL/i)
  assert.match(labels, /target_type\s+IN\s*\('resident',\s*'place',\s*'thing',\s*'kind'\)/i)
})

test('scheduled effects carry immutable payload, due time, and bounded generation', () => {
  const pending = schemaStatement('pending_effects')

  assert.match(pending, /payload\s+JSONB\s+NOT NULL/i)
  assert.match(pending, /due_at\s+TIMESTAMPTZ\s+NOT NULL/i)
  assert.match(pending, /generation\s+SMALLINT\s+NOT NULL[^,]*CHECK\s*\(generation\s+BETWEEN\s+0\s+AND\s+8\)/i)
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+pending_effects_due[\s\S]*?\(place_id,\s*due_at,\s*id\)/i)
})

test('effect generations start at zero and advance exactly once from their parent', () => {
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+pending_effects_check_generation\s+BEFORE\s+INSERT\s+ON\s+pending_effects/i,
  )
  assert.match(schemaDdl, /parent_effect_id\s+IS\s+NULL[\s\S]*NEW\.generation\s*<>\s*0/i)
  assert.match(schemaDdl, /NEW\.generation\s*<>\s*parent_generation\s*\+\s*1/i)
})

test('actions and effects separate immutable requests from one resolution', () => {
  const actions = schemaStatement('action_runs')
  const actionResolutions = schemaStatement('action_resolutions')
  const pending = schemaStatement('pending_effects')
  const effectResolutions = schemaStatement('effect_resolutions')

  for (const column of ['destination_place_id', 'recipient_id', 'payload']) {
    assert.match(actions, new RegExp(`\\b${column}\\b`, 'i'))
    assert.match(pending, new RegExp(`\\b${column}\\b`, 'i'))
  }
  assert.match(pending, /action_id\s+BIGINT\s+REFERENCES\s+action_runs\s*\(id\)/i)
  assert.match(pending, /parent_effect_id\s+BIGINT\s+REFERENCES\s+pending_effects\s*\(id\)/i)
  assert.match(actionResolutions, /action_run_id\s+BIGINT\s+NOT NULL\s+UNIQUE\s+REFERENCES\s+action_runs\s*\(id\)/i)
  assert.match(effectResolutions, /pending_effect_id\s+BIGINT\s+NOT NULL\s+UNIQUE\s+REFERENCES\s+pending_effects\s*\(id\)/i)
  assert.match(actionResolutions, /status\s+TEXT\s+NOT NULL/i)
  assert.match(effectResolutions, /status\s+TEXT\s+NOT NULL/i)
})

test('moderation is founder-only remove-or-restore history', () => {
  const moderation = schemaStatement('moderation_actions')

  assert.match(moderation, /actor_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\s*\(id\)[^,]*CHECK\s*\(actor_id\s*=\s*1\)/i)
  assert.match(moderation, /action\s+TEXT\s+NOT NULL\s+CHECK\s*\(action\s+IN\s*\('remove',\s*'restore'\)\)/i)
  assert.doesNotMatch(moderation, /target_type\s+IN\s*\([^)]*'resident'/i)
})

test('thing withdrawal keeps the row and freezes it as history', () => {
  const things = schemaStatement('things')

  assert.match(things, /open_to_use\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+FALSE/i)
  assert.match(things, /withdrawn_at\s+TIMESTAMPTZ/i)
  assert.match(schemaDdl, /CREATE\s+TRIGGER\s+things_keep_birth_history\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+things/i)
  assert.match(schemaDdl, /OLD\.withdrawn_at\s+IS\s+NOT\s+NULL\s+AND\s+NEW\s+IS\s+DISTINCT\s+FROM\s+OLD/i)
  assert.match(schemaDdl, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+things_place[\s\S]*WHERE\s+withdrawn_at\s+IS\s+NULL/i)
})

test('thing-maker migration derives one authenticated immutable birth actor and fails closed', () => {
  const migration = migrationDdl(thingMakerMigrationFile)

  assert.match(
    migration,
    /LOCK\s+TABLE\s+residents\s*,\s*things\s*,\s*events\s+IN\s+SHARE\s+ROW\s+EXCLUSIVE\s+MODE/iu,
    'history and thing writes must stay frozen through validation and backfill',
  )
  assert.match(migration, /kind\s+IN\s*\(\s*'thing_created'\s*,\s*'thing_crafted'\s*\)/iu)
  assert.match(migration, /JOIN\s+residents[\s\S]*handle\s*=\s*(?:creation_)?event\.actor/iu)
  assert.match(
    migration,
    /authenticated_actor\.joined_at\s*<=\s*creation_event\.at/iu,
    'a later resident must not retroactively authenticate an older actor handle',
  )
  assert.match(migration, /(?:creation_)?event\.at\s*=\s*thing\.created_at/iu)
  assert.match(migration, /detail\s*->>\s*'kind_id'[\s\S]*birth_revision/iu)
  assert.match(migration, /COUNT\s*\([^)]*(?:creation_)?event\.id[^)]*\)\s*<>\s*1/iu)
  assert.match(migration, /malformed\s+or\s+orphan\s+creation\s+event\s+ids/iu)
  assert.match(migration, /maker_id\s+IS\s+DISTINCT\s+FROM[\s\S]*authenticated/iu)
  assert.doesNotMatch(migration, /LIMIT\s+25/iu, 'the failure must name every unresolved record')
  assert.doesNotMatch(
    migration,
    /SET\s+maker_id\s*=\s*(?:things?\.)?owner_id/iu,
    'current ownership is not creation evidence',
  )
  assert.doesNotMatch(
    migration,
    /SET\s+maker_id\s*=[^;]*(?:name|body)/iu,
    'mutable prose is not creation evidence',
  )
  assert.match(migration, /ALTER\s+COLUMN\s+maker_id\s+SET\s+NOT\s+NULL/iu)
  assert.match(migration, /FOREIGN\s+KEY\s*\(maker_id\)[\s\S]*REFERENCES\s+residents\s*\(id\)[\s\S]*ON\s+DELETE\s+RESTRICT/iu)
  assert.match(migration, /NEW\.maker_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.maker_id/iu)
  assert.equal(prepareMigrationExecution(thingMakerMigrationFile, migration).mode, 'transactional')
})

test('thing-maker is selected as one explicit preview or production migration', () => {
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'thing-maker'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, thingMakerMigrationFile)
  assert.equal(preview.executionMode, 'transactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'thing-maker'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'thing-maker-release',
    },
  )
  assert.equal(production.migrationFile, thingMakerMigrationFile)
  assert.equal(production.executionMode, 'transactional')
})

test('later-holder marks are selected as one explicit transactional preview or production migration', () => {
  const migration = migrationDdl(laterHolderMarksMigrationFile)
  assert.match(migration, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+thing_later_holder_marks/iu)
  assert.match(migration, /CREATE\s+TRIGGER\s+thing_later_holder_marks_check_eligibility/iu)
  assert.match(migration, /CREATE\s+TRIGGER\s+things_end_later_holder_mark/iu)
  assert.equal(prepareMigrationExecution(laterHolderMarksMigrationFile, migration).mode, 'transactional')

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'later-holder-marks'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, laterHolderMarksMigrationFile)
  assert.equal(preview.executionMode, 'transactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'later-holder-marks'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'later-holder-marks-release',
    },
  )
  assert.equal(production.migrationFile, laterHolderMarksMigrationFile)
  assert.equal(production.executionMode, 'transactional')
})

test('payment recovery trigger repair is selected as one explicit transactional preview or production migration', () => {
  const migration = migrationDdl(paymentRecoveryTriggerRepairMigrationFile)
  assert.match(migration, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu)
  assert.match(migration, /payment recovery window is immutable/iu)
  assert.match(migration, /payment_pending',\s*'completed',\s*'invalid',\s*'expired'/iu)
  assert.match(migration, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/iu)
  assert.equal(
    prepareMigrationExecution(paymentRecoveryTriggerRepairMigrationFile, migration).mode,
    'transactional',
  )

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-recovery-trigger-repair'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, paymentRecoveryTriggerRepairMigrationFile)
  assert.equal(preview.executionMode, 'transactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-recovery-trigger-repair'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-recovery-trigger-repair-release',
    },
  )
  assert.equal(production.migrationFile, paymentRecoveryTriggerRepairMigrationFile)
  assert.equal(production.executionMode, 'transactional')
})

test('late-finality recheck guard is one explicit transactional preview or production migration', () => {
  const migration = migrationDdl(paymentLateFinalityRecheckMigrationFile)
  assert.equal(splitSqlStatements(migration).length, 1)
  assert.match(migration, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+protect_payment_attempt_history/iu)
  assert.match(migration, /OLD\.status\s*=\s*'expired'[\s\S]*NEW\.status\s*=\s*'founder_review'/iu)
  assert.match(migration, /OLD\.finalized_block_number\s+IS\s+NULL[\s\S]*OR\s+ROW\(/iu)
  assert.equal(
    prepareMigrationExecution(paymentLateFinalityRecheckMigrationFile, migration).mode,
    'transactional',
  )

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'payment-late-finality-recheck'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, paymentLateFinalityRecheckMigrationFile)
  assert.equal(preview.executionMode, 'transactional')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'payment-late-finality-recheck'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'payment-late-finality-recheck-release',
    },
  )
  assert.equal(production.migrationFile, paymentLateFinalityRecheckMigrationFile)
  assert.equal(production.executionMode, 'transactional')
})

test('round-two records are append-only rather than deleted after resolution', () => {
  for (const table of [
    'place_law_changes',
    'active_labels',
    'active_blocks',
    'action_runs',
    'action_resolutions',
    'pending_effects',
    'effect_resolutions',
    'moderation_actions',
  ]) {
    assert.match(
      schemaDdl,
      new RegExp(
        `CREATE\\s+TRIGGER\\s+${table}_append_only\\s+BEFORE\\s+UPDATE\\s+OR\\s+DELETE\\s+ON\\s+${table}\\b`,
        'i',
      ),
      `missing append-only trigger for ${table}`,
    )
  }
})

test('world-root expansion is compatibility-only and does not change city topology', () => {
  const expansion = readFileSync(
    new URL('../db/migrations/20260814_world_root_expand.sql', import.meta.url),
    'utf8',
  )

  assert.match(expansion, /ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+place_kind/i)
  assert.match(expansion, /ALTER\s+COLUMN\s+owner_id\s+DROP\s+NOT\s+NULL/i)
  assert.doesNotMatch(expansion, /INSERT\s+INTO\s+places/i)
  assert.doesNotMatch(expansion, /UPDATE\s+places[\s\S]*parent_id/i)
  assert.doesNotMatch(expansion, /CREATE\s+TRIGGER/i)
})

test('the loopback full schema upgrades a legacy tree before final root indexes', () => {
  const addKind = schemaDdl.search(
    /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+place_kind/i,
  )
  const typeLegacyRoots = schemaDdl.search(
    /UPDATE\s+places[\s\S]*?SET\s+place_kind\s*=\s*'continent'[\s\S]*?parent_id\s+IS\s+NULL/i,
  )
  const createWorld = schemaDdl.search(/INSERT\s+INTO\s+places[\s\S]*?'world'/i)
  const reparent = schemaDdl.search(
    /UPDATE\s+places\s+AS\s+continent[\s\S]*?SET\s+parent_id\s*=\s*world\.id/i,
  )
  const finalRootIndex = schemaDdl.search(
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+places_one_root/i,
  )

  assert.ok(addKind >= 0)
  assert.ok(addKind < typeLegacyRoots)
  assert.ok(typeLegacyRoots < createWorld)
  assert.ok(createWorld < reparent)
  assert.ok(reparent < finalRootIndex)
  assert.match(
    schemaDdl,
    /ADD\s+CONSTRAINT\s+places_active_offer_positive[\s\S]*?active_offer_id\s+IS\s+NULL[\s\S]*?active_offer_id\s*>\s*0/i,
  )
  assert.match(
    schemaDdl,
    /INSERT\s+INTO\s+resident_presence[\s\S]*?ON\s+CONFLICT\s*\(resident_id\)\s+DO\s+UPDATE[\s\S]*?current_place_id\s*=\s*coalesce/i,
  )
})

test('every transactional migration path runs under enforced local time limits', () => {
  const migrationsDirectory = new URL('../db/migrations/', import.meta.url)
  const migrationFiles = readdirSync(migrationsDirectory).filter(name => name.endsWith('.sql'))
  assert.ok(migrationFiles.length >= 14)

  for (const file of [...migrationFiles, 'schema.sql']) {
    if (
      file === '20260821_events_presence_index.sql' ||
      file === '20260821_public_search_indexes.sql'
    ) continue
    const ddl = file === 'schema.sql'
      ? schemaDdl
      : readFileSync(new URL(file, migrationsDirectory), 'utf8')
    const statements = prepareMigrationStatements(ddl)
    assert.equal(
      statements[0],
      `SET LOCAL lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`,
      `${file} must start with the enforced lock timeout`,
    )
    assert.equal(
      statements[1],
      `SET LOCAL statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`,
      `${file} must enforce the statement timeout`,
    )
  }
})

test('the presence index is a separate, exact, nontransactional concurrent migration', () => {
  const totalsMigration = migrationDdl(affordableReadingMigrationFile)
  const indexMigration = migrationDdl(eventsPresenceIndexMigrationFile)
  const statements = splitSqlStatements(indexMigration)
    .map(statement => statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)

  assert.doesNotMatch(totalsMigration, /events_actor_at_desc/i)
  assert.deepEqual(statements, [
    'CREATE INDEX CONCURRENTLY IF NOT EXISTS events_actor_at_desc ON public.events (actor, at DESC)',
  ])
  assert.doesNotMatch(indexMigration, /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/im)

  const execution = prepareMigrationExecution(eventsPresenceIndexMigrationFile, indexMigration)
  assert.equal(execution.mode, 'nontransactional')
  assert.deepEqual(execution.sessionStatements, [
    `SET lock_timeout = '${MIGRATION_LOCK_TIMEOUT}'`,
    `SET statement_timeout = '${MIGRATION_STATEMENT_TIMEOUT}'`,
  ])
  assert.equal(execution.statements.length, 1)
  assert.doesNotMatch(execution.statements.join('\n'), /\b(?:BEGIN|COMMIT|ROLLBACK)\b/i)
})

test('only the reviewed presence-index file may bypass the migration transaction', () => {
  const indexMigration = migrationDdl(eventsPresenceIndexMigrationFile)
  const totalsMigration = migrationDdl(affordableReadingMigrationFile)

  assert.throws(
    () => prepareMigrationExecution(affordableReadingMigrationFile, indexMigration),
    /concurrent index.*allowlisted nontransactional migration/i,
  )
  assert.throws(
    () => prepareMigrationExecution(
      eventsPresenceIndexMigrationFile,
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS another_index ON events (id DESC);',
    ),
    /does not match the reviewed concurrent-index statement/i,
  )
  assert.equal(
    prepareMigrationExecution(affordableReadingMigrationFile, totalsMigration).mode,
    'transactional',
  )
})

test('presence-index retry keeps a valid exact index and repairs only invalid residue', () => {
  const createStatement = splitSqlStatements(migrationDdl(eventsPresenceIndexMigrationFile))[0]!
  const exactState = {
    index_schema: 'public',
    index_name: 'events_actor_at_desc',
    table_schema: 'public',
    table_name: 'events',
    valid: true,
    ready: true,
    unique_index: false,
    access_method: 'btree',
    key_column_count: 2,
    total_column_count: 2,
    options: [0, 3],
    unfiltered: true,
    columns: ['actor', 'at'],
  } as const

  assert.deepEqual(eventsPresenceIndexRecoveryStatements([exactState], createStatement), [])
  assert.deepEqual(
    eventsPresenceIndexRecoveryStatements(
      [{ ...exactState, valid: false, ready: false }],
      createStatement,
    ),
    [
      'DROP INDEX CONCURRENTLY IF EXISTS public.events_actor_at_desc',
      createStatement,
    ],
  )
  assert.deepEqual(eventsPresenceIndexRecoveryStatements([], createStatement), [createStatement])
  assert.throws(
    () => eventsPresenceIndexRecoveryStatements(
      [{ ...exactState, columns: ['at', 'actor'], options: [0, 0] }],
      createStatement,
    ),
    /conflicts with the reviewed definition/i,
  )
  assert.throws(
    () => eventsPresenceIndexRecoveryStatements(
      [{ ...exactState, access_method: 'hash' }],
      createStatement,
    ),
    /conflicts with the reviewed definition/i,
  )
})

test('search-index retry keeps exact indexes and repairs only interrupted builds', () => {
  const statements = splitSqlStatements(migrationDdl(publicSearchIndexesMigrationFile))
  const createStatements = statements.slice(1)
  const exactRows = [
    {
      index_schema: 'public', index_name: 'notes_public_search_words',
      table_schema: 'public', table_name: 'notes', valid: true, ready: true,
      unique_index: false, access_method: 'gin', key_column_count: 1,
      total_column_count: 1, unfiltered: true, predicate: null,
      columns: ["to_tsvector('simple'::regconfig, body)"],
      operator_classes: ['tsvector_ops'],
    },
    {
      index_schema: 'public', index_name: 'notes_public_search_phrase',
      table_schema: 'public', table_name: 'notes', valid: true, ready: true,
      unique_index: false, access_method: 'gin', key_column_count: 1,
      total_column_count: 1, unfiltered: true, predicate: null,
      columns: ['lower(body)'], operator_classes: ['gin_trgm_ops'],
    },
    {
      index_schema: 'public', index_name: 'things_public_search_words_active',
      table_schema: 'public', table_name: 'things', valid: true, ready: true,
      unique_index: false, access_method: 'gin', key_column_count: 1,
      total_column_count: 1, unfiltered: false, predicate: 'withdrawn_at IS NULL',
      columns: ["to_tsvector('simple'::regconfig, (name || ' '::text) || body)"],
      operator_classes: ['tsvector_ops'],
    },
    {
      index_schema: 'public', index_name: 'things_public_search_phrase_active',
      table_schema: 'public', table_name: 'things', valid: true, ready: true,
      unique_index: false, access_method: 'gin', key_column_count: 1,
      total_column_count: 1, unfiltered: false, predicate: 'withdrawn_at IS NULL',
      columns: ["lower((name || ' '::text) || body)"],
      operator_classes: ['gin_trgm_ops'],
    },
  ] as const

  assert.deepEqual(publicSearchIndexRecoveryStatements(exactRows, createStatements), [])
  assert.deepEqual(
    publicSearchIndexRecoveryStatements(
      exactRows.map(row => row.index_name === 'notes_public_search_words'
        ? { ...row, valid: false, ready: false }
        : row),
      createStatements,
    ),
    [
      'DROP INDEX CONCURRENTLY IF EXISTS public.notes_public_search_words',
      createStatements[0],
    ],
  )
  assert.throws(
    () => publicSearchIndexRecoveryStatements(
      exactRows.map(row => row.index_name === 'notes_public_search_phrase'
        ? { ...row, operator_classes: ['tsvector_ops'] }
        : row),
      createStatements,
    ),
    /conflicts with the reviewed definition/i,
  )
  assert.throws(
    () => publicSearchIndexRecoveryStatements(
      exactRows.map(row => row.index_name === 'things_public_search_phrase_active'
        ? { ...row, columns: ["lower(name) || ' '::text || body"] }
        : row),
      createStatements,
    ),
    /conflicts with the reviewed definition/i,
  )
})

test('the concurrent presence index has exact guarded preview and production selection', () => {
  const previewEnvironment = {
    CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
    NEON_API_KEY: 'secret-neon-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PREVIEW_BRANCH_ID: 'branch-preview',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
  } as const
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'events-presence-index'],
    previewEnvironment,
  )
  assert.equal(preview.migrationFile, eventsPresenceIndexMigrationFile)
  assert.equal(preview.executionMode, 'nontransactional')

  assert.throws(
    () => resolveMigrationRun(
      ['--target', 'preview', '--migration', 'events-presence-index-extra'],
      previewEnvironment,
    ),
    /remote migration requires --migration/i,
  )

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'events-presence-index'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'events-presence-index-release',
    },
  )
  assert.equal(production.migrationFile, eventsPresenceIndexMigrationFile)
  assert.equal(production.executionMode, 'nontransactional')
  assert.equal(production.snapshot?.name, 'events-presence-index-release')
})

test('a migration that sets its own limits overrides the enforced defaults', () => {
  const topology = readFileSync(
    new URL('../db/migrations/20260814_world_root_topology.sql', import.meta.url),
    'utf8',
  )

  const statements = prepareMigrationStatements(topology)
  const ownLockTimeout = statements.findIndex((statement, index) =>
    index >= 2 && /SET\s+LOCAL\s+lock_timeout/i.test(statement))
  assert.ok(ownLockTimeout > 1, 'the file keeps its own lock timeout after the enforced one')
})

test('public change markers are one explicit transactional preview or production release', () => {
  const migration = migrationDdl(publicChangeMarkersMigrationFile)
  assert.equal(prepareMigrationExecution(publicChangeMarkersMigrationFile, migration).mode, 'transactional')
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public_change_state/iu)
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public_change_log/iu)
  assert.match(migration, /AFTER INSERT ON events[\s\S]*record_public_change/iu)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'public-change-markers'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, publicChangeMarkersMigrationFile)

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'public-change-markers'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'public-change-markers-release',
    },
  )
  assert.equal(production.migrationFile, publicChangeMarkersMigrationFile)
})

test('world-root topology is one bounded transaction with database backstops', () => {
  const topology = readFileSync(
    new URL('../db/migrations/20260814_world_root_topology.sql', import.meta.url),
    'utf8',
  )

  assert.match(topology, /^\s*BEGIN\s*;/i)
  assert.match(topology, /SET\s+LOCAL\s+lock_timeout\s*=/i)
  assert.match(topology, /SET\s+LOCAL\s+statement_timeout\s*=/i)
  assert.match(topology, /LOCK\s+TABLE\s+places/i)
  assert.match(topology, /INSERT\s+INTO\s+places/i)
  assert.match(topology, /UPDATE\s+places[\s\S]*place_kind\s*=\s*'continent'/i)
  assert.match(topology, /UPDATE\s+places[\s\S]*parent_id/i)
  assert.match(topology, /INSERT\s+INTO\s+resident_presence[\s\S]*ON\s+CONFLICT/i)
  assert.match(topology, /COMMIT\s*;\s*$/i)

  for (const table of ['things', 'notes', 'place_law_changes', 'resident_presence', 'active_labels']) {
    assert.match(
      topology,
      new RegExp(`CREATE\\s+TRIGGER[\\s\\S]{0,240}ON\\s+${table}\\b`, 'i'),
      `missing topology backstop for ${table}`,
    )
  }
})

test('remote world-root topology selection requires its own destructive acknowledgement', () => {
  const previewEnvironment = {
    CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
    NEON_API_KEY: 'secret-neon-key',
    NEON_PROJECT_ID: 'project-one',
    NEON_PREVIEW_BRANCH_ID: 'branch-preview',
    NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
  } as const

  const expansion = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'world-root-expand'],
    previewEnvironment,
  )
  assert.equal(expansion.migrationFile, 'db/migrations/20260814_world_root_expand.sql')

  assert.throws(
    () => resolveMigrationRun(
      ['--target', 'preview', '--migration', 'world-root-topology'],
      previewEnvironment,
    ),
    /CONFIRM_WORLD_ROOT_TOPOLOGY/,
  )

  const topology = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'world-root-topology'],
    {
      ...previewEnvironment,
      CONFIRM_WORLD_ROOT_TOPOLOGY: 'REPARENT_CONTINENTS_UNDER_UNOWNED_WORLD_ROOT',
    },
  )
  assert.equal(topology.migrationFile, 'db/migrations/20260814_world_root_topology.sql')
})

test('world-root description is a bounded transactional forward migration', () => {
  const migration = migrationDdl(worldRootDescriptionMigrationFile)

  assert.match(migration, /^\s*BEGIN\s*;/i)
  assert.match(migration, /SET\s+LOCAL\s+lock_timeout\s*=/i)
  assert.match(migration, /SET\s+LOCAL\s+statement_timeout\s*=/i)
  assert.match(migration, /LOCK\s+TABLE\s+places\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE/i)
  assert.match(
    migration,
    /ALTER\s+TABLE\s+places\s+DISABLE\s+TRIGGER\s+places_protect_topology_write/i,
  )
  assert.match(migration, /UPDATE\s+places\s+SET\s+description\s*=/i)
  assert.match(
    migration,
    /WHERE\s+place_kind\s*=\s*'world'\s+AND\s+description\s+IS\s+DISTINCT\s+FROM/i,
  )
  assert.match(
    migration,
    /ALTER\s+TABLE\s+places\s+ENABLE\s+TRIGGER\s+places_protect_topology_write/i,
  )
  assert.doesNotMatch(migration, /session_replication_role/i)
  assert.match(migration, /COMMIT\s*;\s*$/i)
  assert.equal(
    prepareMigrationExecution(worldRootDescriptionMigrationFile, migration).mode,
    'transactional',
  )

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'world-root-description'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, worldRootDescriptionMigrationFile)

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'world-root-description'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'world-root-description-release',
    },
  )
  assert.equal(production.migrationFile, worldRootDescriptionMigrationFile)
})

test('remote identity rotation is selected as its own additive release', () => {
  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'identity-rotation'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, 'db/migrations/20260816_identity_rotation.sql')

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'identity-rotation'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'identity-rotation-release',
    },
  )
  assert.equal(production.migrationFile, 'db/migrations/20260816_identity_rotation.sql')
})

const publicPaginationIndexes = Object.freeze([
  'CREATE INDEX IF NOT EXISTS places_parent_id_desc ON places (parent_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS places_owner_id_desc ON places (owner_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS things_place_active_id_desc ON things (place_id, id DESC) WHERE withdrawn_at IS NULL',
  'CREATE INDEX IF NOT EXISTS things_owner_active_id_desc ON things (owner_id, id DESC) WHERE withdrawn_at IS NULL',
  'CREATE INDEX IF NOT EXISTS kinds_owner_id_desc ON kinds (owner_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS notes_place_id_desc ON notes (place_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS notes_author_id_desc ON notes (author_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS events_kind_id_desc ON events (kind, id DESC)',
  'CREATE INDEX IF NOT EXISTS transfer_offers_seller_id_desc ON transfer_offers (seller_id, id DESC)',
  'CREATE INDEX IF NOT EXISTS transfer_offers_buyer_id_desc ON transfer_offers (buyer_id, id DESC)',
])

function normalizeSql(statement: string): string {
  return statement.replace(/^\s*--.*$/gm, '').replace(/\s+/g, ' ').trim()
}

test('public pagination migration contains only the exact keyset indexes used by listing queries', () => {
  const migration = readFileSync(
    new URL('../db/migrations/20260814_public_pagination.sql', import.meta.url),
    'utf8',
  )

  assert.deepEqual(
    splitSqlStatements(migration).map(normalizeSql),
    publicPaginationIndexes,
  )
})

test('fresh schema contains every reviewed public pagination index without drift', () => {
  const freshInstallStatements = new Set(splitSqlStatements(schemaDdl).map(normalizeSql))

  for (const index of publicPaginationIndexes) {
    assert.ok(
      freshInstallStatements.has(index),
      `db/schema.sql is missing the reviewed pagination index: ${index}`,
    )
  }
})

test('agreement accession is an append-only opt-in by the original author', () => {
  const agreements = schemaStatement('agreements')
  const parties = schemaStatement('agreement_parties')
  const openings = schemaStatement('agreement_accession_openings')

  assert.doesNotMatch(agreements, /\bsealed\b/i)
  assert.match(parties, /\bnamed\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+TRUE\b/i)
  assert.match(openings, /agreement_id\s+INTEGER\s+PRIMARY KEY/i)
  assert.match(openings, /opened_by_id\s+INTEGER\s+NOT NULL/i)
  assert.match(openings, /opened_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+now\(\)/i)
  assert.match(
    openings,
    /FOREIGN\s+KEY\s*\(agreement_id,\s*opened_by_id\)\s*REFERENCES\s+agreements\s*\(id,\s*created_by_id\)/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+agreements_id_creator\s+ON\s+agreements\s*\(id,\s*created_by_id\)/i,
  )
  assert.match(
    schemaDdl,
    /CREATE\s+TRIGGER\s+agreement_accession_openings_append_only\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+agreement_accession_openings/i,
  )
  assert.doesNotMatch(schemaDdl, /INSERT\s+INTO\s+agreement_accession_openings/i)
})
