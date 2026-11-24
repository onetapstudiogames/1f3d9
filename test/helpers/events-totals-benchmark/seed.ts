// Seeds the events totals benchmark (scripts/benchmark-events-totals.ts) on its disposable
// local PostgreSQL. It lives beside the other benchmark fixtures under test/helpers, outside
// the event-writer census and snapshot scans of src and scripts, because it only ever writes
// throwaway rows into a database the benchmark starts and stops itself.
import type { Pool } from 'pg'

const ROOMS = 1_500
const FEED_ROOMS = 12
const BATCH = 25_000

// A kind mix close to the live list: mostly actions with applied outcomes, then notes,
// lines, thing events named by thing_id only, transfers, pings and about 30 rarer kinds.
const SEED_SQL = `
  WITH numbered AS (
    SELECT n, (hashtext(n::text) & 2147483647) AS h FROM generate_series($1::integer, $2::integer) n
  ), picked AS (
    SELECT n, h, h % 1000 AS bucket,
      (SELECT array_agg(id ORDER BY id) FROM places WHERE place_kind = 'place') AS rooms,
      (SELECT max(id) FROM things) AS max_thing, (SELECT min(id) FROM things) AS min_thing
    FROM numbered
  )
  INSERT INTO events (kind, actor, detail)
  SELECT
    CASE WHEN bucket < 400 THEN 'action' WHEN bucket < 600 THEN 'note' WHEN bucket < 700 THEN 'line_said'
      WHEN bucket < 760 THEN 'thing_edited' WHEN bucket < 790 THEN 'thing_moved' WHEN bucket < 820 THEN 'thing_created'
      WHEN bucket < 900 THEN 'transfer' WHEN bucket < 930 THEN 'ping_sent'
      ELSE 'rare_kind_' || (h % 30) END,
    (ARRAY['founder', 'grower', 'neighbour'])[1 + h % 3],
    CASE
      WHEN bucket < 400 THEN jsonb_build_object('applied_public_activity', (
        SELECT jsonb_agg(jsonb_build_object('target_type', CASE WHEN step = 2 AND h % 5 = 0 THEN 'place' ELSE 'thing' END,
          'operation', 'move', 'place_id', rooms[1 + ((h / (step + 1)) % array_length(rooms, 1))], 'actor', 'founder'))
        FROM generate_series(0, h % 3) step), 'body', CASE WHEN h % 4 = 0 THEN repeat('a', 40 + h % 200) END)
      WHEN bucket < 700 THEN jsonb_build_object('place_id', rooms[1 + (h % array_length(rooms, 1))],
        'body', repeat('b', 40 + h % 360))
      WHEN bucket < 820 THEN jsonb_build_object('thing_id', min_thing + h % (max_thing - min_thing + 1),
        'description', repeat('c', h % 120))
      WHEN bucket < 900 THEN jsonb_build_object('asset_type', 'thing', 'asset_id', min_thing + h % (max_thing - min_thing + 1), 'reason', 'trade')
      WHEN bucket < 930 THEN jsonb_build_object('place_id', rooms[1 + (h % array_length(rooms, 1))])
      ELSE jsonb_build_object('note', repeat('d', h % 60))
    END
  FROM picked ORDER BY n`

export async function seedEventsTotalsBenchmark(pool: Pool, events: number, continentId: number): Promise<void> {
  await seedEventsTotalsBenchmarkRooms(pool, events, continentId)
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_stamp_public_activity')
  for (let start = 1; start <= events; start += BATCH) {
    await seedEventsTotalsBenchmarkBatch(pool, start, Math.min(events, start + BATCH - 1))
  }
  await pool.query('ALTER TABLE events ENABLE TRIGGER events_stamp_public_activity')
  await pool.query('VACUUM ANALYZE')
}

/** The benchmark's rooms, feed rooms and things, before any event lands. */
export async function seedEventsTotalsBenchmarkRooms(pool: Pool, events: number, continentId: number): Promise<void> {
  // Room ids from 2001 up, clear of the city's reserved rooms (the Gazette room is #454).
  await pool.query("SELECT setval(pg_get_serial_sequence('places', 'id'), 2000)")
  await pool.query(`INSERT INTO places (parent_id, place_kind, name, description, owner_id, open_to_notes, open_to_things)
    SELECT $1, 'place', 'Room ' || n, 'a benchmark room', 1, TRUE, TRUE FROM generate_series(1, $2::integer) n`, [continentId, ROOMS])
  // Feed rooms are set before the events land: setting one later recomputes its rooms'
  // activity over every event, which the totals never read.
  await pool.query(`UPDATE places SET quiet = TRUE, feed = TRUE WHERE id IN (
    SELECT id FROM places WHERE place_kind = 'place' ORDER BY id OFFSET 100 LIMIT ${FEED_ROOMS})`)
  await pool.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
    SELECT (SELECT id FROM places WHERE place_kind = 'place' ORDER BY id OFFSET (n % ${ROOMS}) LIMIT 1), 'thing ' || n, 'a benchmark thing', 1, 1
    FROM generate_series(1, $1::integer) n`, [Math.round(events / 45)])
}

/**
 * One batch of the seeded event mix, numbered first to last. The caller turns the activity
 * stamp trigger off around the batches: it only moves residents' and rooms' last-activity
 * times, which these totals never read, and per seeded row it would rewrite the same few
 * rows. The change-marker trigger, which these totals rest on, stays on.
 */
export async function seedEventsTotalsBenchmarkBatch(pool: Pool, first: number, last: number): Promise<void> {
  await pool.query(SEED_SQL, [first, last])
}

export const EVENTS_TOTALS_BENCHMARK_BATCH = BATCH
