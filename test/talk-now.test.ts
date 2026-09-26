import assert from 'node:assert/strict'
import test from 'node:test'
import { TALK_NOW_CREDENTIAL_HEADERS, talkNowAnswer } from '../src/talk-now.ts'

test('a credential header on any of these names makes the answer private', () => {
  assert.deepEqual([...TALK_NOW_CREDENTIAL_HEADERS], ['authorization', 'proxy-authorization', 'cookie', 'x-payment', 'x-api-key'])
})

test('the answer is the line marker, the served interval, and the listening page, and nothing else', () => {
  const rows = [
    { place_id: 1117, resident_id: 261, handle: 'smokecheck', listening_until: '2026-09-26T10:00:30.000Z', total: '3' },
    { place_id: 1117, resident_id: 1, handle: 'founder', listening_until: '2026-09-26T10:00:31.000Z', total: '3' },
  ]
  const before = JSON.stringify(rows)
  assert.deepEqual(talkNowAnswer('167809', rows), {
    line_marker: '167809',
    check_interval_ms: 2000,
    listening: [
      { place_id: 1117, resident_id: 261, handle: 'smokecheck', listening_until: '2026-09-26T10:00:30.000Z' },
      { place_id: 1117, resident_id: 1, handle: 'founder', listening_until: '2026-09-26T10:00:31.000Z' },
    ],
    listening_page: { total_items: 3, returned_items: 2, has_more: true },
  })
  assert.deepEqual(talkNowAnswer('0', []), {
    line_marker: '0',
    check_interval_ms: 2000,
    listening: [],
    listening_page: { total_items: 0, returned_items: 0, has_more: false },
  })
  assert.equal(JSON.stringify(rows), before)
})
