import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BASIC_ACTIONS,
  BLOCKABLE_ACTIONS,
  EFFECT_BRICKS,
  EMPTY_TRAIT_RECIPE,
  MAX_BLOCK_SECONDS,
  MAX_EFFECT_COUNT,
  MAX_EFFECT_DEPTH,
  MAX_EFFECT_GENERATIONS,
  MAX_CRAFT_INGREDIENTS,
  MAX_KIND_INGREDIENTS,
  MAX_KIND_QUANTITY,
  MAX_RECIPE_BYTES,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  MOVE_DESTINATIONS,
  SYMBOLIC_TARGETS,
  TRANSFER_RECIPIENTS,
  effectsForAction,
  isBasicAction,
  isBlockableAction,
  isEffectBrick,
  loadTraitRecipe,
  parseKindRecipe,
  parseTraitRecipe,
} from '../src/physics.ts'

test('the frozen action, block, brick, and target vocabularies match bedrock physics', () => {
  assert.deepEqual(BASIC_ACTIONS, [
    'talk', 'move', 'use', 'give', 'consume', 'make', 'go_home',
  ])
  assert.deepEqual(BLOCKABLE_ACTIONS, ['talk', 'move', 'use', 'give', 'consume', 'make'])
  assert.deepEqual(EFFECT_BRICKS, [
    'destroy', 'move', 'transfer', 'label', 'block', 'wait', 'check_label',
  ])
  assert.deepEqual(SYMBOLIC_TARGETS, ['actor', 'source', 'target', 'place'])
  assert.deepEqual(MOVE_DESTINATIONS, ['destination', 'home'])
  assert.deepEqual(TRANSFER_RECIPIENTS, ['recipient', 'actor'])
  assert.equal(Object.isFrozen(BASIC_ACTIONS), true)
  assert.equal(Object.isFrozen(BLOCKABLE_ACTIONS), true)
  assert.equal(Object.isFrozen(EFFECT_BRICKS), true)
  assert.equal(Object.isFrozen(SYMBOLIC_TARGETS), true)
  assert.equal(Object.isFrozen(MOVE_DESTINATIONS), true)
  assert.equal(Object.isFrozen(TRANSFER_RECIPIENTS), true)
  assert.equal(isBasicAction('go_home'), true)
  assert.equal(isBlockableAction('go_home'), false)
  assert.equal(isEffectBrick('check_label'), true)
  assert.equal(isEffectBrick('require_label'), false)
  assert.equal(isBasicAction('climb'), false)
})

test('an action map is parsed into a normalized, deeply frozen trait recipe', () => {
  const parsed = parseTraitRecipe({
    consume: [
      { effect: 'destroy', target: 'source' },
    ],
    use: [
      { effect: 'label', target: 'actor', label: ' Authorized ' },
      { effect: 'move', target: 'actor', to: 'destination' },
      { effect: 'transfer', target: 'target', to: 'recipient' },
      { effect: 'block', target: 'target', action: 'talk', seconds: MAX_BLOCK_SECONDS },
      {
        effect: 'check_label',
        target: 'actor',
        label: 'authorized',
        then: [{ effect: 'destroy', target: 'target' }],
        else: [{ effect: 'label', target: 'place', label: 'peaceful' }],
      },
      {
        effect: 'wait',
        seconds: MIN_TIMER_SECONDS,
        then: [{ effect: 'label', target: 'place', label: 'echo' }],
        repeat: MAX_EFFECT_GENERATIONS,
      },
    ],
  })

  assert.ok(parsed)
  assert.deepEqual(Object.keys(parsed), ['use', 'consume'])
  assert.equal(parsed.use?.[0]?.effect, 'label')
  assert.equal(parsed.use?.[0]?.effect === 'label' ? parsed.use[0].label : '', 'authorized')
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed.use), true)
  assert.equal(Object.isFrozen(parsed.use?.[4]), true)
  assert.equal(
    parsed.use?.[4]?.effect === 'check_label' && Object.isFrozen(parsed.use[4].then),
    true,
  )
})

test('a legacy effect array canonicalizes to the use action', () => {
  const parsed = parseTraitRecipe([
    { effect: 'label', target: 'source', label: 'lit' },
  ])

  assert.deepEqual(parsed, {
    use: [{ effect: 'label', target: 'source', label: 'lit' }],
  })
})

test('alternate symbolic branches stay part of the canonical contract', () => {
  const parsed = parseTraitRecipe({
    move: [
      { effect: 'move', target: 'actor', to: 'home' },
      { effect: 'transfer', target: 'source', to: 'actor' },
      {
        effect: 'check_label', target: 'place', label: 'open',
        then: [{ effect: 'label', target: 'target', label: 'welcome' }],
      },
      {
        effect: 'wait', seconds: 60,
        then: [{ effect: 'label', target: 'place', label: 'later' }],
      },
    ],
  })

  assert.ok(parsed)
  assert.deepEqual(parsed.move?.map(effect => effect.effect), [
    'move', 'transfer', 'check_label', 'wait',
  ])
})

test('strict trait parsing rejects unknown actions, bricks, fields, IDs, and aliases', () => {
  const invalid = [
    { climb: [] },
    { use: [{ effect: 'teleport', target: 'actor' }] },
    { use: [{ effect: 'label', target: 'actor', label: 'lit', extra: true }] },
    { use: [{ effect: 'move', target: 'actor', place_id: 3 }] },
    { use: [{ effect: 'transfer', target: 'target', to: 7 }] },
    { use: [{ effect: 'destroy', target: 'actor' }] },
    { use: [{ effect: 'require_label', target: 'actor', label: 'ready' }] },
    { use: [null] },
  ]

  for (const recipe of invalid) assert.equal(parseTraitRecipe(recipe), null)

  const sparseLegacyRecipe = new Array(1)
  assert.equal(parseTraitRecipe(sparseLegacyRecipe), null)

  const decoratedLegacyRecipe: unknown[] & { extra?: boolean } = []
  decoratedLegacyRecipe.extra = true
  assert.equal(parseTraitRecipe(decoratedLegacyRecipe), null)
})

test('blocks always expire within 24 hours and can never name go_home', () => {
  const boundary = parseTraitRecipe({
    talk: [{ effect: 'block', target: 'actor', action: 'talk', seconds: 24 * 60 * 60 }],
  })
  assert.ok(boundary)
  assert.equal(MAX_BLOCK_SECONDS, 24 * 60 * 60)

  for (const seconds of [0, -1, MAX_BLOCK_SECONDS + 1, 1.5, Number.NaN]) {
    assert.equal(parseTraitRecipe({
      talk: [{ effect: 'block', target: 'actor', action: 'talk', seconds }],
    }), null)
  }
  assert.equal(parseTraitRecipe({
    talk: [{ effect: 'block', target: 'actor', action: 'go_home', seconds: 1 }],
  }), null)
})

test('wait intervals and repeat counts are bounded and generations are runtime-only', () => {
  for (const seconds of [MIN_TIMER_SECONDS, MAX_TIMER_SECONDS]) {
    assert.ok(parseTraitRecipe({
      use: [{ effect: 'wait', seconds, then: [], repeat: MAX_EFFECT_GENERATIONS }],
    }))
  }

  for (const seconds of [MIN_TIMER_SECONDS - 1, MAX_TIMER_SECONDS + 1, 1.25]) {
    assert.equal(parseTraitRecipe({
      use: [{ effect: 'wait', seconds, then: [] }],
    }), null)
  }
  assert.equal(parseTraitRecipe({
    use: [{
      effect: 'wait', seconds: 60, then: [], repeat: MAX_EFFECT_GENERATIONS + 1,
    }],
  }), null)
  assert.equal(parseTraitRecipe({
    use: [{ effect: 'wait', seconds: 60, then: [], generations: 2 }],
  }), null)
})

test('nested conditionals and timers have hard depth and total-effect ceilings', () => {
  let withinDepth: unknown = { effect: 'label', target: 'actor', label: 'deep' }
  for (let depth = 1; depth < MAX_EFFECT_DEPTH; depth += 1) {
    withinDepth = { effect: 'check_label', target: 'actor', label: 'ready', then: [withinDepth] }
  }
  assert.ok(parseTraitRecipe({ use: [withinDepth] }))

  const tooDeep = {
    effect: 'check_label', target: 'actor', label: 'ready', then: [withinDepth],
  }
  assert.equal(parseTraitRecipe({ use: [tooDeep] }), null)

  const maximum = Array.from({ length: MAX_EFFECT_COUNT }, () => ({
    effect: 'label', target: 'actor', label: 'counted',
  }))
  assert.ok(parseTraitRecipe({ use: maximum }))
  assert.equal(parseTraitRecipe({
    use: [...maximum, { effect: 'label', target: 'actor', label: 'overflow' }],
  }), null)
})

test('oversized, cyclic, or invalid stored recipes become wholly inert at execution', () => {
  const oversized = {
    use: [{ effect: 'label', target: 'actor', label: 'x', padding: 'x'.repeat(MAX_RECIPE_BYTES) }],
  }
  const cyclic: { use: unknown[] } = { use: [] }
  cyclic.use.push(cyclic)

  assert.equal(parseTraitRecipe(oversized), null)
  assert.equal(parseTraitRecipe(cyclic), null)
  assert.equal(loadTraitRecipe({
    use: [
      { effect: 'label', target: 'actor', label: 'must-not-partially-run' },
      { effect: 'destroy', target: 'actor' },
    ],
  }), EMPTY_TRAIT_RECIPE)
  assert.deepEqual(effectsForAction(cyclic, 'use'), [])
  assert.equal(Object.isFrozen(EMPTY_TRAIT_RECIPE), true)
})

test('strict parsing rejects accessors and toJSON hooks without invoking application code', () => {
  let calls = 0
  const hookedEffect = {
    effect: 'label', target: 'actor', label: 'hooked',
    toJSON() {
      calls += 1
      return { effect: 'label', target: 'actor', label: 'hooked' }
    },
  }
  const accessorEffect: Record<string, unknown> = { effect: 'label', target: 'actor' }
  Object.defineProperty(accessorEffect, 'label', {
    enumerable: true,
    get() {
      calls += 1
      return 'accessed'
    },
  })

  assert.equal(parseTraitRecipe({ use: [hookedEffect] }), null)
  assert.equal(parseTraitRecipe({ use: [accessorEffect] }), null)
  assert.equal(calls, 0)
})

test('kind recipes accept future kind names and canonicalize quantities', () => {
  const parsed = parseKindRecipe([
    { kind: ' Uninvented_Glass ', quantity: 2 },
    { kind: 'future-rope', quantity: MAX_KIND_QUANTITY - 2 },
  ])

  assert.deepEqual(parsed, [
    { kind: 'uninvented_glass', quantity: 2 },
    { kind: 'future-rope', quantity: MAX_KIND_QUANTITY - 2 },
  ])
  assert.equal(Object.isFrozen(parsed), true)
  assert.equal(Object.isFrozen(parsed?.[0]), true)
  assert.equal(MAX_CRAFT_INGREDIENTS, 1_024)
  assert.equal(MAX_KIND_QUANTITY, MAX_CRAFT_INGREDIENTS)
})

test('kind recipes reject duplicates, invalid shapes, unsafe counts, and excess ingredients', () => {
  const invalid = [
    null,
    {},
    [{ kind: 'glass' }],
    [{ kind: 'glass', quantity: 0 }],
    [{ kind: 'glass', quantity: MAX_KIND_QUANTITY + 1 }],
    [{ kind: 'bad kind', quantity: 1 }],
    [{ kind: 'glass', quantity: 1, id: 4 }],
    [{ kind: 'Glass', quantity: 1 }, { kind: 'glass', quantity: 1 }],
    [
      { kind: 'glass', quantity: MAX_CRAFT_INGREDIENTS / 2 },
      { kind: 'rope', quantity: MAX_CRAFT_INGREDIENTS / 2 + 1 },
    ],
    Array.from({ length: MAX_KIND_INGREDIENTS + 1 }, (_, index) => ({
      kind: `future_${index}`, quantity: 1,
    })),
  ]

  for (const recipe of invalid) assert.equal(parseKindRecipe(recipe), null)
  assert.deepEqual(parseKindRecipe([]), [])
  assert.deepEqual(parseKindRecipe([
    { kind: 'glass', quantity: MAX_CRAFT_INGREDIENTS / 2 },
    { kind: 'rope', quantity: MAX_CRAFT_INGREDIENTS / 2 },
  ]), [
    { kind: 'glass', quantity: MAX_CRAFT_INGREDIENTS / 2 },
    { kind: 'rope', quantity: MAX_CRAFT_INGREDIENTS / 2 },
  ])
})

test('trait labels and kind ingredients refuse credential-shaped public names', () => {
  for (const prefix of ['1f3d9_sk_', '1f3d9_at_', '1f3d9_rt_', '1f3d9_ac_']) {
    const leaked = `${prefix}${'ab'.repeat(24)}`
    assert.equal(parseKindRecipe([{ kind: leaked, quantity: 1 }]), null, prefix)
    assert.equal(parseTraitRecipe({
      use: [{ effect: 'label', target: 'actor', label: leaked }],
    }), null, prefix)
    assert.equal(parseTraitRecipe({
      use: [{ effect: 'check_label', target: 'actor', label: leaked, then: [] }],
    }), null, prefix)
  }
})
