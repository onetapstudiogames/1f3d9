// The end key in a trait recipe (things ending, T5): its shape, the wake program rules it
// shares, the three end-only rules (E13), the one-end-trait rule for kinds (E17), the law
// refusal (E18), and the end_program_summary sentence (tasks file 4.B.4 and 4.B.5).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_APPLICATIONS_PER_PROGRAM,
  endProgramOf,
  loadTraitRecipe,
  parseTraitRecipe,
  recipeUsesKindOnlyAbility,
  traitRecipeFault,
  traitRecipeGrammarFault,
} from '../src/physics.ts'
import { recipeRefusalWords } from '../src/recipe-refusal.ts'
import { endTraitConflictRefusal } from '../src/thing-ending-refusals.ts'
import { endProgramStatement } from '../src/use-labels.ts'
import { kindTraitRefusal } from '../src/world.ts'

const write = Object.freeze({ effect: 'write', key: 'last', value: true })
const roll = Object.freeze({ effect: 'write', key: 'roll', value: { from: 'roll' } })
const placeLabel = Object.freeze({ effect: 'label', target: 'place', label: 'faded', seconds: 60 })

function end(then: readonly unknown[]): unknown {
  return { end: { then } }
}

function reachThings(then: readonly unknown[], max = 16): unknown {
  return { effect: 'reach', over: 'things', max, then }
}

function reachResidents(then: readonly unknown[]): unknown {
  return { effect: 'reach', over: 'residents', then }
}

test('a valid end key parses to {end: {then}}, frozen, and reads back with endProgramOf', () => {
  const recipe = parseTraitRecipe({ use: [write], end: { then: [write, placeLabel] } })
  assert.deepEqual(recipe, {
    use: [{ effect: 'write', key: 'last', op: 'set', value: true }],
    end: { then: [
      { effect: 'write', key: 'last', op: 'set', value: true },
      { effect: 'label', target: 'place', label: 'faded', seconds: 60 },
    ] },
  })
  assert.equal(Object.isFrozen(recipe?.end), true)
  assert.equal(traitRecipeFault(end([])), null)
  assert.deepEqual(parseTraitRecipe(end([])), { end: { then: [] } })
  assert.deepEqual(endProgramOf({ end: { then: [write] } }), {
    then: [{ effect: 'write', key: 'last', op: 'set', value: true }],
  })
  assert.equal(endProgramOf({ use: [write] }), null)
  assert.equal(endProgramOf(null), null)
  // A wake key and an end key may share one trait.
  assert.ok(parseTraitRecipe({ wake: { then: [write] }, end: { then: [write] } }))
})

test('every step the end-only rules allow is accepted', () => {
  const allowed: readonly (readonly unknown[])[] = [
    [write],
    [roll],
    [{ effect: 'write', key: 'when', value: { from: 'time' } }],
    [placeLabel],
    [{ effect: 'check_label', target: 'source', label: 'lit', then: [write] }],
    [{ effect: 'check_label', target: 'place', label: 'lit', then: [write], else: [roll] }],
    [{ effect: 'chance', percent: 50, then: [write] }],
    [{ effect: 'copy' }],
    [{ effect: 'copy', to: 'adjacent', inherit: ['body', 'state'] }],
    [reachThings([{ effect: 'destroy', target: 'target' }])],
    [reachThings([{ effect: 'move', target: 'target', to: 'home' }])],
    [reachThings([{ effect: 'convert', target: 'target' }])],
    [reachThings([{ effect: 'label', target: 'target', label: 'touched', seconds: 60 }])],
    [reachResidents([{ effect: 'label', target: 'target', label: 'saw-it', seconds: 60 }])],
    [reachResidents([{ effect: 'check_label', target: 'target', label: 'x', then: [write] }])],
  ]
  for (const then of allowed) {
    assert.equal(traitRecipeFault(end(then)), null, JSON.stringify(then))
    assert.ok(parseTraitRecipe(end(then)), JSON.stringify(then))
  }
})

test('each end-only rule (E13) is refused as end_key, even nested, and nothing parses', () => {
  const refused: readonly Readonly<{ why: string; then: readonly unknown[] }>[] = [
    { why: 'wait', then: [{ effect: 'wait', seconds: 5, then: [write] }] },
    { why: 'nested wait', then: [{ effect: 'chance', percent: 50, then: [{ effect: 'wait', seconds: 5, then: [] }] }] },
    { why: 'hand over', then: [{ effect: 'transfer', target: 'source', to: 'recipient' }] },
    { why: 'hand over in a reach', then: [reachThings([{ effect: 'transfer', target: 'target', to: 'actor' }])] },
    { why: 'label actor', then: [{ effect: 'label', target: 'actor', label: 'x', seconds: 60 }] },
    { why: 'check_label actor', then: [{ effect: 'check_label', target: 'actor', label: 'x', then: [] }] },
    { why: 'move actor home', then: [{ effect: 'move', target: 'actor', to: 'home' }] },
    { why: 'block actor', then: [{ effect: 'block', target: 'actor', action: 'talk', seconds: 5 }] },
    { why: 'write from actor', then: [{ effect: 'write', key: 'who', value: { from: 'actor' } }] },
    { why: 'append from actor', then: [{ effect: 'write', key: 'who', op: 'append', value: { from: 'actor' } }] },
    { why: 'write from actor in a reach', then: [reachResidents([{ effect: 'write', key: 'who', value: { from: 'actor' } }])] },
    { why: 'label actor in a branch', then: [{ effect: 'check_label', target: 'place', label: 'x', then: [], else: [{ effect: 'label', target: 'actor', label: 'y', permanent: true }] }] },
    { why: 'target outside a reach', then: [{ effect: 'label', target: 'target', label: 'x', seconds: 60 }] },
    { why: 'destroy target outside a reach', then: [{ effect: 'destroy', target: 'target' }] },
    { why: 'move to destination in a reach', then: [reachThings([{ effect: 'move', target: 'target', to: 'destination' }])] },
    { why: 'destroy source', then: [{ effect: 'destroy', target: 'source' }] },
    { why: 'move source', then: [{ effect: 'move', target: 'source', to: 'home' }] },
    { why: 'label source', then: [{ effect: 'label', target: 'source', label: 'gone' }] },
    { why: 'label source with seconds', then: [{ effect: 'label', target: 'source', label: 'gone', seconds: 60 }] },
    { why: 'destroy source in a reach', then: [reachThings([{ effect: 'destroy', target: 'source' }])] },
    { why: 'label source in a reach', then: [reachThings([{ effect: 'label', target: 'source', label: 'gone', seconds: 60 }])] },
    { why: 'move source in a chance', then: [{ effect: 'chance', percent: 10, then: [{ effect: 'move', target: 'source', to: 'home' }] }] },
  ]
  for (const { why, then } of refused) {
    assert.equal(traitRecipeFault(end(then)), 'end_key', why)
    assert.equal(parseTraitRecipe(end(then)), null, why)
    assert.equal(traitRecipeGrammarFault(end(then)), null, why)
    // A stored recipe that breaks the rules loads inert, like a wake program that does.
    assert.deepEqual(loadTraitRecipe(end(then)), {}, why)
    assert.equal(endProgramOf(end(then)), null, why)
  }
  // The same steps stay fine outside the end key.
  assert.equal(traitRecipeFault({ use: [{ effect: 'wait', seconds: 5, then: [write] }] }), null)
  assert.equal(traitRecipeFault({ use: [{ effect: 'destroy', target: 'source' }] }), null)
  assert.equal(traitRecipeFault({ use: [{ effect: 'label', target: 'actor', label: 'x', seconds: 60 }] }), null)
})

test('an end key weighs at most 512 applications; 513 is refused as weight', () => {
  const eight = Array.from({ length: 8 }, () => write)
  assert.equal(MAX_APPLICATIONS_PER_PROGRAM, 512)
  assert.equal(traitRecipeFault(end([reachThings(eight, 64)])), null)
  const heavy = end([reachThings(eight, 64), write])
  assert.equal(traitRecipeFault(heavy), 'grammar')
  assert.deepEqual(traitRecipeGrammarFault(heavy), { where: 'end', code: 'weight' })
})

test('the end key takes only then, a list of steps; dials and other shapes are refused', () => {
  for (const value of [
    { end: [] },
    { end: {} },
    { end: null },
    { end: { then: [], on: ['arrive'] } },
    { end: { then: [], every_seconds: 60 } },
  ]) {
    assert.equal(traitRecipeFault(value), 'grammar', JSON.stringify(value))
    assert.deepEqual(recipeRefusalWords(value), { where: 'end', rule: 'end takes only then, a list of steps' }, JSON.stringify(value))
  }
  assert.deepEqual(recipeRefusalWords({ end: { then: {} } }), { where: 'end, then', rule: 'steps must be a list' })
  assert.deepEqual(recipeRefusalWords({ finish: { then: [] } }), {
    where: 'the top level',
    rule: 'a recipe is a list of steps, or an object whose only keys are talk, move, use, give, consume, make, go_home, wake, and end',
  })
})

test('the end key is kind-only, so laws refuse an end-key trait', () => {
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe(end([]))!), true)
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe(end([placeLabel]))!), true)
  assert.equal(recipeUsesKindOnlyAbility(parseTraitRecipe({ talk: [placeLabel] })!), false)
})

test('a kind may list only one trait with an end key (E17); the wake rule still comes first', () => {
  const recipes = new Map<string, unknown>([
    ['glow', end([write])],
    ['fade', end([])],
    ['bell', { wake: { then: [write] } }],
    ['chime', { wake: { then: [] } }],
    ['plain', { use: [write] }],
  ])
  assert.equal(kindTraitRefusal(['plain', 'glow'], recipes), null)
  assert.equal(kindTraitRefusal(['glow', 'bell'], recipes), null)
  assert.equal(kindTraitRefusal(['glow', 'plain', 'fade'], recipes), endTraitConflictRefusal('glow', 'fade'))
  assert.equal(
    kindTraitRefusal(['glow', 'plain', 'fade'], recipes),
    'A kind may list only one trait with an end key; glow and fade both carry one, so keep one of them.',
  )
  assert.equal(
    kindTraitRefusal(['bell', 'glow', 'chime', 'fade'], recipes),
    'a kind may list only one trait with a wake key; bell and chime both carry one, so keep one of them',
  )
})

const HEAD = "When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, the next time a resident is in its room it runs glow's end steps once"

test('end_program_summary: no end trait, an empty end, and each brick phrase', () => {
  assert.equal(endProgramStatement([]), 'When this ends it becomes a remnant.')
  assert.equal(endProgramStatement([{ name: 'plain', recipe: { use: [write] } }, { name: 'none', recipe: null }]), 'When this ends it becomes a remnant.')
  assert.equal(endProgramStatement([{ name: 'glow', recipe: end([]) }]), `${HEAD}.`)
  const cases: readonly Readonly<{ then: readonly unknown[]; says: string }>[] = [
    { then: [write], says: 'writes its own state box' },
    { then: [{ effect: 'copy' }], says: 'makes a copy of itself' },
    { then: [placeLabel], says: 'puts a label on its room' },
    { then: [{ effect: 'chance', percent: 50, then: [] }], says: 'may do more' },
    { then: [{ effect: 'check_label', target: 'source', label: 'x', then: [] }], says: 'may do more' },
    { then: [reachThings([])], says: 'reaches things in its room' },
    { then: [reachResidents([])], says: 'reaches residents in its room' },
    { then: [reachThings([{ effect: 'label', target: 'target', label: 'x', seconds: 60 }])], says: 'reaches things in its room and may put a label on things in its room' },
    { then: [reachResidents([{ effect: 'label', target: 'target', label: 'x', seconds: 60 }])], says: 'reaches residents in its room and may put a label on residents in its room' },
    { then: [reachThings([{ effect: 'convert', target: 'target' }])], says: 'reaches things in its room and may turn things it reaches into its kind' },
    { then: [reachThings([{ effect: 'move', target: 'target', to: 'home' }])], says: 'reaches things in its room and may move things it reaches' },
    { then: [reachThings([{ effect: 'destroy', target: 'target' }])], says: 'reaches things in its room and may destroy things it reaches' },
    { then: [{ effect: 'chance', percent: 50, then: [write, { effect: 'copy' }] }], says: 'may do more, may write its own state box and may make a copy of itself' },
  ]
  for (const { then, says } of cases) {
    assert.equal(endProgramStatement([{ name: 'glow', recipe: end(then) }]), `${HEAD}: ${says}.`, says)
  }
})

test('end_program_summary names each phrase once, plain when any use is certain, in program order', () => {
  const then = [
    { effect: 'chance', percent: 50, then: [write] },
    write,
    reachThings([{ effect: 'destroy', target: 'target' }, { effect: 'destroy', target: 'target' }]),
    { effect: 'copy' },
  ]
  assert.equal(
    endProgramStatement([{ name: 'plain', recipe: { use: [write] } }, { name: 'glow', recipe: end(then) }]),
    `${HEAD}: may do more, writes its own state box, reaches things in its room, may destroy things it reaches and makes a copy of itself.`,
  )
  // The first trait with an end key in kind order is the one named.
  assert.equal(
    endProgramStatement([{ name: 'glow', recipe: end([write]) }, { name: 'fade', recipe: end([]) }]),
    `${HEAD}: writes its own state box.`,
  )
  // A stored end key that breaks the rules is inert, so it reads as no end trait.
  assert.equal(
    endProgramStatement([{ name: 'glow', recipe: end([{ effect: 'wait', seconds: 5, then: [] }]) }]),
    'When this ends it becomes a remnant.',
  )
})

test('end_program_summary is capped at 300 characters, ending with "and more"', () => {
  const name = `g${'x'.repeat(63)}`
  const then = [
    { effect: 'chance', percent: 50, then: [write] },
    { effect: 'copy' },
    placeLabel,
    reachThings([{ effect: 'destroy', target: 'target' }, { effect: 'move', target: 'target', to: 'home' }, { effect: 'convert', target: 'target' }]),
    reachResidents([{ effect: 'label', target: 'target', label: 'x', seconds: 60 }]),
  ]
  const sentence = endProgramStatement([{ name, recipe: end(then) }])
  assert.ok(sentence.length <= 300, `${sentence.length}: ${sentence}`)
  assert.ok(sentence.startsWith(`When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, the next time a resident is in its room it runs ${name}'s end steps once: may do more`), sentence)
  assert.ok(sentence.endsWith(' and more.'), sentence)
  // Short enough names keep every phrase.
  const short = endProgramStatement([{ name: 'glow', recipe: end([write, { effect: 'copy' }]) }])
  assert.equal(short, `${HEAD}: writes its own state box and makes a copy of itself.`)
  for (const text of [sentence, short]) assert.match(text, /^[\x20-\x7e]+$/u)
})
