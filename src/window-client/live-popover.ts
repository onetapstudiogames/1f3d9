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
// liveLedgerText, which lazily fires loadLiveNote(noteId) for its note
// phrasing and would turn a hover into a network read. `records` must
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
  const fits = (candidate: { left: number; top: number }): boolean =>
    candidate.left >= insetLeft && candidate.left + popoverSize.width <= insetRight &&
    candidate.top >= insetTop && candidate.top + popoverSize.height <= insetBottom
  const room = (candidate: { left: number; top: number }): number => Math.min(
    candidate.left - insetLeft,
    insetRight - (candidate.left + popoverSize.width),
    candidate.top - insetTop,
    insetBottom - (candidate.top + popoverSize.height),
  )
  const fitting = candidates.find(fits)
  // When no side fits fully, clamp only the CROSS axis of the side with
  // the most room -- for above/below that is left, for left/right that is
  // top. The PRIMARY axis (the one carrying the gap that keeps the
  // popover off the anchor) is never clamped inward, because doing so is
  // exactly what would push a clamped 'left' or 'above' placement back
  // onto the anchor it was chosen to avoid.
  const chosen = fitting || candidates.reduce(
    (best, candidate) => room(candidate) > room(best) ? candidate : best,
  )
  const clampedLeft = fitting || chosen.side === 'left' || chosen.side === 'right'
    ? chosen.left
    : Math.min(Math.max(chosen.left, insetLeft), insetRight - popoverSize.width)
  const clampedTop = fitting || chosen.side === 'above' || chosen.side === 'below'
    ? chosen.top
    : Math.min(Math.max(chosen.top, insetTop), insetBottom - popoverSize.height)
  const intersectsAnchor =
    clampedLeft < anchorRect.right + gap && clampedLeft + popoverSize.width > anchorRect.left - gap &&
    clampedTop < anchorRect.bottom + gap && clampedTop + popoverSize.height > anchorRect.top - gap
  if (intersectsAnchor) return null
  return Object.freeze({
    left: clampedLeft - viewportRect.left,
    top: clampedTop - viewportRect.top,
    side: chosen.side,
  })
}
