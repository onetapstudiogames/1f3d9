import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'
import { benchmarkCounts } from './fixture.ts'

export const productionShape = Object.freeze({
  events: 353849, action_runs: 255875, action_resolutions: 255875,
  notes: 41088, room_lines: 12604, pings: 1718, residents: 459, places: 1418,
})

const room = `CASE WHEN n%3=0 THEN 3 WHEN 7+n%1414=454 THEN 455 ELSE 7+n%1414 END`
const time = `$2::timestamptz-((n*211)%138240)*interval '1 minute'`

async function batches(db: Pool, statement: string, values: unknown[]) {
  const count = Number(values[0])
  for (let first = 1; first <= count; first += 1000) {
    const last = Math.min(first + 999, count)
    await db.query(statement.replace('generate_series(1,$1::int)', `generate_series(${first},$1::int)`),
      [last, ...values.slice(1)])
  }
}

export async function seedProductionBenchmark(db: Pool, schema: string, eventCount = 400000) {
  const baseTime = '2026-10-27T12:00:00Z'
  const scaled = (count: number) => Math.round(count * eventCount / productionShape.events)
  const publicMix = JSON.parse(await readFile('logs/fix4/public-kind-counts.json', 'utf8')) as {
    events: number; kinds: Record<string, number>; actions: Record<string, number>; source: string
  }
  const kindCounts = Object.fromEntries(Object.entries(publicMix.kinds)
    .map(([kind, count]) => [kind, Math.round(count * eventCount / publicMix.events)]))
  kindCounts.undefined! += eventCount - Object.values(kindCounts).reduce((sum, count) => sum + count, 0)
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await db.query(schema)
  await db.query(`INSERT INTO residents(id,handle,model,secret_hash,joined_at)
    SELECT n,'benchmark-'||n,'activity-benchmark',md5('a'||n)||md5('b'||n),
      $1::timestamptz-interval '120 days' FROM generate_series(1,461) n WHERE n<>4`, [baseTime])
  await db.query('UPDATE resident_id_allocator SET last_id=461 WHERE singleton')
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes,created_at)
    VALUES(2,1,'continent','Benchmark continent','Deterministic test land.',1,true,$1::timestamptz-interval '120 days')`, [baseTime])
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,description,owner_id,open_to_notes,quiet,feed,created_at)
    SELECT n,CASE WHEN n>10 AND n%10=0 THEN 5 ELSE 2 END,'place','Benchmark room '||n,
      'Deterministic test room.',1,true,n IN(4,5),n=5,$1::timestamptz-interval '120 days'
    FROM generate_series(3,1420) n WHERE n<>454`, [baseTime])
  await db.query(`INSERT INTO places(id,parent_id,place_kind,name,founding_name,description,purpose,owner_id,
    open_to_building,open_to_things,open_to_notes)
    VALUES(454,2,'place','the gazette submission room',NULL,
      'The Gazette submission room is being prepared. Notes are closed until the weekly printer, per-resident submission limit, and permanent archive are live. Nothing left elsewhere is waiting for print.',
      '',1,false,false,false)`)
  await db.query(`INSERT INTO resident_presence(resident_id,current_place_id,home_place_id)
    SELECT id,3,3 FROM residents`)
  await batches(db, `WITH written AS (
    INSERT INTO notes(place_id,author_id,body,created_at)
    SELECT ${room},5+n%400,'Benchmark note '||n,${time} FROM generate_series(1,$1::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'note',r.handle,w.created_at,jsonb_build_object('note_id',w.id,'place_id',w.place_id)
    FROM written w JOIN residents r ON r.id=w.author_id`, [scaled(productionShape.notes), baseTime])
  await batches(db, `WITH written AS (
    INSERT INTO room_lines(place_id,resident_id,body,body_bytes,request_id,created_at)
    SELECT ${room},5+n%400,'Benchmark line '||n,octet_length('Benchmark line '||n),
      md5('activity-line-'||n)::uuid,${time} FROM generate_series(1,$1::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'line_said',r.handle,w.created_at,jsonb_build_object('line_id',w.id,'place_id',w.place_id)
    FROM written w JOIN residents r ON r.id=w.resident_id WHERE w.id<=$3`, [scaled(productionShape.room_lines), baseTime, kindCounts.line_said])
  await batches(db, `WITH written AS (
    INSERT INTO pings(place_id,sender_id,target_id,sent_at,expires_at,sender_arrived_at,target_arrived_at)
    SELECT ${room},5+n%400,5+(n+1)%400,${time},${time}+interval '5 minutes',
      ${time}-interval '1 hour',${time}-interval '1 hour' FROM generate_series(1,$1::int) n RETURNING *)
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'ping_sent',r.handle,w.sent_at,jsonb_build_object('ping_id',w.id,'place_id',w.place_id,'target_id',w.target_id)
    FROM written w JOIN residents r ON r.id=w.sender_id WHERE w.id<=$3`, [scaled(productionShape.pings), baseTime, kindCounts.ping_sent])
  const actionShape = []
  let offset = 0
  const actionEntries = Object.entries(publicMix.actions)
  for (const [index, [key, count]] of actionEntries.entries()) {
    const [action, status, effects] = key.split(':')
    const size = index === actionEntries.length - 1 ? kindCounts.action! - offset
      : Math.round(count * eventCount / publicMix.events)
    actionShape.push({ first: offset + 1, last: offset + size, action, status, effects })
    offset += size
  }
  await db.query(`CREATE TEMP TABLE benchmark_action_shape AS
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(first int,last int,action text,status text,effects text)`, [JSON.stringify(actionShape)])
  await db.query(`
    INSERT INTO action_runs(actor_id,action_name,place_id,destination_place_id,created_at)
    SELECT 5+n%400,CASE WHEN shape.action='unknown' THEN 'use' ELSE coalesce(shape.action,'move') END,
      3,CASE WHEN coalesce(shape.action,'move') IN('move','go_home') THEN
        CASE WHEN ${room}=3 THEN 7 ELSE ${room} END END,${time}
    FROM generate_series(1,$1::int) n LEFT JOIN benchmark_action_shape shape ON n BETWEEN shape.first AND shape.last`,
  [scaled(productionShape.action_runs), baseTime])
  await db.query(`INSERT INTO action_resolutions(action_run_id,status,detail,resolved_at)
    SELECT action.id,coalesce(shape.status,'applied'),
      jsonb_build_object('from_place_id',action.place_id,'to_place_id',action.destination_place_id),action.created_at
    FROM action_runs action LEFT JOIN benchmark_action_shape shape ON action.id BETWEEN shape.first AND shape.last`)
  await db.query('ANALYZE action_runs; ANALYZE action_resolutions')
  await batches(db, `
    INSERT INTO events(kind,actor,at,detail)
    SELECT 'action',r.handle,w.created_at,jsonb_build_object('action_id',w.id,'status',shape.status)
      || CASE WHEN shape.action='unknown' THEN '{}'::jsonb ELSE jsonb_build_object('action',shape.action) END
      || CASE WHEN shape.effects='missing' THEN '{}'::jsonb ELSE jsonb_build_object('effects_applied',shape.effects::int) END
      || CASE WHEN shape.action IN('move','go_home') AND shape.status='applied'
        THEN jsonb_build_object('from_place_id',w.place_id,'to_place_id',w.destination_place_id)
        ELSE jsonb_build_object('place_id',w.place_id) END
    FROM generate_series(1,$1::int) n JOIN action_runs w ON w.id=n
    JOIN benchmark_action_shape shape ON w.id BETWEEN shape.first AND shape.last
    JOIN residents r ON r.id=w.actor_id`, [kindCounts.action])
  const ordinaryKinds = Object.keys(kindCounts).filter(kind => !['action','note','line_said','ping_sent'].includes(kind))
  const orderedKinds = ['thing_created', 'thing_crafted', 'thing_moved', ...ordinaryKinds.filter(kind =>
    !['thing_created','thing_crafted','thing_moved'].includes(kind))]
  const thingCount = kindCounts.thing_created! + kindCounts.thing_crafted!
  for (const kind of orderedKinds) {
    const thingOffset = kind === 'thing_crafted' ? kindCounts.thing_created! : 0
    await batches(db, `INSERT INTO events(kind,actor,at,detail)
      SELECT $3,'benchmark-'||(5+n%400),${time},
        CASE WHEN $3='room_settled' THEN '{}'::jsonb
          WHEN $3 IN('thing_created','thing_crafted') THEN jsonb_build_object('place_id',${room},'thing_id',n+$4::int)
          WHEN $3='thing_moved' THEN jsonb_build_object('place_id',7,'from_place_id',
            CASE WHEN n%3=0 THEN 3 WHEN 7+n%1414=454 THEN 455 ELSE 7+n%1414 END,'thing_id',n)
          WHEN $3='thing_edited' THEN jsonb_build_object('thing_id',1+(n-1)%$5::int) ||
            CASE WHEN n<=$6 THEN '{}'::jsonb ELSE jsonb_build_object('place_id',${room}) END
          WHEN $3='laws_changed' THEN jsonb_build_object('place_id',${room},'traits',jsonb_build_array('benchmark-'||n))
          WHEN $3='effect_resolved' THEN jsonb_build_object('place_id',${room},'status','applied','effects_applied',0)
          ELSE jsonb_build_object('place_id',${room}) END
      FROM generate_series(1,$1::int) n`, [kindCounts[kind], baseTime,
      kind === 'undefined' ? 'room_settled' : kind, thingOffset, thingCount,
      Math.round(kindCounts.thing_edited! * 5045 / 44000)])
  }
  await db.query('ANALYZE')
  const counts = await benchmarkCounts(db)
  assert.equal(counts.events, eventCount)
  assert.equal(counts.residents, 460)
  assert.equal(counts.places, 1420)
  const kinds = (await db.query('SELECT kind,count(*)::int AS count FROM events GROUP BY kind ORDER BY count(*) DESC,kind')).rows
  const resolutions = Number((await db.query('SELECT count(*) FROM action_resolutions')).rows[0]!.count)
  return { ...counts, resolutions, kinds, baseTime, productionShape, source: publicMix.source,
    withheld: 'The public snapshot withholds kind for 18957 rows. These become room_settled rows.' }
}
