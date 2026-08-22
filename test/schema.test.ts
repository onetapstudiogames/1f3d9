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

test('things retain an immutable maker separately from their transferable owner', () => {
  const thingsTable = /CREATE TABLE IF NOT EXISTS things \(([\s\S]*?)\);/u.exec(schema)?.[1]
  assert.ok(thingsTable, 'fresh schema must define things')
  assert.match(
    thingsTable,
    /\bmaker_id\s+INTEGER\s+NOT NULL\s+REFERENCES\s+residents\(id\)\s+ON\s+DELETE\s+RESTRICT\b/iu,
    'fresh things must retain their maker as a required resident',
  )
  assert.match(
    schema,
    /NEW\.maker_id\s+IS\s+NULL[\s\S]*NEW\.maker_id\s*:=\s*NEW\.owner_id[\s\S]*NEW\.maker_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.owner_id[\s\S]*RAISE\s+EXCEPTION/iu,
    'the insert-only rollout shim may fill an omitted maker but must reject an explicit mismatch',
  )
  assert.match(
    schema,
    /CREATE\s+TRIGGER\s+things_set_maker_on_insert\s+BEFORE\s+INSERT\s+ON\s+things/iu,
    'the compatibility shim must run only on insert',
  )
  assert.match(
    schema,
    /NEW\.maker_id\s+IS\s+DISTINCT\s+FROM\s+OLD\.maker_id[\s\S]*thing birth history is immutable/iu,
    'maker must join the immutable thing birth facts',
  )
})

test('later-holder marks are private deliberate pointers with lifecycle backstops and no reader state', () => {
  const markTable = /CREATE TABLE IF NOT EXISTS thing_later_holder_marks \(([\s\S]*?)\);/u
    .exec(schema)?.[1]
  assert.ok(markTable, 'fresh schema must define the private mark table')
  assert.match(markTable, /\bid\s+BIGSERIAL\s+PRIMARY\s+KEY\b/iu)
  assert.match(
    markTable,
    /\bresident_id\s+INTEGER\s+NOT\s+NULL\s+REFERENCES\s+residents\(id\)\s+ON\s+DELETE\s+RESTRICT\b/iu,
  )
  assert.match(
    markTable,
    /\bthing_id\s+INTEGER\s+NOT\s+NULL\s+UNIQUE\s+REFERENCES\s+things\(id\)\s+ON\s+DELETE\s+RESTRICT\b/iu,
  )
  assert.match(markTable, /\bmarked_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+clock_timestamp\(\)/iu)
  assert.doesNotMatch(
    markTable,
    /\b(?:opened|seen|delivered|dismissed|claimed|consumed|last_viewed|read_receipt|session|branch|holder)_/iu,
    'the city must store no delivery or opening state',
  )
  for (const source of [schema, migrations]) {
    assert.match(source, /CREATE\s+TRIGGER\s+thing_later_holder_marks_check_eligibility\s+BEFORE\s+INSERT/iu)
    assert.match(source, /thing\.maker_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.resident_id/iu)
    assert.match(source, /thing\.owner_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.resident_id/iu)
    assert.match(source, /CREATE\s+TRIGGER\s+things_end_later_holder_mark[\s\S]*UPDATE\s+OF\s+owner_id\s*,\s*withdrawn_at/iu)
    assert.match(source, /DELETE\s+FROM\s+thing_later_holder_marks[\s\S]*thing_id\s*=\s*NEW\.id/iu)
  }
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

test('room reading totals are maintained transactionally instead of rescanning every body', () => {
  assert.match(
    schema,
    /create\s+table\s+if\s+not\s+exists\s+place_reading_totals\s*\([\s\S]*?place_id\s+integer\s+primary\s+key[\s\S]*?subplace_items\s+integer[\s\S]*?subplace_text_bytes\s+bigint[\s\S]*?thing_items\s+integer[\s\S]*?thing_text_bytes\s+bigint[\s\S]*?note_items\s+integer[\s\S]*?note_text_bytes\s+bigint[\s\S]*?\)/iu,
    'fresh databases need one bounded counter row per place',
  )
  for (const trigger of [
    'places_update_reading_totals',
    'things_update_reading_totals',
    'notes_update_reading_totals',
  ]) {
    assert.match(schema, new RegExp(`create\\s+trigger\\s+${trigger}`, 'iu'), trigger)
    assert.match(migrations, new RegExp(`create\\s+trigger\\s+${trigger}`, 'iu'), `${trigger} migration`)
  }
  assert.match(
    migrations,
    /with\s+subplaces\s+as[\s\S]*?count\s*\(\s*\*\s*\)[\s\S]*?sum\s*\(\s*octet_length[\s\S]*?insert\s+into\s+place_reading_totals/iu,
    'the additive migration must backfill exact counts and UTF-8 byte totals before enabling triggers',
  )
  assert.match(
    migrations,
    /lock\s+table\s+places\s*,\s*things\s*,\s*notes\s+in\s+share\s+row\s+exclusive\s+mode/iu,
    'the migration must not miss a concurrent write between backfill and trigger installation',
  )
  assert.match(
    migrations,
    /perform\s+totals\.place_id[\s\S]*?order\s+by\s+totals\.place_id[\s\S]*?for\s+no\s+key\s+update/iu,
    'thing moves must lock affected room counters in one deterministic order',
  )
})
