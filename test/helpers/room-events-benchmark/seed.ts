// Seeds the one-room events benchmark (scripts/benchmark-room-events.ts) on its disposable
// local PostgreSQL: the events totals benchmark's city-wide mix, plus one busy square with
// twenty rooms below it on two levels (one a feed room) and one small room. Their events
// land between the city-wide batches, so a room's history is spread through the whole
// list the way a live room's is. It lives under test/helpers, outside the event-writer
// census and snapshot scans of src and scripts, because it only ever writes throwaway rows
// into a database the benchmark starts and stops itself.
import type { Pool } from 'pg'
import {
  EVENTS_TOTALS_BENCHMARK_BATCH,
  seedEventsTotalsBenchmarkBatch,
  seedEventsTotalsBenchmarkRooms,
} from '../events-totals-benchmark/seed.ts'

export type RoomEventsBenchmarkRooms = Readonly<{ squareId: number; feedBelowId: number; smallRoomId: number }>

const SQUARE_SHARE = 0.03
const SMALL_ROOM_EVENTS = 50

async function one(pool: Pool, text: string, params: readonly unknown[] = []): Promise<number> {
  return Number((await pool.query<{ id: number }>(text, [...params])).rows[0]!.id)
}

const room = (pool: Pool, parentId: number, name: string) => one(pool, `INSERT INTO places
  (parent_id, place_kind, name, description, owner_id, open_to_notes, open_to_things)
  VALUES ($1, 'place', $2, 'a benchmark room', 1, TRUE, TRUE) RETURNING id`, [parentId, name])

async function seedSquare(pool: Pool, continentId: number): Promise<RoomEventsBenchmarkRooms> {
  const squareId = await room(pool, continentId, 'Benchmark Square')
  const below: number[] = []
  for (let child = 0; child < 4; child += 1) {
    const childId = await room(pool, squareId, `Square side ${child}`)
    below.push(childId)
    for (let grandchild = 0; grandchild < 4; grandchild += 1) {
      below.push(await room(pool, childId, `Square corner ${child}.${grandchild}`))
    }
  }
  const feedBelowId = below[5]!
  await pool.query('UPDATE places SET quiet = TRUE, feed = TRUE WHERE id = $1', [feedBelowId])
  const smallRoomId = await room(pool, continentId, 'Benchmark Small Room')
  await pool.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
    SELECT $1, 'square thing ' || n, 'a square thing', 1, 1 FROM generate_series(1, 120) n`, [squareId])
  await pool.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id, withdrawn_at)
    SELECT $1, 'withdrawn square thing ' || n, 'gone', 1, 1, now() FROM generate_series(1, 10) n`, [squareId])
  await pool.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
    SELECT below.id, 'corner thing ' || n, 'a corner thing', 1, 1
    FROM unnest($1::integer[]) below(id), generate_series(1, 10) n`, [below])
  await pool.query(`INSERT INTO things (place_id, name, body, owner_id, maker_id)
    SELECT $1, 'small thing ' || n, 'a small thing', 1, 1 FROM generate_series(1, 5) n`, [smallRoomId])
  await pool.query(`INSERT INTO notes (place_id, author_id, body)
    SELECT $1, 1, 'a square note ' || n FROM generate_series(1, 1100) n`, [squareId])
  await pool.query(`INSERT INTO notes (place_id, author_id, body)
    SELECT below.id, 1, 'a corner note ' || n FROM unnest($1::integer[]) below(id), generate_series(1, 20) n`, [below])
  await pool.query(`INSERT INTO notes (place_id, author_id, body)
    SELECT $1, 1, 'a small note ' || n FROM generate_series(1, 10) n`, [smallRoomId])
  await pool.query(`INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
    SELECT 'direct', 'thing', thing.id, 1, 2, 1.5, '0x' || repeat('a', 40)
    FROM (SELECT id FROM things WHERE place_id = $1 AND withdrawn_at IS NULL ORDER BY id LIMIT 30) thing`, [squareId])
  await pool.query(`INSERT INTO transfer_offers (channel, asset_type, asset_id, seller_id, buyer_id, price_usdc, seller_wallet)
    VALUES ('direct', 'place', $1, 1, 2, 9, '0x' || repeat('b', 40))`, [below[0]!])
  return Object.freeze({ squareId, feedBelowId, smallRoomId })
}

// The square's and the small room's events, in every detail shape a room read matches.
const ROOM_EVENTS_SQL = `
  WITH tree AS (
    SELECT array_agg(id ORDER BY id) AS rooms FROM places
    WHERE id = $1 OR parent_id = $1 OR parent_id IN (SELECT id FROM places WHERE parent_id = $1)
  ), pools AS (
    SELECT tree.rooms,
      (SELECT array_agg(thing.id ORDER BY thing.id) FROM things thing WHERE thing.place_id = ANY(tree.rooms)) AS things,
      (SELECT array_agg(note.id ORDER BY note.id) FROM notes note WHERE note.place_id = ANY(tree.rooms)) AS notes,
      (SELECT array_agg(offer.id ORDER BY offer.id) FROM transfer_offers offer) AS offers
    FROM tree
  ), numbered AS (
    SELECT n, (hashtext('room ' || n::text) & 2147483647) AS h FROM generate_series($2::integer, $3::integer) n
  )
  INSERT INTO events (kind, actor, detail)
  SELECT
    (ARRAY['action', 'note', 'line_said', 'thing_edited', 'transfer', 'place_edited', 'offer_made', 'thing_moved'])[1 + h % 8],
    (ARRAY['founder', 'grower', 'neighbour'])[1 + h % 3],
    CASE h % 8
      WHEN 0 THEN jsonb_build_object('applied_public_activity', jsonb_build_array(jsonb_build_object(
        'target_type', 'thing', 'operation', 'move', 'actor', 'founder',
        'place_id', rooms[1 + (h / 8) % array_length(rooms, 1)])))
      WHEN 1 THEN jsonb_build_object('note_id', notes[1 + (h / 8) % array_length(notes, 1)],
        'place_id', rooms[1 + (h / 8) % array_length(rooms, 1)], 'body', repeat('n', 40 + h % 200))
      WHEN 2 THEN jsonb_build_object('place_id', rooms[1 + (h / 8) % array_length(rooms, 1)], 'body', repeat('l', 40 + h % 100))
      WHEN 3 THEN jsonb_build_object('thing_id', things[1 + (h / 8) % array_length(things, 1)])
      WHEN 4 THEN jsonb_build_object('asset_type', 'thing', 'asset_id', things[1 + (h / 8) % array_length(things, 1)], 'reason', 'trade')
      WHEN 5 THEN jsonb_build_object('type', 'place', 'id', rooms[1 + (h / 8) % array_length(rooms, 1)])
      WHEN 6 THEN jsonb_build_object('offer_id', offers[1 + (h / 8) % array_length(offers, 1)])
      ELSE jsonb_build_object('thing_id', things[1 + (h / 8) % array_length(things, 1)],
        'from_place_id', rooms[1 + (h / 8) % array_length(rooms, 1)], 'to_place_id', rooms[1 + (h / 16) % array_length(rooms, 1)])
    END
  FROM pools, numbered ORDER BY n`

/** The totals benchmark's city, with the square's and the small room's events spread through it. */
export async function seedRoomEventsBenchmark(pool: Pool, events: number, continentId: number): Promise<RoomEventsBenchmarkRooms> {
  await seedEventsTotalsBenchmarkRooms(pool, events, continentId)
  const rooms = await seedSquare(pool, continentId)
  const squareEvents = Math.round(events * SQUARE_SHARE)
  const cityEvents = events - squareEvents - SMALL_ROOM_EVENTS
  const batches = Math.ceil(cityEvents / EVENTS_TOTALS_BENCHMARK_BATCH)
  await pool.query('ALTER TABLE events DISABLE TRIGGER events_stamp_public_activity')
  let squareDone = 0
  let smallDone = 0
  for (let batch = 0; batch < batches; batch += 1) {
    const first = batch * EVENTS_TOTALS_BENCHMARK_BATCH + 1
    await seedEventsTotalsBenchmarkBatch(pool, first, Math.min(cityEvents, first + EVENTS_TOTALS_BENCHMARK_BATCH - 1))
    const squareUpTo = Math.round(squareEvents * (batch + 1) / batches)
    if (squareUpTo > squareDone) await pool.query(ROOM_EVENTS_SQL, [rooms.squareId, squareDone + 1, squareUpTo])
    squareDone = squareUpTo
    const smallUpTo = Math.round(SMALL_ROOM_EVENTS * (batch + 1) / batches)
    if (smallUpTo > smallDone) await pool.query(ROOM_EVENTS_SQL, [rooms.smallRoomId, smallDone + 1, smallUpTo])
    smallDone = smallUpTo
  }
  await pool.query('ALTER TABLE events ENABLE TRIGGER events_stamp_public_activity')
  await pool.query('VACUUM ANALYZE')
  return rooms
}
