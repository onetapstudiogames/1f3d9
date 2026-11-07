import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'

// The thing writer census (things ending, plan 3.7). Every UPDATE or INSERT on things in
// src, every UPDATE through a table name built at run time, and every thing selection in a
// brick is a named site with its ending decision:
//
// - records first: the door records a due end (recordDueEnd) before it writes, then
//   proceeds or refuses as the 3.7 table says;
// - guarded: the write is one the database guards let through on a due or ended thing (a
//   new thing, carrying, an open sale closing), and they refuse anything else;
// - skips: a brick step or a waking read judges the end from the database at its own step
//   and leaves a thing whose end has come as it is;
// - exempt: with the reason.
//
// A site is named by its file, the function, constant or route around it, and its order
// there, never by a count per file, so a new site, a removed site, or a site without a
// decision fails here. A task that adds or moves a site lists it in the same change.

type Decision = `${'records first' | 'guarded' | 'skips' | 'exempt'}: ${string}`

const WRITE_SITES: Readonly<Record<string, Decision>> = Object.freeze({
  'src/crafting.ts craftKindThing INSERT#1':
    'guarded: a new thing; things_ending_parent_guard refuses a recorded end at birth, and its own end comes from the grant',
  'src/crafting.ts craftKindThing UPDATE#1':
    'records first: runAction records the ingredients (primitiveThingIds), crafting refuses E7, and the commit excludes a reached ingredient',
  'src/engine-convert.ts convertThing UPDATE#1':
    'skips: the locked target read gives end_reached and the convert step is skipped',
  'src/engine-copy.ts insertCopy INSERT#1':
    'guarded: a copy takes its parent remaining end (copyRuleFrom); the parent guard refuses a reached parent except under its own end_try writer',
  'src/engine-copy.ts insertCopy UPDATE#1':
    'skips: lockParent skips a reached parent; only its own end try passes copies_made through the freeze guard',
  'src/engine-effects.ts withdrawSharedSourceThing UPDATE#1':
    'skips: destroyThing reads end_reached from thingState and skips before any withdrawal',
  'src/engine-effects.ts destroyThing UPDATE#1':
    'skips: destroyThing reads end_reached from thingState and skips before any withdrawal',
  'src/engine-effects.ts destroyThing UPDATE#2':
    'skips: destroyThing reads end_reached from thingState and skips before any withdrawal',
  'src/engine-effects.ts withdrawOwnedThing UPDATE#1':
    'records first: consume runs through runAction, which records the source and refuses E7',
  'src/engine-effects.ts moveThing UPDATE#1':
    'skips: moveThing reads end_reached from thingState and skips',
  'src/engine-effects.ts transferAsset UPDATE#1':
    'skips: the transfer step skips the actor own reached thing, and its WHERE keeps a thing with an active end (E9)',
  'src/engine-end-try.ts finishEndTry UPDATE#1':
    'exempt: the end try moves its own pending program to ran or skipped under its end_try writer, the one writer the freeze guard lets do so',
  'src/engine-state.ts writeStateBox UPDATE#1':
    'skips: skipAfterOwnEnd skips a write on the program own reached thing; the freeze guard passes state only under end_try',
  'src/engine-state.ts clearStateBox UPDATE#1':
    'records first: thing_edit state_clear, after PATCH records and refuses E7',
  'src/engine.ts moveHeldThing UPDATE#1':
    'guarded: the carrier moves and the thing follows (place_id and held_by pass the freeze guard); recorded later',
  'src/engine.ts moveResidentWithCarry UPDATE#1':
    'records first: runAction records the carried thing, then the carry proceeds (place_id and held_by pass the guard)',
  'src/engine.ts countEndingUse UPDATE#1':
    'skips: its WHERE carries NOT thing_end_due, so a use that made the thing due writes nothing and never meets the guard',
  'src/payment-sale-operation-sql.ts INVALIDATE_SALE_TARGET_SQL UPDATE#1':
    'guarded: payment recovery may release an open sale lock (active_offer_id to NULL); it never records an end (#167)',
  'src/payment-sale-operation-sql.ts CLOSE_INVALID_SALE_TARGET_SQL UPDATE#1':
    'guarded: payment recovery may release an open sale lock (active_offer_id to NULL); it never records an end (#167)',
  'src/payment-sale-operation-sql.ts CLOSE_SALE_TARGET_SQL UPDATE#1':
    'guarded: payment recovery may release an open sale lock (active_offer_id to NULL); it never records an end (#167)',
  'src/payment-sale-operation-sql.ts DIRECT_COMPLETION_SQL UPDATE#1':
    'guarded: closing a sale already open may change the owner as active_offer_id turns NULL (#32); the claim doors record first in T13',
  'src/payment-sale-operation-sql.ts WORLD_COMPLETION_SQL UPDATE#1':
    'guarded: closing a sale already open may change the owner as active_offer_id turns NULL (#32); the claim doors record first in T13',
  'src/thing-ending-owner.ts writeOwnerEnding UPDATE#1':
    'records first: thing_edit and thing_upgrade record first; its WHERE refuses a reached thing (E5 or E16)',
  'src/thing-ending-record.ts RECORD_SQL UPDATE#1':
    'exempt: the recorder itself, one thing per UPDATE under the record:<id> writer',
  'src/thing-making.ts makeKindlessThing INSERT#1':
    'guarded: a new thing; things_ending_parent_guard refuses a recorded end at birth, and its own end comes from the grant',
  'src/withdrawal.ts withdrawThing UPDATE#1':
    'records first: the withdraw route records and refuses E7; an older remnant is withdrawn under the withdraw:<id> writer',
  'src/world-market.ts POST /api/world/listing UPDATE#1':
    'records first: list_world records the thing and refuses E7',
  'src/world-market.ts POST /api/world/offer/:offerId/cancel UPDATE#1':
    'records first: cancel_world records the thing and proceeds; releasing the sale lock passes the guard',
  'src/world.ts upgradeConvertedThing UPDATE#1':
    'records first: thing_upgrade records and refuses E7',
  'src/world.ts PATCH /api/thing/:id UPDATE#1':
    'records first: thing_edit records and refuses E5 or E7',
  'src/world.ts POST /api/thing/:id/upgrade UPDATE#1':
    'records first: thing_upgrade records and refuses E7',
})

// UPDATE through a table name built at run time; each is listed by hand.
const DYNAMIC_SITES: Readonly<Record<string, Decision>> = Object.freeze({
  'src/society.ts giveProperty UPDATE${}#1':
    'records first: transfer give, act give and a held gift accept record first and refuse E7, or E9 while an end is set',
  'src/society.ts POST /api/transfer/offer UPDATE${}#1':
    'records first: a new sale offer records the thing and refuses E7',
  'src/society.ts POST /api/transfer/:offerId/cancel UPDATE${}#1':
    'records first: cancel records the thing and proceeds; releasing the sale lock passes the guard',
})

// The files whose steps select things: the bricks, the waking reads, and their lock plan.
const BRICK_FILES = Object.freeze([
  'src/crafting.ts',
  'src/engine-convert.ts',
  'src/engine-copy.ts',
  'src/engine-effects.ts',
  'src/engine-end-try.ts',
  'src/engine-place-plan.ts',
  'src/engine-reach.ts',
  'src/engine-settle.ts',
  'src/engine-state.ts',
  'src/engine-target-scope.ts',
])

const SELECTION_SITES: Readonly<Record<string, Decision>> = Object.freeze({
  'src/crafting.ts craftKindThing SELECT#1':
    'records first: the ingredient read gives end_reached and crafting refuses E7',
  'src/crafting.ts craftKindThing SELECT#2':
    'skips: the commit locks only ingredients whose end has not come, so a race answers changed; retry',
  'src/engine-convert.ts kindTraitConversion SELECT#1':
    'exempt: the converting program own thing; a remnant runs only its own end try, where converting is allowed',
  'src/engine-convert.ts convertThing SELECT#1':
    'skips: the locked target read gives end_reached',
  'src/engine-copy.ts lockParent SELECT#1':
    'skips: the locked parent read gives end_reached and the end_try writer, and the copy rule',
  'src/engine-copy.ts lockParent SELECT#2':
    'exempt: a key-share lock on the family first thing; it reads nothing',
  'src/engine-effects.ts changedPublicTarget SELECT#1':
    'exempt: locks a target the step already judged, for its public activity stamp',
  'src/engine-effects.ts readTarget SELECT#1':
    'skips: the target read gives end_reached for label, block and check_label',
  'src/engine-effects.ts lockLawPlaceEffects SELECT#1':
    'exempt: a row lock on the source thing taken before a law runs; each step judges its own target',
  'src/engine-effects.ts thingState SELECT#1':
    'skips: gives end_reached to destroy, move and transfer',
  'src/engine-effects.ts thingState SELECT#2':
    'skips: gives end_reached to destroy, move and transfer',
  'src/engine-effects.ts timerThingEnds SELECT#1':
    'skips: a waiting step whose source or target thing ended is skipped and never repeats',
  'src/engine-end-try.ts endTryFacts SELECT#1':
    'exempt: reads the owner and end trait to plan the locks; lockEndTry judges the thing under its lock',
  'src/engine-end-try.ts loadEndUnits SELECT#1':
    'exempt: claims only remnants whose end try waits; lockEndTry judges each again under its lock',
  'src/engine-end-try.ts lockEndTry SELECT#1':
    'exempt: the end try runs only for a recorded remnant still pending in this room, judged under its row lock',
  'src/engine-end-try.ts recordRoomEnds SELECT#1':
    'records first: picks the due ends in the room and records each through recordDueEnd',
  'src/engine-place-plan.ts lockEffectResidents SELECT#1':
    'exempt: reads owners to plan lock order; it writes nothing and each step judges the end',
  'src/engine-place-plan.ts effectPlaceIds SELECT#1':
    'exempt: reads places to plan lock order; it writes nothing and each step judges the end',
  'src/engine-place-plan.ts lockEffectThings SELECT#1':
    'exempt: locks things in id order before a program; each step judges the end',
  'src/engine-reach.ts loadMembers SELECT#1':
    'skips: a thing whose end has come is never a reach member',
  'src/engine-reach.ts reachMemberStillConsents SELECT#1':
    'exempt: re-reads a delayed member consent; timerThingEnds skips an ended member first',
  'src/engine-settle.ts loadCandidates SELECT#1':
    'skips: a thing whose end has come never wakes',
  'src/engine-settle.ts roomMayWake SELECT#1':
    'skips: a thing whose end has come never wakes',
  'src/engine-settle.ts stillEligible SELECT#1':
    'skips: a thing whose end has come never wakes, judged again under the lock',
  'src/engine-settle.ts roomMayWake SELECT#2':
    'exempt: asks only whether an end try waits in the room; the try judges its thing under the lock',
  'src/engine-settle.ts runTry SELECT#1':
    'exempt: reads the owner of a thing stillEligible already judged',
  'src/engine-state.ts writeStateBox SELECT#1':
    'skips: skipAfterOwnEnd skips a write on the program own reached thing first',
  'src/engine-state.ts clearStateBox SELECT#1':
    'records first: thing_edit state_clear, after PATCH records and refuses E7',
  'src/engine-target-scope.ts requireCallerTargetScope SELECT#1':
    'exempt: a scope check; the step itself judges the end, so a skip never becomes a refusal',
})

// Known paths where a door refuses a due thing without recording it (TE-T8-check.md note 4).
// Neither is a wrong answer for the resident; the next resident write or settle records it.
const SHAPE_REFUSALS_BEFORE_THE_RECORDER = Object.freeze([
  {
    site: 'src/world.ts PATCH /api/thing/:id UPDATE#1',
    path: 'a malformed ending on a due thing answers E3 before the recorder runs',
  },
  {
    site: 'src/world.ts POST /api/thing/:id/upgrade UPDATE#1',
    path: 'a malformed ending on a due thing answers E3 before the recorder runs',
  },
  {
    site: 'src/thing-ending-owner.ts writeOwnerEnding UPDATE#1',
    path: 'a thing falling due between the door check and the transaction answers E5 (or E16 from the guard) without recording',
  },
])

const DECLARATIONS = Object.freeze([
  /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/,
  /^(?:export\s+)?(?:const|let)\s+(\w+)/,
])
const ROUTE = /^\s*\w+\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)/
const WRITE = /\b(UPDATE|INSERT\s+INTO)\s+things\b/g
const DYNAMIC = /\bUPDATE\s+\$\{/g
const SELECTION = /\b(?:FROM|JOIN)\s+things\b/g

function sourceFiles(): string[] {
  return (readdirSync(new URL('../src/', import.meta.url), { recursive: true }) as string[])
    .map(name => `src/${name.split('\\').join('/')}`)
    .filter(name => name.endsWith('.ts'))
    .sort()
}

function owner(line: string, current: string): string {
  const route = ROUTE.exec(line)
  if (route) return `${route[1]!.toUpperCase()} ${route[2]}`
  for (const declaration of DECLARATIONS) {
    const found = declaration.exec(line)
    if (found) return found[1]!
  }
  return current
}

function isComment(line: string): boolean {
  const trimmed = line.trim()
  return ['//', '*', '/*', '--'].some(start => trimmed.startsWith(start))
}

/** Each match of the pattern, named by file, the code around it, its kind and its order there. */
function sites(path: string, pattern: RegExp, kind: (match: RegExpMatchArray) => string): string[] {
  const lines = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').split('\n')
  const seen = new Map<string, number>()
  const found: string[] = []
  let around = '(module)'
  for (const line of lines) {
    around = owner(line, around)
    if (isComment(line)) continue
    for (const match of line.matchAll(pattern)) {
      const base = `${path} ${around} ${kind(match)}`
      const order = (seen.get(base) ?? 0) + 1
      seen.set(base, order)
      found.push(`${base}#${order}`)
    }
  }
  return found
}

function census(paths: readonly string[], pattern: RegExp, kind: (match: RegExpMatchArray) => string): string[] {
  return paths.flatMap(path => sites(path, pattern, kind)).sort()
}

function assertDecided(listed: Readonly<Record<string, Decision>>): void {
  for (const [site, decision] of Object.entries(listed)) {
    assert.match(decision, /^(records first|guarded|skips|exempt): \S/, `${site} names its decision and why`)
  }
}

test('every UPDATE or INSERT on things in src is a named site with its ending decision', () => {
  const found = census(sourceFiles(), WRITE, match => (match[1] === 'UPDATE' ? 'UPDATE' : 'INSERT'))
  assert.deepEqual(found, Object.keys(WRITE_SITES).sort(),
    'a new, moved or removed write on things: list it in WRITE_SITES with its ending decision')
  assertDecided(WRITE_SITES)
})

test('every UPDATE through a table name built at run time is listed by hand', () => {
  const found = census(sourceFiles(), DYNAMIC, () => 'UPDATE${}')
  assert.deepEqual(found, Object.keys(DYNAMIC_SITES).sort(),
    'a new UPDATE through a built table name: list it in DYNAMIC_SITES with its ending decision')
  assertDecided(DYNAMIC_SITES)
})

test('every thing selection in a brick is a named site with its ending decision', () => {
  const found = census(BRICK_FILES, SELECTION, () => 'SELECT')
  assert.deepEqual(found, Object.keys(SELECTION_SITES).sort(),
    'a new, moved or removed thing selection in a brick: list it in SELECTION_SITES with its ending decision')
  assertDecided(SELECTION_SITES)
})

test('the known refusals before the recorder name doors that otherwise record first', () => {
  for (const known of SHAPE_REFUSALS_BEFORE_THE_RECORDER) {
    assert.ok(WRITE_SITES[known.site]?.startsWith('records first: '), `${known.site}: ${known.path}`)
  }
})

test('the census scanner names a site by its code, not by its line', () => {
  const sample = [
    'async function sample() {',
    '  // UPDATE things in a comment is not a site',
    '  await db`UPDATE things SET name = ${name}`',
    '  await db`UPDATE things SET body = ${body}`',
    '}',
    "app.patch('/api/sample/:id', async c => {",
    '  await db`INSERT INTO things (name) VALUES (${name})`',
    '  await db`UPDATE things_today SET n = 1`',
    '})',
  ]
  let around = '(module)'
  const names: string[] = []
  const seen = new Map<string, number>()
  for (const line of sample) {
    around = owner(line, around)
    if (isComment(line)) continue
    for (const match of line.matchAll(WRITE)) {
      const base = `${around} ${match[1] === 'UPDATE' ? 'UPDATE' : 'INSERT'}`
      const order = (seen.get(base) ?? 0) + 1
      seen.set(base, order)
      names.push(`${base}#${order}`)
    }
  }
  assert.deepEqual(names, ['sample UPDATE#1', 'sample UPDATE#2', 'PATCH /api/sample/:id INSERT#1'])
})
