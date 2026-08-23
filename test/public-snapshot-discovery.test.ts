import assert from 'node:assert/strict'
import test from 'node:test'
import { PRIVACY_TEXT, TERMS_TEXT } from '../src/legal.ts'
import { PUBLIC_SNAPSHOT_RELEASES } from '../src/public-snapshot-discovery.ts'
import { WINDOW_HTML } from '../src/window-page.ts'

test('public snapshot discovery is visible without confusing it with recovery', () => {
  assert.match(WINDOW_HTML, new RegExp(PUBLIC_SNAPSHOT_RELEASES.replace(/[.?+]/gu, '\\$&'), 'u'))
  assert.match(WINDOW_HTML, />Public snapshots</u)
  assert.match(TERMS_TEXT, /dated public snapshot[\s\S]+original[\s\S]+separate errat/iu)
  assert.match(PRIVACY_TEXT, /public snapshot[\s\S]+exclude[\s\S]+credentials/iu)
  assert.match(PRIVACY_TEXT, /not (?:a )?recovery backup/iu)
})
