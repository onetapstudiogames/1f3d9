import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

export const BENCHMARK_RESIDENT = Object.freeze({
  id: 1, handle: 'benchmark-1', secret: `1f3d9_sk_${'1'.repeat(48)}`,
})
export const BENCHMARK_ROOMS = Object.freeze({ busy: 3, quiet: 4, feed: 5, retired: 6 })

export const benchmarkSecret = (id: number): string => `1f3d9_sk_${String(id).padStart(48, '1')}`

/** Exact old schema with the final additive migration removed, retaining writer preparation. */
export function preparedBaselineSchema(schema: string, migration: string): string {
  const normalized = schema.replaceAll('\r\n', '\n')
  const marker = '-- Stored public activity summaries, decision #'
  const migrationBody = migration.replaceAll('\r\n', '\n')
  const startOfBody = migrationBody.indexOf(marker)
  assert(startOfBody >= 0, 'migration summary boundary is missing')
  const body = migrationBody.slice(startOfBody).replace(/\s*COMMIT;\s*$/, '').trim()
  const start = normalized.indexOf(body)
  assert(start >= 0, 'db/schema.sql must contain the exact stored activity migration body')
  assert.equal(normalized.indexOf(body, start + body.length), -1, 'migration body appears twice')
  return normalized.slice(0, start) + normalized.slice(start + body.length)
}

async function seedPeopleAndPlaces(db: Pool, baseTime: string): Promise<void> {
  const hashes = Array.from({ length: 10 }, (_, index) => createHash('sha256').update(benchmarkSecret(index + 1)).digest('hex'))
  await db.query(`INSERT INTO residents(id,handle,model,secret_hash,joined_at)
    SELECT n,'benchmark-'||n,'activity-benchmark',CASE WHEN n<=10 THEN ($1::text[])[n] ELSE md5('a'||n)||md5('b'||n) END,
      $2::timestamptz-interval '120 days' FROM generate_series(1,454) n WHERE n<>4`, [hashes, baseTime])
  await db.query('UPDATE resident_id_allocator SET last_id=454 WHERE singleton')
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes,created_at)
    VALUES (2,1,'continent','Benchmark continent','Deterministic test land.',1,true,$1::timestamptz-interval '120 days')`, [baseTime])
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes,quiet,feed,created_at,retired_at)
    SELECT n,CASE WHEN n>10 AND n%10=0 THEN 5 ELSE 2 END,'place','Benchmark room '||n,
      'Deterministic test room.',1,true,n IN (4,5),n=5,$1::timestamptz-interval '120 days',
      CASE WHEN n=6 THEN $1::timestamptz-interval '110 days' ELSE NULL END
    FROM generate_series(3,1400) n WHERE n<>454`, [baseTime])
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,founding_name,description,purpose,owner_id,
      open_to_building,open_to_things,open_to_notes)
    VALUES(454,2,'place','the gazette submission room',NULL,
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '',1,false,false,false)`)
  await db.query(await readFile(new URL('../../../db/migrations/20260827_gazette_room_activation.sql', import.meta.url), 'utf8'))
  await db.query(`INSERT INTO resident_presence(resident_id,current_place_id,home_place_id)
    SELECT id,3,3 FROM residents`)
}

// The formula covers 96 days, leaves room 4 and most residents 405 through 453 empty,
// and directs one third of related records to the busy room.
const ROOM = `CASE WHEN n%3=0 THEN 3 ELSE CASE WHEN 7+n%1393=454 THEN 455 ELSE 7+n%1393 END END`
const WHEN = `$3::timestamptz-((n*211)%138240)*interval '1 minute'`

async function seedNotes(db: Pool, first: number, last: number, baseTime: string): Promise<void> {
  await db.query(`WITH written AS (
    INSERT INTO notes(place_id,author_id,body,created_at)
    SELECT ${ROOM},5+n%400,'Benchmark note '||n,${WHEN}
    FROM generate_series($1::int,$2::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'note',r.handle,w.created_at,jsonb_build_object('note_id',w.id,'place_id',w.place_id)
    FROM written w JOIN residents r ON r.id=w.author_id`, [first, last, baseTime])
}

async function seedLines(db: Pool, first: number, last: number, baseTime: string): Promise<void> {
  await db.query(`WITH written AS (
    INSERT INTO room_lines(place_id,resident_id,body,body_bytes,request_id,created_at)
    SELECT ${ROOM},5+n%400,'Benchmark line '||n,octet_length('Benchmark line '||n),
      md5('activity-line-'||n)::uuid,${WHEN} FROM generate_series($1::int,$2::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'line_said',r.handle,w.created_at,jsonb_build_object('line_id',w.id,'place_id',w.place_id)
    FROM written w JOIN residents r ON r.id=w.resident_id`, [first, last, baseTime])
}

async function seedActions(db: Pool, first: number, last: number, baseTime: string): Promise<void> {
  await db.query(`WITH written AS (
    INSERT INTO action_runs(actor_id,action_name,place_id,destination_place_id,created_at)
    SELECT 5+n%400,'move',3,${ROOM},${WHEN} FROM generate_series($1::int,$2::int) n RETURNING *),
    resolved AS (
      INSERT INTO action_resolutions(action_run_id,status,detail,resolved_at)
      SELECT id,CASE WHEN id%5=0 THEN 'blocked' WHEN id%7=0 OR destination_place_id=place_id THEN 'noop' ELSE 'applied' END,
        jsonb_build_object('from_place_id',place_id,'to_place_id',destination_place_id),created_at
      FROM written RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'action',r.handle,w.created_at,jsonb_build_object('action_id',w.id,'action','move','status',s.status,
      'place_id',w.place_id,'from_place_id',w.place_id,'to_place_id',w.destination_place_id)
    FROM written w JOIN resolved s ON s.action_run_id=w.id JOIN residents r ON r.id=w.actor_id`, [first, last, baseTime])
}

async function seedPings(db: Pool, first: number, last: number, baseTime: string): Promise<void> {
  await db.query(`WITH written AS (
    INSERT INTO pings(place_id,sender_id,target_id,sent_at,expires_at,sender_arrived_at,target_arrived_at)
    SELECT ${ROOM},5+n%400,5+(n+1)%400,${WHEN},${WHEN}+interval '5 minutes',
      ${WHEN}-interval '1 hour',${WHEN}-interval '1 hour'
    FROM generate_series($1::int,$2::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'ping_sent',r.handle,w.sent_at,jsonb_build_object('ping_id',w.id,'place_id',w.place_id,'target_id',w.target_id)
    FROM written w JOIN residents r ON r.id=w.sender_id`, [first, last, baseTime])
}

async function seedHistoryEdges(db: Pool, baseTime: string): Promise<void> {
  await db.query(`WITH made AS (
    INSERT INTO things(place_id,name,body,owner_id,maker_id,created_at)
    SELECT 3,'Benchmark moved thing '||n,'A related history fixture.',5,5,$1::timestamptz-interval '95 days'
    FROM generate_series(1,20) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'thing_created','benchmark-5',created_at,jsonb_build_object('thing_id',id,'place_id',place_id) FROM made`, [baseTime])
  await db.query(`WITH moved AS (UPDATE things SET place_id=7 RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'thing_moved','benchmark-5',$1::timestamptz-interval '94 days',
      jsonb_build_object('thing_id',id,'from_place_id',3,'place_id',7) FROM moved`, [baseTime])
  await db.query(`WITH labeled AS (
    INSERT INTO active_labels(target_type,target_id,label,actor_id,source_place_id,created_at)
    SELECT 'thing',id,'benchmark-label',5,7,$1::timestamptz-interval '93 days' FROM things RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'effect_resolved','benchmark-5',created_at,jsonb_build_object('status','applied','effect','label',
      'thing_id',target_id,'place_id',7,'applied_public_activity',jsonb_build_array(jsonb_build_object(
        'actor','benchmark-5','place_id',7,'operation','label'))) FROM labeled`, [baseTime])
  await db.query(`INSERT INTO events(kind,actor,at,detail)
    SELECT 'action','benchmark-5',$1::timestamptz-interval '92 days',
      jsonb_build_object('action','use','status','applied','thing_id',100000+n)
    FROM generate_series(1,20) n`, [baseTime])
  await db.query(`WITH written AS (
    INSERT INTO notes(place_id,author_id,body,created_at)
    VALUES(3,452,'A public note before choosing omission.',$1::timestamptz-interval '30 minutes') RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'note','benchmark-452',created_at,jsonb_build_object('note_id',id,'place_id',place_id) FROM written`, [baseTime])
}

export async function seedBenchmark(db: Pool, schema: string, events: number, baseTime: string) {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await db.query(schema)
  await seedPeopleAndPlaces(db, baseTime)
  await seedHistoryEdges(db, baseTime)
  const parts = [
    { stop: Math.floor(events * 0.5), seed: seedNotes },
    { stop: Math.floor(events * 0.75), seed: seedLines },
    { stop: Math.floor(events * 0.9), seed: seedActions },
    { stop: events - 82, seed: seedPings },
  ]
  let next = 1
  for (const part of parts) {
    for (; next <= part.stop; next += 1000) {
      const end = Math.min(next + 999, part.stop)
      await part.seed(db, next, end, baseTime)
      if (end === part.stop) { next = end + 1; break }
    }
  }
  await db.query('ANALYZE')
  const counts = await benchmarkCounts(db)
  assert.equal(counts.residents, 453)
  assert.equal(counts.places, 1400)
  assert.equal(counts.events, events)
  assert(Number(counts.span_seconds) >= 90 * 86400)
  return counts
}

export async function benchmarkCounts(db: Pool): Promise<Record<string, unknown>> {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM residents) residents,(SELECT count(*)::int FROM places) places,
    (SELECT count(*)::int FROM events) events,(SELECT count(*)::int FROM notes) notes,
    (SELECT count(*)::int FROM room_lines) lines,(SELECT count(*)::int FROM action_runs) actions,
    (SELECT count(*)::int FROM pings) pings,
    (SELECT count(*)::int FROM events WHERE detail->>'status' IN ('blocked','noop')) refused_or_noop,
    (SELECT extract(epoch FROM max(at)-min(at)) FROM events) span_seconds,
    (SELECT md5(string_agg(id||':'||kind||':'||actor||':'||detail::text,',' ORDER BY id)) FROM events) checksum`)).rows[0]!
}
