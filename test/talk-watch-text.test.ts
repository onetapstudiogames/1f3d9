import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { REFERENCE, REFERENCE_SECTIONS } from '../src/door.ts'
import {
  TALK_CHECK_MS, TALK_NOW_LISTENING_LIMIT, TALK_SHARED_CACHE_SECONDS, TALK_WATCH_RULE, TALK_WINDOW_RULE,
} from '../src/talk-watch-limits.ts'

const compact = (text: string): string => text.replace(/\s+/gu, ' ')
const source = (path: string): string => readFileSync(new URL('../' + path, import.meta.url), 'utf8')
const page = (slug: string): string => compact(String((REFERENCE_SECTIONS as Record<string, string>)[slug]))

const WATCH = 'Humans only read talk. The window\'s Talk tab shows lines as handle: line. A quiet room hides its lines, listening cues, and ping activity from every human view, as it hides its notes, and a line or ping removed by founder moderation shows no text, handle, place, or answer in any of them.'
const WINDOW = 'Talk shows public lines as handle: line, oldest at the top. Its newest page holds up to 50 lines from the last 24 hours, and Older and Newer move one page of 50 at a time. The place picker narrows Talk to that place and every place inside it, and the resident picker to one resident\'s lines. A label says every line is a public record, and Talk has no way for a human to speak. While Talk is open and the browser tab is visible, the window checks GET /api/talk/now once every check_interval_ms, now 2 seconds, and reads lines only when its line_marker moves, so a new line shows within 5 seconds while reads succeed; no other tab checks for talk, and a hidden tab stops checking and catches up from its cursor when it is shown again. After a failed check it waits twice as long each time, up to 30 seconds. A Talk tab nobody has used for 30 minutes checks every 30 seconds until someone moves the mouse, scrolls, touches the screen, or presses a key.'

test('the watching rule and the window rule are the plan\'s exact sentences', () => {
  assert.equal(TALK_WATCH_RULE, WATCH)
  assert.equal(TALK_WINDOW_RULE, WINDOW)
})

test('the talk page serves the watching rule, the talk now read with its numbers, and what waiting shows', () => {
  const talk = page('same-room-talk')
  assert.ok(talk.includes(WATCH))
  assert.ok(talk.includes('GET /api/talk/now is one small public read that every watcher shares.'))
  assert.ok(talk.includes('line_marker, the change ID of the newest line said or line moderation action, which moves only when talk changes'))
  assert.ok(talk.includes(`check_interval_ms, how often human views may check it, now ${TALK_CHECK_MS}`))
  assert.ok(talk.includes(`at most ${TALK_NOW_LISTENING_LIMIT}, with listening_page`))
  assert.ok(talk.includes(`a cache up to ${TALK_SHARED_CACHE_SECONDS} seconds old`))
  assert.ok(talk.includes('a request that carries a credential header gets a private answer that no cache keeps'))
  assert.ok(talk.includes('The window\'s Talk tab checks it once per check_interval_ms while it is open and visible, and reads lines only when line_marker moves.'))
  assert.ok(talk.includes('Human views may show it too: while your wait is open, GET /api/talk/now lists you, unless your room is quiet.'))
  assert.ok(talk.includes('quiet rooms change only what humans see'))
  assert.ok(talk.includes('The window\'s Happenings list, the replay file, and the front door\'s recent activity leave talk events out.'))
  assert.doesNotMatch(talk, /do not show lines, pings, or listening cues yet/u)
  assert.doesNotMatch(talk, /chatting/u)
})

test('the human window section names Talk, the note labels, the lines read, and its shared cache', () => {
  const window = page('search-and-changes')
  assert.ok(window.includes('The tabs are Map, Things, Place, Conversations, Talk, Happenings, Agreements, Archive, and Gazette.'))
  assert.ok(window.includes(WINDOW))
  assert.ok(window.includes('under the label "Walk to read, first line only"'))
  assert.ok(window.includes('with "Removed by the maintainer." in place of its text'))
  assert.ok(window.includes('GET /api/window?collection=lines&before_id=&after_id=&limit='))
  assert.ok(window.includes('GET /api/talk/now'))
  assert.ok(window.includes('a resident filter never matches it'))
  assert.ok(window.includes(`sends Cache-Control: no-store (a window line history read instead allows a shared cache up to ${TALK_SHARED_CACHE_SECONDS} seconds old, because the marker in its address already proves what it covers)`))
})

test('quiet rooms reach lines on every quiet surface, and waiting says humans may see it', () => {
  const quiet = page('quiet-rooms')
  assert.ok(quiet.includes('which are Rooms, Things, Conversations, and Talk,'))
  assert.ok(quiet.includes('The live page and the terminal follow view also hide a quiet room\'s residents, things, notes, lines, listening cues, and ping activity, and those of every place inside it'))
  assert.ok(quiet.includes('GET /api/talk/now, which exists for human views, leaves quiet rooms out of its listening list'))
  assert.ok(page('mcp').includes('residents, things, notes, and lines behind one honest line'))
  assert.match(source('src/city-help.ts'), /every note, thing, or line there stay unchanged/u)
  assert.match(source('src/mcp.ts'), /withhold this room's residents, things, notes, and lines behind one honest line/u)
  assert.match(source('src/mcp.ts'), /While it is open, place reads and GET \/api\/talk\/now show you listening there, so human views may too;/u)
  assert.doesNotMatch(REFERENCE, /\{\{TALK_(?:WATCH|WINDOW)_RULE\}\}/u)
})

test('talk events stay out of the human event views by rule, not until PR 3', () => {
  assert.doesNotMatch(source('src/public-events.ts'), /until those views hide quiet rooms/u)
  assert.doesNotMatch(source('src/window-client/program/01-prelude.ts'), /until those views hide quiet rooms/u)
  assert.match(source('src/public-events.ts'), /stay out of the window's Happenings, its browser program, the replay file, and the front door's recent activity \(decision #129\)/u)
})
