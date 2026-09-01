import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { FRONTDOOR, LLMS } from '../src/door.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

const frontDoor = read('../src/frontdoor.txt')
const publishedFrontDoor = read('../docs/published/FRONTDOOR.md')
const compactMap = read('../src/llms.txt')
const systemDesign = read('../docs/SYSTEM_DESIGN.md')
const architecture = read('../docs/ARCHITECTURE.md')
const liveProbe = read('../.github/workflows/live-probe.yml')

const publicContracts = [
  ['front door source', frontDoor],
  ['compact map source', compactMap],
  ['published front door', publishedFrontDoor],
  ['generated front door', FRONTDOOR],
  ['generated compact map', LLMS],
] as const

test('public contracts name the complete Gazette reader, its card, and window destinations', () => {
  for (const [name, text] of publicContracts) {
    const compact = text.replace(/\s+/gu, ' ')
    assert.match(compact, /GET \/gazette\/:issue_number/iu, `${name}: anonymous issue reader`)
    assert.match(
      compact,
      /(?:every|all).{0,100}entr(?:y|ies).{0,140}(?:ordinal|submission) order/iu,
      `${name}: complete ordered issue`,
    )
    assert.match(
      compact,
      /moderation.{0,160}(?:hide|restore).{0,160}(?:membership|entry)/iu,
      `${name}: moderation preserves issue membership`,
    )
    assert.match(
      compact,
      /Read.{0,120}Share.{0,180}\/gazette\/<issue_number>|Share.{0,120}Read.{0,180}\/gazette\/<issue_number>/iu,
      `${name}: window actions use the reader`,
    )
    assert.match(
      compact,
      /top.{0,180}Share issue <issue_number>.{0,180}\/gazette\/<issue_number>/iu,
      `${name}: top Share action uses the canonical issue`,
    )
    assert.match(
      compact,
      /top.{0,220}Open city window.{0,180}\/window\/gazette\?issue=<issue_number>/iu,
      `${name}: top Window action returns to the selected issue`,
    )
    assert.match(
      compact,
      /GET \/gazette\/:issue_number\/card\.png.{0,220}issue number.{0,120}date.{0,120}entry count.{0,120}resident count/iu,
      `${name}: body-free issue card facts`,
    )
  }
})

test('design docs state rendering and index-policy contracts without making the policy decision', () => {
  for (const [name, text] of [
    ['system design', systemDesign],
    ['architecture', architecture],
  ] as const) {
    assert.match(text, /\/gazette\/:issue_number/iu, `${name}: reader route`)
    assert.match(text, /\/gazette\/:issue_number\/card\.png/iu, `${name}: card route`)
    assert.match(
      text,
      /top[\s\S]{0,220}Share issue <issue_number>[\s\S]{0,220}Open city window/iu,
      `${name}: top issue actions`,
    )
    assert.match(
      text,
      /noindex, nofollow, noarchive[^\n]{0,240}(?:one|single)[^\n]{0,120}(?:switch|policy)/iu,
      `${name}: one current robots-policy switch`,
    )
  }

  const compactDesign = systemDesign.replace(/\s+/gu, ' ')
  assert.match(compactDesign, /full-screen.{0,120}without window chrome/iu)
  assert.match(systemDesign, /white-space:\s*pre-wrap/iu)
  assert.match(compactDesign, /binary.{0,200}(?:decoded|prose).{0,200}(?:collapsed|disclosure).{0,120}(?:exact|as filed)/iu)
  assert.match(
    compactDesign,
    /(?:kana.{0,120}hangul|hangul.{0,120}kana).{0,200}(?:before|precedence).{0,120}Han/iu,
  )
  assert.match(compactDesign, /equal (?:visual )?weight.{0,160}(?:featured|pull quote|ranking)/iu)
})

test('the production probe reads issue 1 and verifies its PNG card without writing', () => {
  const step = liveProbe.match(
    /- name: the Gazette issue 1 reader and card answer[\s\S]*?(?=\n\s{6}- name:|$)/u,
  )?.[0] ?? ''

  assert.notEqual(step, '', 'missing Gazette reader production probe')
  assert.match(step, /curl[^\n]*https:\/\/1f3d9\.com\/gazette\/1(?:\)|\s|$)/u)
  assert.match(step, /curl[\s\S]{0,160}https:\/\/1f3d9\.com\/gazette\/1\/card\.png/u)
  assert.match(step, /26 entries/u)
  assert.match(step, /19 residents/u)
  assert.match(step, /content-type:\s*image\/png/iu)
  assert.match(step, /89504e470d0a1a0a/iu)
  assert.match(step, /Gazette card robots header wrong/u)
  assert.match(step, /data-gazette-share/u)
  assert.match(step, /data-share-path="\/gazette\/1"/u)
  assert.match(step, /href="\/window\/gazette\?issue=1"/u)
  assert.doesNotMatch(step, /(?:-X|--request)\s+(?:POST|PUT|PATCH|DELETE)/iu)
})
