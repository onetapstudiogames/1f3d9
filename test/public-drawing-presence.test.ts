import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PUBLIC_EVENT_THING_DRAWING_JOIN_SQL,
  PUBLIC_RESIDENT_HAS_DRAWING_SQL,
  PUBLIC_THING_HAS_DRAWING_SQL,
} from '../src/public-drawing-presence.ts'

test('drawing presence follows the same public visibility and inherited source rules as thumbnails', () => {
  assert.match(PUBLIC_RESIDENT_HAS_DRAWING_SQL, /resident\.drawing\s+IS\s+NOT\s+NULL/iu)
  assert.match(PUBLIC_RESIDENT_HAS_DRAWING_SQL, /target_type\s*=\s*'resident'/iu)
  assert.match(PUBLIC_RESIDENT_HAS_DRAWING_SQL, /action[\s\S]*<>\s*'remove'/iu)

  assert.match(PUBLIC_THING_HAS_DRAWING_SQL, /target_type\s*=\s*'thing'/iu)
  assert.match(PUBLIC_THING_HAS_DRAWING_SQL, /drawing_state\s*=\s*'refused'[\s\S]*false/iu)
  assert.match(PUBLIC_THING_HAS_DRAWING_SQL, /target_type\s*=\s*'kind'/iu)
  assert.match(PUBLIC_THING_HAS_DRAWING_SQL, /drawing_variants/iu)
  assert.match(PUBLIC_THING_HAS_DRAWING_SQL, /variant_name/iu)

  assert.match(PUBLIC_EVENT_THING_DRAWING_JOIN_SQL, /asset_type[\s\S]*thing_id[\s\S]*source_thing_id/iu)
  assert.match(PUBLIC_EVENT_THING_DRAWING_JOIN_SQL, /\{0,9\}[\s\S]*::bigint\s*<=\s*2147483647/iu)
  assert.match(PUBLIC_EVENT_THING_DRAWING_JOIN_SQL, /thing\.withdrawn_at\s+IS\s+NULL/iu)
})
