import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { isDeepStrictEqual } from 'node:util'

const schemaUrl = new URL('../db/schema.sql', import.meta.url)
const baselineMigrationUrl = new URL('../db/migrations/20260827_drawings.sql', import.meta.url)
const contractMigrationUrl = new URL(
  '../db/migrations/20260828_drawing_contract.sql',
  import.meta.url,
)
const worldRootDrawingMigrationUrl = new URL(
  '../db/migrations/20260827_world_root_drawing.sql',
  import.meta.url,
)

const FOUNDER_WORLD_DRAWING = Object.freeze({
  palette: Object.freeze(['#0b1714', '#123026', '#1c4434']),
  indices: Object.freeze([
    0, 0, 0, 0, 0, 0, 0, 0,
    null, 0, 1, 0, 0, 0, 0, 0,
    null, 0, 0, 0, 0, 0, 1, 0,
    0, null, 0, 0, 1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, null, 0, 1, 0, 0, 0,
    0, 0, null, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 1, 0, 0,
  ]),
})

function sqlJsonbValues(sql: string): unknown[] {
  return [...sql.matchAll(/'(\{[^']+\})'\s*::\s*jsonb/giu)].flatMap(match => {
    try {
      return [JSON.parse(match[1]!) as unknown]
    } catch {
      return []
    }
  })
}

function assertIncludesFounderWorldDrawing(sql: string, label: string): void {
  assert.equal(FOUNDER_WORLD_DRAWING.indices.length, 64)
  assert.equal(
    sqlJsonbValues(sql).some(value => isDeepStrictEqual(value, FOUNDER_WORLD_DRAWING)),
    true,
    `${label} must store the exact approved 64-cell founder drawing`,
  )
}

test('fresh and upgraded databases share one strict nullable drawing contract', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(baselineMigrationUrl, 'utf8'),
  ])

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    assert.match(sql, /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+valid_city_drawing\s*\(\s*candidate\s+JSONB\s*\)/iu, name)
    assert.match(sql, /jsonb_typeof\s*\(\s*candidate\s*\)\s*<>\s*'object'/iu, name)
    assert.match(sql, /jsonb_object_keys\s*\(\s*candidate\s*\)/iu, name)
    assert.match(sql, /jsonb_array_length\s*\(\s*candidate\s*->\s*'palette'\s*\)\s+NOT\s+BETWEEN\s+0\s+AND\s+64/iu, name)
    assert.match(sql, /\^#\[0-9a-f\]\{6\}\$/u, name)
    assert.match(sql, /jsonb_array_length\s*\(\s*candidate\s*->\s*'indices'\s*\)\s*<>\s*64/iu, name)
    assert.match(sql, /octet_length\s*\(\s*candidate::text\s*\)\s*>\s*2048/iu, name)
    for (const table of ['residents', 'places', 'things', 'kind_revisions']) {
      assert.match(
        sql,
        new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+drawing\\s+JSONB`, 'iu'),
        `${name}: ${table} drawing column`,
      )
      assert.match(
        sql,
        new RegExp(`CONSTRAINT\\s+${table}_drawing_valid[\\s\\S]{0,180}valid_city_drawing\\s*\\(\\s*drawing\\s*\\)`, 'iu'),
        `${name}: ${table} drawing constraint`,
      )
    }
    assert.match(sql, /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_drawing_rate_limits/iu, name)
    assert.match(sql, /used\s+SMALLINT\s+NOT\s+NULL[\s\S]{0,100}used\s+BETWEEN\s+1\s+AND\s+6/iu, name)
    assert.match(sql, /PRIMARY\s+KEY\s*\(\s*resident_id\s*,\s*minute\s*\)/iu, name)
  }
})

test('the drawing contract is a forward additive layer over the unchanged preview baseline', async () => {
  const [baseline, contract] = await Promise.all([
    readFile(baselineMigrationUrl, 'utf8'),
    readFile(contractMigrationUrl, 'utf8'),
  ])

  assert.doesNotMatch(baseline, /drawing_(?:state|description|variants)|drawing_revisions/iu)
  assert.match(contract, /^BEGIN\s*;/iu)
  assert.match(contract, /COMMIT\s*;\s*$/iu)
  assert.doesNotMatch(contract, /DROP\s+(?:TABLE|COLUMN)\b/iu)
  assert.doesNotMatch(contract, /TRUNCATE\b/iu)
})

test('fresh and upgraded databases store explicit atomic drawing state and description', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(contractMigrationUrl, 'utf8'),
  ])

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    for (const table of ['residents', 'places', 'things', 'kind_revisions']) {
      assert.match(
        sql,
        new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+drawing_state\\s+TEXT`, 'iu'),
        `${name}: ${table} state`,
      )
      assert.match(
        sql,
        new RegExp(`ALTER\\s+TABLE\\s+${table}\\s+ADD\\s+COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+drawing_description\\s+TEXT`, 'iu'),
        `${name}: ${table} description`,
      )
    }
    assert.match(sql, /drawing_state[\s\S]{0,900}'undrawn'[\s\S]{0,900}'refused'[\s\S]{0,900}'in_progress'[\s\S]{0,900}'complete'/iu, name)
    assert.match(
      sql,
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+valid_city_drawing_state[\s\S]{0,900}octet_length\s*\(\s*candidate_description\s*\)\s*<=\s*280/iu,
      name,
    )
    assert.match(sql, /CHECK\s*\(\s*valid_city_drawing_state\s*\(\s*drawing_state\s*,\s*drawing_description\s*,\s*drawing\s*\)\s*\)/iu, name)
    assert.match(sql, /WHEN\s+'undrawn'\s+THEN\s+candidate_description\s+IS\s+NULL\s+AND\s+candidate_drawing\s+IS\s+NULL/iu, name)
    assert.match(sql, /WHEN\s+'refused'\s+THEN\s+candidate_description\s+IS\s+NOT\s+NULL[\s\S]{0,180}candidate_drawing\s+IS\s+NULL/iu, name)
    for (const state of ['in_progress', 'complete']) {
      assert.match(
        sql,
        new RegExp(`WHEN\\s+'${state}'\\s+THEN\\s+candidate_description\\s+IS\\s+NOT\\s+NULL[\\s\\S]{0,180}candidate_drawing\\s+IS\\s+NOT\\s+NULL`, 'iu'),
        `${name}: ${state}`,
      )
    }
  }
})

test('drawing text constraints and dependent SQL helpers stay safe under restore and custom schemas', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(contractMigrationUrl, 'utf8'),
  ])

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    assert.match(
      sql,
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+valid_city_drawing_public_text[\s\S]{0,1800}1f3d9_[\s\S]{0,200}\{8,/iu,
      `${name}: credential-shaped text backstop`,
    )
    assert.match(
      sql,
      /valid_city_drawing_public_text[\s\S]{0,1800}(?:8238|8297)[\s\S]{0,500}65533/iu,
      `${name}: control, bidi, and replacement-character backstop`,
    )
    assert.match(
      sql,
      /valid_city_drawing_variant_name[\s\S]{0,900}btrim[\s\S]{0,500}[\\r\\n]/iu,
      `${name}: trimmed one-line variant names`,
    )

    for (const helper of [
      'valid_city_drawing_state',
      'valid_city_drawing_variants',
      'valid_city_drawing_revision_value',
      'city_drawing_public_value',
    ]) {
      const body = sql.match(new RegExp(
        `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+${helper}\\b([\\s\\S]*?)\\$function\\$\\s*;`,
        'iu',
      ))?.[1] ?? ''
      assert.match(body, /SET\s+search_path\s+FROM\s+CURRENT/iu, `${name}: ${helper}`)
      assert.doesNotMatch(body, /\bpublic\./iu, `${name}: ${helper} must bind to its install schema`)
    }
  }
})

test('kind variants and typed-thing selection are bounded and pinned to the current kind revision', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(contractMigrationUrl, 'utf8'),
  ])

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    assert.match(sql, /ALTER\s+TABLE\s+kind_revisions\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+drawing_variants\s+JSONB/iu, name)
    assert.match(sql, /jsonb_array_length\s*\(\s*(?:candidate|drawing_variants)[^)]*\)\s*>\s*8/iu, name)
    assert.match(
      sql,
      /variant_name\s*:=\s*variant->>'name'[\s\S]{0,120}octet_length\s*\(\s*variant_name\s*\)\s+NOT\s+BETWEEN\s+1\s+AND\s+64/iu,
      name,
    )
    assert.match(sql, /ALTER\s+TABLE\s+things\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+drawing_variant_name\s+TEXT/iu, name)
    assert.match(sql, /drawing_variant_name[\s\S]{0,700}current_revision/iu, name)
    assert.match(sql, /kind_id\s+IS\s+NOT\s+NULL[\s\S]{0,700}drawing\s+IS\s+NULL/iu, name)
    assert.match(sql, /kind_id\s+IS\s+NOT\s+NULL[\s\S]{0,900}drawing_state\s+IN\s*\(\s*'undrawn'\s*,\s*'refused'\s*\)/iu, name)
  }
})

test('every real drawing change has one public immutable exact before-and-after revision shape', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(contractMigrationUrl, 'utf8'),
  ])
  const requiredColumns = [
    'id',
    'target_type',
    'target_id',
    'slot_variant_name',
    'prior_state',
    'prior_description',
    'prior_drawing',
    'prior_source',
    'prior_kind_id',
    'prior_kind_revision',
    'prior_variant_name',
    'current_state',
    'current_description',
    'current_drawing',
    'current_source',
    'current_kind_id',
    'current_kind_revision',
    'current_variant_name',
    'author_id',
    'author_relation',
    'created_at',
  ] as const

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    const table = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+drawing_revisions\s*\(([\s\S]*?)\)\s*;/iu)?.[1]
    assert.ok(table, `${name}: missing drawing_revisions`)
    for (const column of requiredColumns) {
      assert.match(table, new RegExp(`\\b${column}\\b`, 'u'), `${name}: ${column}`)
    }
    assert.match(table, /target_type[\s\S]*'resident'[\s\S]*'place'[\s\S]*'thing'[\s\S]*'kind'/iu, name)
    assert.match(table, /drawing_revisions_prior_valid[\s\S]*valid_city_drawing_revision_value/iu, name)
    assert.match(table, /drawing_revisions_current_valid[\s\S]*valid_city_drawing_revision_value/iu, name)
    assert.match(sql, /value_source\s+IN\s*\(\s*'none'\s*,\s*'resident'\s*,\s*'place'\s*,\s*'thing'\s*,\s*'kind_base'\s*,\s*'kind_variant'\s*\)/iu, name)
    assert.match(sql, /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS[\s\S]{0,180}ON\s+drawing_revisions\s*\(\s*target_type\s*,\s*target_id\s*,\s*id\s+DESC\s*\)/iu, name)
    assert.match(sql, /CREATE\s+TRIGGER\s+drawing_revisions_append_only\s+BEFORE\s+UPDATE\s+OR\s+DELETE\s+ON\s+drawing_revisions/iu, name)
  }
})

test('the world stores the exact founder drawing while ordinary topology writes stay forbidden', async () => {
  const [schema, drawingsMigration, worldRootDrawingMigration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(baselineMigrationUrl, 'utf8'),
    readFile(worldRootDrawingMigrationUrl, 'utf8'),
  ])

  assertIncludesFounderWorldDrawing(schema, 'fresh and upgraded schema')
  assertIncludesFounderWorldDrawing(worldRootDrawingMigration, 'world-root drawing migration')
  for (const [name, sql] of [
    ['fresh and upgraded schema', schema],
    ['drawings migration', drawingsMigration],
    ['world-root drawing migration', worldRootDrawingMigration],
  ] as const) {
    assert.doesNotMatch(
      sql,
      /CONSTRAINT\s+places_world_shape[\s\S]{0,700}place_kind\s*=\s*'world'[\s\S]{0,500}drawing\s+IS\s+NULL/iu,
      name,
    )
  }
  assert.match(
    worldRootDrawingMigration,
    /ALTER\s+TABLE\s+places\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+places_world_shape/iu,
  )
  assert.match(
    worldRootDrawingMigration,
    /ALTER\s+TABLE\s+places\s+(?:ADD\s+)?CONSTRAINT\s+places_world_shape/iu,
  )
  assert.match(
    schema,
    /IF\s+OLD\.place_kind\s*=\s*'world'[\s\S]{0,160}world is transit only and immutable/iu,
  )
})
