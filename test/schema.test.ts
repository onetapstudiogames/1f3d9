import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const schema = read('../db/schema.sql')
const migrationsDirectory = new URL('../db/migrations/', import.meta.url)
const migrations = readdirSync(migrationsDirectory)
  .filter(name => name.endsWith('.sql'))
  .sort()
  .map(name => read(`../db/migrations/${name}`))
  .join('\n')

test('things persist an owner-controlled open-to-use flag that defaults closed', () => {
  assert.match(
    schema,
    /\bopen_to_use\s+boolean\s+not\s+null\s+default\s+false\b/iu,
    'fresh databases must default every thing to closed use',
  )
  assert.match(
    migrations,
    /alter\s+table\s+(?:public\.)?things[\s\S]{0,300}\badd\s+column(?:\s+if\s+not\s+exists)?\s+open_to_use\s+boolean\s+not\s+null\s+default\s+false\b/iu,
    'existing databases need an additive, closed-by-default migration',
  )
})

test('the flag bucket schema admits every configured hourly flag limit', () => {
  // Regression guard for the class of bug where a route-level limit exceeds a
  // column CHECK: the resident cap (20/hour) once collided with the old
  // CHECK (used BETWEEN 1 AND 5), turning a resident's sixth report into a
  // constraint failure. The caps live in src/index.ts; the schema keeps only
  // the sanity floor and each cap is enforced by the upsert's WHERE guard.
  const routeSource = read('../src/index.ts')
  const anonymousLimit = Number(/ANONYMOUS_FLAGS_PER_IP_HOUR = (\d+)/u.exec(routeSource)?.[1])
  const residentLimit = Number(/RESIDENT_FLAGS_PER_HOUR = (\d+)/u.exec(routeSource)?.[1])
  assert.ok(anonymousLimit >= 1, 'anonymous flag limit must be configured')
  assert.ok(residentLimit >= anonymousLimit, 'resident cap is the deliberately generous one')

  const bucketTable = /CREATE TABLE IF NOT EXISTS anonymous_flag_limits \(([\s\S]*?)\);/u.exec(schema)?.[1]
  assert.ok(bucketTable, 'flag bucket table exists in the fresh schema')
  assert.match(bucketTable, /used\s+SMALLINT NOT NULL DEFAULT 1 CHECK \(used >= 1\)/u,
    'the used column keeps only the sanity floor; a BETWEEN cap here breaks the larger caller limit')
  assert.match(
    migrations,
    /alter\s+table\s+anonymous_flag_limits[\s\S]{0,200}add\s+constraint\s+anonymous_flag_limits_used_check\s+check\s+\(used >= 1\)/iu,
    'existing databases need the constraint-widening migration',
  )
})
