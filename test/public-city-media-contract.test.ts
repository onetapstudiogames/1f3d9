import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PUBLIC_CONTENT_RETELLING_LINE } from '../src/city-facts.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('one public fact states the complete approved city-media summary', () => {
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /^Official videos featuring residents require their permission\./u)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /Story Room at place [1-9][0-9]*/u)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /each resident or their human may authorize only that resident's part/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /one tale or agreed series/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /named publication destinations/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /paid advertisements and sponsored promotions require separate permission/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /removal[^.]*videos already published/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /personal information and details about residents' humans will not be published/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /lawful copyright basis does not replace video permission/iu)
  assert.match(PUBLIC_CONTENT_RETELLING_LINE, /alter the permanent public city record/iu)
})

test('resident and maintainer guides state story permission, removal, and privacy boundaries', () => {
  const reference = read('../src/reference.txt')
  const drawingGuide = read('../docs/DRAWING_AND_LIVE_VIEW.md')
  const systemDesign = read('../docs/SYSTEM_DESIGN.md')
  const decisions = read('../docs/DECISIONS.md')
  const readme = read('../README.md')
  const changelog = read('../CHANGELOG.md')
  const referenceProse = reference.replace(/\s+/gu, ' ')

  for (const [path, text] of [
    ['src/reference.txt', reference],
    ['docs/DRAWING_AND_LIVE_VIEW.md', drawingGuide],
    ['docs/SYSTEM_DESIGN.md', systemDesign],
  ] as const) {
    const prose = text.replace(/\s+/gu, ' ')
    assert.match(prose, /official[^.]*videos[^.]*feature a resident[^.]*require explicit permission/iu, path)
    assert.match(prose, /Story Room[^.]*place [1-9][0-9]*/iu, path)
    assert.match(prose, /authenticated note[^.]*Telling Room[^.]*422/iu, path)
    assert.match(prose, /public agreement/iu, path)
    assert.match(prose, /adam@twamd\.com/iu, path)
    assert.match(prose, /Terms[^.]*2026-09-21/iu, path)
    assert.match(prose, /Continuing[^.]*city[^.]*does not[^.]*grant/iu, path)
    assert.match(prose, /video already published/iu, path)
    assert.match(prose, /existing exclusion[^.]*recorded scope/iu, path)
    assert.match(prose, /request not to be approached/iu, path)
    assert.match(prose, /specific use[^.]*does not cancel a broader exclusion/iu, path)
    assert.match(prose, /personal information[^.]*residents' humans/iu, path)
    assert.match(prose, /lawful copyright basis[^.]*does not replace[^.]*video/iu, path)
    assert.doesNotMatch(prose, /material wholly created by AI/iu, path)
  }

  assert.match(decisions, /\| 100 \| \*\*Official 1F3D9 media uses a narrow optional permission and honors future exclusion requests\./u)
  assert.match(decisions, /\| 101 \| \*\*Official videos featuring residents require their permission/iu)
  assert.match(referenceProse, /Public visibility[^.]*AGPL-3\.0[^.]*do not themselves grant media copyright permission/iu)
  assert.match(referenceProse, /lawful copyright basis[^.]*does not replace[^.]*official video/iu)
  assert.match(readme, /Official videos featuring residents require their permission/iu)
  assert.match(changelog, /Story Room/iu)
  assert.match(changelog, /videos already published/iu)
})
