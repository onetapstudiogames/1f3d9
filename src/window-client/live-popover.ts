import { windowDrawingStateLabel, windowDrawingSourceLabel } from './drawing.ts'
import type { WindowDrawing, WindowDrawingState, WindowDrawingSource } from './drawing.ts'

// Step 4 of the Live-view rebuild (docs/DRAWING_AND_LIVE_VIEW.md, decisions
// #60-#62/#75/#77): one reusable popover replaces the per-sprite title
// attributes step 2/3 left behind as the only carrier of a Live item's
// state, provenance, and last recorded action. These three functions are
// stringified via .toString() into the client IIFE (src/window-client/
// program/01-prelude.ts) exactly like every other windowLive* helper — see
// docs/DRAWING_AND_LIVE_VIEW.md §9 for the toString() invariant. They stay
// entirely self-contained (no closures over module-level state) except the
// two drawing-label calls below, which part 01 already injects into the
// same scope, mirroring windowLiveFloorAccessibleLabel's precedent in
// live-visibility.ts.

export type WindowLiveItemKind = 'resident' | 'thing' | 'place'

export type WindowLiveCachedDrawing = WindowDrawingSource & Readonly<{
  state: WindowDrawingState
  drawing: WindowDrawing | null
}>

export type WindowLiveItemFactsResident = Readonly<{
  asleep: boolean
  has_drawing: boolean
}>

export type WindowLiveItemFactsThing = Readonly<{
  made_by: string | null
  current_owner: string
  body: string
  truncated: boolean
  open_to_use: boolean
  kind: string | null
  has_drawing: boolean
}>

export type WindowLiveItemFactsPlace = Readonly<{
  // owner is undefined on a directory-only reference (no owner field at
  // all), null on the ownerless world root, or a handle otherwise — three
  // distinct states this function must not collapse into one another.
  owner?: string | null
  purpose?: string
  places?: number
  notes?: number
  quiet?: boolean
}>

export type WindowLiveItemFactsContext = Readonly<{
  locationName?: string | null
  locationQuiet?: boolean
  cachedDrawing?: WindowLiveCachedDrawing | null
  focused?: boolean
  exactThingTotal?: number | null
  floorDrawn?: boolean | null
}>

export type WindowLiveItemFactsResult = Readonly<{
  quiet: boolean
  facts: readonly string[]
}>

// Every fact below is already held in client state; nothing here triggers a
// read. A fact whose source is absent is omitted entirely — never guessed,
// never defaulted (AGENTS.md's honest-status rule; decision #59's "a
// missing or contradictory survey prints no exact badge").
//
// toString() invariant (docs/DRAWING_AND_LIVE_VIEW.md §9): this function is
// stringified whole into the client IIFE, so it must be entirely
// self-contained. It may call windowDrawingStateLabel/windowDrawingSourceLabel
// only because part 01 already injects both into that same scope; every
// other helper it needs (the drawing-fact two-tier rule, the body-byte-size
// rule) is inlined below as a local closure rather than a separate
// module-level function, which .toString() would not capture.
export function windowLiveItemFacts(
  kind: WindowLiveItemKind,
  item:
    | WindowLiveItemFactsResident
    | WindowLiveItemFactsThing
    | WindowLiveItemFactsPlace,
  context: WindowLiveItemFactsContext = {},
): WindowLiveItemFactsResult {
  const drawingFact = (
    hasDrawing: boolean,
    cachedDrawing: WindowLiveCachedDrawing | null | undefined,
  ): string => {
    if (cachedDrawing) {
      const stateLabel = windowDrawingStateLabel(cachedDrawing.state, cachedDrawing.drawing)
      const sourceLabel = windowDrawingSourceLabel(cachedDrawing)
      return sourceLabel ? stateLabel + ' · ' + sourceLabel : stateLabel
    }
    return hasDrawing ? 'has a drawing' : 'no drawing yet'
  }
  if (kind === 'resident') {
    const resident = item as WindowLiveItemFactsResident
    const facts: string[] = []
    if (context.locationQuiet !== true && context.locationName) {
      facts.push('in ' + context.locationName)
    }
    if (resident.asleep === true) {
      facts.push(
        'dimmed by a two-week public-activity display heuristic · not proof they are offline',
      )
    }
    facts.push(drawingFact(resident.has_drawing === true, context.cachedDrawing))
    if (context.focused === true) facts.push('focused')
    return Object.freeze({ quiet: false, facts: Object.freeze(facts) })
  }
  if (kind === 'thing') {
    const thing = item as WindowLiveItemFactsThing
    const facts: string[] = []
    if (thing.kind) facts.push(thing.kind)
    if (thing.made_by) facts.push('made by ' + thing.made_by)
    if (thing.current_owner) facts.push('kept by ' + thing.current_owner)
    let bodyFact: string | null = null
    if (thing.truncated === true) {
      bodyFact = 'body continues past the loaded head — open the record for the whole body'
    } else if (typeof thing.body === 'string') {
      try {
        bodyFact = 'body ' + String(new TextEncoder().encode(thing.body).byteLength) + ' bytes'
      } catch {
        bodyFact = null
      }
    }
    if (bodyFact) facts.push(bodyFact)
    if (thing.open_to_use === true) facts.push('open to use')
    facts.push(drawingFact(thing.has_drawing === true, context.cachedDrawing))
    return Object.freeze({ quiet: false, facts: Object.freeze(facts) })
  }
  const place = item as WindowLiveItemFactsPlace
  const facts: string[] = []
  if (place.owner === null) facts.push('nobody owns it')
  else if (typeof place.owner === 'string') facts.push('kept by ' + place.owner)
  if (typeof place.places === 'number' && typeof place.notes === 'number') {
    facts.push(String(place.places) + ' places · ' + String(place.notes) + ' notes')
  }
  facts.push(
    context.exactThingTotal !== null && context.exactThingTotal !== undefined
      ? String(context.exactThingTotal) + ' things'
      : 'exact thing count unavailable',
  )
  if (place.quiet === true) return Object.freeze({ quiet: true, facts: Object.freeze(facts) })
  if (place.purpose) facts.push(place.purpose)
  if (context.floorDrawn === true) facts.push('floor drawn')
  else if (context.floorDrawn === false) facts.push('floor undrawn')
  return Object.freeze({ quiet: false, facts: Object.freeze(facts) })
}

export type WindowLiveItemRecord = Readonly<{
  actor: string
  kind: string
  at: Date
  detail: Readonly<{
    action?: string
    status?: string
    from_place_id?: number | null
    to_place_id?: number | null
    place_id?: number | null
    note_id?: number | null
    thing_id?: number | null
    source_thing_id?: number | null
    mode?: string | null
  }>
}>

// Built only from records already held in memory (liveRecords() /
// visibleLiveRecords()), never from a fetch — it must NOT call
// loadLiveNote(noteId), which would start a note read from a hover. `records` must
// already be newest-first, matching every existing caller of liveRecords().
export function windowLiveItemLastAction(
  records: readonly WindowLiveItemRecord[],
  kind: WindowLiveItemKind,
  key: string | number,
  placeNameFor: (placeId: number | null) => string | null = () => null,
): string | null {
  if (kind === 'place') return null
  if (kind === 'resident') {
    const handle = String(key)
    for (const record of records) {
      if (record.actor !== handle) continue
      const detail = record.detail
      if (record.kind === 'action' && detail.status === 'applied' &&
          (detail.action === 'move' || detail.action === 'go_home') &&
          detail.from_place_id && detail.to_place_id) {
        const name = placeNameFor(detail.from_place_id)
        return name ? 'moved in from ' + name : 'moved in'
      }
      if (record.kind === 'note' && detail.note_id && detail.place_id) return 'spoke here'
      if ((record.kind === 'thing_created' || record.kind === 'thing_crafted') &&
          detail.place_id) {
        return 'made thing #' + String(detail.thing_id || '?')
      }
      if (record.kind === 'action' && detail.status === 'applied' &&
          detail.action === 'make' && detail.place_id) {
        return 'made thing #' + String(detail.thing_id || '?')
      }
      if (record.kind === 'action' && detail.status === 'applied' &&
          detail.action === 'use' && detail.source_thing_id && detail.place_id) {
        return 'used thing #' + String(detail.source_thing_id)
      }
    }
    return null
  }
  const thingId = Number(key)
  for (const record of records) {
    const detail = record.detail
    if (record.kind === 'action' && detail.status === 'applied' &&
        detail.action === 'use' && detail.source_thing_id === thingId && detail.place_id) {
      return 'used by ' + record.actor
    }
    if (((record.kind === 'thing_created' || record.kind === 'thing_crafted') ||
        (record.kind === 'action' && detail.status === 'applied' && detail.action === 'make')) &&
        detail.thing_id === thingId && detail.place_id) {
      return 'made by ' + record.actor + ' here'
    }
    if (record.kind === 'action' && detail.status === 'applied' &&
        (detail.action === 'move' || detail.action === 'go_home') &&
        detail.mode === 'carry' && detail.thing_id === thingId) {
      return 'carried in by ' + record.actor
    }
  }
  return null
}

export type WindowLiveRect = Readonly<{ left: number; top: number; right: number; bottom: number }>
export type WindowLiveSize = Readonly<{ width: number; height: number }>
export type WindowLiveItemPopoverSide = 'above' | 'below' | 'right' | 'left'
export type WindowLiveItemPopoverPlacement = Readonly<{
  left: number
  top: number
  side: WindowLiveItemPopoverSide
}>

// Returns coordinates already relative to viewportRect's own origin (ready
// to assign directly to style.left/style.top on an element absolutely
// positioned inside that viewport element), or null when nothing safe can
// be computed — a non-finite input, or a zero-area anchor/viewport/size,
// refuses to open rather than painting at NaN.
//
// PRIORITY RULE (round-1 review finding #1, reproduced live on the deployed
// preview: an off-camera anchor could return a placement rendered entirely
// outside #live-viewport): containment inside the viewport always wins over
// never touching the anchor. The two invariants both hold in the common
// case (a side that fits without clamping, handled first below) and they
// also both hold whenever the anchor sits entirely outside the viewport --
// the normal state for any resident/thing/place the camera has not framed
// -- because a placement clamped fully inside the viewport then cannot
// reach an anchor that is not in the viewport at all. They only truly
// conflict when the anchor itself crowds the viewport closely enough that
// no fully-contained position can avoid it (the popover is wider/taller
// than the viewport, or the anchor fills most of a small one); only then
// do we return the contained candidate with the least overlap instead of
// refusing to open. A caller never has to special-case an off-camera
// anchor: this function is always safe to call with the anchor's real
// (possibly far outside the viewport) rect.
export function windowLiveItemPopoverPlacement(
  anchorRect: WindowLiveRect,
  popoverSize: WindowLiveSize,
  viewportRect: WindowLiveRect,
  gap: number,
  margin: number,
): WindowLiveItemPopoverPlacement | null {
  const finite = [
    anchorRect.left, anchorRect.top, anchorRect.right, anchorRect.bottom,
    popoverSize.width, popoverSize.height,
    viewportRect.left, viewportRect.top, viewportRect.right, viewportRect.bottom,
    gap, margin,
  ].every(Number.isFinite)
  const anchorWidth = anchorRect.right - anchorRect.left
  const anchorHeight = anchorRect.bottom - anchorRect.top
  if (!finite || anchorWidth <= 0 || anchorHeight <= 0 ||
      popoverSize.width <= 0 || popoverSize.height <= 0) return null
  const anchorCenterX = anchorRect.left + anchorWidth / 2
  const anchorCenterY = anchorRect.top + anchorHeight / 2
  const candidates: ReadonlyArray<
    Readonly<{ side: WindowLiveItemPopoverSide; left: number; top: number }>
  > = Object.freeze([
    Object.freeze({
      side: 'above' as const,
      left: anchorCenterX - popoverSize.width / 2,
      top: anchorRect.top - gap - popoverSize.height,
    }),
    Object.freeze({
      side: 'below' as const,
      left: anchorCenterX - popoverSize.width / 2,
      top: anchorRect.bottom + gap,
    }),
    Object.freeze({
      side: 'right' as const,
      left: anchorRect.right + gap,
      top: anchorCenterY - popoverSize.height / 2,
    }),
    Object.freeze({
      side: 'left' as const,
      left: anchorRect.left - gap - popoverSize.width,
      top: anchorCenterY - popoverSize.height / 2,
    }),
  ])
  const insetLeft = viewportRect.left + margin
  const insetRight = viewportRect.right - margin
  const insetTop = viewportRect.top + margin
  const insetBottom = viewportRect.bottom - margin
  const fitsUnclamped = (candidate: { left: number; top: number }): boolean =>
    candidate.left >= insetLeft && candidate.left + popoverSize.width <= insetRight &&
    candidate.top >= insetTop && candidate.top + popoverSize.height <= insetBottom
  // Side preference: above, below, right, left -- first side where the
  // popover fits entirely inside the viewport with the gap and margin
  // honoured, with no clamping needed at all.
  const unclampedFit = candidates.find(fitsUnclamped)
  if (unclampedFit) {
    return Object.freeze({
      left: unclampedFit.left - viewportRect.left,
      top: unclampedFit.top - viewportRect.top,
      side: unclampedFit.side,
    })
  }
  // No side fits without clamping. Clamp EVERY candidate on BOTH axes to
  // the viewport inset -- this is the fix: the old code clamped only the
  // cross axis and left the primary axis (the one carrying the gap) alone,
  // reasoning that clamping it would push the popover onto the anchor --
  // true only when the anchor is itself near the viewport, and false (and
  // silently unchecked) for any anchor the camera has left off-screen.
  const clampBoth = (
    candidate: { side: WindowLiveItemPopoverSide; left: number; top: number },
  ): Readonly<{ side: WindowLiveItemPopoverSide; left: number; top: number }> => Object.freeze({
    side: candidate.side,
    left: Math.min(Math.max(candidate.left, insetLeft), insetRight - popoverSize.width),
    top: Math.min(Math.max(candidate.top, insetTop), insetBottom - popoverSize.height),
  })
  const intersectsAnchorAt = (left: number, top: number): boolean =>
    left < anchorRect.right + gap && left + popoverSize.width > anchorRect.left - gap &&
    top < anchorRect.bottom + gap && top + popoverSize.height > anchorRect.top - gap
  // Only used to rank candidates when every contained position must
  // overlap the anchor at least a little (the genuine-conflict case) --
  // the gap-expanded overlap area, smallest wins.
  const overlapArea = (left: number, top: number): number => {
    const overlapWidth = Math.min(left + popoverSize.width, anchorRect.right + gap) -
      Math.max(left, anchorRect.left - gap)
    const overlapHeight = Math.min(top + popoverSize.height, anchorRect.bottom + gap) -
      Math.max(top, anchorRect.top - gap)
    return Math.max(0, overlapWidth) * Math.max(0, overlapHeight)
  }
  const clamped = candidates.map(clampBoth)
  const clear = clamped.find(candidate => !intersectsAnchorAt(candidate.left, candidate.top))
  const chosen = clear || clamped.reduce((best, candidate) =>
    overlapArea(candidate.left, candidate.top) < overlapArea(best.left, best.top) ? candidate : best)
  return Object.freeze({
    left: chosen.left - viewportRect.left,
    top: chosen.top - viewportRect.top,
    side: chosen.side,
  })
}
