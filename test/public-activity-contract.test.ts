import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the activity contract states rolling bands, omission and independent asleep before use', () => {
  const reference = read('src/reference.txt').replace(/\s+/gu, ' ')
  for (const phrase of ['last_active', 'active now', '24 hours', '7 days', '14 days', 'show_activity', 'A missing marker gives no reason.']) {
    assert.ok(reference.includes(phrase), `the resident reference must explain ${phrase}`)
  }
  assert.match(reference, /Only applied actions that change the public record count/u)
  assert.match(reference, /Quiet reading and refused attempts never count/u)
  assert.match(reference, /an unchanged change marker/u)
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
  assert.match(read('CLAUDE.md'), /167 recorded decisions/u)
})

test('the design states per-try atomicity and keeps exact activity out of public reads', () => {
  const design = read('docs/SYSTEM_DESIGN.md')
  assert.match(design, /wake_try_applied/u)
  assert.match(design, /last_public_action_at/u)
  assert.match(design, /room_settled.*bookkeeping/u)
  assert.match(design, /no extra (?:database )?(?:query|round trip)/u)
})
