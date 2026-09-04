import { windowDrawingStateLabel, windowDrawingSourceLabel } from './drawing.ts'
import type { WindowDrawing, WindowDrawingState, WindowDrawingSource } from './drawing.ts'

export function windowLiveTouchActivation(
  pointerType: string,
  raisedKey: string | null,
  itemKey: string,
): 'bring-forward' | 'open' {
  return pointerType === 'touch' && raisedKey !== itemKey ? 'bring-forward' : 'open'
}

export function windowLiveVisiblePlots<T extends Readonly<{
  x: number
  y: number
  width: number
  height: number
}>>(
  plots: readonly T[],
  viewport: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  overscan: number,
): readonly T[] {
  if (![viewport.left, viewport.top, viewport.right, viewport.bottom, overscan]
    .every(Number.isFinite) || viewport.right < viewport.left ||
      viewport.bottom < viewport.top || overscan < 0) return Object.freeze([])
  const left = viewport.left - overscan
  const top = viewport.top - overscan
  const right = viewport.right + overscan
  const bottom = viewport.bottom + overscan
  return Object.freeze(plots.filter(plot =>
    [plot.x, plot.y, plot.width, plot.height].every(Number.isFinite) &&
    plot.width > 0 && plot.height > 0 &&
    plot.x + plot.width >= left && plot.x <= right &&
    plot.y + plot.height >= top && plot.y <= bottom))
}

export function windowLiveVisiblePlotIds(
  plots: readonly Readonly<{
    id: number
    x: number
    y: number
    width: number
    height: number
  }>[],
  expandedGrounds: Readonly<Record<string, Readonly<{
    x: number
    residentTop: number | null
    thingTop: number | null
    width: number
    bottom: number
  }>>>,
  viewport: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  overscan: number,
  controlRailDepth = 64,
): readonly number[] {
  const safeRailDepth = Number.isFinite(controlRailDepth) && controlRailDepth >= 0
    ? controlRailDepth
    : 0
  const regions = plots.flatMap(plot => {
    if (!Number.isSafeInteger(plot.id) || plot.id <= 0) return []
    const base = Object.freeze({
      id: plot.id,
      x: plot.x,
      y: plot.y,
      width: plot.width,
      height: plot.height + safeRailDepth,
    })
    const ground = expandedGrounds[String(plot.id)]
    if (!ground) return [base]
    const tops = [ground.residentTop, ground.thingTop]
      .filter((value): value is number => Number.isFinite(value))
    const top = tops.length ? Math.min(...tops) : Number.NaN
    if (![ground.x, top, ground.width, ground.bottom].every(Number.isFinite) ||
        ground.width <= 0 || ground.bottom <= top) return [base]
    return [base, Object.freeze({
      id: plot.id,
      x: ground.x,
      y: top,
      width: ground.width,
      height: ground.bottom - top,
    })]
  })
  return Object.freeze([...new Set(
    windowLiveVisiblePlots(regions, viewport, overscan).map(region => region.id),
  )])
}

// Step 3 ruling: a place's own drawing tiles its floor across the whole
// plot; this derives exact, stable tile column/row counts from the plot's
// real pixel size and a tile size, rounding up so the tiled ground never
// leaves a gap at the plot's far edge. Append-stable plot sizes make this
// deterministic across renders -- it never returns zero or a fraction.
export function windowLiveFloorTiling(
  plotWidth: number,
  plotHeight: number,
  tileSize: number,
): Readonly<{ columns: number; rows: number }> {
  const safeTile = Number.isFinite(tileSize) && tileSize > 0 ? tileSize : 1
  const safeWidth = Number.isFinite(plotWidth) && plotWidth > 0 ? plotWidth : safeTile
  const safeHeight = Number.isFinite(plotHeight) && plotHeight > 0 ? plotHeight : safeTile
  return Object.freeze({
    columns: Math.max(1, Math.ceil(safeWidth / safeTile)),
    rows: Math.max(1, Math.ceil(safeHeight / safeTile)),
  })
}

export type WindowLiveFloorDrawingEntry = WindowDrawingSource & Readonly<{
  state: WindowDrawingState
  drawing: WindowDrawing | null
}>

// Round-1 review finding 1: deleting the JSON drawing node (step 3) took its
// role="img" accessible name with it, leaving only the generic "Drawing
// tiled inside <name>" on the outer terrain div. This rebuilds the same
// name/state/source shape the old drawingNode gave (see the deleted
// drawingAccessibleLabel) from data that is already in hand on each path --
// never a new fetch, which would undo step 3's whole point. The non-proof
// path only ever knows the drawn/undrawn binary the thumb probe resolves
// (the same collapse '.live-plot[data-undrawn]' already applies across
// Refused, missing, withdrawn, and moderated presentations); a place's own
// floor is always its own drawing -- places have no kind to inherit a
// drawing from -- so 'Own drawing' there is a structural fact, not a guess.
// The proof path already holds the full synthetic drawing entry, so it
// reuses windowDrawingStateLabel/windowDrawingSourceLabel directly, exactly
// as the deleted drawingNode did.
export function windowLiveFloorAccessibleLabel(
  placeName: string,
  undrawn: boolean,
  proofEntry: WindowLiveFloorDrawingEntry | null = null,
): string {
  if (proofEntry) {
    const stateLabel = windowDrawingStateLabel(proofEntry.state, proofEntry.drawing)
    const sourceLabel = windowDrawingSourceLabel(proofEntry)
    return placeName + ' · ' + stateLabel + (sourceLabel ? ' · ' + sourceLabel : '')
  }
  return placeName + ' · ' + (undrawn ? 'Undrawn' : 'Complete') +
    (undrawn ? '' : ' · Own drawing')
}

export function windowLiveDirectGroundWidth(
  stageWidth: number,
  readableWidth: number,
): number {
  if (![stageWidth, readableWidth].every(Number.isFinite) ||
      stageWidth <= 0 || readableWidth <= 0) return 0
  return Math.min(stageWidth, readableWidth)
}

export function windowLiveCapacitySelection<T extends Readonly<{ id: number }>>(
  rows: readonly T[],
  capacity: number,
  pinnedIds: readonly number[],
  exactTotal = rows.length,
  preferredIds: readonly number[] = [],
): Readonly<{ visible: readonly T[]; overflowCount: number }> {
  const limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
  const total = Number.isSafeInteger(exactTotal) && exactTotal >= rows.length
    ? exactTotal
    : rows.length
  const availableIds = new Set(rows.map(row => row.id))
  const selected = new Set<number>()
  for (const id of pinnedIds) {
    if (selected.size >= limit) break
    if (availableIds.has(id)) selected.add(id)
  }
  for (const id of preferredIds) {
    if (selected.size >= limit) break
    if (availableIds.has(id)) selected.add(id)
  }
  for (const row of rows) {
    if (selected.size >= limit) break
    selected.add(row.id)
  }
  const visible = Object.freeze(rows.filter(row => selected.has(row.id)))
  return Object.freeze({ visible, overflowCount: Math.max(0, total - visible.length) })
}
