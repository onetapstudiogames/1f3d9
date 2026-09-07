import test from 'node:test'
import assert from 'node:assert/strict'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_VIEWER_OPEN_STORAGE_KEY, parseWindowViewerOpenKeys } from '../../src/window-client.ts'

export function registerWindowOpeningTests(): void {
  test('viewer opening choices round-trip as public record ids without recording bodies', () => {
    assert.equal(WINDOW_VIEWER_OPEN_STORAGE_KEY, '1f3d9:window:open-records')
    const keys = ['note:301', 'thing:401', 'agreement:601']
    assert.deepEqual(parseWindowViewerOpenKeys(JSON.stringify(keys)), keys)
    assert.deepEqual(parseWindowViewerOpenKeys(null), [])
    assert.deepEqual(parseWindowViewerOpenKeys('[]'), [])
    assert.deepEqual(parseWindowViewerOpenKeys('["note:1","note:1","thing:1"]'),
      ['note:1', 'thing:1'])
  })

  test('viewer opening choices reject corrupt or unrelated browser storage', () => {
    for (const stored of [
      '{', '{}', 'null', '"note:1"', '[1]', '["note:0"]', '["note:-1"]',
      '["note:1.5"]', '["note:01"]', '["note:9007199254740992"]',
      '["resident:1"]', '["place:11"]', '["live:11"]',
      JSON.stringify(['note:' + '1'.repeat(16_384)]),
    ]) {
      assert.deepEqual(parseWindowViewerOpenKeys(stored), [],
        `stored opening choices ${stored.slice(0, 100)} must produce []`)
    }
  })

  test('viewer opening choices keep valid entries around malformed stored entries', () => {
    const stored = [
      'note:1', null, 2, {}, 'a body', 'note:0', 'note:01',
      'note:9007199254740992', 'thing:2', 'note:1', 'agreement:3',
    ]
    assert.deepEqual(parseWindowViewerOpenKeys(JSON.stringify(stored)),
      ['note:1', 'thing:2', 'agreement:3'])
  })

  test('viewer opening choices enforce a bounded record count', () => {
    const keys = Array.from({ length: 200 }, (_, index) => `note:${index + 1}`)
    assert.deepEqual(parseWindowViewerOpenKeys(JSON.stringify(keys)), keys)
    assert.deepEqual(parseWindowViewerOpenKeys(JSON.stringify([...keys, 'thing:1'])),
      [...keys.slice(1), 'thing:1'])
    assert.deepEqual(parseWindowViewerOpenKeys(JSON.stringify([null, ...keys, 'bad'])), keys)
  })

  test('the window preserves and plainly prints a focused retired-place tombstone', () => {
    assert.match(WINDOW_JS, /status:\s*placeStatus/iu)
    assert.match(WINDOW_JS, /retiredAt[,}]/iu)
    assert.match(WINDOW_JS, /payload\.place\s*\|\|\s*payload\.tombstone/iu)
    assert.match(WINDOW_JS, /This place was retired/iu)
    assert.match(WINDOW_JS, /Founding name:/iu)
  })
}
