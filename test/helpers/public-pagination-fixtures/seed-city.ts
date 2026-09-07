import { readFile } from 'node:fs/promises'
import type { Pool } from 'pg'

export const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
export const POSTGRES_DATABASE = 'public_pagination_integration'
export const SMALL_ROOM_RECORDS = Object.freeze({
  childDescription: 'A short child room. 🏙',
  thingBody: 'A short ordinary thing. 🏙',
  noteBody: 'A short ordinary note. 🏙',
})
export const schemaDdl = await readFile(new URL('../../../db/schema.sql', import.meta.url), 'utf8')
export const affordableReadingMigration = await readFile(
  new URL('../../../db/migrations/20260820_affordable_reading_totals.sql', import.meta.url),
  'utf8',
)
export const eventsPresenceIndexMigration = await readFile(
  new URL('../../../db/migrations/20260821_events_presence_index.sql', import.meta.url),
  'utf8',
)
export const publicChangeMarkersMigration = await readFile(
  new URL('../../../db/migrations/20260821_public_change_markers.sql', import.meta.url),
  'utf8',
)

export interface SeededCity {
  worldPlaceId: number
  mapBranchPlaceId: number
  targetPlaceId: number
  noteHeavyPlaceId: number
  childHeavyPlaceId: number
  smallPlaceId: number
  placeCount: number
  residentCount: number
  expected: Readonly<{
    events: readonly number[]
    worldSubplaces: readonly number[]
    mapSubplaces: readonly number[]
    subplaces: readonly number[]
    things: readonly number[]
    notes: readonly number[]
    allNotes: readonly number[]
  }>
}

export async function seedCity(client: Pool): Promise<SeededCity> {
  await client.query(schemaDdl)
  await client.query(`
    INSERT INTO residents (id, handle, model, secret_hash)
    SELECT resident_id,
      'resident-' || resident_id,
      'pagination-integration',
      lpad(to_hex(resident_id), 64, '0')
    FROM generate_series(1, 2006) AS resident_id
    WHERE resident_id <> 4
  `)

  const world = await client.query<{ id: number }>(
    `SELECT id FROM places WHERE place_kind = 'world'`,
  )
  const continent = await client.query<{ id: number }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES ($1, 'continent', 'Pagination Continent', 1)
     RETURNING id`,
    [world.rows[0]!.id],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     SELECT $1, 'continent', 'Window Continent ' || continent_number, 1
     FROM generate_series(1, 25) AS continent_number`,
    [world.rows[0]!.id],
  )
  const target = await client.query<{ id: number }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES ($1, 'place', 'Pagination Room', 1)
     RETURNING id`,
    [continent.rows[0]!.id],
  )
  const targetPlaceId = target.rows[0]!.id
  const representativeRooms = await client.query<{ id: number; name: string }>(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     VALUES
       ($1, 'place', 'Note-only Room', 1),
       ($1, 'place', 'Child-only Room', 1),
       ($1, 'place', 'Small Room', 1)
     RETURNING id, name`,
    [continent.rows[0]!.id],
  )
  const representativeId = (name: string) => {
    const id = representativeRooms.rows.find(row => row.name === name)?.id
    if (!id) throw new Error(`missing representative room: ${name}`)
    return id
  }
  const noteHeavyPlaceId = representativeId('Note-only Room')
  const childHeavyPlaceId = representativeId('Child-only Room')
  const smallPlaceId = representativeId('Small Room')

  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     SELECT $1, 'place', 'Room child ' || child_number,
       repeat('child ', 400) || child_number || ' 🏙', 1
     FROM generate_series(1, 75) AS child_number`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     SELECT $1, 1, repeat('only notes ', 500) || item_number || ' 🏙',
       '2026-08-15T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 25) AS item_number`,
    [noteHeavyPlaceId],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     SELECT $1, 'place', 'Only child ' || child_number,
       repeat('only children ', 350) || child_number || ' 🏙', 1
     FROM generate_series(1, 25) AS child_number`,
    [childHeavyPlaceId],
  )
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, description, owner_id)
     VALUES ($1, 'place', 'Small Room Child', $2, 1)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.childDescription],
  )
  await client.query(
    `INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
     VALUES ($1, 'Small Room Keepsake', $2, 1, 1,
       '2026-08-15T00:00:01Z'::timestamptz)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.thingBody],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     VALUES ($1, 1, $2,
       '2026-08-15T00:00:02Z'::timestamptz)`,
    [smallPlaceId, SMALL_ROOM_RECORDS.noteBody],
  )
  await client.query(`
    SELECT setval(
      pg_get_serial_sequence('places', 'id'),
      GREATEST(454, (SELECT max(id) FROM places)),
      TRUE
    )
  `)
  await client.query(
    `INSERT INTO places (parent_id, place_kind, name, owner_id)
     SELECT $1, 'place', 'Map sibling ' || child_number, 1
     FROM generate_series(1, 1005) AS child_number`,
    [continent.rows[0]!.id],
  )
  await client.query(
    `INSERT INTO resident_presence (resident_id, current_place_id)
     SELECT id, $1 FROM residents`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO things (place_id, name, body, owner_id, maker_id, created_at)
     SELECT $1, 'thing-' || item_number,
       repeat('thing ', 5000) || item_number || ' 🏙', 1, 1,
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )
  await client.query(
    `INSERT INTO notes (place_id, author_id, body, created_at)
     SELECT $1, 1, repeat('note ', 600) || item_number || ' 🏙',
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )
  await client.query(`
    WITH inserted AS (
      INSERT INTO agreements (created_by_id, body, created_at)
      SELECT 1, 'agreement body ' || item_number,
        '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
      FROM generate_series(1, 75) AS item_number
      RETURNING id
    )
    INSERT INTO agreement_parties (agreement_id, resident_id)
    SELECT id, 1 FROM inserted
  `)
  await client.query(
    `INSERT INTO events (kind, actor, detail, at)
     SELECT 'note', 'resident-1', jsonb_build_object('place_id', $1::integer),
       '2026-08-14T00:00:00Z'::timestamptz + item_number * interval '1 second'
     FROM generate_series(1, 75) AS item_number`,
    [targetPlaceId],
  )

  const ids = async (statement: string, values: readonly unknown[] = []) => (
    await client.query<{ id: number }>(statement, [...values])
  ).rows.map(row => row.id)

  return Object.freeze({
    worldPlaceId: world.rows[0]!.id,
    mapBranchPlaceId: continent.rows[0]!.id,
    targetPlaceId,
    noteHeavyPlaceId,
    childHeavyPlaceId,
    smallPlaceId,
    placeCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM places')).rows[0]!.count),
    residentCount: Number((await client.query<{ count: string }>('SELECT count(*) FROM residents')).rows[0]!.count),
    expected: Object.freeze({
      events: await ids(`SELECT id FROM events WHERE kind = 'note' ORDER BY id DESC`),
      worldSubplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [world.rows[0]!.id],
      ),
      mapSubplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [continent.rows[0]!.id],
      ),
      subplaces: await ids(
        `SELECT id FROM places WHERE parent_id = $1 ORDER BY id DESC`,
        [targetPlaceId],
      ),
      things: await ids(
        `SELECT id FROM things WHERE place_id = $1 AND withdrawn_at IS NULL ORDER BY id DESC`,
        [targetPlaceId],
      ),
      notes: await ids(
        `SELECT id FROM notes WHERE place_id = $1 ORDER BY id DESC`,
        [targetPlaceId],
      ),
      allNotes: await ids('SELECT id FROM notes ORDER BY id DESC'),
    }),
  })
}
