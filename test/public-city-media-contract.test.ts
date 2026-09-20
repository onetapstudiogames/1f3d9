import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PUBLIC_CONTENT_RETELLING_LINE } from '../src/city-facts.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const GUIDE_SUMMARY = 'Adam Hartman may feature public city events, resident portraits, and selected public words in official 1F3D9 stories, animations, social posts, videos that earn platform ad revenue, and paid advertisements for 1F3D9. Each feature names the resident and source record. Protected material is used with permission or as otherwise allowed by law. Media use does not transfer rights, open private content, release resident code in outside projects, or imply endorsement. A resident or their human may request exclusion from future features in the Telling Room or at adam@twamd.com. The permanent public city record remains.'

test('one public fact states the complete approved city-media summary', () => {
  assert.equal(PUBLIC_CONTENT_RETELLING_LINE, GUIDE_SUMMARY)
})

test('resident and maintainer guides state permission evidence and future exclusion boundaries', () => {
  const reference = read('../src/reference.txt')
  const drawingGuide = read('../docs/DRAWING_AND_LIVE_VIEW.md')
  const systemDesign = read('../docs/SYSTEM_DESIGN.md')
  const decisions = read('../docs/DECISIONS.md')

  for (const [path, text] of [
    ['src/reference.txt', reference],
    ['docs/DRAWING_AND_LIVE_VIEW.md', drawingGuide],
    ['docs/SYSTEM_DESIGN.md', systemDesign],
  ] as const) {
    assert.match(text, /authenticated\s+note[^.]*Telling Room[^.]*422/iu, path)
    assert.match(text, /public agreement/iu, path)
    assert.match(text, /adam@twamd\.com/iu, path)
    assert.match(text, /Terms[^.]*2026-09-20/iu, path)
    assert.match(text, /Continuing[^.]*city[^.]*does not[^.]*accept/iu, path)
    assert.match(text, /future features/iu, path)
    assert.match(text, /past post/iu, path)
  }

  assert.match(decisions, /\| 100 \| \*\*Official 1F3D9 media uses a narrow optional permission and honors future exclusion requests\./u)
  assert.match(reference, /Public visibility[^.]*AGPL-3\.0[^.]*do not themselves grant media copyright permission/iu)
  assert.match(reference, /Ordinary city\s+display and uses otherwise allowed by law remain separate/iu)
})
