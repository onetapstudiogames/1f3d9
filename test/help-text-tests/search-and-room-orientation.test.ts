import assert from 'node:assert/strict'
import test from 'node:test'
import { decisions, frontdoor, llms, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerSearchAndRoomOrientationTests(): void {
  test('Wave 5 search and caller-held change-marker truths stay aligned', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
    ] as const) {
      assert.match(text, /\/api\/search/iu, `${name}: public search route`)
      assert.match(text, /\bwords?\b[^\n]{0,120}\bphrase\b|\bphrase\b[^\n]{0,120}\bwords?\b/iu, `${name}: search modes`)
      assert.match(text, /\bnotes?\b[^\n]{0,120}\bthings?\b|\bthings?\b[^\n]{0,120}\bnotes?\b/iu, `${name}: searched records`)
      assert.match(text, /date order|newest (?:first|to oldest)/iu, `${name}: stable order`)
      assert.match(text, /no relevance|not relevance-ranked/iu, `${name}: no relevance promise`)
      assert.match(text, /exact[^\n]{0,100}totals?/iu, `${name}: exact totals`)
      assert.match(text, /\/api\/changes/iu, `${name}: public change route`)
      assert.match(text, /caller-held|client-held|keep (?:the )?marker/iu, `${name}: caller marker`)
      assert.match(text, /\bsince\b/iu, `${name}: continuation marker`)
      assert.match(
        text,
        /no durable[^\n]{0,160}(?:reader identity|reading history)/iu,
        `${name}: no reading history`,
      )
    }
  })

  test('Wave 7 help keeps room purpose and owner-chosen front matter neutral and body-free', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
    ] as const) {
      assert.match(
        text,
        /owner[- ]written[^\n]{0,100}\bpurpose\b|\bpurpose\b[^\n]{0,100}owner[- ]written/iu,
        `${name}: owner-written purpose`,
      )
      assert.match(text, /\bpurpose\b[^\n]{0,140}\b280\b|\b280\b[^\n]{0,140}\bpurpose\b/iu, `${name}: purpose limit`)
      assert.match(
        text,
        /\bpurpose\b[\s\S]{0,220}(?:does not replace|separate from)[\s\S]{0,120}\bdescription\b|\bdescription\b[\s\S]{0,220}(?:preserved|remains|still)[\s\S]{0,120}\bpurpose\b/iu,
        `${name}: purpose does not erase the description`,
      )
      assert.match(
        text,
        /front[ -]matter[\s\S]{0,220}(?:exactly )?(?:two|2)[\s/]+(?:or[\s/]+)?(?:three|3)[\s\S]{0,160}order/iu,
        `${name}: two or three ordered choices`,
      )
      assert.match(
        text,
        /front[ -]matter[\s\S]{0,320}\bactive\b[\s\S]{0,180}(?:same (?:room|place)|in that (?:room|place))|(?:same (?:room|place)|in that (?:room|place))[\s\S]{0,180}\bactive\b[\s\S]{0,320}front[ -]matter/iu,
        `${name}: active things from the same room`,
      )
      assert.match(
        text,
        /front[ -]matter[\s\S]{0,320}(?:body[- ]free|(?:omits?|never (?:includes?|returns?))[\s\S]{0,100}\bbod(?:y|ies)\b)/iu,
        `${name}: body-free room read`,
      )
      assert.match(
        text,
        /unavailable[\s\S]{0,180}(?:disappear|omit|remove)[\s\S]{0,180}(?:no|not|never)[^\n]{0,100}(?:replace|substitute|auto-select)/iu,
        `${name}: unavailable choices disappear without replacement`,
      )
      assert.match(
        text,
        /front[ -]matter[\s\S]{0,320}(?:no|not|never|does not)[^\n]{0,100}\brank(?:s|ed|ing)?\b/iu,
        `${name}: no ranking`,
      )
      assert.match(
        text,
        /front[ -]matter[\s\S]{0,320}(?:no|not|never|does not)[^\n]{0,100}\bendorse(?:s|d|ment)?\b/iu,
        `${name}: no endorsement`,
      )
    }
  })

  test('Wave 2 public truth separates permanent maker from current owner', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
      ['decisions', decisions],
    ] as const) {
      assert.match(text, /(?:permanent|unchangeable|never changes?)[^\n]{0,120}\bmaker\b|\bmaker\b[^\n]{0,120}(?:permanent|unchangeable|never changes?)/iu, `${name}: permanent maker`)
      assert.match(text, /\bmade_by\b/iu, `${name}: public maker field`)
      assert.match(text, /\bcurrent_owner\b/iu, `${name}: public current-owner field`)
      assert.match(text, /(?:gift|transfer|sale)[^\n]{0,180}(?:maker|made_by)|(?:maker|made_by)[^\n]{0,180}(?:gift|transfer|sale)/iu, `${name}: transfers preserve maker`)
    }
  })
}
