import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const schemaUrl = new URL('../db/schema.sql', import.meta.url)
const migrationUrl = new URL('../db/migrations/20260827_drawings.sql', import.meta.url)

test('fresh and upgraded databases share one strict nullable drawing contract', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
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

test('drawing storage is overwrite-only, nullable, and carries no default or history table', async () => {
  const [schema, migration] = await Promise.all([
    readFile(schemaUrl, 'utf8'),
    readFile(migrationUrl, 'utf8'),
  ])

  for (const [name, sql] of [['fresh schema', schema], ['additive migration', migration]] as const) {
    assert.doesNotMatch(sql, /drawing\s+JSONB\s+(?:NOT\s+NULL|DEFAULT)/iu, name)
    assert.doesNotMatch(sql, /CREATE\s+TABLE[^;]*(?:drawing_history|drawing_versions)/iu, name)
  }
  assert.match(migration, /^BEGIN\s*;/iu)
  assert.match(migration, /ALTER\s+TABLE\s+places\s+VALIDATE\s+CONSTRAINT\s+places_drawing_valid/iu)
  assert.match(migration, /COMMIT\s*;\s*$/iu)
  assert.doesNotMatch(migration, /UPDATE\s+(?:residents|places|things|kind_revisions)\s+SET\s+drawing/iu)
})

test('the world shape and immutable topology continue to forbid a stored drawing', async () => {
  const schema = await readFile(schemaUrl, 'utf8')
  assert.match(
    schema,
    /CONSTRAINT\s+places_world_shape[\s\S]{0,700}place_kind\s*=\s*'world'[\s\S]{0,500}drawing\s+IS\s+NULL/iu,
  )
  assert.match(
    schema,
    /IF\s+OLD\.place_kind\s*=\s*'world'[\s\S]{0,160}world is transit only and immutable/iu,
  )
})
