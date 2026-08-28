import assert from 'node:assert/strict'
import test from 'node:test'
import { readPublicLiveSurvey } from '../src/public-live-survey.ts'

test('the live survey returns one body-free direct thing count per public place', async () => {
  const calls: Array<{ text: string; params: readonly unknown[] }> = []
  const survey = await readPublicLiveSurvey(async (text, params) => {
    calls.push({ text, params })
    return [
      { id: '1', parent_id: null, things: 0 },
      { id: 2, parent_id: 1, things: 8 },
    ]
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.params, [])
  assert.match(calls[0]?.text ?? '', /public:window-live-survey/u)
  assert.match(calls[0]?.text ?? '', /join\s+place_reading_totals/iu)
  assert.doesNotMatch(calls[0]?.text ?? '', /description|body|secret|owner/iu)
  assert.deepEqual(survey, [
    { id: 1, parent_id: null, things: 0 },
    { id: 2, parent_id: 1, things: 8 },
  ])
  assert.ok(Object.isFrozen(survey))
  assert.ok(survey.every(Object.isFrozen))
})

test('the live survey refuses malformed ids, parents, and counters', async () => {
  for (const row of [
    { id: 0, parent_id: null, things: 0 },
    { id: 1, parent_id: 0, things: 0 },
    { id: 1, parent_id: null, things: -1 },
    { id: 1, parent_id: null, things: Number.MAX_SAFE_INTEGER + 1 },
    { id: 1, parent_id: null, things: null },
    { id: 1, parent_id: null, things: false },
    { id: 1, parent_id: null, things: '' },
  ]) {
    await assert.rejects(
      () => readPublicLiveSurvey(async () => [row]),
      /invalid public live survey row/u,
    )
  }

  await assert.rejects(
    () => readPublicLiveSurvey(async () => [
      { id: 1, parent_id: null, things: 0 },
      { id: 1, parent_id: null, things: 0 },
    ]),
    /invalid public live survey row/u,
  )
})
