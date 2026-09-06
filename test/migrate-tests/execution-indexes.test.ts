import test from 'node:test'
import assert from 'node:assert/strict'
import {
  readFileSync,
  readdirSync,
} from 'node:fs'
import {
  MIGRATION_LOCK_TIMEOUT,
  MIGRATION_STATEMENT_TIMEOUT,
  eventsPresenceIndexRecoveryStatements,
  publicSearchIndexRecoveryStatements,
  prepareMigrationExecution,
  prepareMigrationStatements,
  resolveMigrationRun,
  splitSqlStatements,
} from '../../scripts/migrate.ts'
import {
  migrationDdl,
  schemaDdl,
} from '../helpers/migrate-fixtures/index.ts'

export function registerExecutionIndexTests(): void {
  const affordableReadingMigrationFile = 'db/migrations/20260820_affordable_reading_totals.sql' as const
  const eventsPresenceIndexMigrationFile = 'db/migrations/20260821_events_presence_index.sql' as const
  const publicSearchIndexesMigrationFile = 'db/migrations/20260821_public_search_indexes.sql' as const

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
      new URL('../../db/migrations/20260814_world_root_expand.sql', import.meta.url),
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
    const migrationsDirectory = new URL('../../db/migrations/', import.meta.url)
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
      {
        index_schema: 'public', index_name: 'place_name_history_name_search',
        table_schema: 'public', table_name: 'place_name_history', valid: true, ready: true,
        unique_index: false, access_method: 'gin', key_column_count: 1,
        total_column_count: 1, unfiltered: true, predicate: null,
        columns: ['lower(name)'], operator_classes: ['gin_trgm_ops'],
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
      new URL('../../db/migrations/20260814_world_root_topology.sql', import.meta.url),
      'utf8',
    )

    const statements = prepareMigrationStatements(topology)
    const ownLockTimeout = statements.findIndex((statement, index) =>
      index >= 2 && /SET\s+LOCAL\s+lock_timeout/i.test(statement))
    assert.ok(ownLockTimeout > 1, 'the file keeps its own lock timeout after the enforced one')
  })
}
