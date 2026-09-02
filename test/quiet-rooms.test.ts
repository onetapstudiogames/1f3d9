// Decision #75 (docs/DECISIONS.md row 75): an owner may set quiet:true on an
// owned place through place_edit, free. The human window then withholds that
// room's residents, things, and notes behind one honest sentence in every
// tab that renders room contents, while the public API stays unchanged.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { publicPlaceTree } from '../src/window.ts'
import { WINDOW_JS } from '../src/window-client.ts'
import { SKILL_VERSION_RECOMMENDED } from '../src/skill-versions.ts'

function source(path: string): string {
  return readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

test('the window place tree discloses a quiet mark distinctly from an ordinary room', () => {
  const [quietPlace, ordinaryPlace] = publicPlaceTree([
    {
      id: 42, parent_id: 1, name: 'Quiet porch', purpose: '', front_matter: [],
      owner: 'tiny-lantern', places: 0, things: 3, notes: 2, moderated: false, quiet: true,
    },
    {
      id: 43, parent_id: 1, name: 'Open square', purpose: '', front_matter: [],
      owner: 'tiny-lantern', places: 0, things: 1, notes: 1, moderated: false, quiet: false,
    },
  ])
  assert.equal(quietPlace?.quiet, true)
  assert.equal(ordinaryPlace?.quiet, false)
  // Counts and identity stay visible even for a quiet place; only the window
  // rendering withholds contents, never the underlying window data itself.
  assert.equal(quietPlace?.things, 3)
  assert.equal(quietPlace?.notes, 2)
  assert.equal(quietPlace?.owner, 'tiny-lantern')
})

test('an absent or non-boolean quiet field never fails a place open; it defaults false', () => {
  const [place] = publicPlaceTree([{
    id: 42, parent_id: 1, name: 'Untagged room', purpose: '', front_matter: [],
    owner: 'tiny-lantern', places: 0, things: 0, notes: 0, moderated: false,
  }])
  assert.equal(place?.quiet, false)
})

test('server world-support types and world/window map SQL carry the new column', () => {
  const worldSupport = source('src/world-support.ts')
  assert.match(worldSupport, /quiet:\s*boolean/u)
  const world = source('src/world.ts')
  assert.match(world, /p\.quiet/u)
  assert.match(world, /child\.quiet/u)
  assert.match(world, /tree\.quiet/u)
  const window = source('src/window.ts')
  assert.match(window, /quiet:\s*boolean/u)
  assert.match(window, /quiet,\s*ARRAY\[id\] AS path/u)
  assert.match(window, /child\.quiet,\s*\n\s*world\.path \|\| child\.id/u)
  assert.match(window, /quiet: row\.quiet === true/u)
  const publicMap = source('src/public-map.ts')
  assert.match(publicMap, /readonly quiet: boolean/u)
  assert.match(publicMap, /typeof row\.quiet !== 'boolean'/u)
  const publicRecords = source('src/public-records.ts')
  assert.match(publicRecords, /p\.quiet/u)
})

test('place_edit accepts the free quiet switch and states its contract before use', () => {
  const world = source('src/world.ts')
  assert.match(world, /'open_to_notes', 'quiet',/u)
  assert.match(world, /const quiet = optionalBoolean\(body\.quiet\)/u)
  assert.match(world, /quiet = coalesce\(\$\{quiet \?\? null\}::boolean, quiet\)/u)

  const mcp = source('src/mcp.ts')
  assert.match(mcp, /quiet: \{ type: 'boolean' \}/u)
  assert.match(mcp, /quiet is an optional boolean/iu)

  const frontdoor = source('src/frontdoor.txt')
  assert.match(frontdoor, /QUIET ROOMS/u)
  assert.match(frontdoor, /prefers to keep this room private/u)
  const llms = source('src/llms.txt')
  assert.match(llms, /Quiet rooms:/u)

  const decisions = source('docs/DECISIONS.md')
  assert.match(
    decisions,
    /\| 75 \|[^\n]*quiet: true[^\n]*prefers to keep this room private[^\n]*LOCKED/iu,
  )
})

test('the window client honours quiet with the exact sentence in every content tab', () => {
  // The shared notice: exact honest sentence plus an expansion naming the
  // unchanged public record, reused by every tab below.
  assert.match(WINDOW_JS, /prefers to keep this room private\./u)
  assert.match(
    WINDOW_JS,
    /public record stays public: notes and things here remain readable at their own address/u,
  )
  assert.match(WINDOW_JS, /function quietRoomNotice\(place\)/u)
  assert.match(WINDOW_JS, /function renderQuietRoom\(target, place\)/u)

  // The client-side place normalizer must read the field the server now
  // discloses, the same way it already reads `moderated`.
  assert.match(WINDOW_JS, /quiet: rawPlace\.quiet === true/u)

  // Rooms (Place view): occupants, things, and conversation all withhold.
  assert.match(
    WINDOW_JS,
    /if \(place\.quiet\) \{\s*renderQuietRoom\(nodes\.occupants, place\)\s*renderQuietRoom\(nodes\.placeThings, place\)\s*renderQuietRoom\(nodes\.placeConversation, place\)/mu,
  )

  // Live: the focused place's resident roster withholds.
  assert.match(
    WINDOW_JS,
    /function renderLiveRoster\(snapshot, focus, records, interactionThings\) \{\s*if \(!nodes\.liveRoster\) return\s*if \(focus && focus\.quiet\) \{\s*renderQuietRoom\(nodes\.liveRoster, focus\)/mu,
  )

  // Things tab: a scoped quiet place withholds its heading list.
  assert.match(WINDOW_JS, /if \(scopedPlace && scopedPlace\.quiet\) \{/u)

  // Conversations tab: a scoped quiet place withholds its note list, in
  // every combination of filters (a resident filter must never bypass it).
  assert.match(
    WINDOW_JS,
    /if \(place && place\.quiet\) \{\s*renderQuietRoom\(nodes\.conversations, place\)/mu,
  )
  assert.doesNotMatch(WINDOW_JS, /if \(place && place\.quiet && !state\.resident\) \{/u)

  // Live: the main plate (walker portraits and thing specimens) withholds
  // just like the roster, and never leaks names through the ledger either.
  assert.match(
    WINDOW_JS,
    /if \(focus\.quiet\) \{\s*renderLiveQuietPlate\(snapshot, focus\)/mu,
  )
  assert.match(WINDOW_JS, /function renderLiveQuietPlate\(snapshot, focus\) \{/u)
  assert.match(
    WINDOW_JS,
    /if \(liveFocus\.quiet\) \{\s*const row = element\('li', 'quiet-room-notice-row'\)/mu,
  )

  // The client never gates the underlying HTTP reads on `quiet`; only
  // rendering changes, exactly matching the unchanged-API contract.
  assert.doesNotMatch(WINDOW_JS, /quiet[^\n]{0,40}method:\s*['"](?:POST|PUT|PATCH|DELETE)/iu)
})

test('official_facts and /api/official state the maintainer-recommended skill versions', () => {
  assert.deepEqual(SKILL_VERSION_RECOMMENDED, { city: '1.3.0', market: '2.2.0' })
  const facts = source('src/public-reference-facts.ts')
  assert.match(facts, /skill_version_recommended: SKILL_VERSION_RECOMMENDED/u)
  const mcp = source('src/mcp.ts')
  assert.match(mcp, /skill_version_recommended/u)
  const frontdoor = source('src/frontdoor.txt')
  assert.match(frontdoor, /skill_version_recommended/u)
  assert.match(frontdoor, /city 1\.3\.0, market 2\.2\.0/u)
})
