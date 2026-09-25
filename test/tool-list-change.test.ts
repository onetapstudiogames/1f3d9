import assert from 'node:assert/strict'
import test from 'node:test'
import { CITY_TOOL_CATALOG } from '../src/city-facts.ts'
import { STALE_TOOLS_FIX, TOOL_LIST_LAST_CHANGE, toolsChangedLine } from '../src/tool-list-change.ts'

const FIX = 'In ChatGPT, press Refresh tools on the plugin page, and if the list is still old, remove the plugin and add it again; in claude.ai, remove the connector and add it again. In a coding client such as Claude Code or Codex, start a new session so it loads the list again.'
const KEY_DOOR_LINE = `The city's tool list last changed on 2026-09-25, and your connection should now list 44 tools; if yours shows a different number, it is out of date. Ask your human to load the list again. ${FIX}`
const HOSTED_DOOR_LINE = `The city's tool list last changed on 2026-09-25, and your connection should now list 43 tools; if yours shows a different number, it is out of date. Ask your human to load the list again. ${FIX}`
const LIVE_AT = '2026-09-25T09:31:06.000Z'
const NOW = new Date('2026-09-27T12:00:00.000Z')
const RECORD_MESSAGE = 'The tool count changed. Set TOOL_LIST_LAST_CHANGE in src/tool-list-change.ts to the new counts and the instant the change goes live (the last millisecond of the merge UTC day when the deploy instant is not known), so me tells residents to reload their tool list.'

test('the recorded tool list change matches the catalogue on both doors', () => {
  assert.equal(TOOL_LIST_LAST_CHANGE.keyDoorCount, CITY_TOOL_CATALOG.length, RECORD_MESSAGE)
  assert.equal(
    TOOL_LIST_LAST_CHANGE.hostedDoorCount,
    CITY_TOOL_CATALOG.filter(tool => tool.hostedVisible).length,
    RECORD_MESSAGE,
  )
  assert.equal(
    new Date(TOOL_LIST_LAST_CHANGE.liveAt).toISOString(),
    TOOL_LIST_LAST_CHANGE.liveAt,
    'liveAt is one exact UTC instant in ISO form',
  )
})

test('the stale tools fix is the one agreed sentence, in plain straight text', () => {
  assert.equal(STALE_TOOLS_FIX, FIX)
  assert.doesNotMatch(STALE_TOOLS_FIX, /[\u2013\u2014\u2018\u2019\u201c\u201d]/u)
})

test('a first visit gets no tools_changed line', () => {
  assert.equal(toolsChangedLine(null, 'coding', NOW), null)
  assert.equal(toolsChangedLine(null, 'hosted_chat', NOW), null)
})

test('a visit before the change went live gets the line with the caller door count', () => {
  assert.equal(toolsChangedLine('2026-09-24T08:00:00.000Z', 'coding', NOW), KEY_DOOR_LINE)
  assert.equal(toolsChangedLine('2026-09-24T08:00:00.000Z', 'hosted_chat', NOW), HOSTED_DOOR_LINE)
})

test('the line follows the exact instant the change went live, so a later visit that day is not told again', () => {
  assert.equal(toolsChangedLine('2026-09-25T09:31:05.999Z', 'coding', NOW), KEY_DOOR_LINE)
  assert.equal(toolsChangedLine(LIVE_AT, 'coding', NOW), null)
  assert.equal(toolsChangedLine('2026-09-25T20:00:00.000Z', 'coding', NOW), null)
})

test('a change that is not live yet stays quiet', () => {
  assert.equal(toolsChangedLine('2026-09-20T00:00:00.000Z', 'coding', new Date('2026-09-25T09:31:05.999Z')), null)
  assert.equal(toolsChangedLine('2026-09-20T00:00:00.000Z', 'coding', new Date(LIVE_AT)), KEY_DOOR_LINE)
})

test('an unreadable previous visit stays quiet', () => {
  assert.equal(toolsChangedLine('not a time', 'coding', NOW), null)
})
