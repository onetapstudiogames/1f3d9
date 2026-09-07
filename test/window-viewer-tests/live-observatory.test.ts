import test from 'node:test'
import assert from 'node:assert/strict'
import * as windowClientModule from '../../src/window-client.ts'
import { WINDOW_JS } from '../../src/window-client.ts'
import { WINDOW_HTML } from '../../src/window-page.ts'
import { WINDOW_CSS } from '../../src/window-style.ts'

export function registerWindowLiveObservatoryTests(): void {
  test('the live plate is one linkable observatory instrument, never a game viewport', () => {
    assert.match(WINDOW_HTML, /id="live-tab"[\s\S]*?data-view="live"/u)
    assert.match(WINDOW_HTML, /id="live-panel"[\s\S]*?aria-labelledby="live-tab"/u)
    for (const id of [
      'live-clock', 'live-breadcrumbs', 'live-plates', 'live-notes-panel',
      'live-notes-title', 'live-notes-status', 'live-notes-list', 'live-notes-page',
      'live-roster', 'live-resident-page', 'live-viewport', 'live-stage',
      'live-zoom-in', 'live-zoom-out', 'live-center', 'live-fullscreen',
      'live-proof', 'live-pause', 'live-focus-status',
    ]) assert.match(WINDOW_HTML, new RegExp(`id="${id}"`))
    assert.match(WINDOW_HTML, /id="live-alpha" class="alpha-chip" hidden>ALPHA<\/span>/u)
    assert.match(WINDOW_HTML, /id="live-alpha-note" class="alpha-note" hidden>/u)
    assert.equal((WINDOW_HTML.match(/>ALPHA</gu) ?? []).length, 1)
    assert.doesNotMatch(`${WINDOW_HTML}\n${WINDOW_JS}`, /live-beta|beta-chip|beta-note|>BETA</u)
    assert.match(
      WINDOW_HTML,
      /This view is new\. It draws the same public record as every other tab — if it disagrees with them, they are right\./u,
    )
    assert.match(WINDOW_JS, /VIEWS[\s\S]{0,120}'live'/u)
    assert.match(WINDOW_JS, /state\.view === 'live'/u)

    const shipped = `${WINDOW_HTML}\n${WINDOW_JS}`
    assert.doesNotMatch(shipped, /Fit live|live-fit|fitLivePlate|windowLiveFitScale/u)
    assert.doesNotMatch(shipped, /type="range"|zoom-slider/iu)
    assert.match(WINDOW_JS, /addEventListener\('wheel'/u)
    assert.match(WINDOW_JS, /addEventListener\('pointerdown'/u)
    assert.match(WINDOW_JS, /addEventListener\('pointermove'/u)
    assert.match(WINDOW_JS, /LIVE_FOCUS_STORAGE_KEY/u)
    assert.match(WINDOW_JS, /localStorage\.getItem\(LIVE_FOCUS_STORAGE_KEY\)/u)
    assert.match(WINDOW_JS, /localStorage\.setItem\(LIVE_FOCUS_STORAGE_KEY/u)
    assert.match(WINDOW_JS, /data-live-focus-resident/u)
    assert.match(WINDOW_JS, /live-overflow-absorbing/u)
    assert.match(WINDOW_JS, /LIVE_FOLLOW_TRAIL_LIFETIME_MS\s*=\s*4_?500/u)
    assert.match(WINDOW_JS, /LIVE_FOOTSTEP_LIFETIME_MS\s*=\s*2_?000/u)
    assert.match(
      WINDOW_JS,
      /function renderLiveAging\(\)[\s\S]*?windowLivePruneTrailStarts\(\s*state\.live\.trailStarts/u,
    )
    assert.match(WINDOW_JS, /data-live-overflow-count/u)
    assert.match(WINDOW_JS, /function liveSurveyIsComplete/u)
    assert.match(WINDOW_JS, /Exact \+N thing counts come from the fixed survey/u)
    assert.match(WINDOW_JS, /!thingsPage\.loading\s*&&\s*!thingsPage\.initialized/u)
    assert.doesNotMatch(WINDOW_JS, /Reading every public thing in this plate/u)
    assert.match(WINDOW_CSS, /\.live-viewport\s*\{[\s\S]*?touch-action:\s*none/u)
    assert.match(WINDOW_CSS, /\.live-stage\s*\{[\s\S]*?transform-origin:\s*0 0/u)
    assert.match(WINDOW_JS, /live-replay-portrait/u)
    assert.match(WINDOW_JS, /live-speech-bubble/u)
    assert.match(WINDOW_JS, /prefers-reduced-motion: reduce/u)
    assert.match(WINDOW_CSS, /\.live-replay-portrait[\s\S]*?live-recorded-glide/u)
    assert.match(
      WINDOW_CSS,
      /\.live-speech-bubble\s*\{[\s\S]*?background:\s*var\(--paper-light\)[\s\S]*?border:\s*2px solid var\(--line\)[\s\S]*?border-radius:\s*0/u,
    )
    assert.doesNotMatch(WINDOW_CSS, /live-speech-arrive/u)
    assert.match(WINDOW_JS, /footsteps = detailed movement[^\n]*followed resident keeps a fading route/u)
    assert.match(WINDOW_JS, /pulse on a thing[^\n]*recorded use/u)
    assert.match(WINDOW_JS, /record\.detail\.status !== 'applied'/u)
    assert.match(WINDOW_JS, /safeExactText\(payload\?\.note\?\.body/u)
    assert.match(WINDOW_JS, /function liveDisplayedThings/u)
    assert.match(WINDOW_JS, /if \(!node\.dataset\.focusKey\) node\.dataset\.focusKey/u)
    assert.doesNotMatch(WINDOW_JS, /state\.resident && actor !== state\.resident/u)
    assert.match(WINDOW_JS, /type !== 'move' && state\.resident && record\.actor !== state\.resident/u)
    assert.doesNotMatch(WINDOW_CSS, /position:\s*fixed[^}]*live-|100vw[^}]*live-/iu)
  })

  test('the live plate states its honest timing and drawing rules in shipped code', () => {
    assert.match(WINDOW_JS, /\b(?:25000|25e3)\b/u)
    assert.match(WINDOW_JS, /\b(?:120000|12e4)\b/u)
    assert.match(WINDOW_JS, /\b(?:240000|24e4)\b/u)
    for (const value of ['60000', '300000', '1800000', '600000', '600']) {
      assert.match(WINDOW_JS, new RegExp(`\\b${value}\\b`))
    }
    assert.match(WINDOW_JS, /\/api\/events/u)
    assert.match(WINDOW_JS, /after_change_marker/u)
    assert.match(WINDOW_JS, /searchParams\.set\('within_seconds', String\(LIVE_MOVE_LIFETIME_MS \/ 1000\)\)/u)
    assert.match(WINDOW_JS, /\/api\/changes/u)
    assert.match(WINDOW_JS, /\/api\/drawing\//u)
    assert.match(WINDOW_JS, /\/api\/note\//u)
    assert.match(WINDOW_CSS, /\.live-trail/u)
    assert.match(WINDOW_CSS, /\.live-footnote-mark/u)
    assert.match(WINDOW_CSS, /\.drawing-undrawn/u)
    assert.doesNotMatch(WINDOW_JS, /cacheRevision/u)
    assert.match(WINDOW_JS, /function invalidateLiveCaches/u)
    assert.match(WINDOW_JS, /resident_edited[\s\S]{0,180}resident:/u)
    // Step 3: a place's Live floor is the same cacheable thumb.png the
    // resident/thing sprites already read, repeated by the compositor, never
    // a per-plot JSON drawing fetch with its own loading-state guard.
    assert.match(WINDOW_JS, /thumb\.png/u)
    assert.match(WINDOW_JS, /backgroundRepeat\s*=\s*'repeat'/u)
    assert.match(WINDOW_JS, /cache:\s*force\s*\?\s*'reload'\s*:\s*'default'/u)
    assert.match(WINDOW_JS, /loadDirectory\(true, false\), 31_000/u)
    assert.match(
      WINDOW_JS,
      /function scheduleLiveClock\(\)[\s\S]*?renderLiveAging\(\)[\s\S]*?setTimeout\(scheduleLiveClock, 1000\)/u,
    )
    assert.match(WINDOW_CSS, /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.live-pulse/u)
    assert.match(
      WINDOW_CSS,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.live-replay-portrait[\s\S]*?animation:\s*none/u,
    )
    assert.match(WINDOW_CSS, /@media \(forced-colors: active\)[\s\S]*?\.live-stage-shell/u)
    assert.match(
      WINDOW_CSS,
      /@media \(max-width: 54rem\)[\s\S]*?\.live-layout\s*\{[^}]*display:\s*block[^}]*\}[\s\S]*?\.live-viewport/u,
    )
  })

  test('Live sprites carry the drawing alone, with a neutral marker and a shadowed name in place of chips', () => {
    // Step 2 ruling: no state chip, no provenance chip, no owner line, no
    // hatched square, no card backing behind a sprite or its name.
    assert.doesNotMatch(WINDOW_JS, /function appendLiveDrawingLabels/u)
    assert.doesNotMatch(WINDOW_JS, /drawing-live-label/u)
    assert.doesNotMatch(WINDOW_JS, /drawing-undrawn-label/u)
    assert.doesNotMatch(WINDOW_JS, /live-plot-owner/u)
    assert.doesNotMatch(WINDOW_CSS, /\.drawing-undrawn-label/u)
    assert.doesNotMatch(WINDOW_CSS, /\.drawing-blank/u)
    assert.doesNotMatch(WINDOW_CSS, /\.live-plot-owner/u)

    // Every resident/thing sprite on the ground is the drawing alone, or a
    // small neutral marker when there is none -- never nothing, never a chip.
    assert.match(WINDOW_JS, /function liveSpriteNode\(type, id, label, hasDrawing\)/u)
    assert.match(WINDOW_JS, /live-neutral-marker/u)
    assert.match(WINDOW_JS, /liveSpriteNode\(\s*'resident'/u)
    assert.match(WINDOW_JS, /liveSpriteNode\(\s*'thing'/u)

    // Genuinely transparent pixels show the floor through: no CSS paints an
    // opaque backing behind a sprite or the ground it fetches from.
    assert.match(
      WINDOW_CSS,
      /\.live-portrait\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;/u,
    )
    assert.match(
      WINDOW_CSS,
      /\.live-thing-specimen\s*\{[^}]*background:\s*transparent;[^}]*border:\s*0;/u,
    )
    assert.match(
      WINDOW_CSS,
      /\.live-plot \.live-thing-specimen\s*\{[^}]*background:\s*transparent;/u,
    )
    assert.doesNotMatch(
      WINDOW_CSS,
      /\.live-resident-tag\s*\{[^}]*background:\s*var\(--paper-light\)/u,
    )

    // Names sit under the sprite with one shared, tunable text shadow --
    // never a box -- so the owner can judge and adjust legibility from one
    // CSS variable on the preview.
    assert.match(WINDOW_CSS, /--live-name-shadow-strength:\s*[\d.]+px;/u)
    assert.match(
      WINDOW_CSS,
      /\.live-item-name\s*\{[^}]*text-shadow:[^}]*var\(--live-name-shadow-strength\)/u,
    )
    assert.match(WINDOW_JS, /'live-resident-tag live-item-name'/u)
    assert.match(WINDOW_JS, /'live-thing-name live-item-name'/u)

    // State and provenance stay a public fact -- reachable via the unchanged
    // drawing-detail click-through, the drawing record, and the readback --
    // they are only no longer painted as a visible chip on the plate. (Step
    // 3 moved place-floor tiling off the per-plot JSON read that used to back
    // a state-carrying title, so that title moved with it; state and
    // provenance were never painted on the plate to begin with.)
    assert.match(WINDOW_JS, /function openDrawingDetailButton/u)
  })

  test('drawing presentation and details expose the complete authored contract without eager history', () => {
    for (const label of ['Undrawn', 'Refused', 'In progress', 'Blank', 'Complete']) {
      assert.match(WINDOW_JS, new RegExp(label.replace(' ', '\\s+'), 'u'))
    }
    for (const field of [
      'presentation_state', 'description', 'rows', 'source', 'kind_id',
      'kind_name', 'revision', 'variant_name',
    ]) {
      assert.match(WINDOW_JS, new RegExp(`\\b${field}\\b`, 'u'))
    }
    assert.match(WINDOW_JS, /Own drawing/u)
    assert.match(WINDOW_JS, /Kind [^'"\n]*revision/u)
    assert.match(WINDOW_CSS, /\.drawing-state-label/u)
    assert.match(WINDOW_CSS, /\.drawing-provenance/u)
    assert.match(WINDOW_CSS, /\.drawing-owner-description/u)
    assert.match(WINDOW_CSS, /\.drawing-canonical-rows/u)

    assert.match(WINDOW_JS, /Show drawing history/u)
    assert.match(WINDOW_JS, /Retry drawing history/u)
    assert.match(WINDOW_JS, /Load earlier drawing revisions/u)
    assert.match(WINDOW_JS, /\/api\/drawing\/'?\s*\+[^\n]*\/history/u)
    assert.match(WINDOW_JS, /searchParams\.set\('limit'/u)
    assert.match(WINDOW_JS, /searchParams\.set\('before'/u)

    // Step 3 removed the per-plot JSON drawing read entirely: a place's Live
    // floor now reads the same cacheable thumb.png the resident/thing sprites
    // already use, never the JSON route or its history, and the deliberate
    // detail page keeps its own separate, still-history-free read.
    const liveFloorRead = /function liveTiledDrawing[\s\S]*?\n  function liveThingFilters/u
      .exec(WINDOW_JS)?.[0] ?? ''
    const ordinaryDetailRead = /async function ensureDetail[\s\S]*?\n  function renderDetail/u
      .exec(WINDOW_JS)?.[0] ?? ''
    assert.ok(liveFloorRead)
    assert.ok(ordinaryDetailRead)
    assert.doesNotMatch(liveFloorRead, /\/history/u)
    assert.doesNotMatch(liveFloorRead, /await fetch\(/u)
    assert.match(liveFloorRead, /portraitUrl\('place', place\.id\)/u)
    assert.doesNotMatch(ordinaryDetailRead, /\/history/u)
    assert.doesNotMatch(WINDOW_HTML, /drawing history|canonical rows|palette indices/iu)
  })

  test('the share link round-trips every reproducible window question', () => {
    for (const parameter of [
      'view', 'place', 'resident', 'context', 'q', 'mode', 'type', 'find', 'sleepers', 'issue',
    ]) {
      assert.match(WINDOW_JS, new RegExp(`params\\.(?:get|set)\\('${parameter}'`))
    }
    assert.match(WINDOW_JS, /nodes\.archiveQuery\.value = state\.archive\.query/)
    assert.match(WINDOW_JS, /nodes\.archiveMode\.value = state\.archive\.mode/)
    assert.match(WINDOW_JS, /nodes\.archiveType\.value = state\.archive\.type/)
    assert.match(WINDOW_JS, /state\.view === 'archive'[\s\S]{0,240}loadArchive\(true, true\)/)
    assert.match(WINDOW_JS, /loadArchive\(true, true\)/)
    assert.match(WINDOW_JS, /directorySearch:\s*state\.directorySearch/)
    assert.doesNotMatch(
      WINDOW_JS,
      /params\.get\('sleepers'\)[\s\S]{0,160}\.slice\(/,
      'sleeper expansions must not be silently capped while restoring a share link',
    )
  })

  test('shared sleeper expansions reject malformed or oversized state without a silent row cap', () => {
    const exports = windowClientModule as unknown as Record<string, unknown>
    assert.equal(typeof exports.parseWindowSleeperPlaceIds, 'function')
    const parse = exports.parseWindowSleeperPlaceIds as (value: string | null) => number[]
    const currentPlaceIds = Array.from({ length: 405 }, (_, index) => index + 1)

    assert.deepEqual(parse(currentPlaceIds.join(',')), currentPlaceIds)
    assert.deepEqual(parse('1,2,2,3'), [1, 2, 3])
    assert.deepEqual(parse('1,,3'), [])
    assert.deepEqual(parse('1,not-an-id,3'), [])
    assert.deepEqual(parse('9'.repeat(8_193)), [])
  })
}
