import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

async function source(path: string): Promise<string> {
  return readFile(new URL(path, root), 'utf8')
}

test('public changes are commit-serialized by one transactional database row', async () => {
  const [schema, migration] = await Promise.all([
    source('db/schema.sql'),
    source('db/migrations/20260821_public_change_markers.sql'),
  ])

  for (const [name, ddl] of [['schema', schema], ['migration', migration]] as const) {
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS public_change_state/i, `${name}: state table`)
    assert.match(ddl, /current_change_id\s+BIGINT\s+NOT NULL/i, `${name}: bigint marker`)
    assert.match(ddl, /CREATE TABLE IF NOT EXISTS public_change_log/i, `${name}: append-only log`)
    assert.match(ddl, /change_id\s+BIGINT\s+(?:PRIMARY KEY|NOT NULL)/i, `${name}: logged marker`)
    assert.match(ddl, /event_id\s+INTEGER\s+(?:UNIQUE|NOT NULL)/i, `${name}: logged event`)
    assert.match(ddl, /UPDATE public_change_state[\s\S]*current_change_id\s*=\s*current_change_id\s*\+\s*1[\s\S]*RETURNING current_change_id/iu,
      `${name}: row-locked increment`)
    assert.match(ddl, /INSERT INTO public_change_log\s*\(\s*change_id\s*,\s*event_id\s*\)[\s\S]{0,160}NEW\.id/iu,
      `${name}: the event is mapped inside its transaction`)
    assert.match(ddl, /AFTER INSERT ON events[\s\S]*record_public_change/iu,
      `${name}: every committed event uses the allocator`)
    assert.doesNotMatch(ddl, /last_value|MAX\s*\(\s*(?:event\.)?id\s*\)[\s\S]{0,100}(?:marker|change)/iu,
      `${name}: serial allocation order is not commit order`)
  }
})

test('the append-only event history cannot rewrite an issued change marker', async () => {
  const schema = await source('db/schema.sql')
  assert.match(schema, /CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events/iu)
})

test('thing movement emits an addressable public change in the same transaction', async () => {
  const [effects, publicEvents] = await Promise.all([
    source('src/engine-effects.ts'),
    source('src/public-events.ts'),
  ])
  assert.match(effects, /INSERT INTO events \(kind, actor, detail\)[\s\S]{0,300}'thing_moved'/iu)
  assert.match(effects, /thing_id/iu)
  assert.match(effects, /from_place_id/iu)
  assert.match(effects, /place_id/iu)
  assert.match(publicEvents, /thing_moved:\s*'moved a thing'/u)
})
