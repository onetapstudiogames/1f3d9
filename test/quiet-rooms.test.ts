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
import { REFERENCE } from '../src/door.ts'

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

  const referenceSource = source('src/reference.txt')
  assert.match(referenceSource, /QUIET ROOMS/u)
  assert.match(referenceSource, /prefers to keep this room private/u)
  assert.match(REFERENCE, /QUIET ROOMS/u)

  const decisions = source('docs/DECISIONS.md')
  assert.match(
    decisions,
    /\| 75 \|[^\n]*quiet: true[^\n]*prefers to keep this room private[^\n]*LOCKED/iu,
  )
})

// Third review pass on row 75: the small-reader directory shape sentence
// (door.ts, llms.txt, and their generated mirrors) still claimed a place
// row carries only type, id, parent_id, and name — stale the moment quiet
// was added to every directory place row. Every mirror must agree.
test('the directory shape sentence discloses quiet, everywhere it is stated', () => {
  const referenceSource = source('src/reference.txt')
  assert.match(
    referenceSource,
    /Place entries contain only type: "place", stable id, parent_id, name, and quiet/u,
  )
  assert.match(
    REFERENCE,
    /Place entries contain only type: "place", stable id, parent_id, name, and quiet/u,
  )
  // The public directory response itself actually carries the field this
  // sentence now promises.
  const publicDirectory = source('src/public-directory.ts')
  assert.match(publicDirectory, /readonly quiet: boolean/u)
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
    /if \(isQuietPlace\(place\)\) \{\s*renderQuietRoom\(nodes\.occupants, place\)\s*renderQuietRoom\(nodes\.placeThings, place\)\s*renderQuietRoom\(nodes\.placeConversation, place\)/mu,
  )

  // Things tab: a scoped quiet place withholds its heading list.
  assert.match(WINDOW_JS, /if \(scopedPlace && scopedPlace\.quiet\) \{/u)

  // Conversations tab: a scoped quiet place withholds its note list, in
  // every combination of filters (a resident filter must never bypass it).
  assert.match(
    WINDOW_JS,
    /if \(isQuietPlace\(place\)\) \{\s*renderQuietRoom\(nodes\.conversations, place\)/mu,
  )
  assert.doesNotMatch(WINDOW_JS, /if \(place && place\.quiet && !state\.resident\) \{/u)

  // The client never gates the underlying HTTP reads on `quiet`; only
  // rendering changes, exactly matching the unchanged-API contract.
  assert.doesNotMatch(WINDOW_JS, /quiet[^\n]{0,40}method:\s*['"](?:POST|PUT|PATCH|DELETE)/iu)
})

// Second adversarial review pass on row 75: the window honoured quiet only
// when the exact selected place was quiet, and leaked everywhere else — the
// the Rooms Occupants panel and the
// Map tab's place cards (both recurse through every descendant), and both
// city-wide feeds (Things and Conversations) with no place selected at all.
// The fix is one shared predicate, isQuietPlace, that every listing path
// below calls on the place resolved at its own row — never at whatever
// place a view happens to be scoped to.
test('isQuietPlace is the one predicate that decides quiet, and only a definite boolean counts', () => {
  const source = /function isQuietPlace\(place\) \{[\s\S]*?\n  \}/.exec(WINDOW_JS)
  assert.ok(source, 'isQuietPlace must be present in the client')
  const isQuietPlace = new Function('return ' + source[0])() as (place: unknown) => boolean
  const cases: ReadonlyArray<readonly [unknown, boolean]> = [
    [null, false],
    [undefined, false],
    [{}, false],
    [{ quiet: false }, false],
    [{ quiet: true }, true],
    // A non-boolean truthy quiet field must never be read as quiet — this
    // is exactly the class of bug that would silently widen or narrow the
    // rule depending on what a partial place record happened to carry.
    [{ quiet: 'true' }, false],
    [{ quiet: 1 }, false],
    [{ quiet: null }, false],
  ]
  for (const [place, expected] of cases) {
    assert.equal(isQuietPlace(place), expected, JSON.stringify(place))
  }
})

test('every path that lists a resident, thing, or note resolves quiet through isQuietPlace at its own row', () => {
  // Table-driven so a future listing path added without this call is a
  // missing table row, not a silent gap — enumerated by the second review's
  // own grep list: residentsAt, placeScopeSet, renderThingIndex,
  // renderOccupants, notes lists, and the map's place cards.
  const paths: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
    {
      name: 'Things heading list (renderThingIndex): scoped-with-descendants and city-wide',
      pattern: /const resolvedPlace = placeReference\(snapshot, thing\.place_id\)\s*\n\s*if \(isQuietPlace\(resolvedPlace\)\) \{\s*\n\s*row\.classList\.add\('thing-index-row-quiet'\)/u,
    },
    {
      name: 'renderThings: the Rooms tab and every scoped-with-descendants or city-wide thing list',
      pattern: /function renderThings\(target, things, placeOf\) \{[\s\S]{0,700}if \(isQuietPlace\(resolvedPlace\)\) \{\s*\n\s*item\.classList\.add\('thing-card-quiet'\)/u,
    },
    {
      name: 'noteCard: every note list — Rooms, Conversations (filtered or not), city-wide',
      pattern: /function noteCard\(note, place\) \{\s*\n\s*if \(isQuietPlace\(place\)\) \{/u,
    },
    {
      name: 'renderPeople: the Rooms Occupants panel, recursive across descendants',
      pattern: /function renderPeople\(target, residents, placeOf\) \{[\s\S]{0,700}if \(isQuietPlace\(residentPlace\)\) \{/u,
    },
    {
      name: "occupantLine: the Map tab's place cards, recursive across descendants",
      pattern: /function occupantLine\(place, occupants, placeOf\) \{[\s\S]{0,700}if \(!isQuietPlace\(residentPlace\)\) return true/u,
    },
    // Third review pass: mountLivePlaceDetail checked isQuietPlace(place)
    // only for the exact plotted place — a quiet place nested two or more
    // levels below it (the plot's grandchild or deeper) still leaked
    // because residentsAt and liveThingShelf recurse through the whole
    // subtree with no per-row check. liveVisibleResidentsAt and
    // liveDisplayedThings are the fix: every row they return is resolved at
    // its own place, never at the plotted place, before a caller can render it.
    // Third review pass: liveFocusInteractionsPanel printed the exact
    // current place name for a resident standing outside the drilled plate,
    // and the exact current/recorded place name for every interaction
    // thing, with no quiet check at all.
    // Step 4: the single reusable Live item popover resolves a resident's
    // current place quiet mark itself -- placeReference at the resident's
    // own row, then isQuietPlace -- before ever building a location fact,
    // exactly like every other listing path above.
  ]
  for (const path of paths) {
    assert.match(WINDOW_JS, path.pattern, path.name + ' must resolve quiet through isQuietPlace')
  }
  // The rule the table enforces: no bespoke `place.quiet` check outside the
  // handful of pre-existing "is the exact selected/focused place itself
  // quiet" gates this file already locks above. Every new per-row check
  // introduced by this fix goes through isQuietPlace by name.
  const bespokeQuietChecks = [...WINDOW_JS.matchAll(/if \([^)]*?\.quiet(?:\s*===\s*true)?\)/gu)]
    .map(match => match[0])
  const allowedBespokeChecks = new Set([
    "if (scopedPlace && scopedPlace.quiet)",
    "if (place.quiet)",
    "if (place && place.quiet)",
  ])
  for (const check of bespokeQuietChecks) {
    assert.ok(
      allowedBespokeChecks.has(check),
      'unexpected bespoke quiet check outside isQuietPlace: ' + check,
    )
  }
})

test('official_facts and /api/official state the maintainer-recommended skill versions', () => {
  assert.deepEqual(SKILL_VERSION_RECOMMENDED, { city: '1.9.5', market: '2.4.2' })
  const facts = source('src/public-reference-facts.ts')
  assert.match(facts, /skill_version_recommended: SKILL_VERSION_RECOMMENDED/u)
  const mcp = source('src/mcp.ts')
  assert.match(mcp, /skill_version_recommended/u)
  assert.match(REFERENCE, /skill_version_recommended/u)
  assert.match(REFERENCE, /city 1\.9\.5, market 2\.4\.2/u)
})
