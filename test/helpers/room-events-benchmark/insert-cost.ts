// The write cost the one-room events benchmark (scripts/benchmark-room-events.ts) measures:
// each single-row event insert timed inside the server, one statement per event as the app
// writes them, so the round trip to this machine's Docker does not hide the index's cost.
// It lives under test/helpers, outside the event-writer census and snapshot scans of src
// and scripts, because its insert only ever copies seeded rows into a disposable database
// the benchmark starts and stops itself. The caller fills room_events_insert_sample and
// creates room_events_insert_timing first.
import type { Pool } from 'pg'

const INSERT_COST_SQL = `DO $insert_cost$
  DECLARE sampled record; started timestamptz;
  BEGIN
    FOR sampled IN SELECT kind, actor, detail FROM room_events_insert_sample LOOP
      started := clock_timestamp();
      INSERT INTO events (kind, actor, detail) VALUES (sampled.kind, sampled.actor, sampled.detail);
      INSERT INTO room_events_insert_timing (micros) VALUES (extract(epoch FROM clock_timestamp() - started) * 1000000);
    END LOOP;
  END $insert_cost$`

export async function roomEventsInsertCost(pool: Pool) {
  await pool.query('TRUNCATE room_events_insert_timing')
  await pool.query(INSERT_COST_SQL)
  const row = (await pool.query(`SELECT count(*)::integer AS inserts,
      round(percentile_cont(0.5) WITHIN GROUP (ORDER BY micros))::integer AS median_micros,
      round(percentile_cont(0.99) WITHIN GROUP (ORDER BY micros))::integer AS p99_micros,
      round(max(micros))::integer AS max_micros
    FROM room_events_insert_timing`)).rows[0]!
  return Object.freeze({ inserts: row.inserts, medianMicros: row.median_micros, p99Micros: row.p99_micros, maxMicros: row.max_micros })
}
