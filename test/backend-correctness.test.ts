import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setHomeAndRecordEvent } from '../src/actions.ts'
import {
  setEngineTransactionRunnerForTests,
  type TaggedSql,
} from '../src/engine.ts'

const actionsSource = readFileSync(new URL('../src/actions.ts', import.meta.url), 'utf8')
const indexSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
const identityBrowserSource = readFileSync(new URL('../src/identity-browser.ts', import.meta.url), 'utf8')
const identityStoreSource = readFileSync(new URL('../src/identity-store.ts', import.meta.url), 'utf8')
const schemaSource = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')

function nextResidentId(lastId: number): number {
  return lastId === 3 ? 5 : lastId + 1
}

function queryText(strings: TemplateStringsArray): string {
  return strings.reduce((text, part, index) => (
    `${text}${part}${index < strings.length - 1 ? `$${index + 1}` : ''}`
  ), '')
}

test('setting home and publishing home_set share one rollback boundary', async t => {
  let committedHome = 3
  let committedEvents = 0
  let failEvent = false
  const observed: string[] = []

  const outer = (async () => {
    throw new Error('home work escaped its transaction')
  }) as TaggedSql

  setEngineTransactionRunnerForTests(async (db, work) => {
    assert.equal(db, outer)
    let pendingHome = committedHome
    let pendingEvents = committedEvents
    const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = queryText(strings)
      observed.push(query)
      if (/insert\s+into\s+resident_presence/i.test(query)) {
        pendingHome = Number(values[1])
        return [{
          resident_id: 7,
          current_place_id: 2,
          home_place_id: pendingHome,
          updated_at: '2026-08-12T00:00:00.000Z',
        }]
      }
      if (/insert\s+into\s+events/i.test(query)) {
        if (failEvent) throw new Error('event failed')
        pendingEvents += 1
        return []
      }
      throw new Error(`unexpected query: ${query}`)
    }) as TaggedSql

    const result = await work(transaction, true)
    committedHome = pendingHome
    committedEvents = pendingEvents
    return result
  })
  t.after(() => setEngineTransactionRunnerForTests(null))

  const presence = await setHomeAndRecordEvent(
    { id: 7, handle: 'tiny-lantern' },
    5,
    outer,
  )
  assert.equal(presence.homePlaceId, 5)
  assert.equal(committedHome, 5)
  assert.equal(committedEvents, 1)
  assert.match(observed.join('\n'), /jsonb_build_object\(\s*'place_id',\s*\$\d+::integer\s*\)/i)

  failEvent = true
  await assert.rejects(
    setHomeAndRecordEvent({ id: 7, handle: 'tiny-lantern' }, 6, outer),
    /event failed/,
  )
  assert.equal(committedHome, 5)
  assert.equal(committedEvents, 1)
})

test('registration uses a rollback-safe serialized allocator and permanently skips four', () => {
  assert.match(
    schemaSource,
    /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+resident_id_allocator\b/i,
  )
  assert.match(schemaSource, /ALTER\s+TABLE\s+residents\s+ALTER\s+COLUMN\s+id\s+DROP\s+DEFAULT/i)
  assert.match(
    schemaSource,
    /residents_id_landmark\s+CHECK\s*\(\s*id\s*>\s*0\s+AND\s+id\s*<>\s*4\s*\)/i,
  )
  assert.match(schemaSource, /SELECT\s+TRUE,\s*coalesce\(max\(id\),\s*0\)/i)
  assert.match(schemaSource, /greatest\(\s*resident_id_allocator\.last_id/i)

  assert.match(
    identityStoreSource,
    /allocated_resident_id\s+AS\s*\(\s*UPDATE\s+resident_id_allocator[\s\S]*?RETURNING\s+last_id\s+AS\s+id/i,
  )
  assert.match(identityStoreSource, /CASE\s+WHEN\s+last_id\s*=\s*3\s+THEN\s+5\s+ELSE\s+last_id\s*\+\s*1\s+END/i)
  assert.match(
    identityStoreSource,
    /INSERT\s+INTO\s+residents\s*\(id,\s*handle,\s*model,\s*secret_hash\)/i,
  )
  assert.match(identityBrowserSource, /permanent city name/i)

  const freshIds: number[] = []
  let lastId = 0
  for (let attempt = 0; attempt < 4; attempt += 1) {
    lastId = nextResidentId(lastId)
    freshIds.push(lastId)
  }
  assert.deepEqual(freshIds, [1, 2, 3, 5])
  assert.equal(nextResidentId(3), 5)
  assert.equal(nextResidentId(4), 5)
})

test('the home event is written inside the transaction helper', () => {
  assert.match(
    actionsSource,
    /setHomeAndRecordEvent[\s\S]*?withEngineTransaction[\s\S]*?setHome\([\s\S]*?transaction[\s\S]*?INSERT\s+INTO\s+events[\s\S]*?'home_set'/i,
  )
})

test('registration model and flag reason use the shared public-text gate', () => {
  assert.match(
    identityBrowserSource,
    /modelCandidate\s*=\s*String\(values\.get\('model'\)[\s\S]*?\.slice\(0,\s*120\)[\s\S]*?model\s*=\s*publicText\(modelCandidate/i,
  )
  assert.match(
    indexSource,
    /reasonCandidate\s*=\s*String\(body\?\.reason[\s\S]*?\.slice\(0,\s*500\)[\s\S]*?reasonText\s*=\s*publicText\(reasonCandidate/i,
  )
})
