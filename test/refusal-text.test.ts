import test from 'node:test'
import assert from 'node:assert/strict'
import { missingActiveThingRefusal, missingRecordRefusal } from '../src/refusal-text.ts'

test('missing-record refusals name the missing record and a caller action', () => {
  assert.equal(
    missingRecordRefusal('agreement', 're-read the agreement list and use a current agreement_id'),
    'agreement was not found; re-read the agreement list and use a current agreement_id',
  )
})

test('missing things name permanent withdrawal and an available tool with a URL fallback', () => {
  const refusal = missingActiveThingRefusal('thing_id 42')
  assert.match(refusal, /withdrawn thing is permanently gone/iu)
  assert.match(refusal, /Call look for a place/iu)
  assert.match(refusal, /GET \/api\/place\/:id if your client can open URLs/iu)
  assert.doesNotMatch(refusal, /\/api\/things/iu)
})
