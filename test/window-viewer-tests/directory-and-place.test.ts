import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowModule from '../../src/window.ts'
import * as windowClientModule from '../../src/window-client.ts'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'

export function registerWindowDirectoryAndPlaceTests(): void {
  test('directory search keeps a bounded menu and reports its exact total', () => {
    const exports = windowClientModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.pageWindowDirectorySearch, 'function')
    const pageSearch = exports.pageWindowDirectorySearch as (
      places: Array<{ id: number, name: string, path: string }>,
      residents: Array<{ id: number, handle: string }>,
      query: string,
      limit?: number,
    ) => {
      results: Array<{ kind: string }>
      total: number
      placeCount: number
      residentCount: number
      hasMore: boolean
    }
    const places = Array.from({ length: 21 }, (_, index) => ({
      id: index + 1,
      name: `room-${index + 1}`,
      path: `world / room-${index + 1}`,
    }))

    const atBound = pageSearch(places.slice(0, 20), [], 'room', 20)
    assert.deepEqual({
      shown: atBound.results.length,
      total: atBound.total,
      places: atBound.placeCount,
      residents: atBound.residentCount,
      hasMore: atBound.hasMore,
    }, { shown: 20, total: 20, places: 20, residents: 0, hasMore: false })

    const pastBound = pageSearch(places, [], 'room', 20)
    assert.deepEqual({
      shown: pastBound.results.length,
      total: pastBound.total,
      places: pastBound.placeCount,
      residents: pastBound.residentCount,
      hasMore: pastBound.hasMore,
    }, { shown: 20, total: 21, places: 21, residents: 0, hasMore: true })
    assert.match(WINDOW_JS, /Showing the first /)
    assert.match(WINDOW_JS, /currently loaded fallback/)
    assert.match(WINDOW_JS, /more citywide matches may exist/)
  })

  test('thing cards and Archive results name maker and current owner separately', () => {
    assert.match(WINDOW_JS, /safeHandle\(rawResult\.made_by\)/)
    assert.match(WINDOW_JS, /safeHandle\(rawResult\.current_owner \?\? rawResult\.owner\)/)
    assert.match(WINDOW_JS, /made by /)
    assert.match(WINDOW_JS, /currently owned by /)
  })

  test('the THINGS tab is bounded, body-free, and reuses lazy transparent portraits', () => {
    assert.match(WINDOW_HTML, /id="things-tab"[^>]*data-view="things"/u)
    assert.match(WINDOW_HTML, /id="things-panel"[^>]*aria-labelledby="things-tab"/u)
    assert.match(WINDOW_HTML, /id="things-summary"[^>]*aria-live="polite"/u)
    assert.match(WINDOW_HTML, /id="things-list"/u)
    assert.match(WINDOW_HTML, /id="things-page"/u)
    assert.match(WINDOW_JS, /presentation', 'headings'/u)
    assert.match(WINDOW_JS, /liveSurveyThingTotal/u)
    assert.match(WINDOW_JS, /Continue(?: loading)? things/u)
    assert.match(WINDOW_JS, /body_text_bytes/u)
    assert.match(WINDOW_JS, /portraitNode\('thing', thing\.id, thing\.name/u)
    assert.match(WINDOW_JS, /archiveResultCard[\s\S]*?portraitNode\('thing'/u)
    assert.match(WINDOW_JS, /renderActivity[\s\S]*?portraitNode\('thing'/u)
    assert.match(WINDOW_JS, /\|thing:' \+ String\(activityThingId\(event\)/u)
    assert.match(
      WINDOW_JS,
      /detailTitle\.replaceChildren\([\s\S]*?portraitNode\('thing',[\s\S]{0,120}entry\?\.record\?\.has_drawing === true/u,
    )
    assert.doesNotMatch(WINDOW_JS, /noteCard[\s\S]{0,1200}portraitNode\('thing'/u)
    assert.match(WINDOW_CSS, /\.entity-portrait\s*\{[^}]*background:\s*transparent[^}]*border:\s*0/u)
  })

  test('bounded map and window rooms carry a short purpose and ordered body-free front matter', () => {
    const purpose = 'p'.repeat(280)
    const frontMatter = [41, 42, 43, 44].map((id, index) => ({
      id,
      type: 'thing',
      name: `room heading ${index + 1}`,
      body: `body ${index + 1} must stay behind its direct link`,
      snippet: `snippet ${index + 1} must not cross the glass`,
      body_text_bytes: 20 + index,
      maker_id: 6,
      made_by: 'old-maker',
      owner_id: 7,
      current_owner_id: 7,
      current_owner: 'tiny-lantern',
      owner: 'tiny-lantern',
    }))
    const places = windowModule.publicPlaceTree([{
      id: 80,
      parent_id: null,
      name: 'reading-room',
      owner: 'tiny-lantern',
      description: 'A full place description stays behind the focused public place read.',
      purpose,
      front_matter: frontMatter,
      places: 0,
      things: 4,
      notes: 0,
    }, {
      id: 81,
      parent_id: null,
      name: 'quiet-room',
      owner: 'tiny-lantern',
      places: 0,
      things: 0,
      notes: 0,
    }, {
      id: 82,
      parent_id: null,
      name: 'overlong-purpose-room',
      owner: 'tiny-lantern',
      purpose: 'x'.repeat(281),
      front_matter: [],
      places: 0,
      things: 0,
      notes: 0,
    }, {
      id: 83,
      parent_id: null,
      name: 'front-matter-shrank-room',
      owner: 'tiny-lantern',
      purpose: '',
      front_matter: [frontMatter[2]],
      places: 0,
      things: 1,
      notes: 0,
    }]) as unknown as Array<Record<string, unknown>>

    const readingRoom = places.find(place => place.id === 80)
    assert.equal(readingRoom?.purpose, purpose)
    assert.ok(readingRoom && !Object.hasOwn(readingRoom, 'description'))
    assert.ok(Array.isArray(readingRoom?.front_matter))
    const headings = readingRoom?.front_matter as Array<Record<string, unknown>>
    assert.equal(headings.length, 3)
    assert.deepEqual(
      headings.map(heading => ({
        id: heading.id,
        name: heading.name,
        body_text_bytes: heading.body_text_bytes,
        made_by: heading.made_by,
        current_owner: heading.current_owner,
      })),
      frontMatter.slice(0, 3).map(heading => ({
        id: heading.id,
        name: heading.name,
        body_text_bytes: heading.body_text_bytes,
        made_by: heading.made_by,
        current_owner: heading.current_owner,
      })),
    )
    assert.ok(headings.every(heading => !('body' in heading) && !('snippet' in heading)))
    assert.equal(places.find(place => place.id === 81)?.purpose, '')
    assert.deepEqual(places.find(place => place.id === 81)?.front_matter, [])
    const boundedPurpose = places.find(place => place.id === 82)?.purpose
    assert.equal(typeof boundedPurpose, 'string')
    assert.ok((boundedPurpose as string).length <= 280)
    const shrunkFrontMatter = places.find(place => place.id === 83)?.front_matter
    assert.ok(Array.isArray(shrunkFrontMatter))
    assert.deepEqual(
      (shrunkFrontMatter as Array<Record<string, unknown>>).map(heading => heading.id),
      [43],
    )
  })

  test('the selected-place panel identifies owner choices and links front matter without fetching bodies', () => {
    assert.match(WINDOW_JS, /owner-written purpose/iu)
    assert.match(WINDOW_JS, /owner-chosen front matter/iu)
    assert.match(WINDOW_JS, /rawPlace\.purpose/)
    assert.match(WINDOW_JS, /rawPlace\.front_matter/)
    assert.match(WINDOW_JS, /place\.purpose/)
    assert.match(WINDOW_JS, /place\.front_matter/)
    assert.equal(WINDOW_JS.match(/place\.front_matter\.map\(/gu)?.length, 1)
    const mapRenderer = WINDOW_JS.slice(
      WINDOW_JS.indexOf('function placeList('),
      WINDOW_JS.indexOf('function mapRoots('),
    )
    assert.doesNotMatch(mapRenderer, /front_matter|quietRoomNotice/u)
    assert.match(mapRenderer, /occupantLine\(/u)
    assert.match(WINDOW_JS, /link\.href\s*=\s*['"]\/window\/['"]\s*\+\s*kind\s*\+\s*['"]\/['"]\s*\+\s*String\(id\)/)
    assert.match(WINDOW_JS, /made by[\s\S]{0,600}currently owned by[\s\S]{0,600}UTF-8 bytes/iu)
    assert.doesNotMatch(WINDOW_JS, /front_matter\.(?:sort|toSorted|reverse|splice)\(/)
    assert.doesNotMatch(WINDOW_JS, /new URL\(\s*['"]\/api\/thing\//u)
    assert.doesNotMatch(WINDOW_JS, /fetch\s*\([^)]*\/api\/thing\//u)
  })

  test('a followed view names which conversation question its fetched rows answer', () => {
    assert.match(WINDOW_HTML, /Conversation question/)
    assert.match(WINDOW_JS, /What ' \+ state\.resident \+ ' said/)
    assert.match(WINDOW_JS, /What was said around ' \+ state\.resident/)
    assert.match(WINDOW_JS, /followedRows/)
  })
}
