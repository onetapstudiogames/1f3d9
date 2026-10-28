// Feed rooms (decision #153): the place_edit rule, the left_out_feed_rooms answer
// shape, and the served words that name both. The real-database behaviour is in
// test/integration/feed-rooms-postgres.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  FEED_ROOM_EVENT_KINDS,
  FEED_ROOMS_READ_LINE,
  feedQuietRefusal,
  feedRoomEventLateralSql,
  feedRoomIdsSql,
  leftOutFeedRooms,
} from '../src/feed-rooms.ts'
import { PUBLIC_EVENT_KINDS } from '../src/public-events.ts'

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('place_edit refuses a feed room that is not quiet and a quiet switch-off while feed is on', () => {
  assert.equal(
    feedQuietRefusal({ quiet: false, feed: false }, true, undefined),
    'a feed room must be quiet; send quiet: true with feed: true, or set quiet: true first',
  )
  assert.equal(
    feedQuietRefusal({ quiet: true, feed: true }, undefined, false),
    'a feed room stays quiet; send feed: false with quiet: false, or set feed: false first',
  )
  assert.equal(
    feedQuietRefusal({ quiet: true, feed: true }, true, false),
    'a feed room must be quiet; send quiet: true with feed: true, or set quiet: true first',
  )
  assert.equal(feedQuietRefusal({ quiet: false, feed: false }, true, true), null)
  assert.equal(feedQuietRefusal({ quiet: true, feed: false }, true, undefined), null)
  assert.equal(feedQuietRefusal({ quiet: true, feed: true }, false, false), null)
  assert.equal(feedQuietRefusal({ quiet: true, feed: true }, undefined, undefined), null)
  assert.equal(feedQuietRefusal({ quiet: false, feed: false }, undefined, false), null)
})

test('left_out_feed_rooms counts, names at most ten rooms lowest first, and says where to read them', () => {
  assert.deepEqual(leftOutFeedRooms(0, null), { count: 0, place_ids: [] })
  assert.deepEqual(leftOutFeedRooms(undefined, undefined), { count: 0, place_ids: [] })
  assert.deepEqual(leftOutFeedRooms(3, [9, 4, 9]), { count: 3, place_ids: [4, 9], read: FEED_ROOMS_READ_LINE })
  assert.deepEqual(
    leftOutFeedRooms(12, Array.from({ length: 12 }, (_, index) => 20 - index)).place_ids,
    [9, 10, 11, 12, 13, 14, 15, 16, 17, 18],
  )
  assert.equal(
    FEED_ROOMS_READ_LINE,
    'count is how many items this answer left out, not how many rooms; place_ids names the rooms they sit in, at most 10. '
      + 'Feed rooms keep their notes, lines, things and pings out of city-wide lists and mention lookups. '
      + 'Read one in the room: look with its place_id, or read events with that place_id.',
  )
  for (const [count, ids] of [[-1, []], [1.5, [2]], [2, []], [0, [3]], [1, ['x']], [1, [0]], [1, 'not a list']] as const) {
    assert.throws(() => leftOutFeedRooms(count, ids), /left-out feed room count is invalid/u)
  }
})

test('only note, line, ping and thing events can be left out, never a place edit', () => {
  for (const kind of FEED_ROOM_EVENT_KINDS) assert.ok(PUBLIC_EVENT_KINDS.includes(kind), kind)
  assert.equal((FEED_ROOM_EVENT_KINDS as readonly string[]).includes('place_edited'), false)
  assert.equal((FEED_ROOM_EVENT_KINDS as readonly string[]).includes('moderation'), false)
  assert.equal(
    feedRoomIdsSql('$3::integer'),
    'ARRAY(SELECT feed_room.id FROM places feed_room WHERE feed_room.feed AND feed_room.id IS DISTINCT FROM $3::integer ORDER BY feed_room.id)',
  )
  const join = feedRoomEventLateralSql('event', feedRoomIdsSql())
  assert.match(join, /^CROSS JOIN LATERAL \(/u)
  assert.match(join, /\) feed$/u)
  assert.match(join, /outcome->>'target_type' = 'thing'/u)
  assert.match(join, /cardinality\(ARRAY\(SELECT feed_room\.id FROM places feed_room WHERE feed_room\.feed ORDER BY feed_room\.id\)\) > 0/u)
})

test('the served words say what a feed room is wherever the feed rule is told', () => {
  const reference = source('src/reference.txt')
  assert.doesNotMatch(reference, /coming in the next change/u)
  assert.match(reference, /\nFEED ROOMS\n~~~~~~~~~~\n/u)
  assert.match(reference, /mention lookups in me/u)
  const legal = source('src/legal.ts')
  assert.doesNotMatch(legal, /being added/u)
  assert.match(legal, /A feed\s+room is a quiet room its owner marks as a feed, and its notes, lines, things and\s+pings stay out of residents' search, events, changes and mention lookups, while\s+anyone can still read them in the room\./u)
  assert.match(source('src/reference-sections.ts'), /\{ anchor: 'feed-rooms', page: 'quiet-rooms', heading: 'FEED ROOMS' \}/u)
  assert.match(source('docs/DECISIONS.md'), /\n\| 153 \| \*\*A place owner may mark an owned quiet room as a feed room/u)
})
