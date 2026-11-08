import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { EngineError } from '../src/engine.ts'
import { MODERATED_TEXT } from '../src/moderation.ts'
import {
  ENDING_MAX_SECONDS,
  ENDING_MAX_USES,
  ENDING_MIN_SECONDS,
} from '../src/engine-limits.ts'
import {
  ENDING_COPY_FIXED_REFUSAL,
  ENDING_NOT_ALLOWED_REFUSAL,
  ENDING_POLICY_REFUSAL,
  ENDING_SHAPE_REFUSAL,
  END_TRY_SKIP_REASONS,
  KINDLESS_ENDING_REFUSAL,
  THING_ENDING_CHANGED_REFUSAL,
  THING_ENDING_GUARD_STATUS,
  endTraitConflictRefusal,
  thingEndingGuardRefusal,
} from '../src/thing-ending-refusals.ts'
import {
  DEFAULT_ENDING_POLICY,
  ENDING_MODES,
  THING_ENDING_LIMITS_VERSION,
  THING_FIRST_LABEL_AT_SQL,
  assertRenewalFits,
  buildGrant,
  copyRuleFrom,
  dueCause,
  endTryBlockedBy,
  endTryGates,
  endingColumnsFor,
  endingDueAt,
  endingFitRefusal,
  endingPermission,
  endingStatus,
  grantForNewEnding,
  isDefaultEndingPolicy,
  parseEndingInput,
  parseEndingPolicy,
  parseStoredEndingRule,
  policyNarrowsOrKeeps,
  policyWidens,
  renewalFitsGrant,
  shortEndingStatus,
  storedEndingPolicy,
  type EndTryRoom,
  type EndTryThing,
  type EndingGrant,
  type EndingPolicy,
  type ThingEndingRow,
} from '../src/thing-endings.ts'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const at = (offsetSeconds: number): string => new Date(NOW.getTime() + offsetSeconds * 1000).toISOString()
const DAY = 86_400

function refusal(fn: () => unknown, message: string, status?: number): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof EngineError, `expected EngineError, got ${String(error)}`)
    assert.equal(error.message, message)
    if (status !== undefined) assert.equal(error.status, status)
    return true
  })
}

// ---------------------------------------------------------------------------
// parseEndingInput: the owner's rule and the city limits
// ---------------------------------------------------------------------------

test('parseEndingInput reads null as a clear and keeps every mode in canonical order', () => {
  assert.equal(parseEndingInput(null, NOW), null)
  const rule = parseEndingInput({
    any: [
      { label_added: 'Spent' },
      { idle_seconds: 3_600 },
      { uses: 5 },
      { at: at(DAY) },
    ],
  }, NOW)
  assert.deepEqual(rule, {
    any: [{ at: at(DAY) }, { uses: 5 }, { idle_seconds: 3_600 }, { label_added: 'spent' }],
  })
  assert.ok(Object.isFrozen(rule))
  assert.deepEqual(ENDING_MODES, ['at', 'after_setting_seconds', 'uses', 'idle_seconds', 'label_added'])
})

test('parseEndingInput holds every city limit at its edge', () => {
  const ok = (condition: Record<string, unknown>) => parseEndingInput({ any: [condition] }, NOW)
  const bad = (condition: Record<string, unknown>) => refusal(() => ok(condition), ENDING_SHAPE_REFUSAL, 400)

  // A date: in the future, at most 366 days ahead, a UTC time.
  assert.deepEqual(ok({ at: at(1) }), { any: [{ at: at(1) }] })
  assert.deepEqual(ok({ at: at(ENDING_MAX_SECONDS) }), { any: [{ at: at(ENDING_MAX_SECONDS) }] })
  assert.deepEqual(ok({ at: '2026-12-01T00:00:00+00:00' }), { any: [{ at: '2026-12-01T00:00:00.000Z' }] })
  assert.deepEqual(ok({ at: '2026-12-01T00:00Z' }), { any: [{ at: '2026-12-01T00:00:00.000Z' }] })
  bad({ at: at(0) })
  bad({ at: at(-60) })
  bad({ at: at(ENDING_MAX_SECONDS + 1) })
  bad({ at: '2026-12-01' })
  bad({ at: '2026-12-01T00:00:00+02:00' })
  bad({ at: '2027-02-30T00:00:00Z' })
  bad({ at: '2026-12-01T00:00:00.1234Z' })
  bad({ at: 1_800_000_000 })

  for (const mode of ['after_setting_seconds', 'idle_seconds']) {
    assert.deepEqual(ok({ [mode]: ENDING_MIN_SECONDS }), { any: [{ [mode]: 60 }] })
    assert.deepEqual(ok({ [mode]: ENDING_MAX_SECONDS }), { any: [{ [mode]: 31_622_400 }] })
    bad({ [mode]: 59 })
    bad({ [mode]: ENDING_MAX_SECONDS + 1 })
    bad({ [mode]: 60.5 })
    bad({ [mode]: '60' })
  }

  assert.deepEqual(ok({ uses: 1 }), { any: [{ uses: 1 }] })
  assert.deepEqual(ok({ uses: ENDING_MAX_USES }), { any: [{ uses: 10_000 }] })
  bad({ uses: 0 })
  bad({ uses: 10_001 })
  bad({ uses: 2.5 })

  assert.deepEqual(ok({ label_added: 'a' }), { any: [{ label_added: 'a' }] })
  assert.deepEqual(ok({ label_added: 'x'.repeat(64) }), { any: [{ label_added: 'x'.repeat(64) }] })
  bad({ label_added: 'x'.repeat(65) })
  bad({ label_added: '-spent' })
  bad({ label_added: 'no spaces' })
  bad({ label_added: '' })
})

test('parseEndingInput refuses a malformed rule, duplicate modes, and too many conditions', () => {
  const bad = (value: unknown) => refusal(() => parseEndingInput(value, NOW), ENDING_SHAPE_REFUSAL, 400)
  bad(undefined)
  bad('soon')
  bad([])
  bad({})
  bad({ any: [] })
  bad({ any: {} })
  bad({ any: [{ uses: 2 }], extra: true })
  bad({ any: [{ uses: 2 }, { uses: 3 }] })
  bad({ any: [{ idle_seconds: 60 }, { idle_seconds: 120 }] })
  bad({ any: [{ uses: 2, idle_seconds: 60 }] })
  bad({ any: [{}] })
  bad({ any: [{ pause: true }] })
  bad({ any: [null] })
  // until belongs to a copy's stored rule; an owner never sends it.
  bad({ any: [{ idle_seconds: 60, until: at(60) }] })
  bad({
    any: [{ at: at(60) }, { after_setting_seconds: 60 }, { uses: 2 }, { idle_seconds: 60 }, { label_added: 'spent' }],
  })
  // eslint-disable-next-line no-sparse-arrays
  bad({ any: [, { uses: 2 }] })
  assert.deepEqual(
    parseEndingInput({ any: [{ at: at(60) }, { after_setting_seconds: 60 }, { uses: 2 }, { idle_seconds: 60 }] }, NOW)?.any.length,
    4,
  )
})

test('parseStoredEndingRule reads a stored rule, until included, and never throws', () => {
  assert.equal(parseStoredEndingRule(null), null)
  assert.equal(parseStoredEndingRule('x'), null)
  assert.equal(parseStoredEndingRule({ any: 'x' }), null)
  assert.deepEqual(
    parseStoredEndingRule({ any: [{ idle_seconds: 3_600, until: at(60) }, 'junk', { uses: 3 }] }),
    { any: [{ idle_seconds: 3_600, until: at(60) }, { uses: 3 }] },
  )
})

// ---------------------------------------------------------------------------
// parseEndingPolicy and the widen and narrow tables
// ---------------------------------------------------------------------------

test('parseEndingPolicy accepts the shapes valid_ending_policy accepts and refuses the rest with E1', () => {
  assert.deepEqual(parseEndingPolicy({ allowed: [] }), { allowed: [] })
  assert.deepEqual(parseEndingPolicy({ allowed: ['uses', 'at'] }), { allowed: ['at', 'uses'] })
  assert.deepEqual(
    parseEndingPolicy({ allowed: ['label_added'], labels: ['Spent', 'worn'] }),
    { allowed: ['label_added'], labels: ['spent', 'worn'] },
  )
  assert.deepEqual(
    parseEndingPolicy({ allowed: ['idle_seconds', 'uses'], max_seconds: 60, max_uses: 1 }),
    { allowed: ['uses', 'idle_seconds'], max_seconds: 60, max_uses: 1 },
  )
  assert.deepEqual(
    parseEndingPolicy({ allowed: ['at'], max_seconds: ENDING_MAX_SECONDS, max_uses: ENDING_MAX_USES }),
    { allowed: ['at'], max_seconds: 31_622_400, max_uses: 10_000 },
  )
  const eight = Array.from({ length: 8 }, (_, index) => `l${index}`)
  assert.deepEqual(parseEndingPolicy({ allowed: ['label_added'], labels: eight }).labels, eight)

  const bad = (value: unknown) => refusal(() => parseEndingPolicy(value), ENDING_POLICY_REFUSAL, 400)
  bad(null)
  bad(undefined)
  bad([])
  bad({})
  bad({ allowed: 'at' })
  bad({ allowed: ['at', 'at'] })
  bad({ allowed: ['pause'] })
  bad({ allowed: ['label_added'] })
  bad({ allowed: ['label_added'], labels: [] })
  bad({ allowed: ['label_added'], labels: [...eight, 'l8'] })
  bad({ allowed: ['label_added'], labels: ['spent', 'SPENT'] })
  bad({ allowed: ['label_added'], labels: ['no spaces'] })
  bad({ allowed: ['at'], labels: ['spent'] })
  bad({ allowed: ['at'], max_seconds: 59 })
  bad({ allowed: ['at'], max_seconds: ENDING_MAX_SECONDS + 1 })
  bad({ allowed: ['at'], max_seconds: 3600.5 })
  bad({ allowed: ['uses'], max_uses: 0 })
  bad({ allowed: ['uses'], max_uses: 10_001 })
  bad({ allowed: ['uses'], extra: 1 })
})

test('the stored policy reads tolerantly and the default is recognised', () => {
  assert.deepEqual(storedEndingPolicy(null), DEFAULT_ENDING_POLICY)
  assert.deepEqual(storedEndingPolicy({ allowed: 'x' }), DEFAULT_ENDING_POLICY)
  assert.deepEqual(storedEndingPolicy({ allowed: ['uses', 'pause'] }).allowed, ['uses'])
  assert.equal(isDefaultEndingPolicy({ allowed: [] }), true)
  assert.equal(isDefaultEndingPolicy({ allowed: ['at'] }), false)
  assert.equal(isDefaultEndingPolicy({ allowed: [], max_uses: 3 }), false)
})

test('policyWidens and policyNarrowsOrKeeps follow the widen and narrow table', () => {
  const base: EndingPolicy = { allowed: ['at', 'uses', 'label_added'], labels: ['spent', 'worn'], max_seconds: DAY, max_uses: 10 }
  const rows: ReadonlyArray<readonly [string, EndingPolicy, boolean]> = [
    ['the same policy', base, false],
    ['labels in another order', { ...base, labels: ['worn', 'spent'] }, false],
    ['a mode removed', { allowed: ['at', 'label_added'], labels: ['spent', 'worn'], max_seconds: DAY, max_uses: 10 }, false],
    ['label_added removed with its labels', { allowed: ['at', 'uses'], max_seconds: DAY, max_uses: 10 }, false],
    ['every mode removed', { allowed: [] }, false],
    ['a label removed', { ...base, labels: ['spent'] }, false],
    ['a lower max_seconds', { ...base, max_seconds: 60 }, false],
    ['a lower max_uses', { ...base, max_uses: 1 }, false],
    ['a mode added', { ...base, allowed: ['at', 'uses', 'idle_seconds', 'label_added'] }, true],
    ['a label added', { ...base, labels: ['spent', 'worn', 'cracked'] }, true],
    ['a label swapped', { ...base, labels: ['spent', 'cracked'] }, true],
    ['a higher max_seconds', { ...base, max_seconds: DAY + 1 }, true],
    ['max_seconds dropped, so the city limit', { allowed: base.allowed, labels: ['spent', 'worn'], max_uses: 10 }, true],
    ['a higher max_uses', { ...base, max_uses: 11 }, true],
    ['max_uses dropped, so the city limit', { allowed: base.allowed, labels: ['spent', 'worn'], max_seconds: DAY }, true],
    ['a higher max_uses with uses no longer allowed', { allowed: ['at'], max_seconds: DAY, max_uses: 99 }, false],
    ['a higher max_seconds with no timed mode left', { allowed: ['uses'], max_seconds: 2 * DAY, max_uses: 10 }, false],
  ]
  for (const [name, next, widens] of rows) {
    assert.equal(policyWidens(base, next), widens, name)
    assert.equal(policyNarrowsOrKeeps(base, next), !widens, name)
  }
  assert.equal(policyWidens(DEFAULT_ENDING_POLICY, { allowed: ['at'] }), true)
  assert.equal(policyWidens({ allowed: ['at'] }, DEFAULT_ENDING_POLICY), false)
})

// ---------------------------------------------------------------------------
// Permission, the grant, and fitting a rule to it
// ---------------------------------------------------------------------------

const LAMP_POLICY: EndingPolicy = { allowed: ENDING_MODES, labels: ['spent'] }
const lampThing = { kind_id: 7, current_revision: 1, owner_id: 2, maker_id: 2 }

test('permission comes from the effective kind revision, or from the kindless maker rule', () => {
  assert.deepEqual(endingPermission(lampThing, LAMP_POLICY), {
    source: 'kind', kind_id: 7, revision: 1, policy: LAMP_POLICY,
  })
  assert.deepEqual(endingPermission({ ...lampThing, current_revision: 3 }, { allowed: [] }), {
    source: null, refusal: ENDING_NOT_ALLOWED_REFUSAL,
  })
  assert.deepEqual(endingPermission({ ...lampThing, current_revision: 3 }, null), {
    source: null, refusal: ENDING_NOT_ALLOWED_REFUSAL,
  })
  // A converted thing takes its permission from the kind it was converted into.
  const converted = { ...lampThing, kind_id: 9, current_revision: 4, as_kind_id: 7, as_revision: 2 }
  assert.deepEqual(endingPermission(converted, LAMP_POLICY), {
    source: 'kind', kind_id: 7, revision: 2, policy: LAMP_POLICY,
  })
  // A kindless thing converted into a kind takes that kind's permission, not the kindless rule.
  const kindlessConverted = { kind_id: null, current_revision: null, as_kind_id: 7, as_revision: 1, owner_id: 3, maker_id: 2 }
  assert.deepEqual(endingPermission(kindlessConverted, LAMP_POLICY), {
    source: 'kind', kind_id: 7, revision: 1, policy: LAMP_POLICY,
  })
  const kindless = { kind_id: null, current_revision: null, owner_id: 2, maker_id: 2 }
  assert.deepEqual(endingPermission(kindless, null), { source: 'kindless_owner' })
  assert.deepEqual(endingPermission({ ...kindless, owner_id: 3 }, null), {
    source: null, refusal: KINDLESS_ENDING_REFUSAL,
  })
})

test('buildGrant records the kind, revision, allowed modes, effective limits and the city limit version', () => {
  assert.equal(THING_ENDING_LIMITS_VERSION, 1)
  assert.deepEqual(buildGrant(endingPermission(lampThing, LAMP_POLICY)), {
    kind_id: 7,
    revision: 1,
    allowed: ENDING_MODES,
    limits: { max_seconds: ENDING_MAX_SECONDS, max_uses: ENDING_MAX_USES, labels: ['spent'] },
    city_limits_version: 1,
  })
  assert.deepEqual(
    buildGrant(endingPermission(lampThing, { allowed: ['uses', 'at'], max_seconds: 600, max_uses: 3 })),
    { kind_id: 7, revision: 1, allowed: ['at', 'uses'], limits: { max_seconds: 600, max_uses: 3, labels: null }, city_limits_version: 1 },
  )
  assert.deepEqual(buildGrant({ source: 'kindless_owner' }), {
    kindless: true,
    allowed: ENDING_MODES,
    limits: { max_seconds: ENDING_MAX_SECONDS, max_uses: ENDING_MAX_USES, labels: null },
    city_limits_version: 1,
  })
  assert.equal(buildGrant({ source: null, refusal: ENDING_NOT_ALLOWED_REFUSAL }), null)
})

test('a rule fits its grant: modes refuse with E2 and limits with E3', () => {
  const grant = buildGrant(endingPermission(lampThing, { allowed: ['at', 'uses', 'label_added'], labels: ['spent'], max_seconds: DAY, max_uses: 5 })) as EndingGrant
  const fits = (value: unknown) => endingFitRefusal(parseEndingInput(value, NOW)!, grant, NOW)
  assert.equal(fits({ any: [{ at: at(DAY) }, { uses: 5 }, { label_added: 'spent' }] }), null)
  assert.equal(fits({ any: [{ idle_seconds: 60 }] }), ENDING_NOT_ALLOWED_REFUSAL)
  assert.equal(fits({ any: [{ at: at(DAY + 1) }] }), ENDING_SHAPE_REFUSAL)
  assert.equal(fits({ any: [{ uses: 6 }] }), ENDING_SHAPE_REFUSAL)
  assert.equal(fits({ any: [{ label_added: 'worn' }] }), ENDING_SHAPE_REFUSAL)
  const timed = buildGrant(endingPermission(lampThing, { allowed: ['after_setting_seconds', 'idle_seconds'], max_seconds: 600 })) as EndingGrant
  assert.equal(endingFitRefusal(parseEndingInput({ any: [{ after_setting_seconds: 600 }, { idle_seconds: 600 }] }, NOW)!, timed, NOW), null)
  assert.equal(endingFitRefusal(parseEndingInput({ any: [{ after_setting_seconds: 601 }] }, NOW)!, timed, NOW), ENDING_SHAPE_REFUSAL)
  assert.equal(endingFitRefusal(parseEndingInput({ any: [{ idle_seconds: 601 }] }, NOW)!, timed, NOW), ENDING_SHAPE_REFUSAL)
  // A kindless grant takes any valid label and the city limits.
  const kindless = buildGrant({ source: 'kindless_owner' }) as EndingGrant
  assert.equal(endingFitRefusal(parseEndingInput({ any: [{ label_added: 'anything' }, { uses: 10_000 }] }, NOW)!, kindless, NOW), null)
})

test('a renewal fits the stored grant even after an upgrade or a conversion changed the revision', () => {
  // The end was set under revision 1, which allowed uses up to 10.
  const grant = buildGrant(endingPermission(lampThing, { allowed: ['uses'], max_uses: 10 })) as EndingGrant
  const upgraded = { ...lampThing, current_revision: 2 }
  // Revision 2 forbids endings and revision 3 allows only dates; the renewal still reads the grant.
  assert.equal(endingPermission(upgraded, { allowed: [] }).source, null)
  const renewal = parseEndingInput({ any: [{ uses: 10 }] }, NOW)!
  assert.equal(renewalFitsGrant(renewal, grant, NOW), true)
  assert.doesNotThrow(() => assertRenewalFits(renewal, grant, NOW))
  assert.equal(renewalFitsGrant(parseEndingInput({ any: [{ uses: 11 }] }, NOW)!, grant, NOW), false)
  refusal(() => assertRenewalFits(parseEndingInput({ any: [{ uses: 11 }] }, NOW)!, grant, NOW), ENDING_SHAPE_REFUSAL, 400)
  refusal(() => assertRenewalFits(parseEndingInput({ any: [{ at: at(60) }] }, NOW)!, grant, NOW), ENDING_NOT_ALLOWED_REFUSAL, 403)
  // A converted thing's new setting takes a new grant from the kind it became.
  const converted = { ...lampThing, kind_id: 9, as_kind_id: 7, as_revision: 2 }
  const fresh = grantForNewEnding(converted, { allowed: ['at'] }, parseEndingInput({ any: [{ at: at(60) }] }, NOW)!, NOW)
  assert.deepEqual(fresh, {
    kind_id: 7, revision: 2, allowed: ['at'], limits: { max_seconds: ENDING_MAX_SECONDS, max_uses: ENDING_MAX_USES, labels: null }, city_limits_version: 1,
  })
  // A garbled stored grant fits nothing, so a renewal can never widen.
  assert.equal(renewalFitsGrant(renewal, { allowed: 'uses' } as unknown as EndingGrant, NOW), false)
})

test('grantForNewEnding refuses with E14 for a kindless thing not owned by its maker, and E2 or E3 otherwise', () => {
  const rule = parseEndingInput({ any: [{ uses: 3 }] }, NOW)!
  refusal(() => grantForNewEnding({ kind_id: null, current_revision: null, owner_id: 3, maker_id: 2 }, null, rule, NOW), KINDLESS_ENDING_REFUSAL, 403)
  refusal(() => grantForNewEnding(lampThing, { allowed: [] }, rule, NOW), ENDING_NOT_ALLOWED_REFUSAL, 403)
  refusal(() => grantForNewEnding(lampThing, { allowed: ['at'] }, rule, NOW), ENDING_NOT_ALLOWED_REFUSAL, 403)
  refusal(() => grantForNewEnding(lampThing, { allowed: ['uses'], max_uses: 2 }, rule, NOW), ENDING_SHAPE_REFUSAL, 400)
  assert.equal(grantForNewEnding({ kind_id: null, current_revision: null, owner_id: 2, maker_id: 2 }, null, rule, NOW).allowed.length, 5)
})

test('endingColumnsFor writes the deadline, the unused anchor, the uses and the label at set time', () => {
  const grant = buildGrant(endingPermission(lampThing, LAMP_POLICY)) as EndingGrant
  const rule = parseEndingInput({ any: [{ at: at(5 * DAY) }, { after_setting_seconds: DAY }, { uses: 4 }, { idle_seconds: 600 }] }, NOW)!
  assert.deepEqual(endingColumnsFor(rule, grant, 2, NOW), {
    ending_rule: rule,
    ending_grant: grant,
    ending_set_by: 2,
    ending_set_at: NOW.toISOString(),
    ending_deadline: at(DAY),
    ending_idle_seconds: 600,
    ending_idle_anchor: NOW.toISOString(),
    ending_uses_left: 4,
    ending_uses_spent_at: null,
    ending_label: null,
  })
  const labelOnly = parseEndingInput({ any: [{ label_added: 'spent' }] }, NOW)!
  const columns = endingColumnsFor(labelOnly, grant, 2, NOW)
  assert.equal(columns.ending_deadline, null)
  assert.equal(columns.ending_idle_seconds, null)
  assert.equal(columns.ending_idle_anchor, null)
  assert.equal(columns.ending_uses_left, null)
  assert.equal(columns.ending_label, 'spent')
})

// ---------------------------------------------------------------------------
// Copies
// ---------------------------------------------------------------------------

const SET_AT = new Date(NOW.getTime() - 3_600_000)
const COPY_AT = NOW

function parentRow(rule: unknown, extra: Partial<ThingEndingRow> = {}): ThingEndingRow {
  return thingRow({
    id: 50,
    ending_rule: rule,
    ending_grant: buildGrant(endingPermission(lampThing, LAMP_POLICY)),
    ending_set_by: 2,
    ending_set_at: SET_AT,
    ...extra,
  })
}

test('copyRuleFrom keeps a date, the uses left, the label and the grant, and turns times into absolute ends', () => {
  const grant = buildGrant(endingPermission(lampThing, LAMP_POLICY))
  assert.equal(copyRuleFrom(thingRow({ id: 50 }), COPY_AT, 3), null)

  const dateParent = parentRow({ any: [{ at: at(DAY) }] }, { ending_deadline: at(DAY) })
  assert.deepEqual(copyRuleFrom(dateParent, COPY_AT, 3), {
    ending_rule: { any: [{ at: at(DAY) }] },
    ending_grant: grant,
    ending_set_by: 3,
    ending_set_at: COPY_AT.toISOString(),
    ending_deadline: at(DAY),
    ending_idle_seconds: null,
    ending_idle_anchor: null,
    ending_uses_left: null,
    ending_uses_spent_at: null,
    ending_label: null,
    ending_copied_from: 50,
    ending_copied_at: COPY_AT.toISOString(),
  })

  const usesParent = parentRow({ any: [{ uses: 5 }] }, { ending_uses_left: 2 })
  const usesCopy = copyRuleFrom(usesParent, COPY_AT, 3)!
  assert.deepEqual(usesCopy.ending_rule, { any: [{ uses: 2 }] })
  assert.equal(usesCopy.ending_uses_left, 2)
  assert.equal(usesCopy.ending_deadline, null)

  const labelParent = parentRow({ any: [{ label_added: 'spent' }] }, { ending_label: 'spent' })
  const labelCopy = copyRuleFrom(labelParent, COPY_AT, 3)!
  assert.deepEqual(labelCopy.ending_rule, { any: [{ label_added: 'spent' }] })
  assert.equal(labelCopy.ending_label, 'spent')
  // Label rows count from the copy's birth.
  assert.equal(labelCopy.ending_set_at, COPY_AT.toISOString())

  // Time after setting: the parent's end, set_at plus the seconds, becomes the copy's until.
  const afterParent = parentRow({ any: [{ after_setting_seconds: DAY }] }, { ending_deadline: new Date(SET_AT.getTime() + DAY * 1000) })
  const afterCopy = copyRuleFrom(afterParent, COPY_AT, 3)!
  const afterEnd = new Date(SET_AT.getTime() + DAY * 1000).toISOString()
  assert.deepEqual(afterCopy.ending_rule, { any: [{ after_setting_seconds: DAY, until: afterEnd }] })
  assert.equal(afterCopy.ending_deadline, afterEnd)

  // Time unused: the parent's unused deadline at copy time, kept as an idle condition.
  const anchor = new Date(NOW.getTime() - 600_000)
  const idleParent = parentRow({ any: [{ idle_seconds: 3_600 }] }, { ending_idle_seconds: 3_600, ending_idle_anchor: anchor })
  const idleCopy = copyRuleFrom(idleParent, COPY_AT, 3)!
  const idleEnd = new Date(anchor.getTime() + 3_600_000).toISOString()
  assert.deepEqual(idleCopy.ending_rule, { any: [{ idle_seconds: 3_600, until: idleEnd }] })
  assert.equal(idleCopy.ending_deadline, idleEnd)
  assert.equal(idleCopy.ending_idle_seconds, null)
  assert.equal(idleCopy.ending_idle_anchor, null)
  // The copy's end reads cause idle_seconds when that deadline comes.
  const idleCopyRow = thingRow({ id: 51, parent_thing_id: 50, ...withDates(idleCopy) })
  assert.equal(dueCause(idleCopyRow), 'idle_seconds')
  assert.equal(endingDueAt(idleCopyRow)?.toISOString(), idleEnd)

  // The soonest of several, and a copy of a copy keeps its parent's until.
  const mixed = parentRow(
    { any: [{ at: at(10 * DAY) }, { uses: 4 }, { idle_seconds: 3_600 }] },
    { ending_deadline: at(10 * DAY), ending_uses_left: 4, ending_idle_seconds: 3_600, ending_idle_anchor: anchor },
  )
  const mixedCopy = copyRuleFrom(mixed, COPY_AT, 3)!
  assert.equal(mixedCopy.ending_deadline, idleEnd)
  const grandchild = copyRuleFrom(thingRow({ id: 51, parent_thing_id: 50, ...withDates(mixedCopy) }), new Date(NOW.getTime() + 60_000), 4)!
  assert.deepEqual(grandchild.ending_rule, mixedCopy.ending_rule)
  assert.equal(grandchild.ending_deadline, idleEnd)
  assert.equal(grandchild.ending_copied_from, 51)

  // A parent whose end has come gives its copy no end (the only such copy is its own end try's).
  assert.equal(copyRuleFrom(parentRow({ any: [{ at: at(-60) }] }, { ending_deadline: at(-60) }), COPY_AT, 3), null)
  assert.equal(copyRuleFrom(parentRow({ any: [{ uses: 2 }] }, { ending_uses_left: 2, ended_at: at(-1), ended_cause: 'uses' }), COPY_AT, 3), null)
})

// ---------------------------------------------------------------------------
// Due and its cause
// ---------------------------------------------------------------------------

test('endingDueAt is the soonest condition and dueCause names it', () => {
  const base = { ending_rule: { any: [{ at: at(3_600) }] }, ending_set_at: SET_AT }
  assert.equal(endingDueAt(thingRow({})), null)
  assert.equal(dueCause(thingRow({})), null)
  assert.equal(endingDueAt(thingRow({ ...base, ending_deadline: at(3_600) }))?.toISOString(), at(3_600))
  assert.equal(dueCause(thingRow({ ...base, ending_deadline: at(3_600) })), 'at')
  const spent = thingRow({
    ending_rule: { any: [{ at: at(3_600) }, { uses: 2 }] },
    ending_set_at: SET_AT,
    ending_deadline: at(3_600),
    ending_uses_left: 0,
    ending_uses_spent_at: at(-5),
  })
  assert.equal(endingDueAt(spent)?.toISOString(), at(-5))
  assert.equal(dueCause(spent), 'uses')
  const labelled = thingRow({
    ending_rule: { any: [{ idle_seconds: 3_600 }, { label_added: 'spent' }] },
    ending_set_at: SET_AT,
    ending_idle_seconds: 3_600,
    ending_idle_anchor: NOW,
    ending_label: 'spent',
    first_label_at: at(-10),
  })
  assert.equal(dueCause(labelled), 'label_added')
  assert.equal(endingDueAt(labelled)?.toISOString(), at(-10))
  // The loader's subquery (THING_FIRST_LABEL_AT_SQL) only returns rows created after the
  // end was set, so a value at or before set_at is a broken loader; the rule still ignores it.
  const early = thingRow({ ...labelled, first_label_at: new Date(SET_AT.getTime() - 1) })
  assert.equal(endingDueAt(early)?.toISOString(), at(3_600))
  assert.equal(dueCause(early), 'idle_seconds')
  // SQL keeps only rows strictly after set_at in microseconds and the driver cuts both
  // times to milliseconds, so a value equal to set_at in milliseconds is a row SQL counts.
  const same = thingRow({ ...labelled, first_label_at: SET_AT })
  assert.equal(endingDueAt(same)?.toISOString(), SET_AT.toISOString())
  assert.equal(dueCause(same), 'label_added')
  const after = thingRow({
    ending_rule: { any: [{ after_setting_seconds: 600 }] },
    ending_set_at: SET_AT,
    ending_deadline: new Date(SET_AT.getTime() + 600_000),
  })
  assert.equal(dueCause(after), 'after_setting_seconds')
})

// ---------------------------------------------------------------------------
// The end try's gates
// ---------------------------------------------------------------------------

const ROOM: EndTryRoom = {
  owner_id: 2, wake_visitors: false, wake_pins: [], wake_block_thing_ids: [], wake_block_resident_ids: [], retired_at: null,
}
const TRY_THING: EndTryThing = {
  id: 60, owner_id: 2, wake_enabled: true, held_by: null, in_sale: false, end_program_state: 'pending', has_end_trait: true,
}

test('endTryGates opens or names each closed gate in the fixed order', () => {
  assert.deepEqual(endTryGates(TRY_THING, ROOM), { would_run: true, blocked_by: [] })
  assert.deepEqual(endTryGates({ ...TRY_THING, wake_enabled: false }, ROOM), { would_run: false, blocked_by: ['wake_off'] })
  assert.deepEqual(endTryGates({ ...TRY_THING, held_by: 2 }, ROOM), { would_run: false, blocked_by: ['carried'] })
  assert.deepEqual(endTryGates({ ...TRY_THING, in_sale: true }, ROOM), { would_run: false, blocked_by: ['in_sale'] })
  assert.deepEqual(endTryGates(TRY_THING, { ...ROOM, retired_at: at(-60) }), { would_run: false, blocked_by: ['room_retired'] })
  // Another resident's room: closed unless it wakes visitors or pins the thing.
  const visiting = { ...ROOM, owner_id: 9 }
  assert.deepEqual(endTryGates(TRY_THING, visiting), { would_run: false, blocked_by: ['visitors_not_waking'] })
  assert.deepEqual(endTryGates(TRY_THING, { ...visiting, wake_visitors: true }), { would_run: true, blocked_by: [] })
  assert.deepEqual(endTryGates(TRY_THING, { ...visiting, wake_pins: [60] }), { would_run: true, blocked_by: [] })
  // Either block list closes the gate, even for the room's owner.
  assert.deepEqual(endTryGates(TRY_THING, { ...ROOM, wake_block_thing_ids: [60] }).blocked_by, ['visitors_not_waking'])
  assert.deepEqual(endTryGates(TRY_THING, { ...ROOM, wake_block_resident_ids: [2] }).blocked_by, ['visitors_not_waking'])
  // Carried into a room its owner does not own: both gates, in order.
  assert.deepEqual(endTryGates({ ...TRY_THING, held_by: 2 }, visiting).blocked_by, ['visitors_not_waking', 'carried'])
  assert.deepEqual(
    endTryGates({ ...TRY_THING, wake_enabled: false, held_by: 2, in_sale: true }, { ...visiting, retired_at: at(-1) }).blocked_by,
    ['wake_off', 'visitors_not_waking', 'carried', 'in_sale', 'room_retired'],
  )
  // No end trait, or a try that already ran or was skipped: nothing to say.
  for (const thing of [
    { ...TRY_THING, has_end_trait: false },
    { ...TRY_THING, end_program_state: 'ran' as const },
    { ...TRY_THING, end_program_state: 'skipped' as const },
  ]) assert.deepEqual(endTryGates(thing, ROOM), { would_run: null, blocked_by: null })
  // State none still reads the gates (an active thing whose kind has an end trait).
  assert.deepEqual(endTryGates({ ...TRY_THING, end_program_state: 'none' }, ROOM), { would_run: true, blocked_by: [] })
  assert.deepEqual(endTryBlockedBy({
    wake_enabled: true, carried: false, in_sale: false, room_retired: false, thing_id: 1, owner_id: 2,
    room_owner_id: 2, wake_visitors: false, wake_pins: [], blocked_thing_ids: [], blocked_resident_ids: [],
  }), [])
  for (const gate of ['wake_off', 'visitors_not_waking', 'carried', 'in_sale', 'room_retired'] as const) {
    assert.equal(typeof END_TRY_SKIP_REASONS[gate], 'string')
  }
})

// ---------------------------------------------------------------------------
// The full object and the short status
// ---------------------------------------------------------------------------

function thingRow(extra: Partial<ThingEndingRow>): ThingEndingRow {
  return {
    id: 40,
    owner_id: 2,
    maker_id: 2,
    kind_id: 7,
    current_revision: 1,
    as_kind_id: null,
    as_revision: null,
    parent_thing_id: null,
    ending_rule: null,
    ending_grant: null,
    ending_set_by: null,
    ending_set_at: null,
    ending_deadline: null,
    ending_idle_seconds: null,
    ending_idle_anchor: null,
    ending_uses_left: null,
    ending_uses_spent_at: null,
    ending_label: null,
    first_label_at: null,
    ending_copied_from: null,
    ending_copied_at: null,
    ended_at: null,
    ended_cause: null,
    end_program_state: 'none',
    end_program_result: null,
    set_by: null,
    owner_at_end: null,
    has_end_trait: false,
    kind_hidden: false,
    ...extra,
  }
}

function withDates(columns: ReturnType<typeof copyRuleFrom> & object): Partial<ThingEndingRow> {
  return { ...columns }
}

const NO_GATES = { would_run: null, blocked_by: null } as const
const LAMP_GRANT = buildGrant(endingPermission(lampThing, LAMP_POLICY))

test('endingStatus: not_permitted_by_kind and permitted_but_unset, from kind or kindless owner', () => {
  const stone = endingStatus(thingRow({}), { allowed: [] }, NO_GATES, NOW)
  assert.deepEqual(stone, {
    status: 'not_permitted_by_kind',
    permission_source: null,
    permitted_modes: [],
    conditions: [],
    soonest_known_end: null,
    uses_left: null,
    unused_deadline: null,
    label: null,
    grant: null,
    still_permitted: null,
    copy_origin: null,
    set_by: null,
    set_at: null,
    renewable_before_end: null,
    remains: 'remnant',
    ended_at: null,
    ended_cause: null,
    owner_at_end: null,
    program: { state: 'none', result: null, has_end_trait: false, would_run: null, blocked_by: null },
    checked_at: NOW.toISOString(),
  })
  const lamp = endingStatus(thingRow({ has_end_trait: true }), { allowed: ['uses', 'at'] }, { would_run: true, blocked_by: [] }, NOW)
  assert.equal(lamp.status, 'permitted_but_unset')
  assert.equal(lamp.permission_source, 'kind')
  assert.deepEqual(lamp.permitted_modes, ['at', 'uses'])
  assert.deepEqual(lamp.program, { state: 'none', result: null, has_end_trait: true, would_run: true, blocked_by: [] })

  const pebble = endingStatus(thingRow({ kind_id: null, current_revision: null }), null, NO_GATES, NOW)
  assert.equal(pebble.status, 'permitted_but_unset')
  assert.equal(pebble.permission_source, 'kindless_owner')
  assert.deepEqual(pebble.permitted_modes, ENDING_MODES)
  const given = endingStatus(thingRow({ kind_id: null, current_revision: null, owner_id: 3 }), null, NO_GATES, NOW)
  assert.equal(given.status, 'not_permitted_by_kind')
  assert.equal(given.permission_source, null)
  // A copy without an end can never gain one.
  const copy = endingStatus(thingRow({ parent_thing_id: 9 }), LAMP_POLICY, NO_GATES, NOW)
  assert.equal(copy.status, 'not_permitted_by_kind')
  assert.deepEqual(copy.permitted_modes, [])
  // A converted thing reads its permission from the kind it became.
  const converted = endingStatus(thingRow({ kind_id: 9, current_revision: 1, as_kind_id: 7, as_revision: 1 }), LAMP_POLICY, NO_GATES, NOW)
  assert.equal(converted.status, 'permitted_but_unset')
  assert.equal(converted.permission_source, 'kind')
})

test('endingStatus: active with every computed field', () => {
  const anchor = new Date(NOW.getTime() - 600_000)
  const row = thingRow({
    ending_rule: { any: [{ at: at(5 * DAY) }, { after_setting_seconds: DAY }, { uses: 5 }, { idle_seconds: 3_600 }] },
    ending_grant: LAMP_GRANT,
    ending_set_by: 2,
    set_by: { id: 2, handle: 'maker' },
    ending_set_at: SET_AT,
    ending_deadline: new Date(SET_AT.getTime() + DAY * 1000),
    ending_idle_seconds: 3_600,
    ending_idle_anchor: anchor,
    ending_uses_left: 3,
  })
  const status = endingStatus(row, { allowed: ['at', 'uses', 'idle_seconds'] }, NO_GATES, NOW)
  const idleEnd = new Date(anchor.getTime() + 3_600_000).toISOString()
  assert.equal(status.status, 'active')
  assert.equal(status.permission_source, 'kind')
  assert.deepEqual(status.permitted_modes, ['at', 'uses', 'idle_seconds'])
  assert.deepEqual(status.conditions, [
    { at: at(5 * DAY) },
    { after_setting_seconds: DAY, ends_at: new Date(SET_AT.getTime() + DAY * 1000).toISOString() },
    { uses: 5, uses_left: 3 },
    { idle_seconds: 3_600, unused_deadline: idleEnd },
  ])
  assert.equal(status.soonest_known_end, idleEnd)
  assert.equal(status.uses_left, 3)
  assert.equal(status.unused_deadline, idleEnd)
  assert.deepEqual(status.grant, LAMP_GRANT)
  // The revision the thing is on no longer permits time after setting.
  assert.deepEqual(status.still_permitted, { at: true, after_setting_seconds: false, uses: true, idle_seconds: true })
  assert.deepEqual(status.set_by, { id: 2, handle: 'maker' })
  assert.equal(status.set_at, SET_AT.toISOString())
  assert.equal(status.renewable_before_end, true)
  assert.deepEqual(shortEndingStatus(row, NOW), { state: 'set', at: idleEnd })

  // A kindless end reads kindless_owner; a copy reads its origin and is not renewable.
  const kindless = endingStatus(thingRow({ ...row, kind_id: null, current_revision: null, ending_grant: buildGrant({ source: 'kindless_owner' }) }), null, NO_GATES, NOW)
  assert.equal(kindless.permission_source, 'kindless_owner')
  assert.deepEqual(kindless.still_permitted, { at: true, after_setting_seconds: true, uses: true, idle_seconds: true })
  const until = at(1_800)
  const copy = endingStatus(thingRow({
    parent_thing_id: 50,
    ending_rule: { any: [{ after_setting_seconds: DAY }, { idle_seconds: 3_600, until }, { label_added: 'spent' }] },
    ending_grant: LAMP_GRANT,
    ending_set_by: 3,
    ending_set_at: NOW,
    ending_deadline: until,
    ending_label: 'spent',
    ending_copied_from: 50,
    ending_copied_at: NOW,
  }), LAMP_POLICY, NO_GATES, NOW)
  assert.equal(copy.status, 'active')
  assert.deepEqual(copy.permitted_modes, [])
  assert.deepEqual(copy.conditions, [
    { after_setting_seconds: DAY, ends_at: null },
    { idle_seconds: 3_600, until, unused_deadline: until },
    { label_added: 'spent' },
  ])
  assert.equal(copy.unused_deadline, until)
  assert.equal(copy.renewable_before_end, false)
  assert.deepEqual(copy.copy_origin, { source_thing_id: 50, copied_at: NOW.toISOString() })
  assert.equal(copy.label, 'spent')
})

test('endingStatus: due_waiting_settle and ended, and the short status of each', () => {
  const due = thingRow({
    ending_rule: { any: [{ at: at(-3_600) }] },
    ending_grant: LAMP_GRANT,
    ending_set_by: 2,
    ending_set_at: new Date(NOW.getTime() - 3 * 3_600_000),
    ending_deadline: at(-3_600),
    has_end_trait: true,
  })
  const dueStatus = endingStatus(due, LAMP_POLICY, { would_run: true, blocked_by: [] }, NOW)
  assert.equal(dueStatus.status, 'due_waiting_settle')
  assert.deepEqual(dueStatus.permitted_modes, [])
  assert.equal(dueStatus.renewable_before_end, false)
  assert.equal(dueStatus.soonest_known_end, at(-3_600))
  assert.equal(dueStatus.ended_at, null)
  assert.deepEqual(shortEndingStatus(due, NOW), { state: 'ended', at: at(-3_600) })
  // Due at exactly now.
  assert.equal(endingStatus({ ...due, ending_deadline: NOW, ending_rule: { any: [{ at: NOW.toISOString() }] } }, LAMP_POLICY, NO_GATES, NOW).status, 'due_waiting_settle')

  const ended = thingRow({
    ...due,
    ended_at: at(-3_600),
    ended_cause: 'at',
    owner_at_end: { id: 2, handle: 'maker' },
    end_program_state: 'ran',
    end_program_result: { wake_try_id: 4, effects_applied: 1 },
  })
  const endedStatus = endingStatus(ended, LAMP_POLICY, NO_GATES, NOW)
  assert.equal(endedStatus.status, 'ended')
  assert.equal(endedStatus.ended_at, at(-3_600))
  assert.equal(endedStatus.ended_cause, 'at')
  assert.deepEqual(endedStatus.owner_at_end, { id: 2, handle: 'maker' })
  assert.deepEqual(endedStatus.program, {
    state: 'ran', result: { wake_try_id: 4, effects_applied: 1 }, has_end_trait: true, would_run: null, blocked_by: null,
  })
  assert.equal(endedStatus.renewable_before_end, false)
  assert.deepEqual(shortEndingStatus(ended, NOW), { state: 'ended', at: at(-3_600) })

  // Uses spent reads due at once, before any recorder runs.
  const spent = thingRow({ ...due, ending_rule: { any: [{ uses: 1 }] }, ending_deadline: null, ending_uses_left: 0, ending_uses_spent_at: NOW })
  assert.equal(endingStatus(spent, LAMP_POLICY, NO_GATES, NOW).status, 'due_waiting_settle')
  assert.deepEqual(shortEndingStatus(spent, NOW), { state: 'ended', at: NOW.toISOString() })

  // No end set and never ended: the short status is left out.
  assert.equal(shortEndingStatus(thingRow({}), NOW), null)
  // A set rule with no known time (a label not yet added).
  assert.deepEqual(
    shortEndingStatus(thingRow({ ending_rule: { any: [{ label_added: 'spent' }] }, ending_set_at: SET_AT, ending_label: 'spent' }), NOW),
    { state: 'set', at: null },
  )
})

// The shape copyRuleFrom writes: Date.prototype.toISOString, milliseconds and Z.
const ISO_UNTIL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u

test('copyRuleFrom always writes until as toISOString, whatever shape the parent times came in', () => {
  const parents = [
    parentRow({ any: [{ after_setting_seconds: DAY }] }, { ending_set_at: '2026-11-06T11:00:00+00:00' }),
    parentRow({ any: [{ after_setting_seconds: DAY }] }, { ending_set_at: new Date('2026-11-06T11:00:00.123Z') }),
    parentRow({ any: [{ idle_seconds: 3_600 }] }, { ending_idle_seconds: 3_600, ending_idle_anchor: '2026-11-06T11:30:00Z' }),
    parentRow({ any: [{ idle_seconds: 3_600, until: at(600) }] }, { ending_copied_from: 49 }),
  ]
  for (const parent of parents) {
    const copy = copyRuleFrom(parent, COPY_AT, 3)!
    const conditions = (copy.ending_rule as unknown as { any: Record<string, unknown>[] }).any
    const untils = conditions.map(condition => condition.until)
    assert.equal(untils.length, 1)
    assert.equal(typeof untils[0], 'string')
    assert.match(untils[0] as string, ISO_UNTIL)
    assert.equal(new Date(untils[0] as string).toISOString(), untils[0])
  }
})

test('an until that is not the toISOString shape of a real time reads as null, as in snapshot v4', () => {
  for (const until of ['not a time', '2026-11-20', '2026-11-20T10:00:00Z', '2026-02-31T10:00:00.000Z', '2026-11-20T10:00:00.000+00:00', 7]) {
    const row = thingRow({
      id: 52,
      parent_thing_id: 50,
      ending_rule: { any: [{ after_setting_seconds: DAY, until }, { idle_seconds: 3_600, until }] },
      ending_grant: LAMP_GRANT,
      ending_set_by: 2,
      ending_set_at: SET_AT,
      ending_copied_from: 50,
      ending_copied_at: SET_AT,
    })
    const status = endingStatus(row, LAMP_POLICY, NO_GATES, NOW)
    assert.equal(status.conditions[0]!.ends_at, null, String(until))
    assert.equal(status.conditions[1]!.unused_deadline, null, String(until))
    assert.equal(status.unused_deadline, null, String(until))
    assert.equal(dueCause(row), null, String(until))
    const copy = copyRuleFrom(row, COPY_AT, 3)!
    assert.deepEqual(copy.ending_rule, { any: [{ after_setting_seconds: DAY }, { idle_seconds: 3_600 }] }, String(until))
  }
  const good = at(600)
  const row = thingRow({
    id: 52, parent_thing_id: 50, ending_rule: { any: [{ idle_seconds: 3_600, until: good }] },
    ending_grant: LAMP_GRANT, ending_set_by: 2, ending_set_at: SET_AT, ending_copied_from: 50, ending_copied_at: SET_AT,
  })
  assert.equal(endingStatus(row, LAMP_POLICY, NO_GATES, NOW).unused_deadline, good)
})

test('a maintainer-hidden kind shows the removal marker for its own label words, nothing else changes', () => {
  // The five-states counting lamp: a date, uses and the watched label 'spent', with the
  // kind's grant naming that label, and a remove moderation on the lamp kind.
  const counting = {
    ending_rule: { any: [{ at: at(10 * DAY) }, { uses: 5 }, { label_added: 'spent' }] },
    ending_grant: LAMP_GRANT,
    ending_set_by: 2,
    ending_set_at: SET_AT,
    ending_deadline: at(10 * DAY),
    ending_uses_left: 3,
    ending_label: 'spent',
    has_end_trait: true,
  } as const
  const shown = endingStatus(thingRow(counting), LAMP_POLICY, NO_GATES, NOW)
  const hidden = endingStatus(thingRow({ ...counting, kind_hidden: true }), LAMP_POLICY, NO_GATES, NOW)
  assert.equal(shown.label, 'spent')
  assert.equal(hidden.label, MODERATED_TEXT)
  assert.deepEqual((hidden.grant as EndingGrant).limits.labels, [MODERATED_TEXT])
  assert.deepEqual(hidden.grant, { ...LAMP_GRANT, limits: { ...LAMP_GRANT!.limits, labels: [MODERATED_TEXT] } })
  assert.deepEqual(hidden.conditions[2], { label_added: MODERATED_TEXT })
  assert.deepEqual(hidden.permitted_modes, shown.permitted_modes)
  assert.deepEqual(hidden.still_permitted, shown.still_permitted)
  assert.deepEqual(hidden.program, shown.program)
  assert.deepEqual({ ...hidden, label: null, grant: null, conditions: [] }, { ...shown, label: null, grant: null, conditions: [] })
  // Null stays null: no watched label, and a grant whose labels are any.
  const anyLabels = { ...LAMP_GRANT, limits: { ...LAMP_GRANT!.limits, labels: null } }
  const quiet = endingStatus(thingRow({
    ...counting, ending_rule: { any: [{ uses: 5 }] }, ending_label: null, ending_grant: anyLabels, kind_hidden: true,
  }), LAMP_POLICY, NO_GATES, NOW)
  assert.equal(quiet.label, null)
  assert.deepEqual(quiet.grant, anyLabels)
  assert.deepEqual(endingStatus(thingRow({ kind_hidden: true }), LAMP_POLICY, NO_GATES, NOW).grant, null)
})

// ---------------------------------------------------------------------------
// The words and the guard mapping
// ---------------------------------------------------------------------------

test('thingEndingGuardRefusal maps the ending guard to E16 and leaves other errors alone', () => {
  const guard = Object.assign(new Error('thing 7 has reached its end'), { code: '23514', constraint: 'thing_ending_guard' })
  assert.equal(thingEndingGuardRefusal(guard), THING_ENDING_CHANGED_REFUSAL)
  assert.equal(thingEndingGuardRefusal({ sourceError: guard }), THING_ENDING_CHANGED_REFUSAL)
  assert.equal(THING_ENDING_GUARD_STATUS, 409)
  assert.equal(thingEndingGuardRefusal(Object.assign(new Error('mark'), { code: '23514', constraint: 'validate_thing_later_holder_mark' })), null)
  assert.equal(thingEndingGuardRefusal(Object.assign(new Error('inventor'), { code: '23514', constraint: 'kinds_invented_by_fixed' })), null)
  assert.equal(thingEndingGuardRefusal(new Error('boom')), null)
  assert.equal(thingEndingGuardRefusal(null), null)
  assert.equal(thingEndingGuardRefusal('thing_ending_guard'), null)
})

test('the ending words carry no dashes or curly quotes and E17 names both traits', () => {
  assert.equal(
    endTraitConflictRefusal('glow-out', 'fade'),
    'A kind may list only one trait with an end key; glow-out and fade both carry one, so keep one of them.',
  )
  for (const words of [ENDING_POLICY_REFUSAL, ENDING_NOT_ALLOWED_REFUSAL, ENDING_SHAPE_REFUSAL, ENDING_COPY_FIXED_REFUSAL, KINDLESS_ENDING_REFUSAL]) {
    assert.doesNotMatch(words, /[\u2013\u2014\u2018\u2019\u201C\u201D]/u)
  }
})

test('THING_FIRST_LABEL_AT_SQL is the label subquery thing_end_due_at_row runs', () => {
  const flat = (text: string): string => text.replace(/\s+/gu, ' ').trim()
  const migration = readFileSync(new URL('../db/migrations/20261106_thing_endings.sql', import.meta.url), 'utf8')
  const body = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION thing_end_due_at_row'))
  const fn = body.slice(0, body.indexOf('$thing_end_due_at_row$;'))
  assert.ok(flat(fn).includes(flat(THING_FIRST_LABEL_AT_SQL)))
  assert.ok(flat(THING_FIRST_LABEL_AT_SQL).includes('AND label.created_at > thing.ending_set_at )'))
})
