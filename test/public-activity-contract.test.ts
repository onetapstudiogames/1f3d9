import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the activity contract states rolling bands, omission and independent asleep before use', () => {
  const reference = read('src/reference.txt').replace(/\s+/gu, ' ')
  for (const phrase of ['last_active', 'active now', '24 hours', '7 days', '14 days', 'show_activity', 'Off removes only the marker', 'stay in the public event list']) {
    assert.ok(reference.includes(phrase), `the resident reference must explain ${phrase}`)
  }
  assert.match(reference, /Only applied actions that change the public record count/u)
  assert.match(reference, /Quiet reading and refused attempts never count/u)
  assert.match(reference, /an unchanged change marker/u)
})

test('the cut wording names what the city could not prove and counts only public record changes', () => {
  // The backfill cut is late on 2026-10-28, so a record from that day can be unproved.
  // action_runs stores no go_home destination, so every old go_home is unproved even when
  // its notice names two places. An applied act with an empty applied_public_activity
  // (going home while home, a use that only labels or blocks a resident) stamps no one.
  const reference = read('src/reference.txt').replace(/\s+/gu, ' ')
  const start = reference.indexOf('show_activity is true by default.')
  const section = reference.slice(start, reference.indexOf('An act while off still counts', start))
  assert.ok(start >= 0 && section.length > 0, 'the PUBLIC ACTIVITY choice paragraph must stay findable')
  const description = read('src/mcp.ts').split('\n').find(line => line.startsWith('const PUBLIC_ACTIVITY_DESCRIPTION = ')) ?? ''
  assert.ok(description, 'the shared tool description must stay one source line')
  const row = read('docs/DECISIONS.md').split('\n').find(line => /^\| 170 \|/u.test(line)) ?? ''
  assert.ok(row, 'decision 170 must exist')
  for (const text of [section, description]) {
    assert.ok(text.includes('a record from 28 October 2026 or earlier that the city could not prove changed anything, such as an old go_home'))
    assert.doesNotMatch(text, /before 28 October 2026/u)
  }
  assert.ok(row.includes('one the city could not prove changed anything, such as an old go_home'))
  for (const text of [section, description, row]) {
    assert.doesNotMatch(text, /does not show whether it changed anything|does not show a change|changed something|changes something/u)
  }
  assert.ok(section.includes('even one that names two different places, or a first home_set'))
  assert.ok(section.includes('beside your public action that changed the public record, made after 28 October 2026'))
  assert.ok(section.includes("the resident's next public action that changes the public record ends it"))
  assert.doesNotMatch(section, /next applied public action|beside your applied public action/u)
  assert.ok(row.includes("beside a resident's public action that changed the public record after 2026-10-28"))
  assert.ok(row.includes('the next public action that changes the public record ends it'))
  const design = read('docs/SYSTEM_DESIGN.md').replace(/\s+/gu, ' ')
  assert.ok(design.includes('or a use whose only effect labels or blocks a resident, changed nothing public and stamps no one'))
  assert.ok(design.includes('every old go_home is unproved'))
  assert.doesNotMatch(design, /act that changed something|changed nothing and stamps no one/u)
})

test('help explains activity and the choice without punctuation that breaks its plain text doors', async () => {
  const { CITY_HELP_DOORS, APP_CITY_HELP_DOORS } = await import('../src/city-help.ts')
  for (const doors of [CITY_HELP_DOORS, APP_CITY_HELP_DOORS]) {
    const line = doors.find(value => value.startsWith('Public activity:'))
    assert.ok(line, 'both help doors need the activity rule')
    assert.match(line, /show_activity/u)
    assert.doesNotMatch(line, /['&<>\u2013\u2014\u2018\u2019\u201c\u201d]/u)
  }
})

test('the new decision records the narrow exceptions without revising locked rules', () => {
  const decisions = read('docs/DECISIONS.md')
  const row = decisions.split('\n').find(line => /^\| 166 \|/u.test(line))
  assert.ok(row, '166 was the next free decision on the builder baseline')
  for (const phrase of ['34', '56', '106', '117', '154', 'wake_try_applied', '40798']) {
    assert.ok(row.includes(phrase), `the decision needs ${phrase}`)
  }
  assert.match(read('CLAUDE.md'), /170 recorded decisions/u)
})

test('the design states per-try atomicity and keeps exact activity out of public reads', () => {
  const design = read('docs/SYSTEM_DESIGN.md')
  assert.match(design, /wake_try_applied/u)
  assert.match(design, /last_public_action_at/u)
  assert.match(design, /room_settled.*bookkeeping/u)
  assert.match(design, /no extra (?:database )?(?:query|round trip)/u)
})
