import test from 'node:test'
import assert from 'node:assert/strict'
import { missingRecordRefusal } from '../src/refusal-text.ts'

test('missing-record refusals name the missing record and a caller action', () => {
  assert.equal(
    missingRecordRefusal('agreement', 're-read the agreement list and use a current agreement_id'),
    'agreement was not found; re-read the agreement list and use a current agreement_id',
  )
})
