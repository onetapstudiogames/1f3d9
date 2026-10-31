// A label's life, chosen by its maker (decision #168), and the founder's ending of a
// resident's label at its request (decision #169): the recipe grammar, the stored-recipe
// leniency, the before-use sentence, and the founder body.
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  loadTraitRecipe,
  parseTraitRecipe,
  traitRecipeGrammarFault,
} from '../src/physics.ts'
import { recipeRefusalWords } from '../src/recipe-refusal.ts'
import { durationWords, useLabelStatement } from '../src/use-labels.ts'
import { parseLabelEndingInput } from '../src/label-endings.ts'

const label = (target: string, extra: Record<string, unknown> = {}) => ({
  effect: 'label', target, label: 'haunted', ...extra,
})

test('a newly coined label on actor or target must choose seconds or permanent, and the refusal names both', () => {
  for (const target of ['actor', 'target']) {
    const recipe = { use: [label(target)] }
    assert.equal(parseTraitRecipe(recipe), null, `${target} with no life is refused`)
    assert.deepEqual(traitRecipeGrammarFault(recipe), { where: 'use, step 1', code: 'label_life' })
    const words = recipeRefusalWords(recipe)
    assert.equal(words.where, 'use, step 1')
    assert.match(words.rule, /seconds, a whole number from 1 to 86400, or permanent: true/u)
  }
  const nested = { use: [{ effect: 'chance', percent: 50, then: [label('actor')] }] }
  assert.equal(recipeRefusalWords(nested).where, 'use, step 1, then step 1')
  const waking = { wake: { then: [label('actor')] } }
  assert.equal(parseTraitRecipe(waking), null, 'a wake sticker must choose too')
})

test('a coined label accepts seconds 1 to 86400 or permanent: true on actor and target, and seconds on source', () => {
  assert.deepEqual(parseTraitRecipe({ use: [label('actor', { seconds: 86_400 })] }), {
    use: [{ effect: 'label', target: 'actor', label: 'haunted', seconds: 86_400 }],
  })
  assert.deepEqual(parseTraitRecipe({ use: [label('target', { permanent: true })] }), {
    use: [{ effect: 'label', target: 'target', label: 'haunted', permanent: true }],
  })
  assert.deepEqual(parseTraitRecipe({ use: [label('source', { seconds: 60 })] }), {
    use: [{ effect: 'label', target: 'source', label: 'haunted', seconds: 60 }],
  })
  assert.deepEqual(parseTraitRecipe({ use: [label('source')] }), {
    use: [{ effect: 'label', target: 'source', label: 'haunted' }],
  }, 'source keeps its permanent label when seconds is omitted')
  for (const refused of [
    label('actor', { seconds: 0 }),
    label('actor', { seconds: 86_401 }),
    label('actor', { seconds: 1.5 }),
    label('actor', { seconds: 60, permanent: true }),
    label('actor', { permanent: false }),
    label('source', { permanent: true }),
    label('place', { permanent: true }),
    label('law_place', { permanent: true }),
  ]) {
    assert.equal(parseTraitRecipe({ use: [refused] }), null, JSON.stringify(refused))
    assert.equal(traitRecipeGrammarFault({ use: [refused] })?.code, 'shape', JSON.stringify(refused))
  }
})

test('a stored recipe coined before the rule still loads, its unstated label permanent', () => {
  const old = { use: [label('actor'), { effect: 'reach', over: 'residents', then: [label('target')] }] }
  assert.deepEqual(loadTraitRecipe(old), {
    use: [
      { effect: 'label', target: 'actor', label: 'haunted' },
      { effect: 'reach', over: 'residents', max: 16, then: [{ effect: 'label', target: 'target', label: 'haunted' }] },
    ],
  })
  const coinedNow = parseTraitRecipe({ use: [label('actor', { permanent: true })] })
  assert.deepEqual(loadTraitRecipe(JSON.parse(JSON.stringify(coinedNow))), coinedNow,
    'a recipe coined now loads back exactly')
})

test('a thing says what using it puts on you and for how long, with may for conditional steps', () => {
  assert.equal(useLabelStatement([]), 'Using it puts no labels on you.')
  assert.equal(useLabelStatement([null, { talk: [label('actor')] }]), 'Using it puts no labels on you.')
  assert.equal(useLabelStatement([{ use: [label('actor')] }]), 'Using it puts a permanent label on you.',
    'a label coined before the rule reads as permanent')
  assert.equal(useLabelStatement([{ use: [label('target', { seconds: 60 })] }]), 'Using it puts no labels on you.',
    'a label on what you aim it at is not on you')
  assert.equal(
    useLabelStatement([
      { use: [label('actor', { permanent: true }), label('actor', { seconds: 86_400 })] },
      { use: [label('actor', { permanent: true })] },
    ]),
    'Using it puts 2 permanent labels on you and puts a label on you that lasts 1 day.',
  )
  assert.equal(
    useLabelStatement([{ use: [
      { effect: 'chance', percent: 10, then: [label('actor', { seconds: 5_400 })], else: [label('actor', { seconds: 90 })] },
      { effect: 'check_label', target: 'actor', label: 'brave', then: [label('actor', { permanent: true })] },
      { effect: 'wait', seconds: 30, then: [label('actor', { seconds: 7_200 })] },
    ] }]),
    'Using it may put a label on you that lasts 90 minutes, may put a label on you that lasts 90 seconds, '
      + 'may put a permanent label on you and may put a label on you that lasts 2 hours.',
  )
  assert.equal(
    useLabelStatement([{ use: [{ effect: 'reach', over: 'residents', then: [label('target', { permanent: true })] }] }]),
    'Using it may put a label on you that lasts 1 day.',
    'a reach over residents reaches you too, and its stickers end within a day',
  )
  assert.equal(durationWords(1), '1 second')
  assert.equal(durationWords(120), '2 minutes')
  assert.equal(durationWords(172_800), '2 days')
})

test('the founder ending body names the resident, the label, and the request note', () => {
  assert.deepEqual(parseLabelEndingInput({ resident_handle: 'elias', label: 'Haunted', request_note_id: 41 }), {
    ok: true, input: { residentHandle: 'elias', label: 'haunted', requestNoteId: 41, sourceThingId: null },
  })
  assert.deepEqual(parseLabelEndingInput({
    resident_handle: 'elias', label: 'haunted', request_note_id: 41, source_thing_id: 6802,
  }), { ok: true, input: { residentHandle: 'elias', label: 'haunted', requestNoteId: 41, sourceThingId: 6802 } })
  for (const [body, error] of [
    [null, /must be a JSON object/u],
    [{ resident_handle: 'elias', label: 'haunted', request_note_id: 41, reason: 'x' }, /does not accept reason/u],
    [{ resident_handle: 'Not A Handle!', label: 'haunted', request_note_id: 41 }, /resident_handle must be a resident handle/u],
    [{ resident_handle: 'elias', label: 'not a name', request_note_id: 41 }, /label must be the world name/u],
    [{ resident_handle: 'elias', label: 'haunted' }, /request_note_id must be the positive id/u],
    [{ resident_handle: 'elias', label: 'haunted', request_note_id: '41' }, /request_note_id must be the positive id/u],
    [{ resident_handle: 'elias', label: 'haunted', request_note_id: 41, source_thing_id: -1 }, /source_thing_id must be a positive thing id/u],
  ] as const) {
    const parsed = parseLabelEndingInput(body)
    assert.equal(parsed.ok, false, JSON.stringify(body))
    if (!parsed.ok) assert.match(parsed.error, error)
  }
})
