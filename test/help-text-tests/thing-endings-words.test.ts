import assert from 'node:assert/strict'
import test from 'node:test'
import { generatedReference, GENERATED_LLMS, REFERENCE_SECTIONS } from '../helpers/help-text-fixtures/door-surfaces.ts'
import { APP_BANNED_TEXT, APP_FRONT_DOOR_SECTIONS } from '../../src/door-profile.ts'
import { CITY_HELP_DOORS, APP_CITY_HELP_DOORS } from '../../src/city-help.ts'
import { CITY_LIMIT_LINES, ENDING_LIMITS_LINE, PAYMENT_TERMINAL_STATES_LINE } from '../../src/city-facts.ts'
import { publicOfficialFacts, publicPhysicsFacts } from '../../src/public-reference-facts.ts'
import { END_KEY_REFUSAL } from '../../src/thing-ending-refusals.ts'
import { ENDING_MODES } from '../../src/thing-endings.ts'
import {
  ENDING_MAX_CONDITIONS,
  ENDING_MAX_SECONDS,
  ENDING_MAX_USES,
  ENDING_MIN_SECONDS,
  ENDING_MIN_USES,
  ENDING_POLICY_MAX_LABELS,
  ENDING_POLICY_MIN_LABELS,
} from '../../src/engine-limits.ts'

// The words of things ending (decisions #171 to #180): the reference page things-ending,
// the money section sale-ends, the pointers from every section an end touches, and the
// facts served beside them. Each assertion names a rule the code enforces.

const prose = (text: string) => text.replace(/\s+/gu, ' ')

/** The served text of one anchored section of the generated reference, up to the next heading. */
function section(heading: string): string {
  const start = generatedReference.indexOf(`\n${heading}\n`)
  assert.ok(start >= 0, `heading ${heading}`)
  const rest = generatedReference.slice(start + heading.length + 2)
  const next = rest.search(/\n[^\n]+\n(?:={3,}|-{3,}|~{3,})\n/u)
  return next < 0 ? rest : rest.slice(0, next)
}

export function registerThingEndingsWordsTests(): void {
  test('the things-ending page is an app front door section and carries no money or sale words', () => {
    assert.ok((APP_FRONT_DOOR_SECTIONS as readonly string[]).includes('things-ending'))
    const page = REFERENCE_SECTIONS['things-ending']
    assert.ok(page, 'things-ending page')
    assert.doesNotMatch(page, APP_BANNED_TEXT)
  })

  test('the things-ending page states the rules residents need before setting an end', () => {
    const page = prose(REFERENCE_SECTIONS['things-ending'] ?? '')
    for (const mode of ENDING_MODES) assert.ok(page.includes(mode), mode)
    for (const field of ['ending_policy', 'ending', 'remnant', 'thing_links', 'end_program_summary', 'ends']) {
      assert.ok(page.includes(field), field)
    }
    assert.match(page, /if waking is on for it and its room lets it wake/u)
    assert.match(page, /check_label on its own remnant always reads false/u)
    assert.match(page, /labels \[\]/u)
    assert.match(page, /Nothing that existed before[^.]*has an end/u)
    assert.match(page, /only the resident who made it, while owning it/iu)
    assert.match(page, /clear[^.]*but nobody can move it earlier, lower its uses, or give the copy a new end/u)
    assert.match(page, /a copy made by a use takes the uses its parent had left before that use/iu)
    assert.match(page, /act give answers with the end first/u)
    assert.match(page, /settles the room you read it in/u)
    assert.match(page, /There is no pause/u)
    assert.match(page, /never records an end/u)
    // How soon an end shows (4.D.32): no promise that every list shows it at once.
    assert.doesNotMatch(page, /every (?:list|read) shows (?:the|an|its) end at once/iu)
    assert.match(page, /can show "set" with a time already past for a few minutes/u)
  })

  test('the money page carries sale-ends with the sale rules of an end', () => {
    const sales = prose(section('WHEN A THING FOR SALE ENDS'))
    assert.ok(REFERENCE_SECTIONS.money?.includes('cite: money#sale-ends'))
    assert.ok(sales.includes(
      "If its room settles while it is still for sale, its end steps are skipped for good; if the sale is cancelled first, they run at the room's next settle.",
    ))
    assert.match(sales, /no new purchase can start/u)
    assert.match(sales, /thing_ended/u)
    assert.match(sales, /asset_state/u)
    assert.match(sales, /no money moved and the authorization lapses/u)
    assert.match(sales, /claim_world 402[^.]*no end fields/u)
    assert.match(sales, /\$1 or one fee credit/u)
    assert.match(sales, /Selling a thing with an end is allowed/u)
    assert.match(prose(PAYMENT_TERMINAL_STATES_LINE), /thing_ended/u)
  })

  test('every section an end touches points to things-ending', () => {
    for (const heading of [
      'LOOK AND BUILD',
      'KINDS, TRAITS, AND REGIONAL PHYSICS',
      'WAKE ON ARRIVAL',
      'NOTHING RUNS WHILE NOBODY IS THERE',
      'MAKE A COPY',
      'OWN, PROMISE, AND SPEAK',
      'HELD GIFTS',
      'SALES, RENT, AND WAGES',
      'THE MARKET NEXT DOOR',
      'DATED PUBLIC SNAPSHOTS',
      'THING EDIT AND UPGRADE',
      'TRAITS AND KINDS',
    ]) {
      assert.match(section(heading), /things-ending/u, heading)
    }
  })

  test('the settle and recipe passages name the end key and what a settle that only records ends answers', () => {
    const settle = prose(section('NOTHING RUNS WHILE NOBODY IS THERE'))
    assert.match(settle, /settle_id null and ended above 0/u)
    assert.match(settle, /End tries run first and are not part of the random pick/u)
    assert.match(settle, /one end try may take a settle past 256/u)
    assert.match(settle, /A failed end try is not tried again/u)
    assert.match(settle, /blocked_by/u)
    for (const gate of ['wake_off', 'visitors_not_waking', 'carried', 'in_sale', 'room_retired']) {
      assert.ok(settle.includes(gate), gate)
    }
    const kinds = prose(section('KINDS, TRAITS, AND REGIONAL PHYSICS'))
    assert.match(kinds, /one wake key and one end key/u)
    const abilities = prose(section('WHAT THINGS CAN DO'))
    assert.match(abilities, /Copy, write, the wake key, the end key, and a convert/u)
    assert.match(abilities, /only one trait with an end key/u)
    assert.match(END_KEY_REFUSAL, /move anything except to home/u)
  })

  test('the reference field lists name ends where the reads carry it', () => {
    assert.match(prose(section('FOCUS MODE')), /outlines only \(id, author, kind, size, date, and ends on a thing/u)
    assert.match(prose(section('MUTES')), /hidden_items: id, type, author, kind, size, date, place_id, and ends on a thing/u)
    assert.match(prose(section('HELD GIFTS')), /\(waiting_id, type, asset_id, from, held_at, and ends on a thing/u)
  })

  test('physics, limits, help and llms state the end facts from the enforced constants', () => {
    const physics = publicPhysicsFacts() as Record<string, any>
    assert.deepEqual(physics.end.modes, [...ENDING_MODES])
    assert.equal(physics.end.key, 'end')
    assert.equal(physics.end.then, 'required')
    assert.equal(physics.end.one_per_kind, 'a kind revision may list only one trait with an end key')
    assert.deepEqual(physics.end.conditions, { min: 1, max: ENDING_MAX_CONDITIONS })
    assert.deepEqual(physics.end.seconds, { min: ENDING_MIN_SECONDS, max: ENDING_MAX_SECONDS })
    assert.deepEqual(physics.end.uses, { min: ENDING_MIN_USES, max: ENDING_MAX_USES })
    assert.deepEqual(physics.end.policy_labels, { min: ENDING_POLICY_MIN_LABELS, max: ENDING_POLICY_MAX_LABELS })
    assert.equal(physics.end.at_days_ahead_max, 366)
    assert.deepEqual(physics.end.end_only, [
      'never names actor or writes the actor\'s handle',
      'never waits',
      'never destroys, moves or labels the thing that is ending',
    ])
    assert.deepEqual(physics.end.never_in_end, ['transfer', 'target outside a reach', 'move to destination'])
    assert.ok(physics.kind_only.includes('end'))
    assert.doesNotMatch(JSON.stringify(physics), APP_BANNED_TEXT)

    // The front door's 10 KB budget has no room for a limit line, so official facts carry
    // ending_limits and the things-ending page prints the same line.
    const limits = ENDING_LIMITS_LINE
    assert.equal(CITY_LIMIT_LINES.includes(limits), false)
    for (const value of ['1..4 conditions', '366 days', '60..31622400 seconds', '1..10000 uses', '1..8 label names', 'thing_links 0..16']) {
      assert.ok(limits.includes(value), value)
    }
    assert.doesNotMatch(limits, APP_BANNED_TEXT)
    const official = publicOfficialFacts({
      domain: 'https://1f3d9.com', identityBrowserReady: true, identityRecoveryEnabled: true,
      identityRotationEnabled: true, codingIdentityDoorsEnabled: true,
    }) as Record<string, unknown>
    assert.equal(official.ending_limits, limits)
    assert.ok((REFERENCE_SECTIONS['things-ending'] ?? '').includes(limits))

    for (const doors of [CITY_HELP_DOORS, APP_CITY_HELP_DOORS]) {
      const line = doors.find(door => door.startsWith('Thing endings:'))
      assert.ok(line, 'help line')
      assert.match(line, /front_door section things-ending/u)
      assert.doesNotMatch(line, APP_BANNED_TEXT)
    }
    assert.match(GENERATED_LLMS, /https:\/\/1f3d9\.com\/reference\/things-ending\.txt/u)
  })
}
