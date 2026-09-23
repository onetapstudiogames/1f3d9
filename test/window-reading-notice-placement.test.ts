import assert from 'node:assert/strict'
import test from 'node:test'
import { WINDOW_HTML } from '../src/window-page.ts'

test('the refresh notice sits inside the City facts drop-down, not in the open', () => {
  const facts = WINDOW_HTML.match(/<details id="city-facts"[^>]*>([\s\S]*?)<\/details>/u)?.[1] ?? ''
  assert.match(facts, /<summary>City facts<\/summary>/u)
  assert.match(facts, /<p id="window-reading-notice"[^>]*hidden>In Conversations, Happenings, Place, Things, and Agreements, expanded text stays open through refresh\./u)
  const outside = WINDOW_HTML.replace(/<details id="city-facts"[\s\S]*?<\/details>/u, '')
  assert.doesNotMatch(outside, /window-reading-notice/u)
  assert.doesNotMatch(outside, /expanded text stays open through refresh/u)
  assert.equal(WINDOW_HTML.match(/id="window-reading-notice"/gu)?.length, 1)
})
