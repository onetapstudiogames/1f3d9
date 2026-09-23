import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHANCE_PERCENT_MAX,
  CHANCE_PERCENT_MIN,
  EFFECT_BRICKS,
  MAX_APPLICATIONS_PER_PROGRAM,
  STATE_TEXT_MAX_CHARACTERS,
  WAKE_DEFAULT_EVERY_SECONDS,
  WAKE_EVENTS,
  WAKE_MAX_EVERY_SECONDS,
  WAKE_MIN_EVERY_SECONDS,
  WRITE_FROM,
  WRITE_OPS,
  loadTraitRecipe,
  parseTraitRecipe,
  programWeight,
  recipeUsesKindOnlyAbility,
  traitRecipeFault,
  wakeProgramOf,
} from '../src/physics.ts'

const label = { effect: 'label', target: 'source', label: 'rang' } as const

test('the brick list grows to nine and the wake key has three events', () => {
  assert.deepEqual(EFFECT_BRICKS, [
    'destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label', 'chance', 'write',
  ])
  assert.deepEqual(WAKE_EVENTS, ['arrive', 'talk', 'clock'])
  assert.deepEqual(WRITE_OPS, ['set', 'add', 'append'])
  assert.deepEqual(WRITE_FROM, ['actor', 'roll', 'time'])
  assert.equal(Object.isFrozen(WAKE_EVENTS), true)
  assert.equal(Object.isFrozen(WRITE_OPS), true)
  assert.equal(Object.isFrozen(WRITE_FROM), true)
  assert.deepEqual(
    [CHANCE_PERCENT_MIN, CHANCE_PERCENT_MAX, WAKE_MIN_EVERY_SECONDS, WAKE_DEFAULT_EVERY_SECONDS, WAKE_MAX_EVERY_SECONDS],
    [1, 99, 10, 60, 86_400],
  )
  assert.equal(MAX_APPLICATIONS_PER_PROGRAM, 512)
  assert.equal(STATE_TEXT_MAX_CHARACTERS, 200)
})

test('chance, write, and the wake key canonicalize with their stated defaults', () => {
  const recipe = parseTraitRecipe({
    use: [
      { effect: 'Chance', percent: 50, then: [label] },
      { effect: 'write', key: 'Visits', op: 'add' },
      { effect: 'write', key: 'last', value: { from: 'roll' } },
      { effect: 'write', key: 'guests', op: 'append', value: '  a guest  ' },
    ],
    wake: { then: [{ effect: 'write', key: 'seen', value: true }] },
  })
  assert.deepEqual(recipe, {
    use: [
      { effect: 'chance', percent: 50, then: [label] },
      { effect: 'write', key: 'visits', op: 'add', value: 1 },
      { effect: 'write', key: 'last', op: 'set', value: { from: 'roll' } },
      { effect: 'write', key: 'guests', op: 'append', value: 'a guest' },
    ],
    wake: {
      on: ['arrive'],
      every_seconds: 60,
      then: [{ effect: 'write', key: 'seen', op: 'set', value: true }],
    },
  })
  assert.equal(Object.isFrozen(recipe), true)
  assert.equal(Object.isFrozen(recipe?.wake), true)
  assert.deepEqual(
    parseTraitRecipe({ wake: { on: ['clock', 'arrive', 'talk'], every_seconds: 10, then: [] } })?.wake?.on,
    ['arrive', 'talk', 'clock'],
  )
  assert.deepEqual(
    parseTraitRecipe({ use: [{ effect: 'chance', percent: 1, then: [], else: [label] }] })?.use,
    [{ effect: 'chance', percent: 1, then: [], else: [label] }],
  )
})

test('dials outside their ranges are refused at coining', () => {
  const refused = [
    { use: [{ effect: 'chance', percent: 0, then: [] }] },
    { use: [{ effect: 'chance', percent: 100, then: [] }] },
    { use: [{ effect: 'chance', percent: 50.5, then: [] }] },
    { use: [{ effect: 'chance', percent: 50 }] },
    { wake: { every_seconds: 9, then: [] } },
    { wake: { every_seconds: 86_401, then: [] } },
    { wake: { on: [], then: [] } },
    { wake: { on: ['arrive', 'arrive'], then: [] } },
    { wake: { on: ['leave'], then: [] } },
    { wake: { then: [], sometimes: true } },
    { wake: [label] },
    { use: [{ effect: 'write', key: 'x', value: 'a'.repeat(201) }] },
    { use: [{ effect: 'write', key: 'x', value: 'two\nlines' }] },
    { use: [{ effect: 'write', key: 'x', value: `1f3d9_sk_${'7'.repeat(48)}` }] },
    { use: [{ effect: 'write', key: 'x', value: 1_000_000_001 }] },
    { use: [{ effect: 'write', key: 'x', op: 'add', value: 1_000_001 }] },
    { use: [{ effect: 'write', key: 'x', op: 'add', value: 'one' }] },
    { use: [{ effect: 'write', key: 'x', op: 'append', value: 7 }] },
    { use: [{ effect: 'write', key: 'x', op: 'append' }] },
    { use: [{ effect: 'write', key: 'x' }] },
    { use: [{ effect: 'write', key: 'Not A Key', value: 1 }] },
    { use: [{ effect: 'write', key: 'x', op: 'multiply', value: 2 }] },
    { use: [{ effect: 'write', key: 'x', value: { from: 'weather' } }] },
    { use: [{ effect: 'write', key: 'x', value: { from: 'actor', also: 1 } }] },
    { use: [{ effect: 'write', key: 'x', target: 'target', value: 1 }] },
  ]
  for (const recipe of refused) {
    assert.equal(parseTraitRecipe(recipe), null, JSON.stringify(recipe))
    assert.equal(traitRecipeFault(recipe), 'grammar', JSON.stringify(recipe))
  }
  assert.ok(parseTraitRecipe({ use: [{ effect: 'write', key: 'x', value: 'a'.repeat(200) }] }))
  assert.ok(parseTraitRecipe({ use: [{ effect: 'write', key: 'x', value: -1_000_000_000 }] }))
})

test('a wake program may never hand a thing over (R-W2), even in a nested branch', () => {
  const handOver = { effect: 'transfer', target: 'source', to: 'actor' }
  for (const then of [
    [handOver],
    [{ effect: 'wait', seconds: 5, then: [handOver] }],
    [{ effect: 'chance', percent: 50, then: [], else: [handOver] }],
    [{ effect: 'check_label', target: 'actor', label: 'friend', then: [handOver] }],
    [{ effect: 'transfer', target: 'source', to: 'recipient' }],
  ]) {
    const recipe = { wake: { then } }
    assert.equal(parseTraitRecipe(recipe), null)
    assert.equal(traitRecipeFault(recipe), 'wake_hand_over')
  }
  // The same step is fine outside the wake key.
  assert.ok(parseTraitRecipe({ use: [handOver] }))
})

test('a wake program has no target or destination of its own and moves only to home (R-W3)', () => {
  for (const then of [
    [{ effect: 'label', target: 'target', label: 'x' }],
    [{ effect: 'destroy', target: 'target' }],
    [{ effect: 'move', target: 'source', to: 'destination' }],
    [{ effect: 'move', target: 'actor', to: 'destination' }],
    [{ effect: 'block', target: 'target', action: 'talk', seconds: 60 }],
    [{ effect: 'wait', seconds: 5, then: [{ effect: 'check_label', target: 'target', label: 'x', then: [] }] }],
    [{ effect: 'chance', percent: 10, then: [{ effect: 'move', target: 'actor', to: 'destination' }] }],
  ]) {
    const recipe = { wake: { then } }
    assert.equal(parseTraitRecipe(recipe), null, JSON.stringify(then))
    assert.equal(traitRecipeFault(recipe), 'wake_scope', JSON.stringify(then))
  }
})

test('a wake program may block or send home the resident who arrived; the room decides when it runs', () => {
  const recipe = parseTraitRecipe({
    wake: {
      on: ['arrive', 'talk'],
      then: [
        { effect: 'block', target: 'actor', action: 'talk', seconds: 60 },
        { effect: 'move', target: 'actor', to: 'home' },
        { effect: 'move', target: 'source', to: 'home' },
        { effect: 'label', target: 'actor', label: 'greeted' },
      ],
    },
  })
  assert.ok(recipe?.wake)
  assert.equal(traitRecipeFault({ wake: { then: [{ effect: 'block', target: 'actor', action: 'move', seconds: 5 }] } }), null)
})

test('program weight counts chance and wait as one plus a branch and check_label as its larger branch', () => {
  assert.equal(programWeight([]), 0)
  assert.equal(programWeight([label, label]), 2)
  assert.equal(programWeight([{ effect: 'chance', percent: 5, then: [label, label], else: [label] }]), 3)
  assert.equal(programWeight([{ effect: 'wait', seconds: 1, then: [label] }]), 2)
  assert.equal(
    programWeight([{ effect: 'check_label', target: 'actor', label: 'x', then: [label], else: [label, label, label] }]),
    3,
  )
})

test('write and the wake key are kind-only abilities; chance is not', () => {
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe({ use: [{ effect: 'write', key: 'x', value: 1 }] })!), true)
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe({
    talk: [{ effect: 'wait', seconds: 1, then: [{ effect: 'write', key: 'x', value: 1 }] }],
  })!), true)
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe({ wake: { then: [label] } })!), true)
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe({
    talk: [{ effect: 'chance', percent: 50, then: [{ effect: 'label', target: 'actor', label: 'lucky' }] }],
  })!), false)
})

test('malformed stored ability recipes load inert, and the wake program reads back', () => {
  assert.deepEqual(loadTraitRecipe({ use: [label], wake: { every_seconds: 3, then: [] } }), {})
  assert.deepEqual(loadTraitRecipe({ use: [{ effect: 'chance', percent: 101, then: [] }] }), {})
  assert.equal(wakeProgramOf({ use: [label] }), null)
  assert.equal(wakeProgramOf({ wake: { then: [{ effect: 'transfer', target: 'source', to: 'actor' }] } }), null)
  assert.deepEqual(wakeProgramOf({ wake: { on: ['clock'], every_seconds: 600, then: [label] } }), {
    on: ['clock'], every_seconds: 600, then: [label],
  })
})
