import test from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  readFileSync,
} from 'node:fs'
import {
  prepareMigrationExecution,
  resolveMigrationRun,
  splitSqlStatements,
} from '../../scripts/migrate.ts'
import {
  migrationDdl,
  schemaDdl,
  schemaStatement,
} from '../helpers/migrate-fixtures/index.ts'

export function registerWorldPublicTests(): void {
  const publicChangeMarkersMigrationFile = 'db/migrations/20260821_public_change_markers.sql' as const
  const worldRootDescriptionMigrationFile =
    'db/migrations/20260823_world_root_description.sql' as const
  const worldRootDrawingMigrationFile =
    'db/migrations/20260827_world_root_drawing.sql' as const

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
      new URL('../../db/migrations/20260814_world_root_topology.sql', import.meta.url),
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

  test('world-root drawing is one bounded reviewed write with explicit remote targets', () => {
    const migrationUrl = new URL(`../../${worldRootDrawingMigrationFile}`, import.meta.url)
    assert.equal(existsSync(migrationUrl), true, 'missing reviewed world-root drawing migration')
    const migration = migrationDdl(worldRootDrawingMigrationFile)

    assert.match(migration, /^\s*BEGIN\s*;/iu)
    assert.match(migration, /SET\s+LOCAL\s+lock_timeout\s*=/iu)
    assert.match(migration, /SET\s+LOCAL\s+statement_timeout\s*=/iu)
    assert.match(migration, /LOCK\s+TABLE\s+places\s+IN\s+ACCESS\s+EXCLUSIVE\s+MODE/iu)
    assert.match(migration, /(?:information_schema\.columns|pg_attribute)[\s\S]{0,500}\bdrawing\b/iu)
    assert.match(migration, /valid_city_drawing/iu)
    assert.match(
      migration,
      /SELECT\s+count\s*\(\s*\*\s*\)[\s\S]{0,900}FROM\s+places[\s\S]{0,160}WHERE\s+place_kind\s*=\s*'world'/iu,
    )
    assert.match(
      migration,
      /FROM\s+pg_trigger[\s\S]{0,300}tgname\s*=\s*'places_protect_topology_write'[\s\S]{0,180}tgenabled\s*=\s*'O'/iu,
    )
    assert.match(
      migration,
      /ALTER\s+TABLE\s+places\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+places_world_shape/iu,
    )
    assert.match(migration, /ALTER\s+TABLE\s+places\s+(?:ADD\s+)?CONSTRAINT\s+places_world_shape/iu)
    assert.match(
      migration,
      /ALTER\s+TABLE\s+places\s+DISABLE\s+TRIGGER\s+places_protect_topology_write/iu,
    )
    assert.match(migration, /UPDATE\s+places\s+SET\s+drawing\s*=/iu)
    assert.match(
      migration,
      /WHERE\s+place_kind\s*=\s*'world'\s+AND\s+drawing\s+IS\s+DISTINCT\s+FROM/iu,
    )
    assert.match(
      migration,
      /ALTER\s+TABLE\s+places\s+ENABLE\s+TRIGGER\s+places_protect_topology_write/iu,
    )
    assert.match(migration, /ALTER\s+TABLE\s+places\s+VALIDATE\s+CONSTRAINT\s+places_world_shape/iu)
    assert.doesNotMatch(migration, /session_replication_role/iu)
    assert.match(migration, /COMMIT\s*;\s*$/iu)
    assert.equal(
      prepareMigrationExecution(worldRootDrawingMigrationFile, migration).mode,
      'transactional',
    )

    const baseEnvironment = {
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
    }
    const preview = resolveMigrationRun(
      ['--target', 'preview', '--migration', 'world-root-drawing'],
      {
        ...baseEnvironment,
        CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
        NEON_PREVIEW_BRANCH_ID: 'branch-preview',
        PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      },
    )
    assert.equal(preview.migrationFile, worldRootDrawingMigrationFile)
    assert.equal(preview.executionMode, 'transactional')

    const production = resolveMigrationRun(
      ['--target', 'production', '--migration', 'world-root-drawing'],
      {
        ...baseEnvironment,
        CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
        PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
        PRODUCTION_SNAPSHOT_NAME: 'world-root-drawing-release',
      },
    )
    assert.equal(production.migrationFile, worldRootDrawingMigrationFile)
    assert.equal(production.executionMode, 'transactional')

    const packageJson = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { scripts?: Record<string, string> }
    assert.match(
      packageJson.scripts?.['migrate:preview:world-root-drawing'] ?? '',
      /--target preview --migration world-root-drawing$/u,
    )
    assert.match(
      packageJson.scripts?.['migrate:production:world-root-drawing'] ?? '',
      /--target production --migration world-root-drawing$/u,
    )
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
      new URL('../../db/migrations/20260814_public_pagination.sql', import.meta.url),
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
}
