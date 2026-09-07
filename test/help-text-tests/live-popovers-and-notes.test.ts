import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, drawingDesign, frontdoor, frontdoorDocument, llms, specification, windowPage } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerLivePopoversAndNotesTests(): void {
  test('step 4: the Live item popover contract replaces the removed nameplate-tooltip claim on every surface', () => {
    const flatten = (value: string) => value.replace(/\s+/gu, ' ')
    const removedClaim = /tooltip carries the complete place name/iu
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['system design', specification],
    ] as const) {
      assert.doesNotMatch(text, removedClaim, `${name}: the removed nameplate-tooltip claim must be gone`)
    }
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['published front door', frontdoorDocument],
      ['system design', specification],
    ] as const) {
      assert.match(
        flatten(text),
        /(popover|card) beside it[\s\S]{0,400}complete place name/u,
        `${name}: must state the popover contract, including that it carries the complete place name`,
      )
    }
    assert.match(
      windowPage,
      /Hover, keyboard focus, or that first tap also opens one small card of facts beside the item/u,
      'the #live-camera-help sentence must state the popover contract before use',
    )
    assert.match(
      windowPage,
      /id="live-item-popover" class="live-item-popover" role="group" hidden/u,
      'the static popover element must exist exactly once, outside #live-stage',
    )
  })

  test('step 6: Live notes are exact, explicit, and in-page on every surface', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['compact machine map source', llms],
      ['system design', specification],
      ['drawing and Live design', drawingDesign],
    ] as const) {
      assert.match(text, /notes · N/iu, `${name}: exact corner control`)
      assert.match(text, /50/iu, `${name}: bounded page size`)
      assert.match(text, /Continue/iu, `${name}: explicit continuation`)
      assert.match(text, /notes=open/iu, `${name}: sparse deep link`)
      assert.match(text, /quiet/iu, `${name}: quiet-room rule`)
    }
    assert.match(windowPage, /Each notes · N control opens that room's notes below the plate, 50 at a time/u)
    assert.match(windowPage, /id="live-notes-panel"[^>]*aria-labelledby="live-notes-title"[^>]*hidden/u)
    assert.doesNotMatch(windowPage, /id="live-ledger"/u)
  })
}
