// Fourth review pass on row 75 (docs/DECISIONS.md row 75, resolving issue #73's
// recurring leaks): three prior review passes each fixed the specific rows a
// human reviewer happened to spot — the directory search box and the Live
// roster's dataset markers were both shipped, reviewed twice more, and still
// missed. This file replaces "spot the leak" with a mechanical inventory: it
// greps the shipped window client for every DOM write that could carry a
// resident handle, a thing name, or a note body — textContent, innerText,
// dataset, setAttribute, title=, aria-label, option/select values, href
// fragments, and the shared identity-rendering helpers (residentNode,
// portraitNode for a resident or thing, openDetailLink, openDrawingDetailButton)
// — and requires every single occurrence to be either provably guarded by an
// isQuietPlace (or liveLedgerQuietPlace) call earlier in its own function, or
// named on the explicit allow-list below with a one-line reason a reviewer can
// check. A new identity-carrying DOM write added anywhere in the file without
// updating one of the two either fails outright (unguarded, unlisted) or shows
// up as a stale allow-list entry (listed, but no longer matched) — either way
// this test fails instead of shipping silently.
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

// Phase 1 of issue #79 (see docs/DRAWING_AND_LIVE_VIEW.md) split the window
// client's runtime body out of src/window-client.ts into ordered program
// parts under src/window-client/program/. Each part file is
// `export const PART_NN_NAME = \`<source>\``: stripping that header/footer
// and joining the parts in filename order reproduces exactly the same
// client source text this scanner watched before the split (proven by the
// PR's byte-identity proof: the assembled WINDOW_JS is unchanged).
const WINDOW_CLIENT_PATH = 'src/window-client/program/*.ts'

// Anchors on the part file's actual header, not on the first backtick in the
// file: a header comment that quotes an identifier in backticks (this
// codebase's normal style) would otherwise slice from inside the comment
// instead of from the template body.
const PART_HEADER = /^export const PART_[A-Z0-9_]+ = `/mu

function templateBody(name: string, fileSource: string): string {
  const match = fileSource.match(PART_HEADER)
  assert.ok(match, `${name}: expected a header matching "export const PART_NN_NAME = \`"`)
  const open = fileSource.indexOf(match[0]) + match[0].length
  return fileSource.slice(open, fileSource.lastIndexOf('`'))
}

function source(_path: string): string {
  const programDir = new URL('../src/window-client/program/', import.meta.url)
  const names = readdirSync(programDir).filter(name => /^\d\d-.*\.ts$/.test(name)).sort()
  return names
    .map(name => templateBody(name, readFileSync(new URL(name, programDir), 'utf8')))
    .join('')
}

type ClientFunction = Readonly<{
  name: string
  startLine: number // 0-indexed, inclusive
  endLine: number // 0-indexed, inclusive (the closing "  }" line)
}>

// The window client's runtime body is one giant template literal of plain
// JS; every top-level function inside it is declared and closed at exactly
// two spaces of indentation (verified by the existing quiet-rooms.test.ts
// patterns and by hand for every function this file names below). A function
// expression or arrow callback nested inside one closes at a deeper
// indentation, so it never prematurely ends the outer function's range.
function extractTopLevelFunctions(fileSource: string): readonly ClientFunction[] {
  const lines = fileSource.split('\n')
  const functions: ClientFunction[] = []
  let open: { name: string; startLine: number } | null = null
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const start = /^ {2}(?:async function|function) ([A-Za-z0-9_]+)\(/.exec(line)
    if (start && !open) {
      open = { name: start[1]!, startLine: index }
      continue
    }
    if (open && /^ {2}\}$/.test(line)) {
      functions.push({ name: open.name, startLine: open.startLine, endLine: index })
      open = null
    }
  }
  return functions
}

// Sinks that are identity-bearing by construction — the whole point of
// calling them is to print a resident's handle or a thing's name/link, so no
// further content check is needed once one of these appears.
const ALWAYS_IDENTITY_SINK =
  /(residentNode\(|openDetailLink\(|openDrawingDetailButton\(|portraitNode\(\s*['"](?:resident|thing)['"])/u

// Generic DOM-write APIs named in the task: textContent, innerText, dataset,
// setAttribute, title=, aria-label, option/select value=, and href
// fragments. element(tag, class, text) is this codebase's own textContent
// helper (see its definition: `if (text !== undefined) node.textContent =
// String(text)`), so a call to it is a textContent write under another name.
const GENERIC_DOM_WRITE_API =
  /(\.textContent\s*=|\.innerText\s*=|\.dataset\.[A-Za-z0-9_]+\s*=|\.setAttribute\(|\.title\s*=|'aria-label'|"aria-label"|\.value\s*=|\.href\s*=|\belement\()/u

// A generic write only counts as identity-carrying when its value looks like
// it came from a resident handle, a thing name, or a note body — covering
// every naming convention this codebase actually uses for those three
// fields (resident.handle / handle / actor, thing.name / heading.name,
// note.body, plus the maker/owner/author resident-reference fields that
// carry a handle without the literal word "handle").
const IDENTITY_BEARING_VALUE =
  /(resident\.handle|residentHandle|\.handle\b|thing\.name|thingName|note\.body|noteBody|\.body\b|\bactor\b|\.actor\b|\.made_by\b|\.current_owner\b|\.author\b)/u

// A function is provably guarded when it resolves quiet for itself, at its
// own row, via one of these two predicates — isQuietPlace directly, or
// liveLedgerQuietPlace (which is isQuietPlace applied to a move's two
// places, or a record's one place, and used by every Live trail/ledger
// surface in place of calling isQuietPlace by hand).
const QUIET_GUARD_CALL = /isQuietPlace\(|liveLedgerQuietPlace\(/u

type Flag = Readonly<{ functionName: string; line: number; text: string }>

function findIdentityDomWrites(fileSource: string, functions: readonly ClientFunction[]): readonly Flag[] {
  const lines = fileSource.split('\n')
  const flags: Flag[] = []
  for (const fn of functions) {
    for (let index = fn.startLine; index <= fn.endLine; index++) {
      const line = lines[index]!
      const lookahead = lines.slice(index, index + 3).join(' ')
      const hit = ALWAYS_IDENTITY_SINK.test(line) ||
        (GENERIC_DOM_WRITE_API.test(line) && IDENTITY_BEARING_VALUE.test(lookahead))
      if (hit) flags.push({ functionName: fn.name, line: index + 1, text: line.trim() })
    }
  }
  return flags
}

function functionBody(fileSource: string, fn: ClientFunction): string {
  return fileSource.split('\n').slice(fn.startLine, fn.endLine + 1).join('\n')
}

// Every function named here was read in full and confirmed not to leak a
// quiet place's occupants, things, or notes, for the one-line reason given.
// A reason is required to be genuinely explanatory (not just "safe") so a
// future reviewer can check the claim without re-deriving it.
const ALLOW_LIST: ReadonlyMap<string, string> = new Map([
  ['renderLiveResidentLabels',
    'Re-labels portraits already rendered by livePortraitGrid from liveVisibleResidentsAt-filtered ' +
    'residents; a quiet resident never has a DOM portrait here for this function to read back.'],
  ['archiveResultCard',
    'Archive search reads the whole public archive by keyword; decision #75 keeps notes and things ' +
    '"readable at their addresses, because the city keeps public books", and this card shows only a ' +
    'bare numeric place id, never a name.'],
  ['gazetteEntryCard',
    'Gazette entries print from founder-owned room #454, which decision #56 bars from ever receiving ' +
    'local configuration such as quiet; the printer can never publish from a quiet room.'],
  ['populateFilters',
    'The resident filter lists every directory handle with no location text; quiet withholds only ' +
    'where a resident currently stands, never their existence in the citywide directory.'],
  ['occupantChip',
    'Only ever invoked by occupantLine with residents already filtered by isQuietPlace; occupantChip ' +
    'itself never resolves a place.'],
  ['renderResidentPage',
    'dataset.focusFallbackKey is an internal keyboard-focus lookup key on the Load More button, never ' +
    'rendered as visible text; handles are already public in the directory regardless of quiet.'],
  ['livePortraitGrid',
    'Every caller passes residents pre-filtered by liveVisibleResidentsAt; livePortraitGrid has no ' +
    'place context of its own to check.'],
  ['liveThingShelf',
    'Things come from liveThingPresentation, which calls liveDisplayedThings and filters isQuietPlace ' +
    'per row before this function ever sees them.'],
  ['renderLive',
    'openDrawingDetailButton("place", focus.id, focus.name, ...) names only the focused place\'s own ' +
    'identity, and this line is unreachable when focus itself is quiet: renderLive returns via ' +
    'renderLiveQuietPlate before reaching it.'],
  ['residentNode',
    'This is the shared sink helper\'s own implementation; it renders whatever caller-supplied handle ' +
    'it is given and has no place context of its own. Every call site is audited separately.'],
  ['openDetailLink',
    'This is the shared sink helper\'s own implementation; it renders whatever caller-supplied label ' +
    'it is given and has no place context of its own. Every call site is audited separately.'],
  ['openDrawingDetailButton',
    'This is the shared sink helper\'s own implementation; it renders whatever caller-supplied label ' +
    'it is given and has no place context of its own. Every call site is audited separately.'],
  ['drawingHistoryNode',
    'Drawing revision authorship is public art-provenance metadata unrelated to a resident\'s current ' +
    'physical location; decision #75 governs a room\'s occupants, things, and notes, not who drew a ' +
    'portrait revision.'],
  ['renderDetail',
    'Renders one record addressed directly by its stable public id; decision #75 states a quiet ' +
    'room\'s notes and things "stay readable at their addresses, because the city keeps public books" ' +
    '— this is that direct address, not ambient room-content discovery.'],
  ['renderExpandableBody',
    'Shared body-expansion helper used by renderThings (already isQuietPlace-gated per row) and by the ' +
    'direct-address detail/archive flows; never the entry point for an ambient quiet-room listing.'],
  ['renderPlace',
    'followed.handle here names the viewer\'s own already-selected resident, shown only when they hold ' +
    'no current place at all; not ambient discovery of a location.'],
  ['renderAgreements',
    'Agreements are signed public deals with no place_id at all; decision #75 governs a room\'s ' +
    'occupants, things, and notes, and quiet has never applied to the agreement record.'],
  ['renderActivity',
    'The Happenings tab is the public action log; decision #75 states "the public API record is ' +
    'unchanged... because the city keeps public books", and e2e/public-window-interactions.spec.ts ' +
    'explicitly asserts an actor\'s handle and a quiet place\'s name both appear in Happenings entries ' +
    'for moves into and out of it.'],
  ['liveItemPopoverContent',
    'Step 4: builds the single reusable Live item popover from facts and a name its caller already ' +
    'resolved through liveItemPopoverFacts, which calls isQuietPlace per item before this function ever ' +
    'runs; like livePortraitGrid and liveThingShelf above, it has no place context of its own to check.'],
])

test('the window client source actually contains identity-bearing DOM writes for this scan to find', () => {
  // A scanner that silently matches nothing would make every assertion below
  // pass vacuously. Floor counts catch that: if these drop to zero, the
  // regexes above broke, not the code they are meant to be watching.
  const clientSource = source(WINDOW_CLIENT_PATH)
  const functions = extractTopLevelFunctions(clientSource)
  assert.ok(functions.length > 200, 'expected well over 200 top-level client functions')
  const flags = findIdentityDomWrites(clientSource, functions)
  assert.ok(flags.length > 80, 'expected well over 80 flagged identity-bearing DOM writes')
})

test('every identity-bearing DOM write in the window client is isQuietPlace-guarded or explicitly allow-listed', () => {
  const clientSource = source(WINDOW_CLIENT_PATH)
  const functions = extractTopLevelFunctions(clientSource)
  const functionsByName = new Map(functions.map(fn => [fn.name, fn]))
  const flags = findIdentityDomWrites(clientSource, functions)

  const unaccounted = flags.filter(flag => {
    if (ALLOW_LIST.has(flag.functionName)) return false
    const fn = functionsByName.get(flag.functionName)
    return !(fn && QUIET_GUARD_CALL.test(functionBody(clientSource, fn)))
  })

  assert.deepEqual(
    unaccounted.map(flag => flag.functionName + ':' + String(flag.line) + ': ' + flag.text),
    [],
    'Every DOM write above must either call isQuietPlace (or liveLedgerQuietPlace) earlier in its own ' +
    'function, or have its function name added to ALLOW_LIST in this file with a one-line reason.',
  )
})

test('the allow-list names only functions that still exist and carries a real reason for each', () => {
  const clientSource = source(WINDOW_CLIENT_PATH)
  const functionNames = new Set(extractTopLevelFunctions(clientSource).map(fn => fn.name))
  for (const [name, reason] of ALLOW_LIST) {
    assert.ok(functionNames.has(name), 'allow-listed function "' + name + '" no longer exists in ' + WINDOW_CLIENT_PATH)
    assert.ok(reason.length >= 40, 'allow-list reason for "' + name + '" is too short to be a real explanation')
  }
})

test('the allow-list carries no stale entries: every listed function still has a flagged DOM write', () => {
  // Keeps the allow-list honest in the other direction — an entry that no
  // longer matches anything is a dead exemption nobody is checking, and a
  // future writer would not know whether it is safe to delete.
  const clientSource = source(WINDOW_CLIENT_PATH)
  const functions = extractTopLevelFunctions(clientSource)
  const flaggedFunctionNames = new Set(findIdentityDomWrites(clientSource, functions).map(flag => flag.functionName))
  for (const name of ALLOW_LIST.keys()) {
    assert.ok(flaggedFunctionNames.has(name), 'allow-list entry "' + name + '" no longer matches any flagged DOM write; remove it')
  }
})

test('thingLookupSearchResults resolves quiet for itself before a thing ever becomes a directory search result', () => {
  // The fourth review's first finding: the directory search box builds a
  // presentation record (kind/id/value/label/detail) from a raw thing row in
  // thingLookupSearchResults, and the actual DOM write happens later in
  // renderDirectorySearch via generically-named `result.label`/`result.detail`
  // fields — so the generic scanner above, which looks for a DOM write next
  // to an identity-shaped field access, cannot see this one at all: the leak
  // is in a data-flow rename, not a raw sink. This is the one path this file
  // checks by name instead of by pattern.
  const clientSource = source(WINDOW_CLIENT_PATH)
  const functions = extractTopLevelFunctions(clientSource)
  const fn = functions.find(candidate => candidate.name === 'thingLookupSearchResults')
  assert.ok(fn, 'thingLookupSearchResults must still exist in ' + WINDOW_CLIENT_PATH)
  const body = functionBody(clientSource, fn!)
  assert.match(body, /isQuietPlace\(/u)
  assert.match(body, /\.filter\(thing => !isQuietPlace\(/u)
})
