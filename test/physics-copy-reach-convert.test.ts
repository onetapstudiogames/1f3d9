import test from 'node:test'
import assert from 'node:assert/strict'
import {
  COPY_COPIES_DEFAULT,
  COPY_COPIES_MAX,
  COPY_DESTINATIONS,
  COPY_GENERATIONS_DEFAULT,
  COPY_INHERITABLE,
  EFFECT_BRICKS,
  MAX_APPLICATIONS_PER_PROGRAM,
  REACH_HARD_STEPS,
  REACH_MAX_CEILING,
  REACH_MAX_DEFAULT,
  REACH_NEVER_INSIDE,
  REACH_OVER,
  REACH_SOFT_STEPS,
  loadTraitRecipe,
  parseTraitRecipe,
  programWeight,
  recipeConvertsIntoNamedKind,
  recipeUsesKindOnlyAbility,
  traitRecipeFault,
} from '../src/physics.ts'

const soak = { effect: 'label', target: 'target', label: 'wet' } as const

test('the brick list grows to twelve with copy, reach, and convert', () => {
  assert.deepEqual(EFFECT_BRICKS, [
    'destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label',
    'chance', 'write', 'copy', 'reach', 'convert',
  ])
  assert.deepEqual(COPY_DESTINATIONS, ['here', 'adjacent'])
  assert.deepEqual(COPY_INHERITABLE, ['body', 'state'])
  assert.deepEqual(REACH_OVER, ['things', 'residents'])
  assert.deepEqual(REACH_SOFT_STEPS, ['label', 'check_label', 'chance', 'write'])
  assert.deepEqual(REACH_HARD_STEPS, ['destroy', 'move', 'transfer', 'convert', 'wait'])
  assert.deepEqual(REACH_NEVER_INSIDE, ['block', 'copy', 'reach'])
  assert.deepEqual(
    [COPY_GENERATIONS_DEFAULT, COPY_COPIES_DEFAULT, COPY_COPIES_MAX, REACH_MAX_DEFAULT, REACH_MAX_CEILING],
    [3, 1, 10_000, 16, 64],
  )
  for (const list of [COPY_DESTINATIONS, COPY_INHERITABLE, REACH_OVER, REACH_SOFT_STEPS, REACH_HARD_STEPS, REACH_NEVER_INSIDE]) {
    assert.equal(Object.isFrozen(list), true)
  }
})

test('copy, reach, and convert canonicalize with every default written out', () => {
  const recipe = parseTraitRecipe({
    use: [
      { effect: 'Copy' },
      { effect: 'copy', generations: 8, copies: 'Unlimited', to: 'ADJACENT', inherit: ['state', 'body'] },
      { effect: 'copy', copies: 10_000, inherit: [] },
      { effect: 'reach', then: [soak] },
      { effect: 'reach', over: 'residents', max: 64, then: [{ effect: 'label', target: 'target', label: 'seen' }] },
      { effect: 'reach', kind: 'Oak', max: 1, then: [{ effect: 'convert', target: 'target' }] },
      { effect: 'convert', target: 'TARGET' },
    ],
  })
  assert.deepEqual(recipe, {
    use: [
      { effect: 'copy', generations: 3, copies: 1, to: 'here', inherit: ['body'] },
      { effect: 'copy', generations: 8, copies: 'unlimited', to: 'adjacent', inherit: ['body', 'state'] },
      { effect: 'copy', generations: 3, copies: 10_000, to: 'here', inherit: [] },
      { effect: 'reach', over: 'things', max: 16, then: [soak] },
      { effect: 'reach', over: 'residents', max: 64, then: [{ effect: 'label', target: 'target', label: 'seen' }] },
      { effect: 'reach', over: 'things', max: 1, kind: 'oak', then: [{ effect: 'convert', target: 'target' }] },
      { effect: 'convert', target: 'target' },
    ],
  })
  assert.deepEqual(
    parseTraitRecipe({ talk: [{ effect: 'convert', target: 'target', into_kind: 'Ash' }] })?.talk,
    [{ effect: 'convert', target: 'target', into_kind: 'ash' }],
  )
  assert.equal(Object.isFrozen(recipe?.use?.[1]), true)
})

test('copy, reach, and convert dials outside their ranges are refused at coining', () => {
  const refused = [
    { use: [{ effect: 'copy', generations: 0 }] },
    { use: [{ effect: 'copy', generations: 9 }] },
    { use: [{ effect: 'copy', generations: 2.5 }] },
    { use: [{ effect: 'copy', copies: 0 }] },
    { use: [{ effect: 'copy', copies: 10_001 }] },
    { use: [{ effect: 'copy', copies: 'many' }] },
    { use: [{ effect: 'copy', to: 'far' }] },
    { use: [{ effect: 'copy', inherit: ['body', 'body'] }] },
    { use: [{ effect: 'copy', inherit: ['soul'] }] },
    { use: [{ effect: 'copy', inherit: 'body' }] },
    { use: [{ effect: 'copy', target: 'target' }] },
    { use: [{ effect: 'reach', max: 0, then: [soak] }] },
    { use: [{ effect: 'reach', max: 65, then: [soak] }] },
    { use: [{ effect: 'reach', over: 'places', then: [soak] }] },
    { use: [{ effect: 'reach' }] },
    { use: [{ effect: 'reach', kind: 'Not A Kind!', then: [soak] }] },
    { use: [{ effect: 'reach', over: 'residents', kind: 'oak', then: [soak] }] },
    { use: [{ effect: 'reach', target: 'target', then: [soak] }] },
    { use: [{ effect: 'convert', target: 'source' }] },
    { use: [{ effect: 'convert', target: 'actor' }] },
    { use: [{ effect: 'convert', target: 'place' }] },
    { use: [{ effect: 'convert' }] },
    { use: [{ effect: 'convert', target: 'target', into_kind: 'Two Words' }] },
    { use: [{ effect: 'convert', target: 'target', kind: 'ash' }] },
  ]
  for (const recipe of refused) {
    assert.equal(parseTraitRecipe(recipe), null, JSON.stringify(recipe))
    assert.equal(traitRecipeFault(recipe), 'grammar', JSON.stringify(recipe))
  }
})

test('a reach over residents accepts only sticker, check, roll, and write', () => {
  const soft = [
    { effect: 'label', target: 'target', label: 'seen' },
    { effect: 'check_label', target: 'target', label: 'friend', then: [{ effect: 'write', key: 'friends', op: 'add' }] },
    { effect: 'chance', percent: 10, then: [{ effect: 'label', target: 'target', label: 'lucky' }] },
    { effect: 'write', key: 'counted', op: 'add' },
  ]
  assert.ok(parseTraitRecipe({ use: [{ effect: 'reach', over: 'residents', then: soft }] }))
  for (const hard of [
    { effect: 'destroy', target: 'target' },
    { effect: 'move', target: 'target', to: 'home' },
    { effect: 'transfer', target: 'source', to: 'actor' },
    { effect: 'convert', target: 'target' },
    { effect: 'wait', seconds: 5, then: [] },
    { effect: 'chance', percent: 50, then: [{ effect: 'move', target: 'target', to: 'home' }] },
  ]) {
    const recipe = { use: [{ effect: 'reach', over: 'residents', then: [hard] }] }
    assert.equal(parseTraitRecipe(recipe), null, JSON.stringify(hard))
    // The same step is fine over things, where only consenting members are touched.
    assert.ok(parseTraitRecipe({ use: [{ effect: 'reach', then: [hard] }] }), JSON.stringify(hard))
  }
})

test('block, copy, a nested reach, and moving the actor are refused inside a reach', () => {
  for (const inside of [
    { effect: 'block', target: 'target', action: 'talk', seconds: 60 },
    { effect: 'block', target: 'actor', action: 'talk', seconds: 60 },
    { effect: 'copy' },
    { effect: 'reach', then: [soak] },
    { effect: 'move', target: 'actor', to: 'home' },
    { effect: 'chance', percent: 50, then: [], else: [{ effect: 'copy' }] },
    { effect: 'wait', seconds: 5, then: [{ effect: 'block', target: 'actor', action: 'move', seconds: 5 }] },
  ]) {
    const recipe = { use: [{ effect: 'reach', then: [inside] }] }
    assert.equal(parseTraitRecipe(recipe), null, JSON.stringify(inside))
  }
  assert.ok(parseTraitRecipe({ use: [{ effect: 'reach', then: [{ effect: 'move', target: 'target', to: 'home' }] }] }))
})

test('a reach weighs its max times its steps, and a program over 512 applications is refused', () => {
  const eight = Array.from({ length: 8 }, () => soak)
  const nine = Array.from({ length: 9 }, () => soak)
  assert.equal(programWeight([{ effect: 'reach', over: 'things', max: 64, then: eight }]), 512)
  assert.equal(programWeight([{ effect: 'reach', over: 'things', max: 3, then: [] }]), 0)
  assert.equal(programWeight([
    { effect: 'copy', generations: 3, copies: 1, to: 'here', inherit: ['body'] },
    { effect: 'convert', target: 'target' },
  ]), 2)
  assert.ok(parseTraitRecipe({ use: [{ effect: 'reach', max: 64, then: eight }] }))
  assert.equal(MAX_APPLICATIONS_PER_PROGRAM, 512)
  assert.equal(parseTraitRecipe({ use: [{ effect: 'reach', max: 64, then: nine }] }), null)
  assert.equal(parseTraitRecipe({ use: [soak, { effect: 'reach', max: 64, then: eight }] }), null)
  assert.equal(parseTraitRecipe({ wake: { then: [{ effect: 'reach', max: 64, then: nine }] } }), null)
})

test('a wake program uses target only inside a reach and still never hands a thing over', () => {
  assert.ok(parseTraitRecipe({
    wake: {
      on: ['clock'],
      then: [
        { effect: 'reach', then: [soak] },
        { effect: 'reach', over: 'residents', then: [{ effect: 'check_label', target: 'target', label: 'x', then: [] }] },
        { effect: 'reach', kind: 'oak', max: 8, then: [{ effect: 'convert', target: 'target' }] },
        { effect: 'chance', percent: 30, then: [{ effect: 'copy', generations: 3, copies: 2 }] },
      ],
    },
  }))
  for (const then of [
    [soak],
    [{ effect: 'convert', target: 'target' }],
    [{ effect: 'reach', then: [{ effect: 'move', target: 'target', to: 'destination' }] }],
  ]) {
    assert.equal(traitRecipeFault({ wake: { then } }), 'wake_scope', JSON.stringify(then))
  }
  assert.equal(
    traitRecipeFault({ wake: { then: [{ effect: 'reach', then: [{ effect: 'transfer', target: 'target', to: 'actor' }] }] } }),
    'wake_hand_over',
  )
})

test('copy and a convert without into_kind are kind-only; a convert naming into_kind is law-only', () => {
  const kindOnly = [
    { use: [{ effect: 'copy' }] },
    { give: [{ effect: 'chance', percent: 5, then: [{ effect: 'copy' }] }] },
    { use: [{ effect: 'convert', target: 'target' }] },
    { talk: [{ effect: 'reach', then: [{ effect: 'convert', target: 'target' }] }] },
  ]
  for (const recipe of kindOnly) {
    const parsed = parseTraitRecipe(recipe)
    assert.ok(parsed, JSON.stringify(recipe))
    assert.equal(recipeUsesKindOnlyAbility(parsed), true, JSON.stringify(recipe))
    assert.equal(recipeConvertsIntoNamedKind(parsed), false, JSON.stringify(recipe))
  }
  const lawOnly = parseTraitRecipe({
    talk: [{ effect: 'reach', kind: 'oak', then: [{ effect: 'convert', target: 'target', into_kind: 'ash' }] }],
  })!
  assert.equal(recipeUsesKindOnlyAbility(lawOnly), false)
  assert.equal(recipeConvertsIntoNamedKind(lawOnly), true)
  const shared = parseTraitRecipe({ use: [{ effect: 'reach', then: [soak] }] })!
  assert.equal(recipeUsesKindOnlyAbility(shared), false, 'reach works in both')
  assert.equal(recipeConvertsIntoNamedKind(shared), false)
})

test('malformed stored copy, reach, and convert recipes load inert', () => {
  assert.deepEqual(loadTraitRecipe({ use: [{ effect: 'copy', copies: -1 }] }), {})
  assert.deepEqual(loadTraitRecipe({ use: [soak, { effect: 'reach', max: 99, then: [soak] }] }), {})
  assert.deepEqual(loadTraitRecipe({ use: [{ effect: 'reach', then: [{ effect: 'reach', then: [] }] }] }), {})
  assert.deepEqual(loadTraitRecipe({ use: [{ effect: 'convert', target: 'source' }] }), {})
})
