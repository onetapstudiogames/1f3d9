import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PUBLIC_EXPOSURE_SQL } from '../scripts/credential-exposure-scan.ts'
import { resolveMigrationRun, splitSqlStatements } from '../scripts/migrate.ts'
import { MODERATED_TEXT, redactPlace } from '../src/moderation.ts'

const root = new URL('../', import.meta.url)
const schemaDdl = source('db/schema.sql')
const migrateSource = source('scripts/migrate.ts')
const readingCostSource = source('src/reading-cost.ts')
const publicPaginationSource = source('src/public-pagination.ts')
const publicMapSource = source('src/public-map.ts')
const packageJson = JSON.parse(source('package.json')) as { scripts: Record<string, string> }
const migrationFile = 'db/migrations/20260822_room_orientation.sql' as const

function source(path: string): string {
  return readFileSync(new URL(path, root), 'utf8')
}

function migrationDdl(): string {
  return source(migrationFile)
}

function normalizedStatement(ddl: string, pattern: RegExp, missing: string): string {
  const statement = splitSqlStatements(ddl).find(candidate => pattern.test(candidate))
  assert.ok(statement, missing)
  return statement.replace(/^\s*--.*$/gmu, '').replace(/\s+/gu, ' ').trim()
}

function table(ddl: string, name: string): string {
  return normalizedStatement(
    ddl,
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(?:public\\.)?${name}\\b`, 'iu'),
    `missing ${name}`,
  )
}

function placeTotalsTriggerFunction(ddl: string): string {
  return normalizedStatement(
    ddl,
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+maintain_place_reading_totals_from_place\s*\(/iu,
    'missing place reading-total trigger function',
  )
}

function assertPurposeDefinition(ddl: string, label: string): void {
  assert.match(ddl, /\bpurpose\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/iu, `${label}: purpose default`)
  assert.match(
    ddl,
    /char_length\s*\(\s*purpose\s*\)\s*<=\s*280/iu,
    `${label}: purpose character bound`,
  )
  assert.match(
    ddl,
    /purpose\s*!~\s*E?'\[[^']*\\r[^']*\\n[^']*\]'/iu,
    `${label}: purpose must be one line`,
  )
}

test('places gain a separate bounded purpose without replacing their description', () => {
  const places = table(schemaDdl, 'places')
  assert.match(
    places,
    /\bdescription\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''\s+CHECK\s*\(\s*octet_length\s*\(\s*description\s*\)\s*<=\s*65536\s*\)/iu,
  )
  assertPurposeDefinition(places, 'fresh schema')

  const migration = migrationDdl()
  assert.match(
    migration,
    /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+purpose\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+''/iu,
  )
  assertPurposeDefinition(migration, 'additive migration')
  assert.doesNotMatch(migration, /(?:DROP|RENAME)\s+COLUMN\s+description/iu)
  assert.doesNotMatch(migration, /UPDATE\s+places[\s\S]{0,160}description\s*=/iu)
})

test('fresh and upgraded schemas keep one atomic bounded ordered front-matter array', () => {
  const places = table(schemaDdl, 'places')
  assert.match(
    places,
    /\bfront_matter_thing_ids\s+INTEGER\[\]\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::INTEGER\[\]/iu,
  )
  assert.match(
    places,
    /cardinality\s*\(\s*front_matter_thing_ids\s*\)\s+BETWEEN\s+0\s+AND\s+3/iu,
  )

  const upgrade = migrationDdl()
  assert.match(
    upgrade,
    /ALTER\s+TABLE\s+places\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+front_matter_thing_ids\s+INTEGER\[\]\s+NOT\s+NULL\s+DEFAULT\s+'\{\}'::INTEGER\[\]/iu,
  )
  assert.match(upgrade, /cardinality\s*\(\s*front_matter_thing_ids\s*\)\s+BETWEEN\s+0\s+AND\s+3/iu)
  assert.doesNotMatch(schemaDdl, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+place_front_matter/iu)
  assert.doesNotMatch(upgrade, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+place_front_matter/iu)
})

test('the additive migration is transactional, non-destructive, and explicitly selectable', () => {
  const migration = migrationDdl()
  assert.match(migration, /^\s*BEGIN\s*;/iu)
  assert.match(migration, /COMMIT\s*;\s*$/iu)
  assert.doesNotMatch(migration, /\b(?:DELETE\s+FROM|TRUNCATE|DROP\s+TABLE|DROP\s+COLUMN)\b/iu)
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+place_front_matter/iu)
  assert.match(migrateSource, /'room-orientation'/u)
  assert.match(migrateSource, /20260822_room_orientation\.sql/u)

  const preview = resolveMigrationRun(
    ['--target', 'preview', '--migration', 'room-orientation'],
    {
      CONFIRM_PREVIEW_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_ISOLATED_PREVIEW',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PREVIEW_BRANCH_ID: 'branch-preview',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PREVIEW_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
    },
  )
  assert.equal(preview.migrationFile, migrationFile)

  const production = resolveMigrationRun(
    ['--target', 'production', '--migration', 'room-orientation'],
    {
      CONFIRM_PRODUCTION_MIGRATION: 'APPLY_ADDITIVE_SCHEMA_TO_PRODUCTION',
      NEON_API_KEY: 'secret-neon-key',
      NEON_PROJECT_ID: 'project-one',
      NEON_PRODUCTION_BRANCH_ID: 'branch-production',
      PRODUCTION_DATABASE_URL_UNPOOLED: 'postgres://role@example.neon.tech/db',
      PRODUCTION_SNAPSHOT_NAME: 'room-orientation-release',
    },
  )
  assert.equal(production.migrationFile, migrationFile)
})

test('package scripts expose the reviewed preview and production migration', () => {
  assert.match(
    packageJson.scripts['migrate:preview:room-orientation'] ?? '',
    /--target preview --migration room-orientation$/u,
  )
  assert.match(
    packageJson.scripts['migrate:production:room-orientation'] ?? '',
    /--target production --migration room-orientation$/u,
  )
})

test('subplace authored-text totals count description plus purpose on every write path', () => {
  assert.match(
    schemaDdl,
    /sum\s*\(\s*octet_length\s*\(\s*description\s*\)\s*\+\s*octet_length\s*\(\s*purpose\s*\)\s*\)[\s\S]{0,100}AS\s+text_bytes/iu,
  )

  for (const [label, ddl] of [['fresh schema', schemaDdl], ['migration', migrationDdl()]] as const) {
    const triggerFunction = placeTotalsTriggerFunction(ddl)
    assert.match(
      triggerFunction,
      /octet_length\s*\(\s*NEW\.description\s*\)\s*\+\s*octet_length\s*\(\s*NEW\.purpose\s*\)/iu,
      `${label}: add new authored bytes`,
    )
    assert.match(
      triggerFunction,
      /octet_length\s*\(\s*OLD\.description\s*\)\s*\+\s*octet_length\s*\(\s*OLD\.purpose\s*\)/iu,
      `${label}: remove old authored bytes`,
    )
    assert.match(
      triggerFunction,
      /NEW\.purpose\s+IS\s+DISTINCT\s+FROM\s+OLD\.purpose/iu,
      `${label}: detect purpose edits`,
    )
    assert.match(
      ddl,
      /CREATE\s+TRIGGER\s+places_update_reading_totals[\s\S]{0,160}UPDATE\s+OF\s+parent_id\s*,\s*description\s*,\s*purpose\s+ON\s+places/iu,
      `${label}: purpose update trigger`,
    )
  }
})

test('reading-cost meters include room and child purposes in stored and first-read bytes', () => {
  assert.match(
    readingCostSource,
    /sum\s*\(\s*octet_length\s*\(\s*description\s*\)\s*\+\s*octet_length\s*\(\s*purpose\s*\)\s*\)/iu,
  )
  assert.match(
    readingCostSource,
    /octet_length\s*\(\s*place\.description\s*\)\s*\+\s*octet_length\s*\(\s*place\.purpose\s*\)[\s\S]{0,100}stored_text_bytes/iu,
  )
  assert.match(
    readingCostSource,
    /octet_length\s*\(\s*place\.description\s*\)\s*\+\s*octet_length\s*\(\s*place\.purpose\s*\)[\s\S]{0,140}first_read_text_bytes/iu,
  )
  assert.match(readingCostSource, /counted_text:\s*'[^']*place descriptions and purposes/iu)
})

test('outline loaders return the bounded purpose while charging it to authored-text totals', () => {
  assert.match(
    publicPaginationSource,
    /octet_length\s*\(\s*p\.description\s*\)\s*\+\s*octet_length\s*\(\s*p\.purpose\s*\)[\s\S]{0,50}AS\s+__text_bytes/iu,
  )
  assert.ok(
    (publicPaginationSource.match(/\bp\.purpose\b/gu) ?? []).length >= 2,
    'full/budgeted and outline place collections must select purpose',
  )
  assert.match(
    publicPaginationSource,
    /SELECT\s+p\.id\s*,\s*p\.parent_id\s*,\s*p\.name\s*,[\s\S]{0,160}\$\{subplaceTextProjection\}[\s\S]{0,100}p\.purpose/iu,
  )

  assert.match(publicMapSource, /readonly\s+purpose:\s*string/iu)
  assert.ok(
    (publicMapSource.match(/\bp\.purpose\b/gu) ?? []).length >= 2,
    'map parent and child outlines must select purpose',
  )
  assert.match(publicMapSource, /purpose:\s*(?:row\.purpose|String\s*\(\s*row\.purpose\s*\))/iu)
})

test('credential scanning and moderation treat purpose as public resident-authored text', () => {
  assert.match(
    PUBLIC_EXPOSURE_SQL,
    /SELECT\s+id::bigint\s*,\s*owner_id\s*,\s*purpose\s+FROM\s+public\.places\s+WHERE\s+purpose\s*~\*\s*\$1/iu,
  )

  const redacted = redactPlace({
    id: 8,
    name: 'A room name',
    description: 'A long room description',
    purpose: 'A short room purpose',
  })
  assert.equal(redacted.name, MODERATED_TEXT)
  assert.equal(redacted.description, MODERATED_TEXT)
  assert.equal(redacted.purpose, MODERATED_TEXT)
})
