import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  BRICK_BRANCHES,
  EFFECT_BRICKS,
  MAX_APPLICATIONS_PER_PROGRAM,
  type EffectBrick,
  parseTraitRecipe,
  traitRecipeFault,
  traitRecipeGrammarFault,
} from '../src/physics.ts'
import { publicPhysicsFacts } from '../src/public-reference-facts.ts'
import { recipeGrammarWords, recipeRefusalWords } from '../src/recipe-refusal.ts'

const TOP_RULE = 'a recipe is a list of steps, or an object whose only keys are talk, move, use, give, consume, make, go_home, and wake'
const LIST_RULE = 'steps must be a list'
const LABEL_RULE = 'label takes target (actor, source, target, or place) and label (a world name)'
const BAD_BRICK_CASES: readonly Readonly<{ step: unknown; rule: string }>[] = [
  { step: { effect: 'destroy', target: 'actor' }, rule: 'destroy takes target (source or target)' },
  { step: { effect: 'move', target: 'actor', to: 'there' }, rule: 'move takes target (actor, source, or target) and to (destination or home)' },
  { step: { effect: 'transfer', target: 'source', to: 'nobody' }, rule: 'transfer takes target (source or target) and to (recipient or actor)' },
  { step: { effect: 'label', target: 'actor', label: 'Bad Name!' }, rule: LABEL_RULE },
  { step: { effect: 'block', target: 'actor', action: 'go_home', seconds: 1 }, rule: 'block takes target (actor or target), action (talk, move, use, give, consume, or make), and seconds (1 to 86400)' },
  { step: { effect: 'wait', seconds: 0, then: [] }, rule: 'wait takes seconds (1 to 86400), then, and an optional repeat (1 to 8)' },
  { step: { effect: 'check_label', target: 'room', label: 'x', then: [] }, rule: 'check_label takes target (actor, source, target, or place), label (a world name), then, and an optional else' },
  { step: { effect: 'chance', percent: 100, then: [] }, rule: 'chance takes percent (1 to 99), then, and an optional else' },
  { step: { effect: 'write', key: 'k', op: 'set' }, rule: 'write takes key (a world name), an optional op (set, add, or append), and value, which set and append need' },
  { step: { effect: 'copy', generations: 9 }, rule: 'copy takes optional generations (1 to 8), copies (1 to 10000 or unlimited), to (here or adjacent), and inherit (a list of body and state)' },
  { step: { effect: 'reach', over: 'residents', kind: 'apple', then: [] }, rule: 'reach takes then and optional over (things or residents), max (1 to 64), and kind (a world name, only with over things)' },
  { step: { effect: 'convert', target: 'source' }, rule: 'convert takes target (which must be target) and an optional into_kind (a world name)' },
]

function expectRefusal(value: unknown, where: string, rule: string): void {
  assert.deepEqual(recipeRefusalWords(value), { where, rule })
  assert.equal(traitRecipeFault(value), 'grammar')
}

function nestedChances(count: number): unknown[] {
  return [{
    effect: 'chance',
    percent: 50,
    then: count === 1 ? [] : nestedChances(count - 1),
  }]
}

test('recipe refusals name the first failing location and rule', () => {
  const first = {
    use: [
      { effect: 'label', target: 'actor', label: 'a' },
      { effect: 'chance', percent: 50, then: [{ effect: 'label', target: 'actor', label: 'b', then: [] }] },
    ],
  }
  expectRefusal(first, 'use, step 2, then step 1', 'label takes no then or else')
  const firstFault = traitRecipeGrammarFault(first)
  assert.ok(firstFault)
  assert.deepEqual(recipeGrammarWords(firstFault), {
    where: 'use, step 2, then step 1',
    rule: 'label takes no then or else',
  })

  expectRefusal(
    [{ effect: 'check_label', target: 'actor', label: 'x', else: [] }],
    'use, step 1',
    'check_label needs then, a list of steps',
  )
  expectRefusal(
    { give: [{ effect: 'wait', seconds: 5, then: [], else: [] }] },
    'give, step 1',
    'wait takes then but no else',
  )
  expectRefusal({ use: [{ effect: 'chance', percent: 50, then: 'x' }] }, 'use, step 1, then', LIST_RULE)
  expectRefusal({ use: ['x'] }, 'use, step 1', 'each step is an object whose effect is destroy, move, transfer, label, block, wait, check_label, chance, write, copy, reach, or convert')
  expectRefusal({ dance: [] }, 'the top level', TOP_RULE)
  expectRefusal(
    { use: [{ effect: 'reach', over: 'residents', then: [{ effect: 'destroy', target: 'target' }] }] },
    'use, step 1',
    'a reach never holds block, copy, or another reach, and never moves actor; over residents it holds only label, check_label, chance, and write',
  )
  expectRefusal(
    { use: [{ effect: 'reach', max: 64, then: Array.from({ length: 9 }, () => ({ effect: 'label', target: 'target', label: 'a' })) }] },
    'use',
    `one program may weigh at most ${MAX_APPLICATIONS_PER_PROGRAM} effect applications, a reach counting its max times its steps`,
  )
  expectRefusal({ wake: { then: [], every_seconds: 5 } }, 'wake', 'wake takes then and optional on (a list of arrive, talk, and clock) and every_seconds (10 to 86400)')
  expectRefusal(
    { wake: { then: [{ effect: 'label', target: 'actor', label: 'a', else: [] }] } },
    'wake, then step 1',
    'label takes no then or else',
  )

  assert.ok(parseTraitRecipe({ use: nestedChances(7) }))
  expectRefusal(
    { use: nestedChances(8) },
    'use, step 1' + ', then step 1'.repeat(7) + ', then',
    'steps nest at most 8 levels deep',
  )
  expectRefusal(
    { use: Array.from({ length: 129 }, () => ({ effect: 'label', target: 'actor', label: 'a' })) },
    'use',
    'a recipe holds at most 128 steps in all',
  )
  expectRefusal(
    Array.from({ length: 129 }, () => ({ effect: 'label', target: 'actor', label: 'a' })),
    'use',
    'a recipe holds at most 128 steps in all',
  )
  expectRefusal(new Array(1), 'use', LIST_RULE)
  expectRefusal(
    {
      use: Array.from({ length: 100 }, () => ({ effect: 'label', target: 'actor', label: 'a' })),
      give: Array.from({ length: 29 }, () => ({ effect: 'label', target: 'actor', label: 'a' })),
    },
    'give',
    'a recipe holds at most 128 steps in all',
  )
  expectRefusal(
    { use: Array.from({ length: 128 }, () => ({ effect: 'write', key: 'k', value: '中'.repeat(200) })) },
    'the whole recipe',
    'a recipe may be at most 65,536 bytes as JSON',
  )
})

test('each brick refusal names its invalid field with the physics rule', () => {
  for (const { step, rule } of BAD_BRICK_CASES) expectRefusal({ use: [step] }, 'use, step 1', rule)
})

test('shape refusal words match the public branch rules for every brick', () => {
  const physics = publicPhysicsFacts() as {
    brick_fields: Record<EffectBrick, { then: string; else: string }>
  }
  const probes = new Map(BAD_BRICK_CASES.map(({ step }) => [
    (step as { effect: EffectBrick }).effect,
    step,
  ]))

  for (const brick of EFFECT_BRICKS) {
    const fields = physics.brick_fields[brick]
    const branchRule = BRICK_BRANCHES[brick]
    assert.equal(fields.then, branchRule === 'none' ? 'not allowed' : 'required', brick)
    assert.equal(fields.else, branchRule === 'then and else' ? 'optional' : 'not allowed', brick)

    const probe = probes.get(brick)
    assert.ok(probe && typeof probe === 'object', brick)
    const withoutBranches = Object.fromEntries(
      Object.entries(probe).filter(([key]) => key !== 'then' && key !== 'else'),
    )
    const withoutThen = recipeRefusalWords({ use: [withoutBranches] })
    assert.equal(withoutThen.where, 'use, step 1', brick)
    assert.equal(withoutThen.rule.includes(' needs then, a list of steps'), fields.then === 'required', brick)

    const withThen = recipeRefusalWords({ use: [{ ...withoutBranches, then: [] }] })
    assert.equal(withThen.rule.includes(' takes no then or else'), fields.then === 'not allowed', brick)

    const withThenAndElse = recipeRefusalWords({ use: [{ ...withoutBranches, then: [], else: [] }] })
    assert.equal(
      withThenAndElse.rule.includes(' takes then but no else'),
      fields.then === 'required' && fields.else === 'not allowed',
      brick,
    )
  }
})

test('reference example and credential-shaped values do not expose caller text', () => {
  const example = 'recipe refused at use, step 2, then step 1: label takes no then or else'
  const reference = readFileSync(new URL('../src/reference.txt', import.meta.url), 'utf8')
  assert.ok(reference.replace(/\s+/gu, ' ').includes(example))

  const credential = `1f3d9_sk_${'a1'.repeat(24)}`
  expectRefusal({ [credential]: [] }, 'the top level', TOP_RULE)
  const labelWords = recipeRefusalWords({
    use: [{ effect: 'label', target: 'actor', label: credential }],
  })
  assert.deepEqual(labelWords, { where: 'use, step 1', rule: LABEL_RULE })
  assert.equal(JSON.stringify(labelWords).includes(credential), false)
})

test('grammar faults stay separate from accepted recipes and wake faults', () => {
  const accepted = {
    use: [{
      effect: 'check_label', target: 'actor', label: 'a', then: [{
        effect: 'check_label', target: 'actor', label: 'b', then: [{
          effect: 'check_label', target: 'actor', label: 'c', then: [],
        }],
      }],
    }],
  }
  assert.ok(parseTraitRecipe(accepted))
  assert.equal(traitRecipeGrammarFault(accepted), null)

  const wakeHandOver = {
    wake: { then: [{ effect: 'transfer', target: 'source', to: 'actor' }] },
  }
  assert.equal(traitRecipeFault(wakeHandOver), 'wake_hand_over')
  assert.equal(traitRecipeGrammarFault(wakeHandOver), null)
})
