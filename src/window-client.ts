import { WINDOW_CLIENT_SAFETY_JS } from './window-client-safety.ts'
import { containsMalformedPublicText } from './input.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'
import { BASIC_ACTIONS } from './physics.ts'
import {
  PUBLIC_EVENT_DETAIL_ID_FIELDS,
  PUBLIC_EVENT_KINDS,
  PUBLIC_EVENT_LABELS,
  PUBLIC_SYSTEM_EVENT_ACTORS,
} from './public-events.ts'
import {
  validateWindowArchiveQuery,
  validateWindowDirectorySearch,
  windowDetailShareState,
  windowSharePath,
  windowShareTargetPath,
} from './window-sharing.ts'

export { PUBLIC_EVENT_KINDS, PUBLIC_EVENT_LABELS }

export type WindowDrawing = Readonly<{
  palette: readonly string[]
  indices: readonly (number | null)[]
}>

export type WindowDrawingState = 'undrawn' | 'refused' | 'in_progress' | 'complete'

export type WindowDrawingSource = Readonly<{
  source: 'none' | 'resident' | 'place' | 'thing' | 'kind_base' | 'kind_variant'
  kind_id?: number
  kind_name?: string
  revision?: number
  variant_name?: string
}>

export function normalizeWindowDrawing(value: unknown): WindowDrawing | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  const fields = Object.keys(candidate).sort()
  if (fields.length !== 2 || fields[0] !== 'indices' || fields[1] !== 'palette') return null
  if (!Array.isArray(candidate.palette) || candidate.palette.length > 64 ||
      !candidate.palette.every(colour => typeof colour === 'string' && /^#[0-9a-f]{6}$/u.test(colour))) {
    return null
  }
  if (!Array.isArray(candidate.indices) || candidate.indices.length !== 64 ||
      !candidate.indices.every(index => index === null || (
        typeof index === 'number' && Number.isInteger(index) && index >= 0 &&
        index < (candidate.palette as unknown[]).length
      ))) return null
  try {
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 2_048) return null
  } catch {
    return null
  }
  return Object.freeze({
    palette: Object.freeze([...(candidate.palette as string[])]),
    indices: Object.freeze([...(candidate.indices as Array<number | null>)]),
  })
}

export function windowDrawingStateLabel(
  state: WindowDrawingState,
  drawing: WindowDrawing | null,
): 'Undrawn' | 'Refused' | 'In progress' | 'Blank' | 'Complete' {
  if (state === 'undrawn') return 'Undrawn'
  if (state === 'refused') return 'Refused'
  if (state === 'in_progress') return 'In progress'
  return drawing?.indices.every(index => index === null) ? 'Blank' : 'Complete'
}

export function windowDrawingSourceLabel(source: WindowDrawingSource | null): string {
  if (!source || source.source === 'none') return ''
  if (['resident', 'place', 'thing'].includes(source.source)) return 'Own drawing'
  if (!source.kind_name || !Number.isSafeInteger(source.revision) ||
      (source.revision ?? 0) <= 0) return ''
  const prefix = `Kind ${source.kind_name} · revision ${String(source.revision)} · `
  if (source.source === 'kind_base') return prefix + 'base'
  return source.variant_name ? prefix + `variant ${source.variant_name}` : ''
}

export function windowLivePlateChildren<T extends Readonly<{
  id: number
  parent_id: number | null
}>>(values: readonly T[], parentId: number): T[] {
  return values.filter(value => value.parent_id === parentId)
    .sort((left, right) => left.id - right.id)
}

export const WINDOW_LIVE_DIRECT_COMMONS_WIDTH = 1_100
export const WINDOW_LIVE_DIRECT_COMMONS_HEIGHT = 680
export const WINDOW_LIVE_CHILD_GROUND_GAP = 80

export function windowLiveSurveyedPlots<T extends Readonly<{
  id: number
  parent_id: number | null
}>>(values: readonly T[], parentId: number): ReadonlyArray<Readonly<{
  id: number
  x: number
  y: number
  width: number
  height: number
}>> {
  // One fixed ordinary footprint holds both declared six-item visible caps.
  // Fixed dimensions keep existing places still when later occupants arrive.
  const width = 440
  const height = 280
  const gap = 80
  const childGroundLeft = WINDOW_LIVE_DIRECT_COMMONS_WIDTH + WINDOW_LIVE_CHILD_GROUND_GAP
  const placed: Array<Readonly<{
    id: number
    x: number
    y: number
    width: number
    height: number
  }>> = []
  const randomUnit = (seed: number): number => {
    let value = seed >>> 0
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return (value >>> 0) / 4_294_967_296
  }
  const overlaps = (left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>): boolean =>
    left.x < right.x + right.width + gap && left.x + left.width + gap > right.x &&
    left.y < right.y + right.height + gap && left.y + left.height + gap > right.y

  for (const place of windowLivePlateChildren(values, parentId)) {
    let foundOpenGround = false
    let candidate: Readonly<{
      id: number
      x: number
      y: number
      width: number
      height: number
    }> = Object.freeze({ id: place.id, x: childGroundLeft, y: 184, width, height })
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const band = Math.floor(attempt / 24)
      const availableWidth = 860 + band * 420
      const availableHeight = 420 + band * 260
      const xSeed = Math.imul(place.id ^ 0x9e3779b9, 0x85ebca6b) + attempt * 0x27d4eb2d
      const ySeed = Math.imul(place.id ^ 0xc2b2ae35, 0x165667b1) + attempt * 0x9e3779b1
      candidate = Object.freeze({
        id: place.id,
        x: Math.round(childGroundLeft + randomUnit(xSeed) * Math.max(1, availableWidth - width)),
        y: Math.round(184 + randomUnit(ySeed) * Math.max(1, availableHeight - height)),
        width,
        height,
      })
      if (!placed.some(existing => overlaps(candidate, existing))) {
        foundOpenGround = true
        break
      }
    }
    if (!foundOpenGround) {
      candidate = Object.freeze({
        id: place.id,
        x: childGroundLeft,
        y: placed.reduce((bottom, existing) =>
          Math.max(bottom, existing.y + existing.height), 184) + gap,
        width,
        height,
      })
    }
    placed.push(candidate)
  }
  return Object.freeze(placed)
}

export function windowLiveExpandedGroundLayout(
  plots: readonly Readonly<{
    id: number
    x: number
    y: number
    width: number
    height: number
  }>[],
  expansions: readonly Readonly<{
    id: number
    residentHeight: number
    thingHeight: number
  }>[],
  groundWidth = 480,
  gap = 16,
  controlRailDepth = 64,
): Readonly<{
  grounds: Readonly<Record<string, Readonly<{
    x: number
    residentTop: number | null
    thingTop: number | null
    width: number
    bottom: number
  }>>>
  width: number
  height: number
}> {
  const safeGroundWidth = Number.isFinite(groundWidth) && groundWidth > 0
    ? groundWidth
    : 480
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 16
  const safeRailDepth = Number.isFinite(controlRailDepth) && controlRailDepth >= 0
    ? controlRailDepth
    : 64
  const plotById = new Map(plots.filter(plot =>
    [plot.id, plot.x, plot.y, plot.width, plot.height].every(Number.isFinite) &&
      Number.isSafeInteger(plot.id) && plot.id > 0 && plot.width > 0 && plot.height > 0)
    .map(plot => [plot.id, plot]))
  const fixed = [...plotById.values()].map(plot => Object.freeze({
    x: plot.x,
    y: plot.y,
    width: plot.width,
    height: plot.height + safeRailDepth,
  }))
  const obstacles = [...fixed]
  const grounds: Record<string, Readonly<{
    x: number
    residentTop: number | null
    thingTop: number | null
    width: number
    bottom: number
  }>> = {}
  const ordered = expansions.filter(expansion =>
    plotById.has(expansion.id) &&
      [expansion.residentHeight, expansion.thingHeight].every(Number.isFinite) &&
      expansion.residentHeight >= 0 && expansion.thingHeight >= 0 &&
      (expansion.residentHeight > 0 || expansion.thingHeight > 0))
    .sort((left, right) => {
      const leftPlot = plotById.get(left.id)!
      const rightPlot = plotById.get(right.id)!
      return leftPlot.y - rightPlot.y || leftPlot.x - rightPlot.x || left.id - right.id
    })
  for (const expansion of ordered) {
    const plot = plotById.get(expansion.id)!
    const totalHeight = expansion.residentHeight + expansion.thingHeight +
      (expansion.residentHeight > 0 && expansion.thingHeight > 0 ? safeGap : 0)
    let top = plot.y + plot.height + safeRailDepth + safeGap
    while (true) {
      const overlapping = obstacles.filter(obstacle =>
        plot.x < obstacle.x + obstacle.width + safeGap &&
        plot.x + safeGroundWidth + safeGap > obstacle.x &&
        top < obstacle.y + obstacle.height + safeGap &&
        top + totalHeight + safeGap > obstacle.y)
      if (!overlapping.length) break
      top = Math.max(...overlapping.map(obstacle => obstacle.y + obstacle.height + safeGap))
    }
    const residentTop = expansion.residentHeight > 0 ? top : null
    const thingTop = expansion.thingHeight > 0
      ? top + expansion.residentHeight +
        (expansion.residentHeight > 0 ? safeGap : 0)
      : null
    const ground = Object.freeze({
      x: plot.x,
      residentTop,
      thingTop,
      width: safeGroundWidth,
      bottom: top + totalHeight,
    })
    grounds[String(expansion.id)] = ground
    obstacles.push(Object.freeze({ x: ground.x, y: top, width: ground.width, height: totalHeight }))
  }
  return Object.freeze({
    grounds: Object.freeze(grounds),
    width: Math.max(0, ...fixed.map(area => area.x + area.width),
      ...Object.values(grounds).map(ground => ground.x + ground.width)),
    height: Math.max(0, ...fixed.map(area => area.y + area.height),
      ...Object.values(grounds).map(ground => ground.bottom)),
  })
}

export function windowLiveScatteredPoint(
  key: number,
  width: number,
  height: number,
  seed: number,
  margin: number,
): Readonly<{ x: number; y: number }> {
  if (![key, width, height, seed, margin].every(Number.isFinite) ||
      width <= margin * 2 || height <= margin * 2 || margin < 0) {
    return Object.freeze({ x: 0, y: 0 })
  }
  const radicalInverse = (value: number, base: number): number => {
    let fraction = 1 / base
    let result = 0
    let remaining = Math.max(1, Math.floor(value))
    while (remaining > 0) {
      result += (remaining % base) * fraction
      remaining = Math.floor(remaining / base)
      fraction /= base
    }
    return result
  }
  const offset = Math.abs(Math.floor(seed)) % 65_521
  const pointKey = offset + Math.abs(Math.floor(key)) + 1
  return Object.freeze({
    x: Math.round(margin + radicalInverse(pointKey, 2) * (width - margin * 2)),
    y: Math.round(margin + radicalInverse(pointKey, 3) * (height - margin * 2)),
  })
}

export function windowLiveScatteredPoints(
  count: number,
  width: number,
  height: number,
  seed: number,
  margin: number,
): ReadonlyArray<Readonly<{ x: number; y: number }>> {
  if (![count, width, height, seed, margin].every(Number.isFinite) || count <= 0) {
    return Object.freeze([])
  }
  const limit = Math.max(0, Math.floor(count))
  return Object.freeze(Array.from({ length: limit }, (_, index) =>
    windowLiveScatteredPoint(index, width, height, seed, margin)))
}

export function windowLiveScatterSurfaceHeight(
  occupiedHeight: number,
  width: number,
  count: number,
  itemWidth: number,
  itemHeight: number,
  margin: number,
  reserveOverflowControl = false,
): number {
  const numbers = [occupiedHeight, width, count, itemWidth, itemHeight, margin]
  if (!numbers.every(Number.isFinite) || occupiedHeight < 0 || width <= 0 || count < 0 ||
      itemWidth <= 0 || itemHeight <= 0 || margin < 0) {
    return Math.max(0, Number.isFinite(occupiedHeight) ? Math.floor(occupiedHeight) : 0)
  }
  const gap = 6
  const usableWidth = width - margin * 2
  const columns = Math.max(1, Math.floor((usableWidth + gap) / (itemWidth + gap)))
  const blockedRows = occupiedHeight > 0
    ? Math.ceil((occupiedHeight + gap) / (itemHeight + gap))
    : 0
  const controlRows = reserveOverflowControl
    ? Math.ceil((52 + gap) / (itemHeight + gap)) + 1
    : 0
  const contentRows = Math.ceil(Math.max(0, Math.floor(count)) / columns)
  if (!contentRows && !controlRows) return Math.ceil(occupiedHeight)
  const rows = blockedRows + contentRows + controlRows
  return Math.ceil(margin * 2 + rows * (itemHeight + gap))
}

export function windowLiveSeparatedPoints(
  keys: readonly number[],
  width: number,
  height: number,
  seed: number,
  itemWidth: number,
  itemHeight: number,
  margin: number,
  anchorY: number,
  reserved: readonly Readonly<{ x: number; y: number; width: number; height: number }>[] = [],
  previous: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {},
): Readonly<Record<string, Readonly<{ x: number; y: number }>>> {
  const numbers = [width, height, seed, itemWidth, itemHeight, margin, anchorY]
  if (!numbers.every(Number.isFinite) || width <= 0 || height <= 0 ||
      itemWidth <= 0 || itemHeight <= 0 || margin < 0 || anchorY < 0 || anchorY > 1) {
    return Object.freeze({})
  }
  const uniqueKeys = [...new Set(keys.filter(key => Number.isSafeInteger(key) && key >= 0))]
    .sort((left, right) => left - right)
  if (!uniqueKeys.length) return Object.freeze({})

  const gap = 6
  const usableWidth = width - margin * 2
  const usableHeight = height - margin * 2
  const columns = Math.max(1, Math.floor((usableWidth + gap) / (itemWidth + gap)))
  const rows = Math.max(1, Math.floor((usableHeight + gap) / (itemHeight + gap)))
  const cellWidth = usableWidth / columns
  const cellHeight = usableHeight / rows
  const rectangle = (point: Readonly<{ x: number; y: number }>) => Object.freeze({
    x: point.x - itemWidth / 2,
    y: point.y - itemHeight * anchorY,
    width: itemWidth,
    height: itemHeight,
  })
  const overlaps = (
    left: Readonly<{ x: number; y: number; width: number; height: number }>,
    right: Readonly<{ x: number; y: number; width: number; height: number }>,
    clearance = 0,
  ): boolean => left.x < right.x + right.width + clearance &&
    left.x + left.width + clearance > right.x &&
    left.y < right.y + right.height + clearance &&
    left.y + left.height + clearance > right.y
  const validReserved = reserved.filter(area =>
    [area.x, area.y, area.width, area.height].every(Number.isFinite) &&
    area.width >= 0 && area.height >= 0)
  const inside = (point: Readonly<{ x: number; y: number }>): boolean => {
    const area = rectangle(point)
    return area.x >= margin && area.y >= margin &&
      area.x + area.width <= width - margin &&
      area.y + area.height <= height - margin &&
      !validReserved.some(block => overlaps(area, block, gap))
  }
  const hashUnit = (value: number): number => {
    let held = value >>> 0
    held ^= held << 13
    held ^= held >>> 17
    held ^= held << 5
    return (held >>> 0) / 4_294_967_296
  }
  const candidates: Array<Readonly<{ x: number; y: number }>> = []
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const slot = row * columns + column
      const horizontalSlack = Math.max(0, cellWidth - itemWidth - gap)
      const verticalSlack = Math.max(0, cellHeight - itemHeight - gap)
      const top = margin + row * cellHeight
      const point = Object.freeze({
        x: Math.round((margin + (column + 0.5) * cellWidth +
          (hashUnit(Math.imul(slot + 1, 0x9e3779b1) ^ Math.floor(seed)) - 0.5) *
          horizontalSlack) * 10) / 10,
        y: Math.round((top + (cellHeight - itemHeight) / 2 + itemHeight * anchorY +
          (hashUnit(Math.imul(slot + 1, 0x85ebca6b) ^ Math.floor(seed * 17)) - 0.5) *
          verticalSlack) * 10) / 10,
      })
      if (inside(point)) candidates.push(point)
    }
  }
  candidates.sort((left, right) => {
    const leftHash = Math.imul(Math.round(left.x * 10) ^ Math.round(left.y * 10), 0x9e3779b1) ^
      Math.floor(seed)
    const rightHash = Math.imul(Math.round(right.x * 10) ^ Math.round(right.y * 10), 0x9e3779b1) ^
      Math.floor(seed)
    return (leftHash >>> 0) - (rightHash >>> 0)
  })

  const placed: Array<Readonly<{ x: number; y: number; width: number; height: number }>> = []
  const result: Record<string, Readonly<{ x: number; y: number }>> = {}
  const available = (point: Readonly<{ x: number; y: number }>): boolean => {
    const area = rectangle(point)
    return inside(point) && !placed.some(other => overlaps(area, other, gap))
  }
  for (const key of uniqueKeys.filter(key => Object.hasOwn(previous, String(key)))) {
    const point = previous[String(key)]
    if (!point || ![point.x, point.y].every(Number.isFinite) || !available(point)) continue
    result[String(key)] = Object.freeze({ x: point.x, y: point.y })
    placed.push(rectangle(point))
  }
  for (const key of uniqueKeys) {
    if (Object.hasOwn(result, String(key))) continue
    const offset = candidates.length
      ? Math.abs(Math.imul(key ^ Math.floor(seed), 0x27d4eb2d)) % candidates.length
      : 0
    let point = null
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[(offset + index) % candidates.length]
      if (candidate && available(candidate)) {
        point = candidate
        break
      }
    }
    if (!point) {
      const minX = Math.ceil(margin + itemWidth / 2)
      const maxX = Math.floor(width - margin - itemWidth / 2)
      const minY = Math.ceil(margin + itemHeight * anchorY)
      const maxY = Math.floor(height - margin - itemHeight * (1 - anchorY))
      const xCount = Math.max(0, maxX - minX + 1)
      const yCount = Math.max(0, maxY - minY + 1)
      const fineCount = xCount * yCount
      const fineOffset = fineCount
        ? (Math.imul(key ^ Math.floor(seed), 0x27d4eb2d) >>> 0) % fineCount
        : 0
      for (let attempt = 0; attempt < fineCount; attempt += 1) {
        const index = (fineOffset + attempt) % fineCount
        const candidate = Object.freeze({
          x: minX + index % xCount,
          y: minY + Math.floor(index / xCount),
        })
        if (available(candidate)) {
          point = candidate
          break
        }
      }
    }
    if (!point) continue
    result[String(key)] = point
    placed.push(rectangle(point))
  }
  return Object.freeze(result)
}

export const WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT = Object.freeze({
  x: 6,
  y: 286,
  width: 128,
  height: 44,
})

function windowLivePointFootprints(
  points: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  itemWidth: number,
  itemHeight: number,
  anchorY: number,
): readonly Readonly<{ x: number; y: number; width: number; height: number }>[] {
  if (![itemWidth, itemHeight, anchorY].every(Number.isFinite) ||
      itemWidth <= 0 || itemHeight <= 0 || anchorY < 0 || anchorY > 1) {
    return Object.freeze([])
  }
  return Object.freeze(Object.values(points).flatMap(point =>
    [point.x, point.y].every(Number.isFinite)
      ? [Object.freeze({
          x: point.x - itemWidth / 2,
          y: point.y - itemHeight * anchorY,
          width: itemWidth,
          height: itemHeight,
        })]
      : []))
}

export function windowLiveRootReservations(
  width: number,
  height: number,
): readonly Readonly<{ x: number; y: number; width: number; height: number }>[] {
  if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) {
    return Object.freeze([])
  }
  const controlWidth = Math.min(116, width)
  const controlHeight = Math.min(144, height)
  return Object.freeze([Object.freeze({
    x: width - controlWidth,
    y: height - controlHeight,
    width: controlWidth,
    height: controlHeight,
  })])
}

export function windowLiveResidentPointsAroundThings(
  keys: readonly number[],
  width: number,
  height: number,
  seed: number,
  itemWidth: number,
  itemHeight: number,
  margin: number,
  thingPoints: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  thingItemWidth: number,
  reserved: readonly Readonly<{ x: number; y: number; width: number; height: number }>[] = [],
  previous: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {},
  sharesThingSurface = true,
): Readonly<Record<string, Readonly<{ x: number; y: number }>>> {
  const thingFootprints = sharesThingSurface
    ? windowLivePointFootprints(thingPoints, thingItemWidth, 56, 0.5)
    : Object.freeze([])
  return windowLiveSeparatedPoints(
    keys,
    width,
    height,
    seed,
    itemWidth,
    itemHeight,
    margin,
    1,
    Object.freeze([...reserved, ...thingFootprints]),
    previous,
  )
}

export function windowLiveThingPointsAroundResidents(
  keys: readonly number[],
  width: number,
  height: number,
  seed: number,
  itemWidth: number,
  itemHeight: number,
  margin: number,
  residentPoints: Readonly<Record<string, Readonly<{ x: number; y: number }>>>,
  reserved: readonly Readonly<{ x: number; y: number; width: number; height: number }>[] = [],
  previous: Readonly<Record<string, Readonly<{ x: number; y: number }>>> = {},
  sharesResidentSurface = true,
): Readonly<Record<string, Readonly<{ x: number; y: number }>>> {
  const residentFootprints = sharesResidentSurface
    ? windowLivePointFootprints(residentPoints, 56, 56, 1)
    : Object.freeze([])
  return windowLiveSeparatedPoints(
    keys,
    width,
    height,
    seed,
    itemWidth,
    itemHeight,
    margin,
    0.5,
    Object.freeze([...reserved, ...residentFootprints]),
    previous,
  )
}

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

export function windowLivePollDelay(hadEvents: boolean, quietReads: number): number {
  if (hadEvents) return 25000
  return [60000, 120000, 240000, 300000][Math.min(3, Math.max(0, quietReads))]!
}

export function windowLiveTraceOpacity(at: number, now: number, lifetime: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(lifetime) || lifetime <= 0) {
    return 0
  }
  return Math.max(0, Math.min(1, 1 - Math.max(0, now - at) / lifetime))
}

export function windowLiveCenterCamera(
  viewportWidth: number,
  viewportHeight: number,
  targetX: number,
  targetY: number,
  preferredScale: number,
  minimumScale: number,
  maximumScale: number,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> | null {
  if (![viewportWidth, viewportHeight, targetX, targetY, preferredScale,
    minimumScale, maximumScale].every(Number.isFinite) ||
      viewportWidth <= 0 || viewportHeight <= 0 || targetX < 0 || targetY < 0 ||
      minimumScale <= 0 || maximumScale < minimumScale) return null
  const scale = windowLiveClampZoomScale(preferredScale, minimumScale, maximumScale)
  return Object.freeze({
    scale,
    offsetX: viewportWidth / 2 - targetX * scale,
    offsetY: viewportHeight / 2 - targetY * scale,
  })
}

export function windowLiveRevealCamera(
  viewportWidth: number,
  viewportHeight: number,
  targetX: number,
  targetY: number,
  targetWidth: number,
  targetHeight: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  safeInset: number,
): Readonly<{ scale: number; offsetX: number; offsetY: number }> | null {
  if (![viewportWidth, viewportHeight, targetX, targetY, targetWidth, targetHeight,
    scale, offsetX, offsetY, safeInset].every(Number.isFinite) ||
      viewportWidth <= 0 || viewportHeight <= 0 || scale <= 0 ||
      targetWidth < 0 || targetHeight < 0 || safeInset < 0 ||
      safeInset * 2 >= viewportWidth || safeInset * 2 >= viewportHeight) return null
  const safeCenter = (
    current: number,
    viewportSize: number,
    scaledTargetSize: number,
  ) => {
    const half = scaledTargetSize / 2
    const available = viewportSize - safeInset * 2
    const canFit = scaledTargetSize <= available
    const inwardGuard = canFit
      ? Math.min(0.01, Math.max(0, available - scaledTargetSize) / 2)
      : 0
    const minimum = canFit ? safeInset + half + inwardGuard : safeInset
    const maximum = canFit
      ? viewportSize - safeInset - half - inwardGuard
      : viewportSize - safeInset
    return Math.max(minimum, Math.min(maximum, current))
  }
  const screenX = targetX * scale + offsetX
  const screenY = targetY * scale + offsetY
  const revealedX = safeCenter(screenX, viewportWidth, targetWidth * scale)
  const revealedY = safeCenter(screenY, viewportHeight, targetHeight * scale)
  return Object.freeze({
    scale,
    offsetX: revealedX - targetX * scale,
    offsetY: revealedY - targetY * scale,
  })
}

export function windowLiveClampZoomScale(
  requestedScale: number,
  minimumScale: number,
  maximumScale: number,
): number {
  if (![minimumScale, maximumScale].every(Number.isFinite) ||
      minimumScale <= 0 || maximumScale < minimumScale) return 1
  if (!Number.isFinite(requestedScale)) return minimumScale
  return Math.max(minimumScale, Math.min(maximumScale, requestedScale))
}

export function windowLiveResidentLabelMode(
  scale: number,
  readableThreshold: number,
): 'far' | 'readable' {
  if (!Number.isFinite(scale) || scale <= 0 ||
      !Number.isFinite(readableThreshold) || readableThreshold <= 0) return 'far'
  return scale >= readableThreshold ? 'readable' : 'far'
}

export function windowLivePruneTrailStarts(
  starts: Readonly<Record<string, number>>,
  now: number,
  lifetime: number,
  protectedKeys: readonly string[] = [],
): Readonly<Record<string, number>> {
  if (!Number.isFinite(now) || !Number.isFinite(lifetime) || lifetime <= 0) return starts
  const protectedSet = new Set(protectedKeys)
  const entries = Object.entries(starts).filter(([key, at]) =>
    protectedSet.has(key) || windowLiveTraceOpacity(at, now, lifetime) > 0)
  return entries.length === Object.keys(starts).length
    ? starts
    : Object.freeze(Object.fromEntries(entries))
}

export function windowLiveSelectTrailKeys(
  keys: readonly string[],
  capacity: number,
  protectedKeys: readonly string[],
): readonly string[] {
  const limit = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0
  if (!limit || !keys.length) return Object.freeze([])
  const uniqueKeys = [...new Set(keys)]
  const availableKeys = new Set(uniqueKeys)
  const protectedSet = new Set(protectedKeys.filter(key => availableKeys.has(key)))
  const protectedInOrder = uniqueKeys.filter(key => protectedSet.has(key)).slice(0, limit)
  const ordinaryLimit = Math.max(0, limit - protectedInOrder.length)
  const selected = new Set([
    ...uniqueKeys.filter(key => !protectedSet.has(key)).slice(0, ordinaryLimit),
    ...protectedInOrder,
  ])
  return Object.freeze(uniqueKeys.filter(key => selected.has(key)).slice(0, limit))
}

export function windowLiveReplayDuration(
  distance: number,
  remainingLifetime = Number.POSITIVE_INFINITY,
): number {
  const duration = !Number.isFinite(distance)
    ? 3_200
    : Math.round(Math.min(8_000, Math.max(3_200, 3_200 + Math.max(0, distance) * 42)))
  if (Number.isNaN(remainingLifetime) || remainingLifetime < 3_200) return 0
  return Math.min(duration, Math.floor(remainingLifetime))
}

export function windowLiveReplayPace(
  eventCount: number,
  millisecondsUntilNextRead: number,
): Readonly<{ startGapMs: number; actionDurationMs: number }> {
  if (!Number.isFinite(eventCount) || eventCount <= 0 ||
      !Number.isFinite(millisecondsUntilNextRead) || millisecondsUntilNextRead <= 0) {
    return Object.freeze({ startGapMs: 0, actionDurationMs: 0 })
  }
  const count = Math.max(1, Math.floor(eventCount))
  const available = Math.max(300, Math.floor(millisecondsUntilNextRead) - 500)
  const busy = count > 12
  const startGapMs = busy
    ? Math.max(40, Math.min(300, Math.floor(available / (count * 2))))
    : Math.max(1_000, Math.min(4_000, Math.floor(available / (count + 1))))
  const actionDurationMs = busy
    ? Math.max(120, Math.min(450, Math.floor(available / (count * 2))))
    : Math.max(600, Math.min(3_200, Math.floor(startGapMs * 0.8)))
  return Object.freeze({ startGapMs, actionDurationMs })
}

export function windowLiveReplayStartOffsets<T extends Readonly<{
  actor: string
  at: Date
}>>(
  records: readonly T[],
  millisecondsUntilNextRead: number,
): Readonly<Record<string, number>> {
  if (!Number.isFinite(millisecondsUntilNextRead) || millisecondsUntilNextRead <= 0) {
    return Object.freeze({})
  }
  const ordered = records.map((record, index) => Object.freeze({ record, index }))
    .filter(entry => typeof entry.record.actor === 'string' && entry.record.actor.length > 0 &&
      entry.record.at instanceof Date && Number.isFinite(entry.record.at.getTime()))
    .sort((left, right) =>
      left.record.at.getTime() - right.record.at.getTime() || left.index - right.index)
  if (!ordered.length) return Object.freeze({})
  const pace = windowLiveReplayPace(ordered.length, millisecondsUntilNextRead)
  const result: Record<string, number> = {}
  let groupIndex = -1
  let groupTime = Number.NaN
  for (const { record } of ordered) {
    const recordedAt = record.at.getTime()
    if (recordedAt !== groupTime) {
      groupTime = recordedAt
      groupIndex += 1
    }
    if (!Object.hasOwn(result, record.actor)) {
      result[record.actor] = groupIndex * pace.startGapMs
    }
  }
  return Object.freeze(result)
}

export function windowLiveReplayOrder<T extends Readonly<{
  change_id?: string
  id?: number
  at: Date
}>>(values: readonly T[], cutoff: number): T[] {
  return values.filter(value => value.at.getTime() >= cutoff).sort((left, right) => {
    const leftIsChange = left.change_id !== undefined
    const rightIsChange = right.change_id !== undefined
    if (leftIsChange !== rightIsChange) return leftIsChange ? 1 : -1
    if (left.change_id !== undefined && right.change_id !== undefined) {
      const leftMarker = BigInt(left.change_id)
      const rightMarker = BigInt(right.change_id)
      return leftMarker < rightMarker ? -1 : leftMarker > rightMarker ? 1 : 0
    }
    if (left.id !== undefined && right.id !== undefined) return left.id - right.id
    return left.at.getTime() - right.at.getTime()
  })
}

export function windowLiveSpeechLine(value: string, maximum = 60): string {
  const [firstLine = ''] = value.split(/\r\n?|\n/u, 1)
  const characters = Array.from(firstLine)
  if (characters.length <= maximum) return firstLine
  return characters.slice(0, Math.max(0, maximum - 1)).join('') + '…'
}

export function parseWindowSleeperPlaceIds(
  value: string | null,
  maximumLength = 8_192,
): number[] {
  if (typeof value !== 'string' || !value || value.length > maximumLength) return []
  const ids: number[] = []
  const seen = new Set<number>()
  for (const token of value.split(',')) {
    if (!/^[1-9]\d*$/u.test(token)) return []
    const id = Number(token)
    if (!Number.isSafeInteger(id) || id > 2_147_483_647) return []
    if (!seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
  }
  return ids
}

export function mergeWindowRows<T extends Readonly<{ id: number }>>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const rows = new Map<number, T>()
  for (const row of current) rows.set(row.id, row)
  for (const row of incoming) rows.set(row.id, row)
  return [...rows.values()].sort((left, right) => right.id - left.id)
}

export function mergeResidentRows<
  T extends Readonly<{ id: number, joined_at: Date }>,
>(
  currentResidents: readonly T[],
  incomingResidents: readonly T[],
): T[] {
  const residents = mergeWindowRows(currentResidents, incomingResidents)
  return [...residents].sort((left, right) => {
    const joinedDifference = right.joined_at.getTime() - left.joined_at.getTime()
    return joinedDifference || right.id - left.id
  })
}

export function windowPlaceLabel(
  placeId: number | null,
  place: Readonly<{ path: string }> | null,
): string | null {
  if (!placeId) return null
  return place?.path ?? `Place #${placeId} · not currently loaded`
}

export type WindowDirectoryPlace = Readonly<{
  id: number
  parent_id: number | null
  name: string
}>

export type WindowDirectoryPlaceWithPath = WindowDirectoryPlace & Readonly<{
  path: string
}>

export type WindowDirectoryPlaceOption = Readonly<{
  id: number
  depth: number
  label: string
}>

export type WindowDirectoryResident = Readonly<{
  id: number
  handle: string
  has_drawing?: boolean
}>

export type WindowDirectorySearchResult = Readonly<{
  kind: 'place' | 'resident'
  id: number
  value: string
  label: string
  detail: string
  hasDrawing?: boolean
}>

export type WindowDirectorySearchPage = Readonly<{
  results: readonly WindowDirectorySearchResult[]
  total: number
  placeCount: number
  residentCount: number
  hasMore: boolean
}>

export function windowDirectoryPlaceScopeIds(
  values: readonly WindowDirectoryPlace[],
  placeId: number,
): number[] {
  const children = new Map<number, number[]>()
  for (const value of values) {
    if (value.parent_id === null) continue
    const siblings = children.get(value.parent_id) ?? []
    if (!siblings.includes(value.id)) children.set(value.parent_id, [...siblings, value.id])
  }

  const found: number[] = []
  const seen = new Set<number>()
  const queue = [placeId]
  while (queue.length) {
    const id = queue.shift()
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    found.push(id)
    queue.push(...(children.get(id) ?? []))
  }
  return found
}

export function deriveWindowDirectoryPlaces(
  values: readonly WindowDirectoryPlace[],
): WindowDirectoryPlaceWithPath[] {
  const maximumPathDepth = 32
  const counts = new Map<number, number>()
  for (const value of values) counts.set(value.id, (counts.get(value.id) ?? 0) + 1)

  const unique = new Map<number, WindowDirectoryPlace>()
  for (const value of values) {
    if (!unique.has(value.id)) unique.set(value.id, value)
  }

  const fallback = (value: WindowDirectoryPlace): string =>
    `${value.name} · Place #${value.id}`
  const pathFor = (value: WindowDirectoryPlace): string => {
    if ((counts.get(value.id) ?? 0) !== 1) return fallback(value)
    const names: string[] = []
    const seen = new Set<number>()
    let current: WindowDirectoryPlace | undefined = value
    while (current) {
      if (
        names.length >= maximumPathDepth || seen.has(current.id) ||
        (counts.get(current.id) ?? 0) !== 1
      ) return fallback(value)
      names.push(current.name)
      seen.add(current.id)
      if (current.parent_id === null) return names.reverse().join(' / ')
      current = unique.get(current.parent_id)
      if (!current) return fallback(value)
    }
    return fallback(value)
  }

  return [...unique.values()].map(value => ({ ...value, path: pathFor(value) }))
}

export function listWindowDirectoryPlaces(
  values: readonly WindowDirectoryPlaceWithPath[],
): WindowDirectoryPlaceOption[] {
  const placesById = new Map(values.map(place => [place.id, place]))
  const rootIds = new Set(values.filter(place => place.parent_id === null).map(place => place.id))
  const continentFor = (place: WindowDirectoryPlaceWithPath) => {
    if (place.parent_id === null) return null
    const seen = new Set<number>()
    let current: WindowDirectoryPlaceWithPath | undefined = place
    while (current && current.parent_id !== null) {
      if (seen.has(current.id)) return undefined
      seen.add(current.id)
      const parent = placesById.get(current.parent_id)
      if (!parent) return undefined
      if (rootIds.has(parent.id)) return current
      current = parent
    }
    return undefined
  }
  type MutableGroup = {
    wholePlaceId: number | null
    options: Array<{ id: number, depth: number, label: string }>
  }
  const groups = new Map<string, MutableGroup>()
  const ensureGroup = (key: string, wholePlaceId: number | null) => {
    const existing = groups.get(key)
    if (existing) return existing
    const created: MutableGroup = { wholePlaceId, options: [] }
    groups.set(key, created)
    return created
  }

  for (const place of values) {
    const parts = place.path.split(' / ').filter(Boolean)
    if (place.parent_id === null) {
      ensureGroup('root', null).options.push({
        id: place.id,
        depth: 0,
        label: `${place.name} · Place #${place.id}`,
      })
      continue
    }

    const continent = continentFor(place)
    if (!continent) {
      ensureGroup('other', null).options.push({
        id: place.id,
        depth: 0,
        label: `${place.name} · Place #${place.id}`,
      })
      continue
    }
    const parent = placesById.get(place.parent_id)
    const depth = Math.max(0, parts.length - 2)
    const shortLabel = `${place.name}${depth > 1 && parent ? ` — in ${parent.name}` : ''} · Place #${place.id}`
    ensureGroup(`continent:${continent.id}`, continent.id).options.push({
      id: place.id,
      depth,
      label: shortLabel,
    })
  }

  return [...groups.values()].flatMap(group => [...group.options]
    .sort((left, right) =>
      Number(right.id === group.wholePlaceId) - Number(left.id === group.wholePlaceId))
    .map(option => Object.freeze(option)))
}

export function searchWindowDirectory(
  places: readonly WindowDirectoryPlaceWithPath[],
  residents: readonly WindowDirectoryResident[],
  query: string,
  limit = 20,
): WindowDirectorySearchResult[] {
  const normalizedSearchText = (value: string): string => value.normalize('NFC').toLowerCase()
  const normalizedQuery = normalizedSearchText(query.trim())
  if (!normalizedQuery) return []
  const safeLimit = Math.max(0, Math.floor(limit))
  const score = (primary: string, searchText: string, id: number): number | null => {
    const normalizedPrimary = normalizedSearchText(primary)
    if (
      normalizedQuery === normalizedPrimary || normalizedQuery === String(id) ||
      normalizedQuery === `#${id}` || normalizedQuery === `place #${id}` ||
      normalizedQuery === `resident #${id}`
    ) return 0
    if (normalizedPrimary.startsWith(normalizedQuery)) return 1
    return normalizedSearchText(searchText).includes(normalizedQuery) ? 2 : null
  }
  const candidates = [
    ...places.flatMap((place, order) => {
      const matchScore = score(
        place.name,
        `${place.name}\n${place.path}\nplace #${place.id}\n#${place.id}`,
        place.id,
      )
      return matchScore === null ? [] : [{
        score: matchScore,
        order,
        result: Object.freeze({
          kind: 'place' as const,
          id: place.id,
          value: String(place.id),
          label: `${place.name} · Place #${place.id}`,
          detail: place.path,
        }),
      }]
    }),
    ...residents.flatMap((resident, index) => {
      const matchScore = score(
        resident.handle,
        `${resident.handle}\nresident #${resident.id}\n#${resident.id}`,
        resident.id,
      )
      return matchScore === null ? [] : [{
        score: matchScore,
        order: places.length + index,
        result: Object.freeze({
          kind: 'resident' as const,
          id: resident.id,
          value: resident.handle,
          label: `${resident.handle} · Resident #${resident.id}`,
          detail: 'Resident',
          hasDrawing: resident.has_drawing === true,
        }),
      }]
    }),
  ]
  return candidates
    .sort((left, right) => left.score - right.score || left.order - right.order)
    .slice(0, safeLimit)
    .map(candidate => candidate.result)
}

export function pageWindowDirectorySearch(
  places: readonly WindowDirectoryPlaceWithPath[],
  residents: readonly WindowDirectoryResident[],
  query: string,
  limit = 20,
): WindowDirectorySearchPage {
  const matches = searchWindowDirectory(places, residents, query, Number.MAX_SAFE_INTEGER)
  const safeLimit = Math.max(0, Math.floor(limit))
  const placeCount = matches.filter(result => result.kind === 'place').length
  return Object.freeze({
    results: Object.freeze(matches.slice(0, safeLimit)),
    total: matches.length,
    placeCount,
    residentCount: matches.length - placeCount,
    hasMore: matches.length > safeLimit,
  })
}

const PUBLIC_EVENT_LABELS_JSON = JSON.stringify(PUBLIC_EVENT_LABELS)
const PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON = JSON.stringify(PUBLIC_EVENT_DETAIL_ID_FIELDS)
const PUBLIC_SYSTEM_EVENT_ACTORS_JSON = JSON.stringify(Object.values(PUBLIC_SYSTEM_EVENT_ACTORS))
const BASIC_ACTIONS_JSON = JSON.stringify(BASIC_ACTIONS)
const WORLD_ROOT_NAME_JSON = JSON.stringify(WORLD_ROOT_NAME)
const MERGE_WINDOW_ROWS_JS = mergeWindowRows.toString()
const MERGE_RESIDENT_ROWS_JS = mergeResidentRows.toString()
const WINDOW_PLACE_LABEL_JS = windowPlaceLabel.toString()
const DERIVE_WINDOW_DIRECTORY_PLACES_JS = deriveWindowDirectoryPlaces.toString()
const LIST_WINDOW_DIRECTORY_PLACES_JS = listWindowDirectoryPlaces.toString()
const SEARCH_WINDOW_DIRECTORY_JS = searchWindowDirectory.toString()
const PAGE_WINDOW_DIRECTORY_SEARCH_JS = pageWindowDirectorySearch.toString()
const WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS = windowDirectoryPlaceScopeIds.toString()
const PARSE_WINDOW_SLEEPER_PLACE_IDS_JS = parseWindowSleeperPlaceIds.toString()
const CONTAINS_MALFORMED_PUBLIC_TEXT_JS = containsMalformedPublicText.toString()
const VALIDATE_WINDOW_ARCHIVE_QUERY_JS = validateWindowArchiveQuery.toString()
const VALIDATE_WINDOW_DIRECTORY_SEARCH_JS = validateWindowDirectorySearch.toString()
const WINDOW_DETAIL_SHARE_STATE_JS = windowDetailShareState.toString()
const WINDOW_SHARE_PATH_JS = windowSharePath.toString()
const WINDOW_SHARE_TARGET_PATH_JS = windowShareTargetPath.toString()
const NORMALIZE_WINDOW_DRAWING_JS = normalizeWindowDrawing.toString()
const WINDOW_DRAWING_STATE_LABEL_JS = windowDrawingStateLabel.toString()
const WINDOW_DRAWING_SOURCE_LABEL_JS = windowDrawingSourceLabel.toString()
const WINDOW_LIVE_PLATE_CHILDREN_JS = windowLivePlateChildren.toString()
const WINDOW_LIVE_SURVEYED_PLOTS_JS = windowLiveSurveyedPlots.toString()
const WINDOW_LIVE_EXPANDED_GROUND_LAYOUT_JS = windowLiveExpandedGroundLayout.toString()
const WINDOW_LIVE_SCATTERED_POINT_JS = windowLiveScatteredPoint.toString()
const WINDOW_LIVE_SCATTERED_POINTS_JS = windowLiveScatteredPoints.toString()
const WINDOW_LIVE_SCATTER_SURFACE_HEIGHT_JS = windowLiveScatterSurfaceHeight.toString()
const WINDOW_LIVE_SEPARATED_POINTS_JS = windowLiveSeparatedPoints.toString()
const WINDOW_LIVE_POINT_FOOTPRINTS_JS = windowLivePointFootprints.toString()
const WINDOW_LIVE_ROOT_RESERVATIONS_JS = windowLiveRootReservations.toString()
const WINDOW_LIVE_RESIDENT_POINTS_AROUND_THINGS_JS =
  windowLiveResidentPointsAroundThings.toString()
const WINDOW_LIVE_THING_POINTS_AROUND_RESIDENTS_JS =
  windowLiveThingPointsAroundResidents.toString()
const WINDOW_LIVE_VISIBLE_PLOTS_JS = windowLiveVisiblePlots.toString()
const WINDOW_LIVE_VISIBLE_PLOT_IDS_JS = windowLiveVisiblePlotIds.toString()
const WINDOW_LIVE_DIRECT_GROUND_WIDTH_JS = windowLiveDirectGroundWidth.toString()
const WINDOW_LIVE_CAPACITY_SELECTION_JS = windowLiveCapacitySelection.toString()
const WINDOW_LIVE_POLL_DELAY_JS = windowLivePollDelay.toString()
const WINDOW_LIVE_TRACE_OPACITY_JS = windowLiveTraceOpacity.toString()
const WINDOW_LIVE_CENTER_CAMERA_JS = windowLiveCenterCamera.toString()
const WINDOW_LIVE_REVEAL_CAMERA_JS = windowLiveRevealCamera.toString()
const WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS = windowLiveClampZoomScale.toString()
const WINDOW_LIVE_RESIDENT_LABEL_MODE_JS = windowLiveResidentLabelMode.toString()
const WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS = windowLivePruneTrailStarts.toString()
const WINDOW_LIVE_SELECT_TRAIL_KEYS_JS = windowLiveSelectTrailKeys.toString()
const WINDOW_LIVE_REPLAY_DURATION_JS = windowLiveReplayDuration.toString()
const WINDOW_LIVE_REPLAY_PACE_JS = windowLiveReplayPace.toString()
const WINDOW_LIVE_REPLAY_START_OFFSETS_JS = windowLiveReplayStartOffsets.toString()
const WINDOW_LIVE_REPLAY_ORDER_JS = windowLiveReplayOrder.toString()
const WINDOW_LIVE_SPEECH_LINE_JS = windowLiveSpeechLine.toString()
const WINDOW_LIVE_TOUCH_ACTIVATION_JS = windowLiveTouchActivation.toString()
const WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT_JSON = JSON.stringify(
  WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT,
)
const WINDOW_LIVE_DIRECT_COMMONS_WIDTH_JSON = JSON.stringify(WINDOW_LIVE_DIRECT_COMMONS_WIDTH)
const WINDOW_LIVE_DIRECT_COMMONS_HEIGHT_JSON = JSON.stringify(WINDOW_LIVE_DIRECT_COMMONS_HEIGHT)
const WINDOW_LIVE_CHILD_GROUND_GAP_JSON = JSON.stringify(WINDOW_LIVE_CHILD_GROUND_GAP)

export const WINDOW_JS = `(() => {
  'use strict'

  const BASE_REFRESH_MS = 60000
  const MAX_REFRESH_MS = 300000
  const LIVE_MOVE_LIFETIME_MS = 1800000
  const LIVE_NOTE_LIFETIME_MS = 600000
  const LIVE_TRAIL_LIFETIME_MS = 4_500
  const LIVE_ABSORPTION_MS = 900
  const LIVE_PULSE_MS = 600
  const LIVE_NOTE_REPLAY_MS = 650
  const LIVE_NOTE_FETCH_CONCURRENCY = 4
  const LIVE_NOTE_QUEUE_LIMIT = 16
  const LIVE_DRAWING_FETCH_CONCURRENCY = 4
  const LIVE_DRAWING_QUEUE_LIMIT = 32
  const LIVE_OPENING_PAGE_LIMIT = 200
  const LIVE_REPLAY_BACKLOG_LIMIT = LIVE_OPENING_PAGE_LIMIT
  const LIVE_PORTRAIT_LIMIT = 6
  const LIVE_THING_LIMIT = 6
  const LIVE_FOCUS_STORAGE_KEY = '1f3d9:window:live-focus'
  const LIVE_CAMERA_MIN_SCALE = 0.8
  const LIVE_CAMERA_CENTER_SCALE = 1
  const LIVE_CAMERA_MAX_SCALE = 2.2
  const LIVE_CAMERA_SAFE_INSET = 16
  const WINDOW_LIVE_DIRECT_COMMONS_WIDTH = ${WINDOW_LIVE_DIRECT_COMMONS_WIDTH_JSON}
  const WINDOW_LIVE_DIRECT_COMMONS_HEIGHT = ${WINDOW_LIVE_DIRECT_COMMONS_HEIGHT_JSON}
  const WINDOW_LIVE_CHILD_GROUND_GAP = ${WINDOW_LIVE_CHILD_GROUND_GAP_JSON}
  const LIVE_DIRECT_GROUND_WIDTH = WINDOW_LIVE_DIRECT_COMMONS_WIDTH
  const LIVE_LABEL_READABLE_SCALE = 1.6
  const LIVE_LABEL_FULL_REFRESH_MS = 250
  const LIVE_LABEL_CONTINUOUS_LIMIT = 12
  const LIVE_PLOT_OVERSCAN = 160
  const LIVE_PLOT_DRAWING_DETAIL_RECT = Object.freeze(
    ${WINDOW_LIVE_PLOT_DRAWING_DETAIL_RECT_JSON})
  const LIVE_TRAIL_DOM_LIMIT = 96
  const REQUEST_TIMEOUT_MS = 10000
  const MAX_FORWARD_RECONCILE_PAGES = 8
  const MAX_AUTO_HISTORY_PAGES = 8
  const GAZETTE_ISSUE_PAGE_LIMIT = 10
  const GAZETTE_ENTRY_PAGE_LIMIT = 25
  const GAZETTE_FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
  const GAZETTE_FIRST_PRINT_EMPTY_STATE = 'No Gazette issues have printed yet. The first print is scheduled for Monday, 31 August 2026 at 16:00 UTC.'
  const SAFE_HANDLE = /^[a-z0-9][a-z0-9-]{2,31}$/
  const SAFE_WORLD_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/
  const MODERATED_TEXT = '[removed by maintainer]'
  const WORLD_ROOT_NAME = ${WORLD_ROOT_NAME_JSON}
  const VIEWS = Object.freeze([
    'map', 'live', 'things', 'place', 'conversations', 'happenings', 'agreements', 'archive', 'gazette',
  ])
  const SAFE_EVENT_KINDS = new Map(Object.entries(${PUBLIC_EVENT_LABELS_JSON}))
  const SAFE_EVENT_DETAIL_IDS = Object.freeze(${PUBLIC_EVENT_DETAIL_ID_FIELDS_JSON})
  const SAFE_SYSTEM_EVENT_ACTORS = new Set(${PUBLIC_SYSTEM_EVENT_ACTORS_JSON})
  const SAFE_ACTIONS = new Set(${BASIC_ACTIONS_JSON})
  const SAFE_ACTION_STATUSES = new Set(['applied', 'blocked', 'noop', 'failed'])
  const SAFE_EFFECT_STATUSES = new Set(['applied', 'skipped', 'failed'])
  const EVENT_ERROR_LIMIT = 500
  const UNSAFE_EVENT_ERROR = 'the recorded cause could not be shown safely'
  const LIVE_MOTION_PREFERENCE = window.matchMedia('(prefers-reduced-motion: reduce)')
  const mergeWindowRows = ${MERGE_WINDOW_ROWS_JS}
  const mergeResidentRows = ${MERGE_RESIDENT_ROWS_JS}
  const windowPlaceLabel = ${WINDOW_PLACE_LABEL_JS}
  const deriveWindowDirectoryPlaces = ${DERIVE_WINDOW_DIRECTORY_PLACES_JS}
  const listWindowDirectoryPlaces = ${LIST_WINDOW_DIRECTORY_PLACES_JS}
  const searchWindowDirectory = ${SEARCH_WINDOW_DIRECTORY_JS}
  const pageWindowDirectorySearch = ${PAGE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDirectoryPlaceScopeIds = ${WINDOW_DIRECTORY_PLACE_SCOPE_IDS_JS}
  const parseWindowSleeperPlaceIds = ${PARSE_WINDOW_SLEEPER_PLACE_IDS_JS}
  const containsMalformedPublicText = ${CONTAINS_MALFORMED_PUBLIC_TEXT_JS}
  const validateWindowArchiveQuery = ${VALIDATE_WINDOW_ARCHIVE_QUERY_JS}
  const validateWindowDirectorySearch = ${VALIDATE_WINDOW_DIRECTORY_SEARCH_JS}
  const windowDetailShareState = ${WINDOW_DETAIL_SHARE_STATE_JS}
  const windowSharePath = ${WINDOW_SHARE_PATH_JS}
  const windowShareTargetPath = ${WINDOW_SHARE_TARGET_PATH_JS}
  const normalizeWindowDrawing = ${NORMALIZE_WINDOW_DRAWING_JS}
  const windowDrawingStateLabel = ${WINDOW_DRAWING_STATE_LABEL_JS}
  const windowDrawingSourceLabel = ${WINDOW_DRAWING_SOURCE_LABEL_JS}
  const windowLivePlateChildren = ${WINDOW_LIVE_PLATE_CHILDREN_JS}
  const windowLiveSurveyedPlots = ${WINDOW_LIVE_SURVEYED_PLOTS_JS}
  const windowLiveExpandedGroundLayout = ${WINDOW_LIVE_EXPANDED_GROUND_LAYOUT_JS}
  const windowLiveScatteredPoint = ${WINDOW_LIVE_SCATTERED_POINT_JS}
  const windowLiveScatteredPoints = ${WINDOW_LIVE_SCATTERED_POINTS_JS}
  const windowLiveScatterSurfaceHeight = ${WINDOW_LIVE_SCATTER_SURFACE_HEIGHT_JS}
  const windowLiveSeparatedPoints = ${WINDOW_LIVE_SEPARATED_POINTS_JS}
  const windowLivePointFootprints = ${WINDOW_LIVE_POINT_FOOTPRINTS_JS}
  const windowLiveRootReservations = ${WINDOW_LIVE_ROOT_RESERVATIONS_JS}
  const windowLiveResidentPointsAroundThings =
    ${WINDOW_LIVE_RESIDENT_POINTS_AROUND_THINGS_JS}
  const windowLiveThingPointsAroundResidents =
    ${WINDOW_LIVE_THING_POINTS_AROUND_RESIDENTS_JS}
  const windowLiveVisiblePlots = ${WINDOW_LIVE_VISIBLE_PLOTS_JS}
  const windowLiveVisiblePlotIds = ${WINDOW_LIVE_VISIBLE_PLOT_IDS_JS}
  const windowLiveDirectGroundWidth = ${WINDOW_LIVE_DIRECT_GROUND_WIDTH_JS}
  const windowLiveCapacitySelection = ${WINDOW_LIVE_CAPACITY_SELECTION_JS}
  const windowLivePollDelay = ${WINDOW_LIVE_POLL_DELAY_JS}
  const windowLiveTraceOpacity = ${WINDOW_LIVE_TRACE_OPACITY_JS}
  const windowLiveCenterCamera = ${WINDOW_LIVE_CENTER_CAMERA_JS}
  const windowLiveRevealCamera = ${WINDOW_LIVE_REVEAL_CAMERA_JS}
  const windowLiveClampZoomScale = ${WINDOW_LIVE_CLAMP_ZOOM_SCALE_JS}
  const windowLiveResidentLabelMode = ${WINDOW_LIVE_RESIDENT_LABEL_MODE_JS}
  const windowLivePruneTrailStarts = ${WINDOW_LIVE_PRUNE_TRAIL_STARTS_JS}
  const windowLiveSelectTrailKeys = ${WINDOW_LIVE_SELECT_TRAIL_KEYS_JS}
  const windowLiveReplayDuration = ${WINDOW_LIVE_REPLAY_DURATION_JS}
  const windowLiveReplayPace = ${WINDOW_LIVE_REPLAY_PACE_JS}
  const windowLiveReplayStartOffsets = ${WINDOW_LIVE_REPLAY_START_OFFSETS_JS}
  const windowLiveReplayOrder = ${WINDOW_LIVE_REPLAY_ORDER_JS}
  const windowLiveSpeechLine = ${WINDOW_LIVE_SPEECH_LINE_JS}
  const windowLiveTouchActivation = ${WINDOW_LIVE_TOUCH_ACTIVATION_JS}

  const nodes = {
    status: document.getElementById('window-status'),
    counts: document.getElementById('city-counts'),
    scope: document.getElementById('view-scope'),
    liveAlpha: document.getElementById('live-alpha'),
    liveAlphaNote: document.getElementById('live-alpha-note'),
    liveClock: document.getElementById('live-clock'),
    liveBreadcrumbs: document.getElementById('live-breadcrumbs'),
    liveHistoryStatus: document.getElementById('live-history-status'),
    liveViewport: document.getElementById('live-viewport'),
    liveStage: document.getElementById('live-stage'),
    liveLabelLayer: document.getElementById('live-label-layer'),
    liveWorldGround: document.querySelector('#live-stage > .live-world-ground'),
    liveZoomIn: document.getElementById('live-zoom-in'),
    liveZoomOut: document.getElementById('live-zoom-out'),
    liveCenter: document.getElementById('live-center'),
    liveFullscreen: document.getElementById('live-fullscreen'),
    liveProof: document.getElementById('live-proof'),
    livePause: document.getElementById('live-pause'),
    liveFocusStatus: document.getElementById('live-focus-status'),
    liveMapCaption: document.getElementById('live-map-caption'),
    livePlates: document.getElementById('live-plates'),
    liveLedger: document.getElementById('live-ledger'),
    liveRoster: document.getElementById('live-roster'),
    liveResidentPage: document.getElementById('live-resident-page'),
    map: document.getElementById('place-map'),
    roster: document.getElementById('resident-roster'),
    residentPage: document.getElementById('resident-page'),
    thingsSummary: document.getElementById('things-summary'),
    thingsList: document.getElementById('things-list'),
    thingsPage: document.getElementById('things-page'),
    directorySearch: document.getElementById('directory-search'),
    directorySearchResults: document.getElementById('directory-search-results'),
    directorySearchStatus: document.getElementById('directory-search-status'),
    placeFilter: document.getElementById('place-filter'),
    residentFilter: document.getElementById('resident-filter'),
    directoryStatus: document.getElementById('directory-status'),
    shareStatus: document.getElementById('share-status'),
    detailShareStatus: document.getElementById('record-detail-share-status'),
    detail: document.getElementById('record-detail'),
    detailKind: document.getElementById('record-detail-kind'),
    detailTitle: document.getElementById('record-detail-title'),
    detailBody: document.getElementById('record-detail-body'),
    detailClose: document.getElementById('record-detail-close'),
    placeTitle: document.getElementById('place-focus-title'),
    placeSummary: document.getElementById('place-focus-summary'),
    placeDescription: document.getElementById('place-description'),
    placePurposeLabel: document.getElementById('place-purpose-title'),
    placePurpose: document.getElementById('place-purpose'),
    placeFrontMatterLabel: document.getElementById('place-front-matter-title'),
    placeFrontMatter: document.getElementById('place-front-matter'),
    occupants: document.getElementById('place-occupants'),
    placeThings: document.getElementById('place-things'),
    placeThingsPage: document.getElementById('place-things-page'),
    placeConversation: document.getElementById('place-conversation'),
    placeNotesPage: document.getElementById('place-notes-page'),
    conversationMode: document.getElementById('conversation-mode'),
    conversations: document.getElementById('conversation-stream'),
    conversationPage: document.getElementById('conversation-page'),
    activity: document.getElementById('activity-list'),
    happeningsPage: document.getElementById('happenings-page'),
    agreements: document.getElementById('agreement-list'),
    agreementsPage: document.getElementById('agreements-page'),
    archiveForm: document.getElementById('archive-form'),
    archiveQuery: document.getElementById('archive-query'),
    archiveMode: document.getElementById('archive-mode'),
    archiveType: document.getElementById('archive-type'),
    archiveSearch: document.getElementById('archive-search'),
    archiveResults: document.getElementById('archive-results'),
    archivePage: document.getElementById('archive-page'),
    gazetteRead: document.getElementById('gazette-read'),
    gazetteShare: document.getElementById('gazette-share'),
    gazetteSubmissionStatus: document.getElementById('gazette-submission-status'),
    gazetteIssueList: document.getElementById('gazette-issue-list'),
    gazetteIssuesPage: document.getElementById('gazette-issues-page'),
    gazetteIssue: document.getElementById('gazette-issue'),
    gazetteEntriesPage: document.getElementById('gazette-entries-page'),
    directorySearchField: document.querySelector('.directory-search-field'),
    viewFilters: document.querySelector('.view-filters'),
  }
  const tabs = [...document.querySelectorAll('[role="tab"][data-view]')]
  const panels = [...document.querySelectorAll('[role="tabpanel"]')]
  const viewShareButtons = [...document.querySelectorAll('[data-share-scope="view"]')]
  const detailShareButton = document.querySelector('[data-share-scope="detail"]')
  let bodyIdSequence = 0
  let branchRefreshOffset = 0
  let navigationRevision = 0
  let authoredRevision = 0
  let archiveRequestRevision = 0
  let thingLookupRequestRevision = 0
  let thingLookupController = null
  let thingLookupTimer = null
  let scheduledThingLookupQuery = ''
  let gazetteListRequestRevision = 0
  let gazetteListRequestPromise = null
  let gazetteDetailRequestRevision = 0
  let detailRequestRevision = 0
  let detailDrawingRequestRevision = 0
  let detailDrawingHistoryRequestRevision = 0
  let shareFeedbackRevision = 0
  let state = {
    failures: 0,
    refreshing: false,
    hasSnapshot: false,
    pollTimer: 0,
    changeMarker: null,
    snapshot: null,
    directory: {
      places: [], residents: [], loaded: false, loading: false, error: false,
      marker: null, recheckTimer: 0,
    },
    focusedPlaces: {},
    focusedResidents: {},
    histories: { notes: {}, things: {}, agreements: {}, events: {} },
    branches: {},
    residentPaging: {
      initialized: false, hasMore: false, nextBeforeId: null, loading: false, error: false,
      seenBeforeIds: [], automaticPageCount: 0, automaticPaused: false,
    },
    collapsedPlaceIds: [],
    sleeperPlaceIds: [],
    expandedBodies: [],
    fullBodies: {},
    detail: null,
    details: {},
    detailDrawings: {},
    detailDrawingHistories: {},
    archive: {
      query: '', mode: 'words', type: 'all', results: [], totalItems: 0,
      totalTextBytes: 0, nextBefore: null, hasMore: false, loading: false,
      initialized: false, error: null,
    },
    thingIndex: {
      scopeKey: '', rows: [], nextBeforeId: null, hasMore: false,
      loading: false, initialized: false, error: false,
    },
    thingLookup: {
      query: '', rows: [], hasMore: false, loading: false, error: false,
    },
    gazette: {
      firstPrintAt: null,
      submissionsOpen: null,
      issues: [],
      nextBeforeIssueNumber: null,
      hasMoreIssues: false,
      listLoading: false,
      listInitialized: false,
      listError: null,
      listRetryMode: 'initial',
      issue: null,
      entries: [],
      nextAfterOrdinal: null,
      hasMoreEntries: false,
      detailLoading: false,
      detailInitialized: false,
      detailError: null,
    },
    gazetteIssueId: null,
    view: 'map',
    directorySearch: '',
    directorySearchIndex: -1,
    placeId: null,
    resident: null,
    conversationContext: false,
    live: {
      openingMarker: null, openingEvents: [], openingLoaded: false, openingLoading: false,
      openingComplete: false, openingPaused: false, openingError: false,
      openingReplaySuppressed: false,
      openingNextBeforeId: null, streamError: false, streamMarker: null,
      changes: [], drawings: {}, noteBodies: {},
      highlightedKey: null, quietReads: 0, nextReadAt: null,
      lastChangeAt: null, clockTimer: 0,
      replayQueues: {}, replayActive: {}, replayPositions: {},
      replayReadyAtByActor: {},
      replaySeenKeys: [], replayRevealedKeys: [],
      focusResident: null, paused: false, absorptionEndsAtByPlaceId: {}, trailStarts: {},
      raisedItemKey: null, expandedResidentPlaceIds: [], expandedThingPlaceIds: [],
      focusRestoreKey: null, focusRestoreFallbackId: null,
      suppressReplayOnNextRead: false,
      proofScene: false, proofFailure: false, proofRetrySucceeded: false,
    },
  }
  let liveCamera = Object.freeze({
    scale: LIVE_CAMERA_CENTER_SCALE, offsetX: 0, offsetY: 0, stageId: null,
    panStart: null, pinchStart: null,
  })
  let liveFullscreenHistoryEntry = false
  let liveProofRestore = null
  let liveCameraFrame = 0
  let liveLabelFrame = 0
  let liveLabelNeedsFullRefresh = true
  let liveLabelLastFullRefresh = 0
  let liveLabelRefreshTimer = 0
  const liveLabelDimensions = new WeakMap()
  let liveReplayCompletionFrame = 0
  let liveReplayCompletions = Object.freeze([])
  let liveReplayStartTimer = 0
  let liveVisibilityRevision = 0
  let liveWasHidden = document.hidden
  let liveTrailExpiryTimer = 0
  let livePointers = Object.freeze({})
  let liveResidentVisibleIdsByPlaceId = Object.freeze({})
  let liveThingVisibleIdsByPlaceId = Object.freeze({})
  let liveResidentPointsByPlaceId = Object.freeze({})
  let liveThingPointsByPlaceId = Object.freeze({})
  let livePlotDetailContext = null
  let livePendingRevealPlaceId = null
  let livePendingRevealTarget = null
  let liveNoteQueue = Object.freeze([])
  let liveNoteFetches = 0
  let liveDrawingQueue = Object.freeze([])
  let liveDrawingFetches = 0
  const LIVE_PROOF_ROOT_ID = 9101
  const LIVE_PROOF_GARDEN_ID = 9102
  const LIVE_PROOF_WORKSHOP_ID = 9103
  const LIVE_PROOF_RETRY_ROOM_ID = 9104

  function element(tagName, className, text) {
    const node = document.createElement(tagName)
    if (className) node.className = className
    if (text !== undefined) node.textContent = String(text)
    return node
  }

  let portraitObserver = null
  const observedPortraitShells = new Set()
  const pendingPortraitShells = new Set()
  let portraitObservationScheduled = false

  function portraitUrl(type, id) {
    const path = '/api/drawing/' + encodeURIComponent(type) + '/' + String(id) + '/thumb.png'
    const revision = state.changeMarker || state.snapshot?.changeMarker || null
    return revision ? path + '?rev=' + encodeURIComponent(revision) : path
  }

  function loadPortraitImage(shell) {
    if (!shell.isConnected || shell.dataset.loaded === 'true') return
    shell.dataset.loaded = 'true'
    const image = element('img', 'entity-portrait-image')
    image.alt = ''
    image.width = 32
    image.height = 32
    image.loading = 'lazy'
    image.decoding = 'async'
    image.dataset.portraitType = shell.dataset.portraitType
    image.dataset.portraitId = shell.dataset.portraitId
    image.addEventListener('load', () => { shell.dataset.portraitState = 'loaded' })
    image.addEventListener('error', () => {
      shell.dataset.portraitState = 'placeholder'
      image.remove()
    })
    shell.append(image)
    image.src = portraitUrl(shell.dataset.portraitType, shell.dataset.portraitId)
  }

  function observePortraitShell(shell) {
    if (!shell.isConnected) return
    if (!('IntersectionObserver' in window)) {
      loadPortraitImage(shell)
      return
    }
    if (!portraitObserver) {
      portraitObserver = new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue
          portraitObserver.unobserve(entry.target)
          observedPortraitShells.delete(entry.target)
          loadPortraitImage(entry.target)
        }
      }, { rootMargin: '48px' })
    }
    observedPortraitShells.add(shell)
    portraitObserver.observe(shell)
  }

  function schedulePortraitShell(shell) {
    pendingPortraitShells.add(shell)
    if (portraitObservationScheduled) return
    portraitObservationScheduled = true
    window.queueMicrotask(() => {
      portraitObservationScheduled = false
      const pending = [...pendingPortraitShells]
      pendingPortraitShells.clear()
      for (const shell of pending) observePortraitShell(shell)
    })
  }

  function resetPortraitImages() {
    pendingPortraitShells.clear()
    if (portraitObserver) portraitObserver.disconnect()
    observedPortraitShells.clear()
  }

  function portraitNode(type, id, label, hasDrawing, className = '') {
    if (!hasDrawing) return document.createDocumentFragment()
    const shell = element('span', 'entity-portrait' + (className ? ' ' + className : ''))
    shell.setAttribute('aria-hidden', 'true')
    shell.title = label + ' drawing'
    shell.dataset.portraitType = type
    shell.dataset.portraitId = String(id)
    shell.append(element('span', 'entity-portrait-placeholder'))
    schedulePortraitShell(shell)
    return shell
  }

  function drawingRowsFor(drawing) {
    return Object.freeze(Array.from({ length: 8 }, (_, row) => drawing.indices
      .slice(row * 8, row * 8 + 8)
      .map(index => index === null ? '.' : String(index))
      .join(' ')))
  }

  function safeDrawingText(value, maximumBytes, allowEmpty) {
    const text = safeExactText(value, null, maximumBytes, allowEmpty)
    if (text === null) return null
    try {
      return new TextEncoder().encode(text).byteLength <= maximumBytes ? text : null
    } catch {
      return null
    }
  }

  function normalizeDrawingSnapshot(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const state = ['undrawn', 'refused', 'in_progress', 'complete'].includes(raw.state)
      ? raw.state
      : null
    if (!state) return null
    const drawing = raw.drawing === null ? null : normalizeWindowDrawing(raw.drawing)
    if (raw.drawing !== null && !drawing) return null
    if ((state === 'undrawn' || state === 'refused') !== (drawing === null)) return null
    const presentationState = windowDrawingStateLabel(state, drawing).toLowerCase()
      .replace(' ', '_')
    if (raw.presentation_state !== presentationState) return null
    const description = state === 'undrawn'
      ? raw.description === null ? null : undefined
      : safeDrawingText(raw.description, 280, true)
    if (description === undefined || (state !== 'undrawn' && description === null)) return null
    const rows = drawing ? drawingRowsFor(drawing) : null
    if (rows) {
      if (!Array.isArray(raw.rows) || raw.rows.length !== 8 ||
          raw.rows.some((row, index) => row !== rows[index])) return null
    } else if (raw.rows !== null) return null
    const source = ['none', 'resident', 'place', 'thing', 'kind_base', 'kind_variant']
      .includes(raw.source) ? raw.source : null
    if (!source || (state === 'undrawn') !== (source === 'none')) return null
    const rawKindId = raw.kind_id ?? null
    const rawKindName = raw.kind_name ?? null
    const rawRevision = raw.revision ?? null
    const rawVariantName = raw.variant_name ?? null
    const kindId = rawKindId === null ? null : safeId(rawKindId)
    const kindName = rawKindName === null ? null : safeDrawingText(rawKindName, 64, false)
    const revision = rawRevision === null ? null : safeId(rawRevision)
    const variantName = rawVariantName === null
      ? null
      : safeDrawingText(rawVariantName, 64, false)
    if ((rawKindId !== null && !kindId) || (rawKindName !== null && !kindName) ||
        (rawRevision !== null && !revision) || (rawVariantName !== null && !variantName)) {
      return null
    }
    if (source === 'kind_base' || source === 'kind_variant') {
      if (!kindId || !kindName || !revision) return null
      if ((source === 'kind_variant') !== Boolean(variantName)) return null
    } else if (variantName) return null
    return Object.freeze({
      state,
      presentation_state: presentationState,
      description,
      drawing,
      rows,
      source,
      kind_id: kindId,
      kind_name: kindName,
      revision,
      variant_name: variantName,
    })
  }

  function normalizeDrawingRead(type, id, payload) {
    if (!payload || typeof payload !== 'object' || payload.type !== type ||
        safeId(payload.id) !== id) return null
    return normalizeDrawingSnapshot(payload)
  }

  function normalizeDrawingRevision(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const id = safeId(raw.id)
    const slotVariantName = raw.slot_variant_name === null
      ? null
      : safeDrawingText(raw.slot_variant_name, 64, false)
    const previous = normalizeDrawingSnapshot(raw.previous)
    const current = normalizeDrawingSnapshot(raw.current)
    const rawAuthorId = raw.author?.id ?? null
    const rawAuthorHandle = raw.author?.handle ?? null
    const authorId = rawAuthorId === null ? null : safeId(rawAuthorId)
    const authorHandle = rawAuthorHandle === null ? null : safeHandle(rawAuthorHandle)
    const authorRelation = safeDrawingText(raw.author?.relation, 64, false)
    const createdAt = safeDate(raw.created_at)
    if (!id || (raw.slot_variant_name !== null && !slotVariantName) || !previous || !current ||
        (rawAuthorId !== null && !authorId) || (rawAuthorHandle !== null && !authorHandle) ||
        Boolean(authorId) !== Boolean(authorHandle) || !authorRelation || !createdAt) return null
    return Object.freeze({
      id,
      slot_variant_name: slotVariantName,
      previous,
      current,
      author: Object.freeze({ id: authorId, handle: authorHandle, relation: authorRelation }),
      created_at: createdAt.toISOString(),
    })
  }

  function normalizeDrawingHistory(type, id, payload) {
    if (!payload || typeof payload !== 'object' || payload.type !== type ||
        safeId(payload.id) !== id || !Array.isArray(payload.revisions) ||
        payload.revisions.length > 20 || !payload.page || typeof payload.page !== 'object' ||
        payload.page.limit !== 20 || typeof payload.page.has_more !== 'boolean') return null
    const revisions = payload.revisions.map(normalizeDrawingRevision)
    if (revisions.some(revision => !revision) ||
        new Set(revisions.map(revision => revision.id)).size !== revisions.length) return null
    const nextBefore = payload.page.next_before === null ? null : safeId(payload.page.next_before)
    if (payload.page.has_more !== Boolean(nextBefore)) return null
    return Object.freeze({
      revisions: Object.freeze(revisions),
      hasMore: payload.page.has_more,
      nextBefore,
    })
  }

  function liveProofPayload(now) {
    const rootId = LIVE_PROOF_ROOT_ID
    const gardenId = LIVE_PROOF_GARDEN_ID
    const workshopId = LIVE_PROOF_WORKSHOP_ID
    const retryRoomId = LIVE_PROOF_RETRY_ROOM_ID
    const residents = Array.from({ length: 7 }, (_, index) => ({
      id: 9201 + index,
      handle: ['proof-alex', 'proof-bea', 'proof-cato', 'proof-dara',
        'proof-eli', 'proof-fia', 'proof-gus'][index],
      current_place_id: workshopId,
      joined_at: new Date(now - 86_400_000 - index * 1_000).toISOString(),
      asleep: false,
      has_drawing: index === 0,
    }))
    const things = Array.from({ length: 7 }, (_, index) => ({
      id: 9401 + index,
      place_id: workshopId,
      name: ['pace lantern', 'shared compass', 'talking kettle', 'motion bell',
        'crowd map', 'retry key', 'quiet marker'][index],
      body: 'A preview-only proof object.',
      maker_id: residents[0].id,
      made_by: residents[0].handle,
      current_owner_id: residents[0].id,
      current_owner: residents[0].handle,
      owner: residents[0].handle,
      open_to_use: true,
      kind: index === 0 ? null : 'proof-object',
      traits: [],
      created_at: new Date(now - 120_000 - index * 1_000).toISOString(),
      moderated: false,
      kind_moderated: false,
      has_drawing: index !== 5,
    }))
    const child = (id, name, thingCount) => ({
      id,
      parent_id: rootId,
      name,
      owner: 'proof-alex',
      purpose: 'Preview-only Live View proof ground.',
      front_matter: [],
      places: 0,
      things: thingCount,
      notes: 0,
      moderated: false,
      children: [],
    })
    const children = [
      child(gardenId, 'Movement garden', 0),
      child(workshopId, 'Crowded activity workshop', things.length),
      child(retryRoomId, 'Retry room', 0),
    ]
    const places = [{
      id: rootId,
      parent_id: null,
      name: WORLD_ROOT_NAME,
      owner: null,
      purpose: 'Repeatable preview proof ground.',
      front_matter: [],
      places: children.length,
      things: 0,
      notes: 0,
      moderated: false,
      children,
    }]
    const snapshot = {
      view: 'outline',
      change_marker: '9500',
      places,
      residents,
      notes: [],
      things,
      agreements: [],
      events: [],
      totals: {
        places: 4,
        residents: residents.length,
        conversations: 1,
        things: things.length,
        agreements: 0,
        events: 5,
      },
      pages: Object.fromEntries(['places', 'residents', 'notes', 'things',
        'agreements', 'events'].map(collection => [collection, { has_more: false }])),
      live_survey: [
        { id: rootId, parent_id: null, things: 0 },
        ...children.map(place => ({
          id: place.id,
          parent_id: rootId,
          things: place.things,
        })),
      ],
      refreshed_at: new Date(now).toISOString(),
    }
    const at = new Date(now - 100).toISOString()
    const changes = [
      { change_id: '9501', created_at: at, kind: 'action', actor: 'proof-alex',
        detail: { action: 'move', status: 'applied',
          from_place_id: gardenId, to_place_id: workshopId } },
      { change_id: '9502', created_at: at, kind: 'action', actor: 'proof-bea',
        detail: { action: 'move', status: 'applied',
          from_place_id: gardenId, to_place_id: workshopId } },
      { change_id: '9503', created_at: new Date(now - 50).toISOString(), kind: 'note',
        actor: 'proof-alex', detail: { place_id: workshopId, note_id: 9301 } },
      { change_id: '9504', created_at: new Date(now - 25).toISOString(), kind: 'action',
        actor: 'proof-alex', detail: { action: 'use', status: 'applied',
          place_id: workshopId, source_thing_id: things[0].id } },
      { change_id: '9505', created_at: new Date(now - 25).toISOString(), kind: 'action',
        actor: 'proof-bea', detail: { action: 'use', status: 'applied',
          place_id: workshopId, source_thing_id: things[1].id } },
    ]
    return Object.freeze({ rootId, snapshot, changes, residents, things })
  }

  function liveProofDrawings(proof) {
    const pixels = Object.freeze({
      palette: Object.freeze(['#174d3c', '#f0c95f']),
      indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? 0 : 1)),
    })
    const alternate = Object.freeze({
      palette: Object.freeze(['#d95c46', '#174d3c']),
      indices: Object.freeze(Array.from({ length: 64 }, (_, index) => index % 2)),
    })
    const blank = Object.freeze({
      palette: Object.freeze([]),
      indices: Object.freeze(Array.from({ length: 64 }, () => null)),
    })
    const held = (state, drawing, description, source, kind = {}) => Object.freeze({
      loading: false,
      loaded: true,
      error: false,
      state,
      presentation_state: windowDrawingStateLabel(state, drawing).toLowerCase().replace(' ', '_'),
      description,
      drawing,
      rows: drawing ? drawingRowsFor(drawing) : null,
      source,
      kind_id: kind.kind_id ?? null,
      kind_name: kind.kind_name ?? null,
      revision: kind.revision ?? null,
      variant_name: kind.variant_name ?? null,
    })
    const undrawn = () => held('undrawn', null, null, 'none')
    const base = Object.freeze({ kind_id: 9601, kind_name: 'proof-object', revision: 3 })
    const entries = [
      ['place:' + String(LIVE_PROOF_ROOT_ID), undrawn()],
      ['place:' + String(LIVE_PROOF_GARDEN_ID),
        held('refused', null, 'This proof place declines a drawing.', 'place')],
      ['place:' + String(LIVE_PROOF_WORKSHOP_ID),
        held('in_progress', pixels, 'The workshop outline is still being drawn.', 'place')],
      ['place:' + String(LIVE_PROOF_RETRY_ROOM_ID),
        held('complete', blank, 'An intentionally transparent room.', 'place')],
      ['resident:' + String(proof.residents[0].id),
        held('complete', alternate, 'Proof Alex drew this portrait.', 'resident')],
      ['resident:' + String(proof.residents[1].id),
        held('refused', null, 'Proof Bea chose not to draw.', 'resident')],
      ...proof.residents.slice(2).map(resident => ['resident:' + String(resident.id), undrawn()]),
      ['thing:' + String(proof.things[0].id),
        held('complete', pixels, 'An untyped owner drawing.', 'thing')],
      ['thing:' + String(proof.things[1].id),
        held('complete', alternate, 'The pinned kind base.', 'kind_base', base)],
      ['thing:' + String(proof.things[2].id), held(
        'complete', pixels, 'The ember glow named variant.', 'kind_variant',
        Object.freeze({ ...base, variant_name: 'ember glow' }),
      )],
      ['thing:' + String(proof.things[3].id),
        held('in_progress', alternate, 'An owner-selected base still in progress.', 'kind_base', base)],
      ['thing:' + String(proof.things[4].id),
        held('complete', blank, 'A deliberately blank named variant.', 'kind_variant',
          Object.freeze({ ...base, variant_name: 'clear glass' }))],
      ['thing:' + String(proof.things[5].id),
        held('refused', null, 'This thing owner explicitly refused.', 'thing', base)],
      ['thing:' + String(proof.things[6].id),
        held('complete', alternate, 'Another pinned kind base.', 'kind_base', base)],
    ]
    return Object.freeze(Object.fromEntries(entries))
  }

  function startLiveProofScene() {
    if (nodes.liveProof?.dataset.previewAvailable !== 'true') return
    if (liveReplayHeldKeys().size) settleLiveReplays()
    window.clearTimeout(state.pollTimer)
    window.clearTimeout(state.live.clockTimer)
    navigationRevision += 1
    authoredRevision += 1
    if (!liveProofRestore) {
      liveProofRestore = Object.freeze({
        state,
        liveCamera,
        liveResidentVisibleIdsByPlaceId,
        liveThingVisibleIdsByPlaceId,
        liveResidentPointsByPlaceId,
        liveThingPointsByPlaceId,
      })
    }
    const now = Date.now()
    const proof = liveProofPayload(now)
    const normalized = normalizeSnapshot(proof.snapshot)
    const navigation = freshSnapshotNavigation(normalized)
    const changes = Object.freeze(normalizeLiveChanges(proof.changes))
    const directory = Object.freeze({
      places: Object.freeze(normalized.flatPlaces.map(place => Object.freeze({
        id: place.id, parent_id: place.parent_id, name: place.name, path: place.path,
      }))),
      residents: Object.freeze(normalized.residents.map(resident => Object.freeze({
        id: resident.id, handle: resident.handle,
      }))),
      loaded: true,
      loading: false,
      error: false,
      marker: '9500',
      recheckTimer: 0,
    })
    liveResidentVisibleIdsByPlaceId = Object.freeze({})
    liveThingVisibleIdsByPlaceId = Object.freeze({})
    liveResidentPointsByPlaceId = Object.freeze({})
    liveThingPointsByPlaceId = Object.freeze({})
    liveCamera = Object.freeze({
      scale: LIVE_CAMERA_CENTER_SCALE,
      offsetX: 0,
      offsetY: 0,
      stageId: null,
      panStart: null,
      pinchStart: null,
    })
    state = {
      ...state,
      refreshing: false,
      hasSnapshot: true,
      pollTimer: 0,
      changeMarker: '9500',
      snapshot: navigation.snapshot,
      directory,
      focusedPlaces: {},
      focusedResidents: {},
      histories: freshSnapshotHistories(navigation.snapshot),
      branches: navigation.branches,
      residentPaging: navigation.residentPaging,
      placeId: null,
      resident: null,
      conversationContext: false,
      live: {
        ...state.live,
        openingMarker: '9500',
        openingEvents: [],
        openingLoaded: true,
        openingLoading: false,
        openingComplete: true,
        openingPaused: false,
        openingError: false,
        openingReplaySuppressed: false,
        openingNextBeforeId: null,
        streamError: false,
        streamMarker: '9500',
        changes,
        drawings: liveProofDrawings(proof),
        noteBodies: Object.freeze({
          '9301': Object.freeze({
            loading: false,
            error: false,
            body: 'spoke: two residents move together while this message appears.',
          }),
        }),
        highlightedKey: null,
        quietReads: 0,
        nextReadAt: now + 25_000,
        lastChangeAt: now,
        clockTimer: 0,
        replayQueues: {},
        replayActive: {},
        replayPositions: {},
        replayReadyAtByActor: {},
        replaySeenKeys: [],
        replayRevealedKeys: [],
        focusResident: null,
        paused: false,
        absorptionEndsAtByPlaceId: {},
        trailStarts: {},
        raisedItemKey: null,
        expandedResidentPlaceIds: [],
        expandedThingPlaceIds: [],
        focusRestoreKey: null,
        focusRestoreFallbackId: null,
        suppressReplayOnNextRead: false,
        proofScene: true,
        proofFailure: true,
        proofRetrySucceeded: false,
      },
    }
    const panel = document.getElementById('live-panel')
    if (panel) panel.dataset.liveProof = 'true'
    populateFilters(state.snapshot)
    queueLiveReplays(changes)
    renderAll()
    setStatus('Running the repeatable preview proof scene', 'live')
  }

  function exitLiveProofScene() {
    if (!liveProofRestore) return
    if (liveReplayHeldKeys().size) settleLiveReplays()
    window.clearTimeout(state.pollTimer)
    window.clearTimeout(state.live.clockTimer)
    const restore = liveProofRestore
    liveProofRestore = null
    state = {
      ...restore.state,
      refreshing: false,
      pollTimer: 0,
      live: { ...restore.state.live, clockTimer: 0, nextReadAt: null },
    }
    liveCamera = restore.liveCamera
    liveResidentVisibleIdsByPlaceId = restore.liveResidentVisibleIdsByPlaceId
    liveThingVisibleIdsByPlaceId = restore.liveThingVisibleIdsByPlaceId
    liveResidentPointsByPlaceId = restore.liveResidentPointsByPlaceId
    liveThingPointsByPlaceId = restore.liveThingPointsByPlaceId
    const panel = document.getElementById('live-panel')
    if (panel) delete panel.dataset.liveProof
    if (state.snapshot) populateFilters(state.snapshot)
    renderAll()
    scheduleRefresh(0)
  }

  function liveProofLoadNode(focus, survey) {
    if (!state.live.proofScene ||
        ![LIVE_PROOF_ROOT_ID, LIVE_PROOF_RETRY_ROOM_ID].includes(focus.id)) return null
    const row = element('section', state.live.proofFailure
      ? 'live-proof-load live-proof-load-failed'
      : 'live-proof-load live-proof-load-ready')
    if (focus.id === LIVE_PROOF_ROOT_ID) {
      const retryPlot = survey.plots.find(plot => plot.id === LIVE_PROOF_RETRY_ROOM_ID)
      if (!retryPlot) return null
      row.style.left = String(retryPlot.x + 12) + 'px'
      row.style.top = String(retryPlot.y + 48) + 'px'
      row.style.width = '12rem'
    } else {
      row.style.left = String(Math.max(24, survey.width / 2 - 144)) + 'px'
      row.style.top = String(Math.max(72, survey.height / 2 - 80)) + 'px'
    }
    if (state.live.proofFailure) {
      row.append(element('strong', '', 'Forced preview failure'))
      row.append(element('span', '', 'The proof room did not load. This is deliberate.'))
      const retry = element('button', 'selection-retry', 'Retry proof room')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-proof-retry'
      retry.addEventListener('click', () => {
        state = { ...state, live: {
          ...state.live,
          proofFailure: false,
          proofRetrySucceeded: true,
        } }
        if (state.snapshot) {
          renderLive(state.snapshot)
          window.queueMicrotask(() =>
            revealLiveElements(liveRevealTargetsForPlace(LIVE_PROOF_WORKSHOP_ID)))
        }
      })
      row.append(retry)
    } else {
      row.append(element('strong', '', 'Proof room loaded on Retry'))
    }
    return row
  }
${WINDOW_CLIENT_SAFETY_JS}

  function readLiveFocusResident() {
    try {
      const value = localStorage.getItem(LIVE_FOCUS_STORAGE_KEY)
      if (typeof value === 'string' && SAFE_HANDLE.test(value)) return value
      if (value !== null) localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // Focus is optional per-viewer presentation; storage refusal leaves it unset.
    }
    return null
  }

  function storeLiveFocusResident(handle) {
    try {
      if (handle) localStorage.setItem(LIVE_FOCUS_STORAGE_KEY, handle)
      else localStorage.removeItem(LIVE_FOCUS_STORAGE_KEY)
    } catch {
      // The in-memory focus still works for this page when storage is unavailable.
    }
  }

  function setLiveFocusResident(handle) {
    const next = typeof handle === 'string' && SAFE_HANDLE.test(handle) ? handle : null
    storeLiveFocusResident(next)
    state = { ...state, live: { ...state.live, focusResident: next } }
    if (next && state.view === 'live' && state.resident) {
      navigate({ resident: null, conversationContext: false })
      return
    }
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
  }

  function toggleLiveFocusResident(handle) {
    setLiveFocusResident(state.live.focusResident === handle ? null : handle)
  }

  function setLiveRaisedItem(key) {
    state = { ...state, live: { ...state.live, raisedItemKey: key } }
    for (const node of nodes.livePlates?.querySelectorAll('[data-live-item-key]') || []) {
      if (node.dataset.liveItemKey === key) node.setAttribute('data-live-raised', 'true')
      else node.removeAttribute('data-live-raised')
    }
    syncLivePlotVisibility()
    scheduleLiveResidentLabels(true)
  }

  function bindLiveActivation(control, raiseTarget, key, open) {
    control.addEventListener('pointerdown', event => {
      control.dataset.livePointerType = event.pointerType || ''
    })
    control.addEventListener('pointercancel', () => {
      delete control.dataset.livePointerType
    })
    control.addEventListener('click', event => {
      const pointerType = event.pointerType || control.dataset.livePointerType || ''
      delete control.dataset.livePointerType
      if (windowLiveTouchActivation(pointerType, state.live.raisedItemKey, key) ===
          'bring-forward') {
        event.preventDefault()
        event.stopPropagation()
        raiseTarget.dataset.liveItemKey = key
        setLiveRaisedItem(key)
        control.focus({ preventScroll: true })
        return
      }
      setLiveRaisedItem(key)
      if (open) {
        event.preventDefault()
        open()
      }
    })
  }

  function requestLiveFocusRestore(
    focusKey,
    fallbackId = 'live-plates',
    revealPlaceId = null,
  ) {
    livePendingRevealPlaceId = safeId(revealPlaceId)
    livePendingRevealTarget = liveStageTargetForElements(
      document.querySelectorAll('[data-focus-key="' + CSS.escape(focusKey) + '"]'),
    )
    state = {
      ...state,
      live: {
        ...state.live,
        focusRestoreKey: focusKey,
        focusRestoreFallbackId: fallbackId,
      },
    }
  }

  function liveRevealTargetsForPlace(placeId) {
    const safePlaceId = safeId(placeId)
    if (!safePlaceId || !nodes.livePlates) return []
    return [...nodes.livePlates.querySelectorAll(
      '[data-live-overflow-place-id="' + String(safePlaceId) + '"]',
    )]
  }

  function flushLiveFocusRestore() {
    const focusKey = state.live.focusRestoreKey
    const fallbackId = state.live.focusRestoreFallbackId
    if (!focusKey) return
    const revealPlaceId = livePendingRevealPlaceId
    const revealTarget = livePendingRevealTarget
    livePendingRevealPlaceId = null
    livePendingRevealTarget = null
    state = {
      ...state,
      live: {
        ...state.live,
        focusRestoreKey: null,
        focusRestoreFallbackId: null,
      },
    }
    window.queueMicrotask(() => {
      const focusTargets = [...document.querySelectorAll(
        '[data-focus-key="' + CSS.escape(focusKey) + '"]',
      )].filter(target => !target.closest('[hidden]'))
      const placeTargets = liveRevealTargetsForPlace(revealPlaceId)
      if (!revealLiveElements(focusTargets.length ? focusTargets : placeTargets) &&
          revealTarget) revealLiveStageTarget(revealTarget)
      restoreFocus(focusKey, null, fallbackId || null)
    })
  }

  function renderLiveFocusStatus() {
    if (!nodes.liveFocusStatus) return
    const handle = state.live.focusResident
    nodes.liveFocusStatus.dataset.focused = String(Boolean(handle))
    if (!handle) {
      nodes.liveFocusStatus.replaceChildren(document.createTextNode(
        'No resident focused. Click a resident to keep them and their visible interaction partners in view.'
      ))
      return
    }
    const message = element('span', '', 'Focused on ' + handle +
      '. Finite plate slots prioritize them while they are on this plate; if they leave, the Focus / Interactions board names their actual location. The complete roster and board keep every safely identified partner visible. ')
    const clear = element('button', 'live-focus-clear', 'Clear focus')
    clear.type = 'button'
    clear.setAttribute('aria-label', 'Clear resident focus')
    clear.dataset.focusKey = 'live-focus-clear'
    clear.addEventListener('click', () => setLiveFocusResident(null))
    nodes.liveFocusStatus.replaceChildren(message, clear)
  }

  function clampLiveScale(value) {
    return windowLiveClampZoomScale(
      value, LIVE_CAMERA_MIN_SCALE, LIVE_CAMERA_MAX_SCALE)
  }

  function liveScreenRectsOverlap(left, right, gap = 3) {
    return left.left < right.right + gap && left.right + gap > right.left &&
      left.top < right.bottom + gap && left.bottom + gap > right.top
  }

  function renderLiveResidentLabels(frameTime) {
    liveLabelFrame = 0
    if (!nodes.liveLabelLayer || !nodes.liveStage || !nodes.livePlates ||
        state.view !== 'live') return
    const fullRefresh = liveLabelNeedsFullRefresh ||
      frameTime - liveLabelLastFullRefresh >= LIVE_LABEL_FULL_REFRESH_MS
    liveLabelNeedsFullRefresh = false
    if (fullRefresh) {
      liveLabelLastFullRefresh = frameTime
      if (liveLabelRefreshTimer) {
        window.clearTimeout(liveLabelRefreshTimer)
        liveLabelRefreshTimer = 0
      }
    }
    const readable = nodes.liveStage.dataset.liveLabelMode === 'readable'
    const activeElement = document.activeElement
    const layerRect = nodes.liveLabelLayer.getBoundingClientRect()
    const existingTags = new Map([...nodes.liveLabelLayer.querySelectorAll(
      '[data-live-resident-tag]')].map(tag => [tag.dataset.liveResidentTag, tag]))
    const residents = [...nodes.livePlates.querySelectorAll(
      '.live-walker .live-portrait[data-live-resident-handle], ' +
      '.live-replay-portrait .live-portrait[data-live-resident-handle]')]
      .flatMap(portrait => {
        const shell = portrait.closest('.live-walker, .live-replay-portrait')
        if (!shell) return []
        const focused = shell.hasAttribute('data-live-focus-resident')
        const intent = shell.matches(':hover') || portrait === activeElement ||
          portrait.contains(activeElement)
        const handle = portrait.dataset.liveResidentHandle
        if (!handle) return []
        const raised = state.live.raisedItemKey === 'resident:' + handle
        if (!readable && !focused && !intent && !raised) return []
        const existingTag = existingTags.get(handle)
        const priority = raised ? 0 : focused ? 1 : intent ? 2 : 3
        const moving = shell.classList.contains('live-replay-portrait') &&
          shell.hasAttribute('data-replay-duration')
        if (!fullRefresh && priority === 3 && existingTag?.dataset.livePacked !== 'true') {
          return [{ existingTag, focused, handle, intent, measured: false, moving,
            portraitRect: null, priority, raised }]
        }
        const portraitRect = portrait.getBoundingClientRect()
        const visible = portraitRect.width > 0 && portraitRect.height > 0 &&
          portraitRect.right > layerRect.left && portraitRect.left < layerRect.right &&
          portraitRect.bottom > layerRect.top && portraitRect.top < layerRect.bottom
        const tag = existingTag || element('span', 'live-resident-tag', handle)
        return [{
          existingTag: tag,
          focused,
          handle,
          intent,
          measured: true,
          tag,
          portraitRect: visible ? portraitRect : null,
          moving,
          priority,
          raised,
        }]
      })
    const candidates = residents.filter(candidate => candidate.portraitRect && candidate.tag)
      .sort((left, right) => left.priority - right.priority ||
        left.portraitRect.top - right.portraitRect.top ||
        left.portraitRect.left - right.portraitRect.left)
    const movingResidents = residents.some(resident => resident.moving)
    const occupied = [...nodes.livePlates.querySelectorAll('.live-speech-bubble')]
      .flatMap(bubble => {
        const rect = bubble.getBoundingClientRect()
        if (!(rect.width > 0 && rect.height > 0)) return []
        return [{
          left: rect.left - layerRect.left,
          right: rect.right - layerRect.left,
          top: rect.top - layerRect.top,
          bottom: rect.bottom - layerRect.top,
        }]
      })
    for (const resident of residents) {
      if (resident.measured && resident.existingTag) {
        resident.existingTag.dataset.livePacked = 'false'
      }
    }
    for (const candidate of candidates) {
      if (!candidate.tag.dataset.liveResidentTag) {
        candidate.tag.dataset.liveResidentTag = candidate.handle
      }
      if (candidate.focused) candidate.tag.dataset.liveFocusResident = candidate.handle
      else delete candidate.tag.dataset.liveFocusResident
      if (candidate.intent) candidate.tag.dataset.liveIntent = 'true'
      else delete candidate.tag.dataset.liveIntent
      if (candidate.raised) candidate.tag.dataset.liveRaised = 'true'
      else delete candidate.tag.dataset.liveRaised
    }
    if (fullRefresh) {
      const labels = candidates.map(candidate => candidate.tag)
      const heldLabels = [...nodes.liveLabelLayer.children]
      if (labels.length !== heldLabels.length ||
          labels.some((label, index) => label !== heldLabels[index])) {
        nodes.liveLabelLayer.replaceChildren(...labels)
      }
    }
    if (!candidates.length) {
      if (movingResidents || !fullRefresh) scheduleLiveResidentLabelRefresh()
      return
    }

    const margin = 4
    const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value))
    for (const candidate of candidates) {
      if (!liveLabelDimensions.has(candidate.tag)) {
        const tagRect = candidate.tag.getBoundingClientRect()
        liveLabelDimensions.set(candidate.tag, Object.freeze({
          width: tagRect.width,
          height: tagRect.height,
        }))
      }
    }
    for (const candidate of candidates) {
      const { width, height } = liveLabelDimensions.get(candidate.tag)
      const maximumLeft = Math.max(margin, layerRect.width - margin - width)
      const maximumTop = Math.max(margin, layerRect.height - margin - height)
      const anchorLeft = candidate.portraitRect.left - layerRect.left +
        (candidate.portraitRect.width - width) / 2
      const aboveTop = candidate.portraitRect.top - layerRect.top - height - 5
      const belowTop = candidate.portraitRect.bottom - layerRect.top + 5
      const stepY = height + 5
      const stepX = Math.max(36, width * 0.55)
      const positions = []
      const seen = new Set()
      const offer = (left, top) => {
        const held = Object.freeze({
          left: clamp(left, margin, maximumLeft),
          top: clamp(top, margin, maximumTop),
        })
        const key = held.left.toFixed(2) + ':' + held.top.toFixed(2)
        if (seen.has(key)) return
        seen.add(key)
        positions.push(held)
      }
      const laneLimit = candidate.priority < 3 ? 20 : 8
      for (let lane = 0; lane < laneLimit; lane += 1) {
        for (const horizontal of [0, -stepX, stepX]) {
          offer(anchorLeft + horizontal, aboveTop - lane * stepY)
          offer(anchorLeft + horizontal, belowTop + lane * stepY)
        }
      }
      let chosen = positions.find(position => {
        const rect = {
          left: position.left,
          right: position.left + width,
          top: position.top,
          bottom: position.top + height,
        }
        return !occupied.some(other => liveScreenRectsOverlap(rect, other))
      })
      if (!chosen && candidate.priority < 3) {
        const verticalStep = height + 5
        for (let top = margin; top <= maximumTop && !chosen; top += verticalStep) {
          for (let left = margin; left <= maximumLeft; left += 8) {
            const rect = { left, right: left + width, top, bottom: top + height }
            if (!occupied.some(other => liveScreenRectsOverlap(rect, other))) {
              chosen = Object.freeze({ left, top })
              break
            }
          }
        }
      }
      if (!chosen) continue
      candidate.tag.style.left = String(chosen.left) + 'px'
      candidate.tag.style.top = String(chosen.top) + 'px'
      candidate.tag.dataset.livePacked = 'true'
      occupied.push(Object.freeze({
        left: chosen.left,
        right: chosen.left + width,
        top: chosen.top,
        bottom: chosen.top + height,
      }))
    }
    const movingResidentCount = residents.filter(resident => resident.moving).length
    if (movingResidentCount <= LIVE_LABEL_CONTINUOUS_LIMIT &&
        candidates.some(candidate => candidate.moving &&
          candidate.tag.dataset.livePacked === 'true')) {
      scheduleLiveResidentLabels()
    } else if (movingResidents || !fullRefresh) {
      scheduleLiveResidentLabelRefresh()
    }
  }

  function scheduleLiveResidentLabelRefresh() {
    if (liveLabelRefreshTimer || state.view !== 'live' || document.hidden) return
    liveLabelRefreshTimer = window.setTimeout(() => {
      liveLabelRefreshTimer = 0
      scheduleLiveResidentLabels(true)
    }, LIVE_LABEL_FULL_REFRESH_MS)
  }

  function scheduleLiveResidentLabels(fullRefresh = false) {
    if (fullRefresh) {
      liveLabelNeedsFullRefresh = true
      if (liveLabelRefreshTimer) {
        window.clearTimeout(liveLabelRefreshTimer)
        liveLabelRefreshTimer = 0
      }
    }
    if (!nodes.liveLabelLayer || liveLabelFrame) return
    liveLabelFrame = window.requestAnimationFrame(renderLiveResidentLabels)
  }

  function liveCameraViewport() {
    if (!nodes.liveViewport || !(liveCamera.scale > 0)) return null
    return Object.freeze({
      left: -liveCamera.offsetX / liveCamera.scale,
      top: -liveCamera.offsetY / liveCamera.scale,
      right: (nodes.liveViewport.clientWidth - liveCamera.offsetX) / liveCamera.scale,
      bottom: (nodes.liveViewport.clientHeight - liveCamera.offsetY) / liveCamera.scale,
    })
  }

  function liveDetailedPlotIds(plots, expandedGrounds = Object.freeze({})) {
    const viewport = liveCameraViewport()
    return new Set(viewport ? windowLiveVisiblePlotIds(
      plots, expandedGrounds, viewport, LIVE_PLOT_OVERSCAN,
    ) : [])
  }

  function livePlotHasFocusedDetail(node) {
    return node.dataset.liveFocusPlot === 'true' || node.dataset.liveRaised === 'true' ||
      Boolean(node.querySelector(
      '[data-live-focus-resident], [data-live-focus-partner], [data-live-focus-thing], ' +
      '[data-live-raised="true"]',
    ))
  }

  function syncLivePlotVisibility() {
    if (!nodes.liveViewport || !nodes.livePlates || !(liveCamera.scale > 0)) return
    const plots = [...nodes.livePlates.querySelectorAll('.live-plot')].flatMap(node => {
      const plot = {
        id: safeId(node.dataset.placeId),
        x: Number(node.dataset.livePlotX),
        y: Number(node.dataset.livePlotY),
        width: Number(node.dataset.livePlotWidth),
        height: Number(node.dataset.livePlotHeight),
      }
      return plot.id ? [plot] : []
    })
    const visibleIds = liveDetailedPlotIds(
      plots,
      livePlotDetailContext?.expandedGrounds || Object.freeze({}),
    )
    for (const node of nodes.livePlates.querySelectorAll('.live-plot')) {
      const placeId = safeId(node.dataset.placeId)
      const detailed = visibleIds.has(placeId) ||
        livePlotHasFocusedDetail(node)
      node.dataset.liveDetail = String(detailed)
      if (detailed && placeId && livePlotDetailContext) {
        const place = livePlotDetailContext.children.find(candidate => candidate.id === placeId)
        if (place) mountLivePlaceDetail(node, livePlotDetailContext, place)
      } else if (!detailed) {
        unmountLivePlaceDetail(node)
      }
    }
    refillLiveDrawingQueue()
    drainLiveDrawingQueue()
  }

  function commitLiveCamera() {
    liveCameraFrame = 0
    if (!nodes.liveStage) return
    const previousLabelMode = nodes.liveStage.dataset.liveLabelMode
    nodes.liveStage.style.transform = 'translate3d(' + String(liveCamera.offsetX) + 'px, ' +
      String(liveCamera.offsetY) + 'px, 0) scale(' + String(liveCamera.scale) + ')'
    nodes.liveStage.dataset.liveScale = String(liveCamera.scale)
    nodes.liveStage.dataset.liveOffsetX = String(liveCamera.offsetX)
    nodes.liveStage.dataset.liveOffsetY = String(liveCamera.offsetY)
    const labelMode = windowLiveResidentLabelMode(liveCamera.scale, LIVE_LABEL_READABLE_SCALE)
    nodes.liveStage.dataset.liveLabelMode = labelMode
    syncLivePlotVisibility()
    scheduleLiveResidentLabels(previousLabelMode !== labelMode)
  }

  function applyLiveCamera(next) {
    liveCamera = Object.freeze({ ...liveCamera, ...next })
    if (!nodes.liveStage || liveCameraFrame) return
    liveCameraFrame = window.requestAnimationFrame(commitLiveCamera)
  }

  function liveCameraForStageTarget(target, center = false) {
    if (!nodes.liveViewport || !target) return null
    const base = center
      ? windowLiveCenterCamera(
          nodes.liveViewport.clientWidth,
          nodes.liveViewport.clientHeight,
          target.x,
          target.y,
          LIVE_CAMERA_CENTER_SCALE,
          LIVE_CAMERA_MIN_SCALE,
          LIVE_CAMERA_MAX_SCALE,
        )
      : liveCamera
    if (!base) return null
    return windowLiveRevealCamera(
      nodes.liveViewport.clientWidth,
      nodes.liveViewport.clientHeight,
      target.x,
      target.y,
      Number(target.width) || 0,
      Number(target.height) || 0,
      base.scale,
      base.offsetX,
      base.offsetY,
      LIVE_CAMERA_SAFE_INSET,
    )
  }

  function revealLiveStageTarget(target, center = false) {
    const next = liveCameraForStageTarget(target, center)
    if (!next) return false
    applyLiveCamera({ ...next, panStart: null, pinchStart: null })
    return true
  }

  function liveStageTargetForElements(elements) {
    if (!nodes.liveViewport || !nodes.liveStage || !(liveCamera.scale > 0)) return null
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    const rects = [...elements].flatMap(node => {
      if (!(node instanceof Element) || node.closest('[hidden]')) return []
      const rect = node.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 ? [rect] : []
    })
    if (!rects.length) return null
    const viewportRect = nodes.liveViewport.getBoundingClientRect()
    const left = Math.min(...rects.map(rect => rect.left))
    const right = Math.max(...rects.map(rect => rect.right))
    const top = Math.min(...rects.map(rect => rect.top))
    const bottom = Math.max(...rects.map(rect => rect.bottom))
    return Object.freeze({
      x: ((left + right) / 2 - viewportRect.left - liveCamera.offsetX) /
        liveCamera.scale,
      y: ((top + bottom) / 2 - viewportRect.top - liveCamera.offsetY) /
        liveCamera.scale,
      width: (right - left) / liveCamera.scale,
      height: (bottom - top) / liveCamera.scale,
    })
  }

  function revealLiveElements(elements, center = false) {
    const target = liveStageTargetForElements(elements)
    return target ? revealLiveStageTarget(target, center) : false
  }

  function liveDefaultCenterTarget(snapshot, focus, survey, renderContext = null) {
    const focusedResident = state.live.focusResident
      ? displayedResidents(snapshot).find(resident =>
          resident.handle === state.live.focusResident)
      : null
    if (focusedResident) {
      const focusedPoint = liveResidentReplayPoint(
        snapshot,
        focusedResident.current_place_id,
        focusedResident.handle,
        focus,
        liveChildren(snapshot, focus),
        renderContext,
      )
      if (focusedPoint) return focusedPoint
    }
    const hasDirectResident = displayedResidents(snapshot).some(resident =>
      resident.current_place_id === focus.id &&
      (!state.resident || resident.handle === state.resident))
    const firstChild = survey.plots[0] || null
    const proofRetry = state.live.proofScene && focus.id === LIVE_PROOF_ROOT_ID
      ? survey.plots.find(plot => plot.id === LIVE_PROOF_RETRY_ROOM_ID) || null
      : null
    if (firstChild && proofRetry) {
      return Object.freeze({
        x: (firstChild.x + firstChild.width / 2 +
          proofRetry.x + proofRetry.width / 2) / 2,
        y: (firstChild.y + firstChild.height / 2 +
          proofRetry.y + proofRetry.height / 2) / 2,
      })
    }
    if (!hasDirectResident && Number(focus.things) <= 0 && firstChild) {
      return Object.freeze({
        x: firstChild.x + firstChild.width / 2,
        y: firstChild.y + firstChild.height / 2,
      })
    }
    const ordinaryTarget = Object.freeze({
      x: Math.min(survey.width, LIVE_DIRECT_GROUND_WIDTH) / 2,
      y: Math.min(survey.height, WINDOW_LIVE_DIRECT_COMMONS_HEIGHT) / 2,
    })
    if (!firstChild || !nodes.liveViewport) return ordinaryTarget
    const ordinaryCamera = liveCameraForStageTarget(ordinaryTarget, true)
    if (!ordinaryCamera) return ordinaryTarget
    const ordinaryViewport = Object.freeze({
      left: -ordinaryCamera.offsetX / ordinaryCamera.scale,
      top: -ordinaryCamera.offsetY / ordinaryCamera.scale,
      right: (nodes.liveViewport.clientWidth - ordinaryCamera.offsetX) /
        ordinaryCamera.scale,
      bottom: (nodes.liveViewport.clientHeight - ordinaryCamera.offsetY) /
        ordinaryCamera.scale,
    })
    if (windowLiveVisiblePlotIds(
      survey.plots,
      survey.expandedGrounds,
      ordinaryViewport,
      LIVE_PLOT_OVERSCAN,
    ).length) return ordinaryTarget
    return Object.freeze({
      x: firstChild.x + firstChild.width / 2,
      y: firstChild.y + firstChild.height / 2,
      preservesChildDetail: true,
      childDetailPlaceId: firstChild.id,
    })
  }

  function liveChildDetailRevealTargets(target) {
    const placeId = safeId(target?.childDetailPlaceId)
    if (!target?.preservesChildDetail || !placeId || !nodes.livePlates) return []
    return [
      ...nodes.livePlates.querySelectorAll(
        '.live-plot[data-place-id="' + String(placeId) + '"] .live-plot-open',
      ),
      ...nodes.livePlates.querySelectorAll('.live-root-walkers .live-speech-bubble'),
    ]
  }

  function liveCenterTarget() {
    if (!nodes.liveViewport || !nodes.liveStage) return null
    const preferredKey = state.live.focusResident
      ? 'resident:' + state.live.focusResident
      : state.live.raisedItemKey
    const target = preferredKey
      ? nodes.livePlates?.querySelector('[data-live-item-key="' + CSS.escape(preferredKey) + '"]')
      : null
    if (target) {
      const viewportRect = nodes.liveViewport.getBoundingClientRect()
      const targetRect = target.getBoundingClientRect()
      if (targetRect.width > 0 && targetRect.height > 0) {
        return Object.freeze({
          x: (targetRect.left + targetRect.width / 2 - viewportRect.left -
            liveCamera.offsetX) / liveCamera.scale,
          y: (targetRect.top + targetRect.height / 2 - viewportRect.top -
            liveCamera.offsetY) / liveCamera.scale,
        })
      }
    }
    if (state.live.focusResident && state.snapshot) {
      const focus = liveFocusPlace(state.snapshot)
      const resident = displayedResidents(state.snapshot).find(candidate =>
        candidate.handle === state.live.focusResident)
      const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
        focus && livePlotDetailContext.focus.id === focus.id
        ? livePlotDetailContext
        : null
      if (focus && resident) {
        const point = liveResidentReplayPoint(
          state.snapshot,
          resident.current_place_id,
          resident.handle,
          focus,
          liveChildren(state.snapshot, focus),
          renderContext,
        )
        if (point) return point
      }
    }
    if (state.snapshot) {
      const focus = liveFocusPlace(state.snapshot)
      if (focus) {
        const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
          livePlotDetailContext.focus.id === focus.id
          ? livePlotDetailContext
          : null
        return liveDefaultCenterTarget(
          state.snapshot,
          focus,
          renderContext?.survey || liveStageSurvey(livePlaceRows(state.snapshot), focus.id),
          renderContext,
        )
      }
    }
    const width = Number(nodes.liveStage.dataset.liveStageWidth) || nodes.liveStage.offsetWidth
    const height = Number(nodes.liveStage.dataset.liveStageHeight) || nodes.liveStage.offsetHeight
    return Object.freeze({
      x: Math.min(width, LIVE_DIRECT_GROUND_WIDTH) / 2,
      y: Math.min(height, WINDOW_LIVE_DIRECT_COMMONS_HEIGHT) / 2,
    })
  }

  function centerLivePlate() {
    if (!nodes.liveViewport) return
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    const target = liveCenterTarget()
    if (!target) return
    const centered = liveCameraForStageTarget(target, true)
    if (!centered) return
    applyLiveCamera({ ...centered, panStart: null, pinchStart: null })
    if (liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
    if (revealLiveElements(liveChildDetailRevealTargets(target)) && liveCameraFrame) {
      window.cancelAnimationFrame(liveCameraFrame)
      liveCameraFrame = 0
      commitLiveCamera()
    }
  }

  function renderLiveFullscreen(active) {
    const panel = document.getElementById('live-panel')
    if (!panel || !nodes.liveFullscreen) return
    if (active) panel.dataset.liveFullscreen = 'true'
    else delete panel.dataset.liveFullscreen
    nodes.liveFullscreen.setAttribute('aria-pressed', String(active))
    nodes.liveFullscreen.setAttribute('aria-label', active
      ? 'Exit full-screen Live'
      : 'Enter full-screen Live')
    nodes.liveFullscreen.textContent = active ? 'Exit full screen' : 'Full screen'
    if (active) window.requestAnimationFrame(centerLivePlate)
  }

  function enterLiveFullscreen() {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen === 'true') return
    const nextHistory = { ...(window.history.state || {}), windowLiveFullscreen: true }
    window.history.pushState(nextHistory, '', window.location.href)
    liveFullscreenHistoryEntry = true
    renderLiveFullscreen(true)
  }

  function exitLiveFullscreen() {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen !== 'true') return
    if (liveFullscreenHistoryEntry && window.history.state?.windowLiveFullscreen === true) {
      window.history.back()
      return
    }
    liveFullscreenHistoryEntry = false
    renderLiveFullscreen(false)
  }

  function syncLiveFullscreenFromHistory() {
    const active = window.history.state?.windowLiveFullscreen === true && state.view === 'live'
    liveFullscreenHistoryEntry = active
    renderLiveFullscreen(active)
  }

  function zoomLivePlateAt(clientX, clientY, requestedScale) {
    if (!nodes.liveViewport) return
    const scale = clampLiveScale(requestedScale)
    const rect = nodes.liveViewport.getBoundingClientRect()
    const x = clientX - rect.left
    const y = clientY - rect.top
    const worldX = (x - liveCamera.offsetX) / liveCamera.scale
    const worldY = (y - liveCamera.offsetY) / liveCamera.scale
    applyLiveCamera({
      scale,
      offsetX: x - worldX * scale,
      offsetY: y - worldY * scale,
    })
  }

  function livePointerValues(pointers = livePointers) {
    return Object.values(pointers)
  }

  function livePinchStart(pointers) {
    const values = livePointerValues(pointers)
    if (values.length < 2 || !nodes.liveViewport) return null
    const [first, second] = values
    const midpointX = (first.x + second.x) / 2
    const midpointY = (first.y + second.y) / 2
    const rect = nodes.liveViewport.getBoundingClientRect()
    return Object.freeze({
      distance: Math.max(1, Math.hypot(second.x - first.x, second.y - first.y)),
      scale: liveCamera.scale,
      worldX: (midpointX - rect.left - liveCamera.offsetX) / liveCamera.scale,
      worldY: (midpointY - rect.top - liveCamera.offsetY) / liveCamera.scale,
    })
  }

  function beginLivePointer(event) {
    if (!nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [String(event.pointerId)]: Object.freeze({
        id: event.pointerId, x: event.clientX, y: event.clientY,
      }),
    })
    const values = livePointerValues()
    if (values.length === 1) {
      liveCamera = Object.freeze({ ...liveCamera,
        panStart: Object.freeze({
          id: event.pointerId, x: event.clientX, y: event.clientY,
          offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
        }),
        pinchStart: null,
      })
    } else if (values.length === 2) {
      liveCamera = Object.freeze({ ...liveCamera, panStart: null, pinchStart: livePinchStart(livePointers) })
    }
    try { nodes.liveViewport.setPointerCapture(event.pointerId) } catch {}
  }

  function moveLivePointer(event) {
    const key = String(event.pointerId)
    if (!Object.hasOwn(livePointers, key) || !nodes.liveViewport) return
    livePointers = Object.freeze({
      ...livePointers,
      [key]: Object.freeze({ id: event.pointerId, x: event.clientX, y: event.clientY }),
    })
    const values = livePointerValues()
    if (values.length >= 2 && liveCamera.pinchStart) {
      const [first, second] = values
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y))
      const scale = clampLiveScale(liveCamera.pinchStart.scale *
        (distance / liveCamera.pinchStart.distance))
      const rect = nodes.liveViewport.getBoundingClientRect()
      const midpointX = (first.x + second.x) / 2 - rect.left
      const midpointY = (first.y + second.y) / 2 - rect.top
      applyLiveCamera({
        scale,
        offsetX: midpointX - liveCamera.pinchStart.worldX * scale,
        offsetY: midpointY - liveCamera.pinchStart.worldY * scale,
      })
      return
    }
    const start = liveCamera.panStart
    if (values.length === 1 && start?.id === event.pointerId) {
      applyLiveCamera({
        offsetX: start.offsetX + event.clientX - start.x,
        offsetY: start.offsetY + event.clientY - start.y,
      })
    }
  }

  function endLivePointer(event) {
    const remaining = Object.fromEntries(Object.entries(livePointers)
      .filter(([key]) => key !== String(event.pointerId)))
    livePointers = Object.freeze(remaining)
    const values = livePointerValues()
    liveCamera = Object.freeze({
      ...liveCamera,
      pinchStart: values.length >= 2 ? livePinchStart(livePointers) : null,
      panStart: values.length === 1 ? Object.freeze({
        id: values[0].id, x: values[0].x, y: values[0].y,
        offsetX: liveCamera.offsetX, offsetY: liveCamera.offsetY,
      }) : null,
    })
  }

  function resetShareFeedback() {
    shareFeedbackRevision += 1
    for (const status of [nodes.shareStatus, nodes.detailShareStatus]) {
      if (!status) continue
      status.textContent = ''
      delete status.dataset.tone
    }
    for (const button of [...viewShareButtons, detailShareButton].filter(Boolean)) {
      button.textContent = button.dataset.shareLabel || (button.dataset.shareScope === 'detail'
        ? 'Share this detail'
        : 'Share this view')
    }
  }

  function setShareStatus(message, tone, button) {
    const status = button?.dataset.shareScope === 'detail'
      ? nodes.detailShareStatus
      : nodes.shareStatus
    if (!status) return
    status.textContent = message
    status.dataset.tone = tone
  }

  function currentSharePath(button) {
    const current = viewShareState()
    const shareState = button?.dataset.shareScope === 'detail'
      ? windowDetailShareState(current)
      : current
    return shareState ? windowShareTargetPath(shareState) : null
  }

  async function copyCurrentShareLink(button) {
    const requestShareFeedbackRevision = ++shareFeedbackRevision
    const path = currentSharePath(button)
    if (!path) {
      const values = [state.directorySearch, state.archive.query]
      const credentialPresent = values.some(value => (
        typeof value === 'string' && /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
      ))
      setShareStatus(credentialPresent
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : 'This view contains a filter that is not safe for a public URL. Clear that filter, then try sharing again.',
      'error', button)
      return
    }
    const absoluteUrl = new URL(path, window.location.origin).href
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(absoluteUrl)
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        currentSharePath(button) !== path
      ) return
      setShareStatus('Link copied: ' + absoluteUrl, 'success', button)
      if (button) button.textContent = button.dataset.shareScope === 'detail'
        ? 'Detail link copied'
        : button === nodes.gazetteShare
          ? state.gazetteIssueId ? 'Issue link copied' : 'Gazette link copied'
          : 'View link copied'
    } catch {
      if (
        shareFeedbackRevision !== requestShareFeedbackRevision ||
        currentSharePath(button) !== path
      ) return
      setShareStatus('The link could not copy. Copy this URL: ' + absoluteUrl, 'error', button)
    }
  }

  function safePlacePurpose(value) {
    const purpose = safeText(value, '', 1000, true)
    return /[\\r\\n\\u2028\\u2029]/u.test(purpose) || Array.from(purpose).length > 280
      ? ''
      : purpose
  }

  function normalizeFrontMatterHeading(rawHeading) {
    if (!rawHeading || typeof rawHeading !== 'object' || rawHeading.type !== 'thing') return null
    const id = safeId(rawHeading.id)
    const name = safeText(rawHeading.name, '', 120, false)
    const bodyTextBytes = Number(rawHeading.body_text_bytes)
    const makerId = safeId(rawHeading.maker_id)
    const madeBy = safeHandle(rawHeading.made_by)
    const currentOwnerId = safeId(rawHeading.current_owner_id)
    const currentOwner = safeHandle(rawHeading.current_owner)
    const ownerId = safeId(rawHeading.owner_id)
    const owner = safeHandle(rawHeading.owner)
    if (
      !id || !name || !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0 ||
      !makerId || !madeBy || !currentOwnerId || !currentOwner ||
      ownerId !== currentOwnerId || owner !== currentOwner
    ) return null
    return Object.freeze({
      id,
      type: 'thing',
      name,
      body_text_bytes: bodyTextBytes,
      maker_id: makerId,
      made_by: madeBy,
      current_owner_id: currentOwnerId,
      current_owner: currentOwner,
      owner_id: ownerId,
      owner,
      has_drawing: rawHeading.has_drawing === true,
    })
  }

  function normalizeFrontMatter(values) {
    if (!Array.isArray(values)) return []
    const seen = new Set()
    return values.slice(0, 3).flatMap(rawHeading => {
      const heading = normalizeFrontMatterHeading(rawHeading)
      if (!heading || seen.has(heading.id)) return []
      seen.add(heading.id)
      return [heading]
    })
  }

  function setStatus(message, tone) {
    if (!nodes.status) return
    if (nodes.status.textContent !== message) nodes.status.textContent = message
    if (nodes.status.dataset.tone !== tone) nodes.status.dataset.tone = tone
    if (nodes.status.dataset.statusMessage) delete nodes.status.dataset.statusMessage
  }

  function renderGlobalReadRetry(message, tone) {
    if (nodes.status) {
      if (
        nodes.status.dataset.statusMessage === message &&
        nodes.status.dataset.tone === tone &&
        nodes.status.querySelector('.global-read-retry')
      ) return
      const retry = element('button', 'global-read-retry', 'Retry reading the public city view')
      retry.type = 'button'
      retry.dataset.focusKey = 'global-read-retry'
      retry.addEventListener('click', () => void refreshCity())
      nodes.status.dataset.tone = tone
      nodes.status.dataset.statusMessage = message
      nodes.status.replaceChildren(document.createTextNode(message + ' '), retry)
    }
  }

  function renderGlobalReadFailure() {
    const message = 'The current public city view could not be read.'
    renderGlobalReadRetry(message, 'error')
    if (nodes.counts) nodes.counts.textContent = message
    if (nodes.scope) nodes.scope.textContent = message
    for (const target of [nodes.map, nodes.roster, nodes.livePlates, nodes.liveRoster,
      nodes.placePurpose, nodes.placeFrontMatter,
      nodes.occupants, nodes.placeThings, nodes.placeConversation, nodes.conversations,
      nodes.agreements]) {
      renderEmpty(target, 'error-row', message)
    }
    if (nodes.liveLedger) {
      nodes.liveLedger.replaceChildren(element('li', 'error-row', message))
    }
    if (nodes.activity) {
      nodes.activity.replaceChildren(element('li', 'error-row', message))
    }
  }

  function renderEmpty(target, className, message) {
    if (!target) return
    target.replaceChildren(element('p', className, message))
  }

  function safeArchiveChoice(value, choices, fallback) {
    return typeof value === 'string' && choices.includes(value) ? value : fallback
  }

  function safeArchiveCursor(value) {
    return safeText(value, null, 2048, false)
  }

  function safeChangeMarker(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(value)) return null
    try {
      return BigInt(value) <= 9223372036854775807n ? value : null
    } catch {
      return null
    }
  }

  function markerCovers(actual, minimum) {
    const safeActual = safeChangeMarker(actual)
    const safeMinimum = safeChangeMarker(minimum)
    return Boolean(safeActual && safeMinimum && BigInt(safeActual) >= BigInt(safeMinimum))
  }

  function requireExactReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested) return
    throw new Error('public read marker does not match its accepted rows')
  }

  function requireCurrentReadMarker(actual, requested) {
    if (!requested) return
    const responseMarker = safeChangeMarker(actual)
    if (responseMarker === requested && state.changeMarker === requested) return
    if (responseMarker && state.changeMarker &&
        BigInt(responseMarker) > BigInt(state.changeMarker)) void refreshCity()
    throw new Error('public read marker does not match the neighboring snapshot totals')
  }

  function normalizeArchiveResult(rawResult) {
    if (!rawResult || typeof rawResult !== 'object') return null
    const type = safeArchiveChoice(rawResult.type, ['note', 'thing'], null)
    const id = safeId(rawResult.id)
    const createdAt = safeDate(rawResult.created_at)
    if (!type || !id || !createdAt) return null
    const placeId = rawResult.place_id === null || rawResult.place_id === undefined
      ? null
      : safeId(rawResult.place_id)
    if (rawResult.place_id !== null && rawResult.place_id !== undefined && !placeId) return null
    const madeBy = type === 'thing' ? safeHandle(rawResult.made_by) : null
    const currentOwner = type === 'thing'
      ? safeHandle(rawResult.current_owner ?? rawResult.owner)
      : null
    const makerId = type === 'thing' ? safeId(rawResult.maker_id) : null
    const currentOwnerId = type === 'thing' ? safeId(rawResult.current_owner_id) : null
    const hasThingProvenance = type === 'thing' && [
      rawResult.maker_id, rawResult.made_by,
      rawResult.current_owner_id, rawResult.current_owner,
    ].some(value => value !== null && value !== undefined)
    if (hasThingProvenance && (!makerId || !madeBy || !currentOwnerId || !currentOwner)) return null
    const actor = type === 'note' ? safeHandle(rawResult.author) : currentOwner
    const name = type === 'thing'
      ? safeText(rawResult.name, '', 160, false)
      : ''
    return Object.freeze({
      type,
      id,
      createdAt,
      placeId,
      actor,
      makerId,
      madeBy,
      currentOwnerId,
      currentOwner,
      name,
      hasDrawing: rawResult.has_drawing === true,
      textBytes: safeCount(rawResult.body_text_bytes ?? rawResult.text_bytes),
      href: '/window/' + type + '/' + String(id),
    })
  }

  function normalizeArchivePayload(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid archive response')
    const rawResults = Array.isArray(payload.results)
      ? payload.results
      : Array.isArray(payload.items) ? payload.items : []
    if (rawResults.length > 25) throw new Error('invalid archive response')
    const results = rawResults.map(normalizeArchiveResult)
    if (results.some(result => !result)) throw new Error('invalid archive response')
    const totalItems = safeCount(payload.total_items ?? payload.totalItems)
    if (payload.returned_items !== results.length || totalItems < results.length) {
      throw new Error('invalid archive response')
    }
    const hasMore = payload.has_more === true || payload.hasMore === true
    const nextBefore = safeArchiveCursor(payload.next_before ?? payload.nextBefore)
    if (hasMore !== Boolean(nextBefore)) throw new Error('invalid archive response')
    return Object.freeze({
      results,
      totalItems,
      totalTextBytes: safeCount(
        payload.total_text_bytes ?? payload.total_body_bytes ??
          payload.totalTextBytes ?? payload.totalBodyBytes,
      ),
      hasMore,
      nextBefore,
    })
  }

  function archiveResultCard(result) {
    const card = element('li', 'archive-card')
    const heading = element('h3', 'archive-result-title', result.type === 'thing' && result.name
      ? result.name
      : 'Public note #' + String(result.id))
    if (result.type === 'thing' && result.name) {
      heading.prepend(portraitNode('thing', result.id, result.name, result.hasDrawing))
    }
    const recordLabel = result.type === 'thing'
      ? 'Thing #' + String(result.id)
      : 'Note #' + String(result.id)
    const details = [
      recordLabel,
      result.type === 'note' && result.actor ? 'by ' + result.actor : '',
      result.type === 'thing' && result.madeBy ? 'made by ' + result.madeBy : '',
      result.type === 'thing' && result.currentOwner
        ? 'currently owned by ' + result.currentOwner
        : '',
      result.placeId ? 'place #' + String(result.placeId) : '',
      dateLabel(result.createdAt),
      String(result.textBytes) + ' public text bytes',
    ].filter(Boolean)
    const meta = element('p', 'archive-result-meta', details.join(' · '))
    const link = openDetailLink(result.type, result.id, 'Open detail', 'archive-open')
    card.append(heading, meta, link)
    return card
  }

  function archiveRetryButton() {
    const retry = element('button', 'archive-retry', 'Retry search')
    retry.type = 'button'
    retry.addEventListener('click', () => void loadArchive(!state.archive.query))
    return retry
  }

  function renderArchivePage(archive) {
    if (!nodes.archivePage) return
    nodes.archivePage.hidden = true
    nodes.archivePage.replaceChildren()
    if (archive.loading && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(element('p', 'loading-row', 'Searching the archive for older matches…'))
      return
    }
    if (archive.error && archive.results.length) {
      nodes.archivePage.hidden = false
      nodes.archivePage.replaceChildren(
        element('p', 'error-row', archive.error),
        archiveRetryButton(),
      )
      return
    }
    if (!archive.hasMore || !archive.nextBefore) return
    const load = element('button', 'archive-load', 'Load older matches')
    load.type = 'button'
    load.addEventListener('click', () => void loadArchive(false))
    nodes.archivePage.hidden = false
    nodes.archivePage.replaceChildren(load)
  }

  function renderArchive() {
    if (!nodes.archiveResults) return
    const archive = state.archive
    if (nodes.archiveSearch) {
      nodes.archiveSearch.disabled = archive.loading
      nodes.archiveSearch.setAttribute('aria-busy', String(archive.loading))
    }
    nodes.archiveResults.setAttribute('aria-busy', String(archive.loading))
    if (archive.loading && !archive.results.length) {
      renderEmpty(nodes.archiveResults, 'loading-row', 'Searching the archive…')
      renderArchivePage(archive)
      return
    }
    if (archive.error && !archive.results.length) {
      const message = element('p', 'error-row', archive.error)
      nodes.archiveResults.replaceChildren(message, archiveRetryButton())
      renderArchivePage(archive)
      return
    }
    if (!archive.initialized) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'Enter public words or an exact phrase to search.')
      renderArchivePage(archive)
      return
    }
    if (!archive.results.length) {
      renderEmpty(nodes.archiveResults, 'empty-row', 'No public notes or things matched this search.')
      renderArchivePage(archive)
      return
    }
    const summary = element(
      'p',
      'archive-summary',
      String(archive.totalItems) + (archive.totalItems === 1 ? ' exact match · ' : ' exact matches · ') +
        String(archive.totalTextBytes) + ' public text bytes total · bodies stay on their original records',
    )
    const list = element('ol', 'archive-list')
    list.append(...archive.results.map(archiveResultCard))
    nodes.archiveResults.replaceChildren(summary, list)
    renderArchivePage(archive)
  }

  async function loadArchive(reset, fromLocation = false) {
    if (state.archive.loading) return
    const requestAuthoredRevision = authoredRevision
    const mode = reset
      ? safeArchiveChoice(nodes.archiveMode?.value, ['words', 'phrase'], 'words')
      : state.archive.mode
    const type = reset
      ? safeArchiveChoice(nodes.archiveType?.value, ['all', 'note', 'thing'], 'all')
      : state.archive.type
    const candidateQuery = reset ? nodes.archiveQuery?.value : state.archive.query
    const validatedQuery = validateWindowArchiveQuery(candidateQuery, mode)
    if (!validatedQuery.ok) {
      const error = validatedQuery.reason === 'credential'
        ? 'That looks like a credential. Never put it in a public URL. If it is a resident key, replace it now; if it is a recovery code, create a fresh recovery set.'
        : validatedQuery.reason === 'word_count'
          ? 'Words mode needs 1 to 16 word lexemes.'
          : 'Search must be one safe line of 1 to 256 UTF-8 bytes.'
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false, error },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    const formQuery = validatedQuery.value
    if (!formQuery) {
      state = {
        ...state,
        archive: { ...state.archive, initialized: true, loading: false,
          error: 'Enter words or an exact phrase before searching.' },
      }
      renderArchive()
      nodes.archiveQuery?.focus()
      return
    }
    if (reset && nodes.archiveQuery) nodes.archiveQuery.value = formQuery
    const requestArchiveRevision = ++archiveRequestRevision
    const previous = state.archive
    state = {
      ...state,
      archive: {
        ...previous,
        query: formQuery,
        mode,
        type,
        results: reset ? [] : previous.results,
        loading: true,
        initialized: true,
        error: null,
      },
    }
    if (reset) writeLocation(!fromLocation)
    renderArchive()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/search', window.location.origin)
      url.searchParams.set('q', formQuery)
      url.searchParams.set('mode', mode)
      url.searchParams.set('type', type)
      url.searchParams.set('limit', '25')
      if (!reset && previous.nextBefore) url.searchParams.set('before', previous.nextBefore)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) {
        const error = new Error('archive unavailable')
        error.isBusy = response.status === 503
        throw error
      }
      const page = normalizeArchivePayload(await response.json())
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      const combined = new Map()
      for (const result of reset ? [] : previous.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      for (const result of page.results) {
        combined.set(result.type + ':' + String(result.id), result)
      }
      state = {
        ...state,
        archive: {
          ...state.archive,
          results: [...combined.values()],
          totalItems: page.totalItems,
          totalTextBytes: page.totalTextBytes,
          nextBefore: page.nextBefore,
          hasMore: page.hasMore && Boolean(page.nextBefore),
          loading: false,
          error: null,
        },
      }
    } catch (error) {
      if (
        authoredRevision !== requestAuthoredRevision ||
        archiveRequestRevision !== requestArchiveRevision
      ) return
      state = {
        ...state,
        archive: {
          ...state.archive,
          loading: false,
          error: error && error.isBusy
            ? 'Search could not be loaded within the public reading limit.'
            : 'Search could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderArchive()
    }
  }

  function safeGazetteCount(value) {
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
  }

  function safeGazetteStoredText(value, maximum, allowEmpty = false) {
    if (
      typeof value !== 'string' || containsMalformedPublicText(value) || hasUnsafeText(value) ||
      /1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}/iu.test(value)
    ) return null
    const characters = Array.from(value)
    if (characters.length > maximum || (!allowEmpty && !value.trim())) return null
    return value
  }

  function normalizeGazetteIssueSummary(rawIssue) {
    if (!rawIssue || typeof rawIssue !== 'object') return null
    const issueNumber = safeId(rawIssue.issue_number)
    const scheduledFor = safeDate(rawIssue.scheduled_for)
    const printedAt = safeDate(rawIssue.printed_at)
    const entryCount = safeGazetteCount(rawIssue.entry_count)
    if (!issueNumber || !scheduledFor || !printedAt || entryCount === null) return null
    if (printedAt.getTime() < scheduledFor.getTime()) return null
    return Object.freeze({ issueNumber, scheduledFor, printedAt, entryCount })
  }

  function normalizeGazetteListPayload(payload, requestedBeforeIssueNumber) {
    if (!payload || typeof payload !== 'object' ||
        !payload.submission_room || Array.isArray(payload.submission_room) ||
        payload.submission_room.place_id !== 454 ||
        typeof payload.submission_room.submissions_open !== 'boolean' ||
        payload.first_print_at !== GAZETTE_FIRST_PRINT_AT || !Array.isArray(payload.issues) ||
        payload.issues.length > GAZETTE_ISSUE_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue page')
    }
    const firstPrintAt = safeDate(payload.first_print_at)
    const issues = payload.issues.map(normalizeGazetteIssueSummary)
    if (!firstPrintAt || issues.some(issue => !issue)) {
      throw new Error('invalid Gazette issue page')
    }
    for (let index = 1; index < issues.length; index += 1) {
      if (issues[index - 1].issueNumber <= issues[index].issueNumber) {
        throw new Error('invalid Gazette issue order')
      }
    }
    if (
      requestedBeforeIssueNumber &&
      issues.some(issue => issue.issueNumber >= requestedBeforeIssueNumber)
    ) throw new Error('invalid Gazette issue cursor page')
    const hasMore = payload.has_more === true
    const nextBeforeIssueNumber = payload.next_before_issue_number === null ||
      payload.next_before_issue_number === undefined
      ? null
      : safeId(payload.next_before_issue_number)
    if (hasMore !== Boolean(nextBeforeIssueNumber)) {
      throw new Error('invalid Gazette issue continuation')
    }
    if (hasMore && (
      !issues.length || nextBeforeIssueNumber !== issues.at(-1).issueNumber ||
      (requestedBeforeIssueNumber && nextBeforeIssueNumber >= requestedBeforeIssueNumber)
    )) throw new Error('stalled Gazette issue continuation')
    return Object.freeze({
      firstPrintAt,
      submissionsOpen: payload.submission_room.submissions_open,
      issues,
      hasMore,
      nextBeforeIssueNumber,
    })
  }

  function normalizeGazetteEntry(rawEntry, scheduledFor) {
    if (!rawEntry || typeof rawEntry !== 'object') return null
    const ordinal = safeId(rawEntry.ordinal)
    const noteId = safeId(rawEntry.note_id)
    const author = safeHandle(rawEntry.author)
    const body = safeGazetteStoredText(rawEntry.body, 65536)
    const createdAt = safeDate(rawEntry.created_at)
    if (!ordinal || !noteId || !author || body === null || !createdAt ||
        createdAt.getTime() >= scheduledFor.getTime()) return null
    return Object.freeze({ ordinal, noteId, author, body, createdAt })
  }

  function sameGazetteIssue(left, right) {
    return Boolean(left && right &&
      left.issueNumber === right.issueNumber &&
      left.scheduledFor.getTime() === right.scheduledFor.getTime() &&
      left.printedAt.getTime() === right.printedAt.getTime() &&
      left.entryCount === right.entryCount && left.header === right.header)
  }

  function normalizeGazetteDetailPayload(
    payload,
    expectedIssueNumber,
    requestedAfterOrdinal,
    acceptedIssue,
  ) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid Gazette issue')
    const summary = normalizeGazetteIssueSummary(payload.issue)
    const header = safeGazetteStoredText(payload.issue?.header, 4000)
    if (!summary || summary.issueNumber !== expectedIssueNumber || header === null ||
        !Array.isArray(payload.entries) || payload.entries.length > GAZETTE_ENTRY_PAGE_LIMIT) {
      throw new Error('invalid Gazette issue')
    }
    const entries = payload.entries.map(entry => normalizeGazetteEntry(entry, summary.scheduledFor))
    if (entries.some(entry => !entry)) throw new Error('invalid Gazette entries')
    let expectedOrdinal = (requestedAfterOrdinal || 0) + 1
    for (const entry of entries) {
      if (entry.ordinal !== expectedOrdinal) {
        throw new Error('invalid Gazette entry order')
      }
      expectedOrdinal += 1
    }
    const issue = Object.freeze({ ...summary, header })
    if (acceptedIssue && !sameGazetteIssue(issue, acceptedIssue)) {
      throw new Error('Gazette issue metadata changed between pages')
    }
    const hasMore = payload.has_more === true
    const nextAfterOrdinal = payload.next_after_ordinal === null ||
      payload.next_after_ordinal === undefined
      ? null
      : safeId(payload.next_after_ordinal)
    const lastOrdinal = entries.at(-1)?.ordinal ?? (requestedAfterOrdinal || 0)
    if (
      hasMore !== Boolean(nextAfterOrdinal) || summary.entryCount < entries.length ||
      (hasMore && (
        !entries.length || nextAfterOrdinal !== lastOrdinal ||
        nextAfterOrdinal >= summary.entryCount
      )) ||
      (!hasMore && lastOrdinal !== summary.entryCount)
    ) {
      throw new Error('invalid Gazette entry continuation')
    }
    return Object.freeze({
      issue,
      entries,
      hasMore,
      nextAfterOrdinal,
    })
  }

  function gazetteDateLabel(date, includeWeekday = false) {
    const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const months = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ]
    const weekday = includeWeekday ? weekdays[date.getUTCDay()] + ', ' : ''
    return weekday + String(date.getUTCDate()) + ' ' + months[date.getUTCMonth()] + ' ' +
      String(date.getUTCFullYear()) + ' at ' + String(date.getUTCHours()).padStart(2, '0') +
      ':' + String(date.getUTCMinutes()).padStart(2, '0') + ' UTC'
  }

  function selectGazetteIssue(issueNumber, push) {
    if (!issueNumber || state.gazetteIssueId === issueNumber) return
    gazetteDetailRequestRevision += 1
    resetShareFeedback()
    state = {
      ...state,
      gazetteIssueId: issueNumber,
      gazette: {
        ...state.gazette,
        issue: null,
        entries: [],
        nextAfterOrdinal: null,
        hasMoreEntries: false,
        detailLoading: false,
        detailInitialized: false,
        detailError: null,
      },
    }
    writeLocation(push)
    renderGazettePreservingFocus()
    void loadGazetteIssue(issueNumber, true)
  }

  function gazetteIssueLink(issue) {
    const item = element('li', 'gazette-issue-summary')
    const link = element('a', 'gazette-issue-link', 'Issue ' + String(issue.issueNumber))
    link.href = '/window/gazette?issue=' + String(issue.issueNumber)
    link.dataset.focusKey = 'gazette-issue-' + String(issue.issueNumber)
    if (issue.issueNumber === state.gazetteIssueId) link.setAttribute('aria-current', 'page')
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      selectGazetteIssue(issue.issueNumber, true)
    })
    const count = String(issue.entryCount) + (issue.entryCount === 1 ? ' submission' : ' submissions')
    const meta = element(
      'p',
      'gazette-issue-summary-meta',
      gazetteDateLabel(issue.scheduledFor, true) + ' · ' + count,
    )
    item.append(link, meta)
    return item
  }

  function gazetteListRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading Gazette issues')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-issues'
    retry.dataset.focusFallbackId = 'gazette-issue-list'
    retry.addEventListener('click', () => void loadGazetteIssues(state.gazette.listRetryMode))
    return retry
  }

  function gazetteDetailRetryButton() {
    const retry = element('button', 'gazette-retry', 'Retry loading this Gazette issue')
    retry.type = 'button'
    retry.dataset.focusKey = 'gazette-retry-detail'
    retry.dataset.focusFallbackId = 'gazette-issue'
    retry.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, state.gazette.entries.length === 0)
    })
    return retry
  }

  function renderGazetteIssuesPage(gazette) {
    if (!nodes.gazetteIssuesPage) return
    nodes.gazetteIssuesPage.hidden = true
    nodes.gazetteIssuesPage.replaceChildren()
    if (gazette.listLoading && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'loading-row', 'Checking the Gazette archive…'),
      )
      return
    }
    if (gazette.listError && gazette.issues.length) {
      nodes.gazetteIssuesPage.hidden = false
      nodes.gazetteIssuesPage.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreIssues || !gazette.nextBeforeIssueNumber) return
    const load = element('button', 'gazette-load', 'Load older issues')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-issues'
    load.dataset.focusFallbackId = 'gazette-issue-list'
    load.addEventListener('click', () => void loadGazetteIssues('older'))
    nodes.gazetteIssuesPage.hidden = false
    nodes.gazetteIssuesPage.replaceChildren(load)
  }

  function gazetteEntryCard(entry) {
    const item = element('li', 'gazette-entry')
    const body = element('p', 'gazette-entry-body')
    body.textContent = entry.body
    const attribution = element('p', 'gazette-entry-attribution')
    const source = element('a', 'gazette-source-note', 'Note #' + String(entry.noteId))
    source.href = '/window/note/' + String(entry.noteId)
    attribution.append(
      document.createTextNode('by '),
      residentNode(entry.author, 'gazette-entry-author',
        'gazette-entry-author:' + String(entry.noteId)),
      document.createTextNode(' · '),
      source,
      document.createTextNode(' · ' + gazetteDateLabel(entry.createdAt)),
    )
    item.append(body, attribution)
    return item
  }

  function renderGazetteEntriesPage(gazette) {
    if (!nodes.gazetteEntriesPage) return
    nodes.gazetteEntriesPage.hidden = true
    nodes.gazetteEntriesPage.replaceChildren()
    if (gazette.detailLoading && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'loading-row', 'Reading more entries in this issue…'),
      )
      return
    }
    if (gazette.detailError && gazette.entries.length) {
      nodes.gazetteEntriesPage.hidden = false
      nodes.gazetteEntriesPage.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      return
    }
    if (!gazette.hasMoreEntries || !gazette.nextAfterOrdinal) return
    const load = element('button', 'gazette-load', 'Load more entries')
    load.type = 'button'
    load.dataset.focusKey = 'gazette-load-entries'
    load.dataset.focusFallbackId = 'gazette-issue'
    load.addEventListener('click', () => {
      if (state.gazetteIssueId) void loadGazetteIssue(state.gazetteIssueId, false)
    })
    nodes.gazetteEntriesPage.hidden = false
    nodes.gazetteEntriesPage.replaceChildren(load)
  }

  function renderGazetteIssue(gazette) {
    if (!nodes.gazetteIssue) return
    nodes.gazetteIssue.setAttribute('aria-busy', String(gazette.detailLoading))
    if (!state.gazetteIssueId) {
      renderEmpty(
        nodes.gazetteIssue,
        'empty-row',
        gazette.issues.length
          ? 'Choose a permanent Gazette issue.'
          : 'The first permanent issue will appear here after its scheduled print.',
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailLoading && !gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Reading Gazette issue ' + String(state.gazetteIssueId) + '…')
      renderGazetteEntriesPage(gazette)
      return
    }
    if (gazette.detailError && !gazette.issue) {
      nodes.gazetteIssue.replaceChildren(
        element('p', 'error-row', gazette.detailError),
        gazetteDetailRetryButton(),
      )
      renderGazetteEntriesPage(gazette)
      return
    }
    if (!gazette.issue) {
      renderEmpty(nodes.gazetteIssue, 'loading-row', 'Opening this permanent issue…')
      renderGazetteEntriesPage(gazette)
      return
    }
    const heading = element('h3', 'gazette-issue-title', 'Issue ' + String(gazette.issue.issueNumber))
    const printTime = element(
      'p',
      'gazette-print-time',
      'Weekly print for ' + gazetteDateLabel(gazette.issue.scheduledFor, true),
    )
    const provenance = element('p', 'gazette-provenance', gazette.issue.header)
    const entries = element('ol', 'gazette-entries')
    if (gazette.entries.length) {
      entries.append(...gazette.entries.map(gazetteEntryCard))
      nodes.gazetteIssue.replaceChildren(heading, printTime, provenance, entries)
    } else {
      nodes.gazetteIssue.replaceChildren(
        heading,
        printTime,
        provenance,
        element('p', 'empty-row', 'This permanent issue printed with no submissions.'),
      )
    }
    renderGazetteEntriesPage(gazette)
  }

  function renderGazette() {
    if (!nodes.gazetteIssueList) return
    const gazette = state.gazette
    if (nodes.gazetteSubmissionStatus) {
      if (gazette.submissionsOpen === true) {
        nodes.gazetteSubmissionStatus.dataset.state = 'open'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is open for Gazette submissions.'
      } else if (gazette.submissionsOpen === false) {
        nodes.gazetteSubmissionStatus.dataset.state = 'closed'
        nodes.gazetteSubmissionStatus.textContent = 'Room #454 is closed for Gazette submissions. Wait until this notice says open before submitting.'
      } else {
        nodes.gazetteSubmissionStatus.dataset.state = gazette.listError ? 'unavailable' : 'checking'
        nodes.gazetteSubmissionStatus.textContent = gazette.listError
          ? 'Gazette submission status is unavailable. Check again before submitting.'
          : 'Checking whether Room #454 is open for submissions…'
      }
    }
    if (nodes.gazetteShare) {
      const label = state.gazetteIssueId
        ? 'Share issue ' + String(state.gazetteIssueId)
        : 'Share this Gazette'
      nodes.gazetteShare.dataset.shareLabel = label
      nodes.gazetteShare.textContent = label
    }
    if (nodes.gazetteRead) {
      const issueNumber = safeId(state.gazetteIssueId) ? state.gazetteIssueId : null
      nodes.gazetteRead.hidden = issueNumber === null
      nodes.gazetteRead.textContent = issueNumber === null
        ? 'Read issue'
        : 'Read issue ' + String(issueNumber)
      if (issueNumber === null) nodes.gazetteRead.removeAttribute('href')
      else nodes.gazetteRead.href = '/gazette/' + String(issueNumber)
    }
    nodes.gazetteIssueList.setAttribute('aria-busy', String(gazette.listLoading))
    if (gazette.listLoading && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'loading-row', 'Opening the Gazette archive…')
    } else if (gazette.listError && !gazette.issues.length) {
      nodes.gazetteIssueList.replaceChildren(
        element('p', 'error-row', gazette.listError),
        gazetteListRetryButton(),
      )
    } else if (gazette.listInitialized && !gazette.issues.length) {
      renderEmpty(nodes.gazetteIssueList, 'empty-row', GAZETTE_FIRST_PRINT_EMPTY_STATE)
    } else if (gazette.issues.length) {
      const list = element('ol', 'gazette-issue-list-items')
      list.append(...gazette.issues.map(gazetteIssueLink))
      nodes.gazetteIssueList.replaceChildren(list)
    }
    renderGazetteIssuesPage(gazette)
    renderGazetteIssue(gazette)
  }

  function renderGazettePreservingFocus() {
    const active = document.activeElement
    const focusKey = active?.dataset?.focusKey || null
    const focusFallbackKey = active?.dataset?.focusFallbackKey || null
    const focusFallbackId = active?.dataset?.focusFallbackId || null
    renderGazette()
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  async function loadGazetteIssues(mode) {
    if (gazetteListRequestPromise) return gazetteListRequestPromise
    const previous = state.gazette
    const initial = mode === 'initial'
    const older = mode === 'older'
    const requestRevision = ++gazetteListRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        submissionsOpen: older ? previous.submissionsOpen : null,
        issues: initial ? [] : previous.issues,
        nextBeforeIssueNumber: initial ? null : previous.nextBeforeIssueNumber,
        hasMoreIssues: initial ? false : previous.hasMoreIssues,
        listLoading: true,
        listInitialized: true,
        listError: null,
        listRetryMode: mode,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    const request = (async () => {
      try {
        const url = new URL('/api/gazette', window.location.origin)
        url.searchParams.set('limit', String(GAZETTE_ISSUE_PAGE_LIMIT))
        if (older && previous.nextBeforeIssueNumber) {
          url.searchParams.set('before_issue_number', String(previous.nextBeforeIssueNumber))
        }
        const response = await fetch(url.pathname + url.search, {
          cache: 'no-store',
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('Gazette archive unavailable')
        const requestedBeforeIssueNumber = older ? previous.nextBeforeIssueNumber : null
        const page = normalizeGazetteListPayload(
          await response.json(),
          requestedBeforeIssueNumber,
        )
        if (gazetteListRequestRevision !== requestRevision) return false
        const combined = new Map()
        for (const issue of initial ? [] : previous.issues) {
          combined.set(issue.issueNumber, issue)
        }
        for (const issue of page.issues) combined.set(issue.issueNumber, issue)
        const issues = [...combined.values()]
          .sort((left, right) => right.issueNumber - left.issueNumber)
        const shouldSelectLatest = state.view === 'gazette' && !state.gazetteIssueId && issues.length
        const selectedIssueNumber = shouldSelectLatest ? issues[0].issueNumber : state.gazetteIssueId
        const preserveLoadedPagination = mode === 'refresh' && previous.issues.length > 0
        const nextBeforeIssueNumber = preserveLoadedPagination
          ? previous.nextBeforeIssueNumber
          : page.nextBeforeIssueNumber
        const hasMoreIssues = preserveLoadedPagination
          ? previous.hasMoreIssues
          : page.hasMore && Boolean(page.nextBeforeIssueNumber)
        if (shouldSelectLatest) resetShareFeedback()
        state = {
          ...state,
          gazetteIssueId: selectedIssueNumber,
          gazette: {
            ...state.gazette,
            firstPrintAt: page.firstPrintAt,
            submissionsOpen: page.submissionsOpen,
            issues,
            nextBeforeIssueNumber,
            hasMoreIssues,
            listLoading: false,
            listError: null,
          },
        }
        if (shouldSelectLatest) writeLocation(false)
        if (shouldSelectLatest) void loadGazetteIssue(selectedIssueNumber, true)
        return true
      } catch {
        if (gazetteListRequestRevision !== requestRevision) return false
        state = {
          ...state,
          gazette: {
            ...state.gazette,
            listLoading: false,
            listError: 'Gazette issues could not be loaded. Check the connection and try again.',
          },
        }
        return false
      } finally {
        window.clearTimeout(timeout)
        renderGazettePreservingFocus()
      }
    })()
    gazetteListRequestPromise = request
    try {
      return await request
    } finally {
      if (gazetteListRequestPromise === request) gazetteListRequestPromise = null
    }
  }

  async function loadGazetteIssue(issueNumber, reset) {
    const previous = state.gazette
    if (previous.detailLoading || !safeId(issueNumber)) return
    const sameIssue = previous.issue?.issueNumber === issueNumber
    const requestRevision = ++gazetteDetailRequestRevision
    state = {
      ...state,
      gazette: {
        ...previous,
        issue: reset || !sameIssue ? null : previous.issue,
        entries: reset || !sameIssue ? [] : previous.entries,
        nextAfterOrdinal: reset || !sameIssue ? null : previous.nextAfterOrdinal,
        hasMoreEntries: reset || !sameIssue ? false : previous.hasMoreEntries,
        detailLoading: true,
        detailInitialized: true,
        detailError: null,
      },
    }
    renderGazettePreservingFocus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/gazette/' + String(issueNumber), window.location.origin)
      url.searchParams.set('limit', String(GAZETTE_ENTRY_PAGE_LIMIT))
      if (!reset && previous.nextAfterOrdinal) {
        url.searchParams.set('after_ordinal', String(previous.nextAfterOrdinal))
      }
      const response = await fetch(url.pathname + url.search, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('Gazette issue unavailable')
      const requestedAfterOrdinal = reset || !sameIssue ? null : previous.nextAfterOrdinal
      const acceptedIssue = reset || !sameIssue ? null : previous.issue
      const page = normalizeGazetteDetailPayload(
        await response.json(),
        issueNumber,
        requestedAfterOrdinal,
        acceptedIssue,
      )
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      const combined = new Map()
      for (const entry of reset || !sameIssue ? [] : previous.entries) {
        combined.set(entry.ordinal, entry)
      }
      for (const entry of page.entries) combined.set(entry.ordinal, entry)
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          issue: page.issue,
          entries: [...combined.values()].sort((left, right) => left.ordinal - right.ordinal),
          nextAfterOrdinal: page.nextAfterOrdinal,
          hasMoreEntries: page.hasMore && Boolean(page.nextAfterOrdinal),
          detailLoading: false,
          detailError: null,
        },
      }
    } catch {
      if (gazetteDetailRequestRevision !== requestRevision || state.gazetteIssueId !== issueNumber) return
      state = {
        ...state,
        gazette: {
          ...state.gazette,
          detailLoading: false,
          detailError: 'This Gazette issue could not be loaded. Check the connection and try again.',
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderGazettePreservingFocus()
    }
  }

  function loadSharedGazette() {
    if (state.view !== 'gazette') return
    if (!state.gazette.listInitialized && !state.gazette.listLoading) {
      void loadGazetteIssues('initial')
    }
    if (
      state.gazetteIssueId && !state.gazette.detailLoading &&
      (!state.gazette.detailInitialized || state.gazette.issue?.issueNumber !== state.gazetteIssueId)
    ) {
      void loadGazetteIssue(state.gazetteIssueId, true)
    }
  }

  function dateLabel(date) {
    return date.toLocaleString([], {
      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    })
  }

  function timeNode(date, className) {
    const time = element('time', className, dateLabel(date))
    time.dateTime = date.toISOString()
    return time
  }

  function normalizePlaces(values, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.flatMap(rawPlace => {
      if (!rawPlace || typeof rawPlace !== 'object') return []
      const id = safeId(rawPlace.id)
      const parentId = rawPlace.parent_id === null ? null : safeId(rawPlace.parent_id)
      const owner = rawPlace.owner === null ? null : safeHandle(rawPlace.owner)
      const name = safeText(rawPlace.name, '', 120, false)
      const foundingName = safeText(rawPlace.founding_name ?? rawPlace.name, '', 120, false)
      const retiredAt = rawPlace.retired_at == null ? null : safeDate(rawPlace.retired_at)
      const placeStatus = rawPlace.status ?? (retiredAt ? 'retired' : 'active')
      const nameHistory = Array.isArray(rawPlace.name_history)
        ? rawPlace.name_history.flatMap(span => {
            if (!span || typeof span !== 'object') return []
            const spanName = safeText(span.name, '', 120, false)
            const startedAt = safeDate(span.started_at)
            const endedAt = span.ended_at == null ? null : safeDate(span.ended_at)
            return spanName && startedAt && (span.ended_at == null || endedAt)
              ? [Object.freeze({ name: spanName, startedAt, endedAt })]
              : []
          })
        : []
      const isOwnerlessWorld = rawPlace.owner === null && parentId === null && name === WORLD_ROOT_NAME
      if (
        !id || !name || !foundingName || seen.has(id) ||
        (placeStatus !== 'active' && placeStatus !== 'retired') ||
        (rawPlace.retired_at != null && !retiredAt) ||
        (!owner && !isOwnerlessWorld) ||
        (rawPlace.parent_id !== null && !parentId)
      ) return []
      const nextSeen = new Set([...seen, id])
      const moderated = rawPlace.moderated === true
      return [{
        id,
        parent_id: parentId,
        name,
        foundingName,
        nameHistory: Object.freeze(nameHistory),
        retiredAt,
        status: placeStatus,
        purpose: moderated ? '' : safePlacePurpose(rawPlace.purpose),
        front_matter: moderated ? [] : normalizeFrontMatter(rawPlace.front_matter),
        owner,
        places: safeCount(rawPlace.places),
        things: safeCount(rawPlace.things),
        notes: safeCount(rawPlace.notes),
        moderated,
        children: normalizePlaces(rawPlace.children, depth + 1, nextSeen),
      }]
    })
  }

  function normalizeLiveSurvey(values) {
    if (values === undefined) return Object.freeze([])
    if (!Array.isArray(values)) throw new Error('invalid public live survey')
    const seen = new Set()
    const rows = values.map(raw => {
      if (!raw || typeof raw !== 'object') throw new Error('invalid public live survey')
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const things = raw.things
      if (!id || (raw.parent_id !== null && !parentId) || parentId === id || seen.has(id) ||
          typeof things !== 'number' || !Number.isSafeInteger(things) || things < 0) {
        throw new Error('invalid public live survey')
      }
      seen.add(id)
      return Object.freeze({ id, parent_id: parentId, things })
    })
    return Object.freeze(rows)
  }

  function normalizeResidents(values) {
    if (!Array.isArray(values)) return []
    return values.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const handle = safeHandle(raw.handle)
      const joinedAt = safeDate(raw.joined_at)
      const currentPlaceId = raw.current_place_id == null ? null : safeId(raw.current_place_id)
      return id && handle && joinedAt && (raw.current_place_id == null || currentPlaceId)
        ? [{ id, handle, current_place_id: currentPlaceId, joined_at: joinedAt,
          asleep: raw.asleep === true, has_drawing: raw.has_drawing === true }]
        : []
    })
  }

  function normalizeDirectory(payload) {
    if (!payload || typeof payload !== 'object' || payload.view !== 'directory') {
      throw new Error('invalid public directory')
    }
    const rawPlaces = Array.isArray(payload.places) ? payload.places : []
    const places = deriveWindowDirectoryPlaces(rawPlaces.flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const parentId = raw.parent_id === null ? null : safeId(raw.parent_id)
      const name = safeText(raw.name, '', 120, false)
      return id && name && (raw.parent_id === null || parentId)
        ? [{ id, parent_id: parentId, name }]
        : []
    }))
    const residentsByHandle = new Map()
    if (Array.isArray(payload.residents)) {
      for (const raw of payload.residents) {
        if (!raw || typeof raw !== 'object') continue
        const id = safeId(raw.id)
        const handle = safeHandle(raw.handle)
        if (id && handle && !residentsByHandle.has(handle)) {
          residentsByHandle.set(handle, Object.freeze({
            id, handle, has_drawing: raw.has_drawing === true,
          }))
        }
      }
    }
    return Object.freeze({
      places: Object.freeze(places.map(place => Object.freeze(place))),
      residents: Object.freeze([...residentsByHandle.values()]),
    })
  }

  function normalizeNotes(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const author = safeHandle(raw.author)
      const body = safeText(raw.body, '', 2000, false)
      const createdAt = safeDate(raw.created_at)
      return id && placeId && author && body && createdAt
        ? [{ id, place_id: placeId, author, body, created_at: createdAt,
          moderated: raw.moderated === true, truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeThings(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const body = safeText(raw.body, null, 1000, true)
      const makerId = raw.maker_id == null ? null : safeId(raw.maker_id)
      const madeBy = raw.made_by == null ? null : safeHandle(raw.made_by)
      const currentOwnerId = raw.current_owner_id == null ? null : safeId(raw.current_owner_id)
      const currentOwner = safeHandle(raw.current_owner ?? raw.owner)
      const owner = safeHandle(raw.owner ?? raw.current_owner)
      const hasProvenance = [raw.maker_id, raw.made_by, raw.current_owner_id, raw.current_owner]
        .some(value => value !== null && value !== undefined)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const kindId = raw.kind_id == null ? null : safeId(raw.kind_id)
      const createdAt = safeDate(raw.created_at)
      if (
        !id || !placeId || !name || body === null || !currentOwner || !owner ||
        owner !== currentOwner || !createdAt || (raw.kind != null && !kind) ||
        (raw.kind_id != null && !kindId) ||
        (hasProvenance && (!makerId || !madeBy || !currentOwnerId))
      ) return []
      const traits = Array.isArray(raw.traits)
        ? [...new Set(raw.traits.map(safeWorldName).filter(Boolean))].slice(0, 32)
        : []
      return [{ id, place_id: placeId, name, body,
        maker_id: makerId, made_by: madeBy,
        current_owner_id: currentOwnerId, current_owner: currentOwner,
        owner, open_to_use: raw.open_to_use === true, kind_id: kindId, kind, traits,
        created_at: createdAt, moderated: raw.moderated === true,
        kind_moderated: raw.kind_moderated === true, truncated: raw.truncated === true,
        has_drawing: raw.has_drawing === true }]
    })
  }

  function normalizeThingHeadings(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const placeId = safeId(raw.place_id)
      const name = safeText(raw.name, '', 120, false)
      const kindId = raw.kind_id == null ? null : safeId(raw.kind_id)
      const kind = raw.kind == null ? null : safeWorldName(raw.kind)
      const makerId = safeId(raw.maker_id)
      const madeBy = safeHandle(raw.made_by)
      const currentOwnerId = safeId(raw.current_owner_id)
      const currentOwner = safeHandle(raw.current_owner)
      const bodyTextBytes = Number(raw.body_text_bytes)
      const createdAt = safeDate(raw.created_at)
      if (
        !id || !placeId || !name || !makerId || !madeBy || !currentOwnerId ||
        !currentOwner || !createdAt ||
        (raw.kind_id != null && !kindId) || (raw.kind != null && !kind) ||
        !Number.isSafeInteger(bodyTextBytes) || bodyTextBytes < 0
      ) return []
      return [Object.freeze({
        id, place_id: placeId, name, kind_id: kindId, kind,
        maker_id: makerId, made_by: madeBy,
        current_owner_id: currentOwnerId, current_owner: currentOwner,
        body_text_bytes: bodyTextBytes, created_at: createdAt,
        has_drawing: raw.has_drawing === true,
      })]
    })
  }

  function normalizeAgreements(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, 200).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const body = safeText(raw.body, '', 4000, false)
      const createdBy = safeHandle(raw.created_by)
      const parties = safeHandles(raw.parties)
      const acceded = safeHandles(raw.acceded).filter(handle => parties.includes(handle))
      const signatures = safeHandles(raw.signatures).filter(handle => parties.includes(handle))
      const partyCount = Math.max(safeCount(raw.party_count), parties.length)
      const createdAt = safeDate(raw.created_at)
      return id && body && createdBy && parties.length && createdAt
        ? [{ id, body, created_by: createdBy, parties, acceded, signatures,
          open: typeof raw.open === 'boolean' ? raw.open : signatures.length < parties.length,
          accession_open: raw.accession_open === true,
          party_count: partyCount,
          parties_truncated: raw.parties_truncated === true && partyCount > parties.length,
          created_at: createdAt, moderated: raw.moderated === true,
          truncated: raw.truncated === true }]
        : []
    })
  }

  function normalizeEvents(values, maximum = 100) {
    if (!Array.isArray(values)) return []
    return values.slice(0, maximum).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const id = safeId(raw.id)
      const changeId = raw.change_id == null ? null : safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor) || (
        SAFE_SYSTEM_EVENT_ACTORS.has(raw.actor) ? raw.actor : null
      )
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.at)
      if (!id || (raw.change_id != null && !changeId) || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
      if (raw.kind === 'gazette_printed') {
        const issueNumber = safeId(source.issue_number)
        const entryCount = safeGazetteCount(source.entry_count)
        if (!issueNumber || entryCount === null || detail.place_id !== 454) return []
        detail.issue_number = issueNumber
        detail.entry_count = entryCount
      }
      let carriesFailureCause = false
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) {
          detail.status = source.status
          carriesFailureCause = source.status === 'blocked' || source.status === 'failed'
        }
        if (source.action === 'move' && source.mode === 'carry') detail.mode = 'carry'
      } else if (raw.kind === 'effect_resolved' && SAFE_EFFECT_STATUSES.has(source.status)) {
        detail.status = source.status
        carriesFailureCause = source.status === 'skipped' || source.status === 'failed'
      }
      if (raw.kind === 'thing_moved' && source.mode === 'carry') detail.mode = 'carry'
      if (carriesFailureCause && Object.hasOwn(source, 'error')) {
        const error = safeText(source.error, null, EVENT_ERROR_LIMIT + 1, false)
        if (error) {
          const truncated = source.error_truncated === true || error.length > EVENT_ERROR_LIMIT
          detail.error = error.length > EVENT_ERROR_LIMIT
            ? error.slice(0, EVENT_ERROR_LIMIT - 1) + '…'
            : error
          if (truncated) detail.error_truncated = true
        } else {
          detail.error = UNSAFE_EVENT_ERROR
        }
      }
      return [{ id, ...(changeId ? { change_id: changeId } : {}),
        actor, kind: raw.kind, verb, at, detail,
        thingHasDrawing: raw.thing_has_drawing === true }]
    })
  }

  function normalizeLiveChanges(values) {
    if (!Array.isArray(values)) return []
    return values.slice(0, LIVE_OPENING_PAGE_LIMIT).flatMap(raw => {
      if (!raw || typeof raw !== 'object') return []
      const changeId = safeChangeMarker(raw.change_id)
      const actor = safeHandle(raw.actor)
      const verb = SAFE_EVENT_KINDS.get(raw.kind)
      const at = safeDate(raw.created_at)
      if (!changeId || !actor || !verb || !at) return []
      const source = raw.detail && typeof raw.detail === 'object' ? raw.detail : {}
      let detail = Object.fromEntries(SAFE_EVENT_DETAIL_IDS.flatMap(key => {
        const value = safeId(source[key])
        return value ? [[key, value]] : []
      }))
      detail = normalizeLiveTransferDetail(raw.kind, source, detail)
      if (raw.kind === 'action' && SAFE_ACTIONS.has(source.action)) {
        detail.action = source.action
        if (SAFE_ACTION_STATUSES.has(source.status)) detail.status = source.status
        if (source.mode === 'carry') detail.mode = 'carry'
      }
      return [Object.freeze({ change_id: changeId, actor, kind: raw.kind, verb, at, detail })]
    })
  }

  function normalizeLiveTransferDetail(kind, source, detail) {
    if (kind !== 'transfer') return detail
    const assetType = ['place', 'thing', 'kind'].includes(source.asset_type)
      ? source.asset_type
      : ['place', 'thing', 'kind'].includes(source.type) ? source.type : null
    const assetId = safeId(source.asset_id ?? source.id)
    return assetType && assetId
      ? { ...detail, asset_type: assetType, asset_id: assetId }
      : detail
  }

  function mergeLiveChanges(current, incoming) {
    const rows = new Map(current.map(row => [row.change_id, row]))
    for (const row of incoming) rows.set(row.change_id, row)
    return Object.freeze([...rows.values()].sort((left, right) =>
      Number(BigInt(right.change_id) - BigInt(left.change_id))))
  }

  function liveTraceKey(record) {
    return record.change_id ? 'change:' + record.change_id : 'event:' + String(record.id)
  }

  function liveRecordType(record) {
    if (record.kind === 'note' && record.detail.note_id && record.detail.place_id) return 'note'
    if ((record.kind === 'thing_created' || record.kind === 'thing_crafted') &&
        record.detail.place_id) return 'make'
    if (record.kind !== 'action' || record.detail.status !== 'applied') {
      return null
    }
    if ((record.detail.action === 'move' || record.detail.action === 'go_home') &&
        record.detail.from_place_id && record.detail.to_place_id) return 'move'
    if (record.detail.action === 'use' && record.detail.source_thing_id &&
        record.detail.place_id) return 'use'
    if (record.detail.action === 'make' && record.detail.place_id) return 'make'
    return null
  }

  function liveRecords() {
    const records = new Map()
    for (const record of [...state.live.changes, ...state.live.openingEvents]) {
      records.set(liveTraceKey(record), record)
    }
    return windowLiveReplayOrder([...records.values()], Number.NEGATIVE_INFINITY).reverse()
  }

  function liveInteractionRecords() {
    return liveRecords().filter(record =>
      record.kind === 'transfer' &&
      record.detail.resident_id && record.detail.place_id && liveRecordIsRecent(record))
  }

  function liveRecordLifetime(record) {
    return liveRecordType(record) === 'note' ? LIVE_NOTE_LIFETIME_MS : LIVE_MOVE_LIFETIME_MS
  }

  function liveRecordIsRecent(record, now = Date.now()) {
    return windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) > 0
  }

  function liveRecordPlaceId(record) {
    const type = liveRecordType(record)
    if (type === 'move') return record.detail.to_place_id || null
    if (record.detail.place_id) return record.detail.place_id
    return null
  }

  function liveMotionReduced() {
    return LIVE_MOTION_PREFERENCE.matches
  }

  function liveReplayRecordIsRevealed(record) {
    if (record.change_id && !state.live.openingLoaded) return false
    const key = liveTraceKey(record)
    return !state.live.replaySeenKeys.includes(key) ||
      state.live.replayRevealedKeys.includes(key)
  }

  function liveReplayHeldKeys() {
    return new Set([
      ...Object.values(state.live.replayQueues).flat().map(liveTraceKey),
      ...Object.values(state.live.replayActive).map(active => active.key),
    ])
  }

  function queueLiveReplays(records, animate = true) {
    const now = Date.now()
    const recentKeys = new Set(liveRecords().filter(record =>
      liveRecordIsRecent(record, now)).map(liveTraceKey))
    const heldKeys = liveReplayHeldKeys()
    const seen = new Set(state.live.replaySeenKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    const revealed = new Set(state.live.replayRevealedKeys.filter(key =>
      recentKeys.has(key) || heldKeys.has(key)))
    const additions = windowLiveReplayOrder(records, Number.NEGATIVE_INFINITY).filter(record => {
      const key = liveTraceKey(record)
      if (!record.change_id || !liveRecordType(record) || !liveRecordIsRecent(record, now) ||
          seen.has(key)) return false
      seen.add(key)
      if (state.resident && record.actor !== state.resident) {
        revealed.add(key)
        return false
      }
      return true
    })
    if (!additions.length &&
        seen.size === state.live.replaySeenKeys.length &&
        revealed.size === state.live.replayRevealedKeys.length) return

    const animates = animate && !liveMotionReduced()
    const retainedAdditions = animates
      ? additions.slice(-LIVE_REPLAY_BACKLOG_LIMIT)
      : additions
    const caughtUpAdditions = animates
      ? additions.slice(0, Math.max(0, additions.length - retainedAdditions.length))
      : []
    if (!animates) {
      const trailStarts = { ...state.live.trailStarts }
      for (const record of additions) {
        if (liveRecordType(record) === 'move') trailStarts[liveTraceKey(record)] = now
      }
      for (const record of additions) revealed.add(liveTraceKey(record))
      state = { ...state, live: {
        ...state.live,
        replaySeenKeys: Object.freeze([...seen]),
        replayRevealedKeys: Object.freeze([...revealed]),
        trailStarts: Object.freeze(trailStarts),
      } }
      return
    }

    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    for (const record of caughtUpAdditions) {
      const key = liveTraceKey(record)
      revealed.add(key)
      if (liveRecordType(record) === 'move') trailStarts[key] = now
    }
    for (const record of retainedAdditions) {
      queues[record.actor] = Object.freeze([...(queues[record.actor] || []), record])
      if (!Object.hasOwn(positions, record.actor) && liveRecordType(record) === 'move') {
        positions[record.actor] = record.detail.from_place_id
      }
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: Object.freeze(queues),
      replayPositions: Object.freeze(positions),
      replaySeenKeys: Object.freeze([...seen]),
      replayRevealedKeys: Object.freeze([...revealed]),
      trailStarts: Object.freeze(trailStarts),
    } }
  }

  function settleLiveReplays() {
    window.clearTimeout(liveReplayStartTimer)
    liveReplayStartTimer = 0
    const heldRecords = [
      ...Object.values(state.live.replayQueues).flat(),
      ...Object.values(state.live.replayActive).map(active => active.record),
    ]
    const keys = new Set([
      ...state.live.replaySeenKeys,
      ...liveReplayHeldKeys(),
    ])
    const trailStarts = { ...state.live.trailStarts }
    const settledAt = Date.now()
    for (const record of heldRecords) {
      if (liveRecordType(record) === 'move') trailStarts[liveTraceKey(record)] = settledAt
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: {}, replayActive: {}, replayPositions: {}, replayReadyAtByActor: {},
      replaySeenKeys: Object.freeze([...keys]),
      replayRevealedKeys: Object.freeze([...keys]),
      trailStarts: Object.freeze(trailStarts),
    } }
  }

  function livePlaceAnchorLookup(focusId, children) {
    const places = state.snapshot
      ? livePlaceRows(state.snapshot)
      : state.directory.loaded ? state.directory.places : []
    const byId = new Map(places.map(place => [place.id, place]))
    const childIds = new Set(children.map(place => place.id))
    const anchors = new Map()
    return Object.freeze({
      resolve(placeId) {
        if (anchors.has(placeId)) return anchors.get(placeId)
        const seen = new Set()
        let current = byId.get(placeId)
        let anchor = null
        while (current && !seen.has(current.id)) {
          if (childIds.has(current.id) || current.parent_id === focusId) {
            anchor = current.id
            break
          }
          seen.add(current.id)
          current = current.parent_id ? byId.get(current.parent_id) : null
        }
        anchors.set(placeId, anchor)
        return anchor
      },
    })
  }

  function livePlaceAnchor(placeId, focusId, children, renderContext = null) {
    if (!placeId) return null
    if (placeId === focusId) return focusId
    const buildLookup = () => livePlaceAnchorLookup(focusId, children)
    const lookup = renderContext
      ? renderContext.remember('place-anchor-lookup:' + String(focusId), buildLookup)
      : buildLookup()
    return lookup.resolve(placeId)
  }

  function liveDrawingKey(type, id) {
    return type + ':' + String(id)
  }

  async function fetchLiveDrawing(type, id) {
    const key = liveDrawingKey(type, id)
    const held = state.live.drawings[key]
    if (held?.loading || held?.loaded) return
    const loading = Object.freeze({ loading: true, loaded: false, error: false })
    state = {
      ...state,
      live: {
        ...state.live,
        drawings: { ...state.live.drawings, [key]: loading },
      },
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let settled = false
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('drawing unavailable')
      const payload = await response.json()
      const drawing = normalizeDrawingRead(type, id, payload)
      if (!drawing) throw new Error('invalid drawing')
      if (state.live.drawings[key] !== loading) return
      state = {
        ...state,
        live: {
          ...state.live,
          drawings: {
            ...state.live.drawings,
            [key]: Object.freeze({ loading: false, loaded: true, error: false, ...drawing }),
          },
        },
      }
      settled = true
    } catch {
      if (state.live.drawings[key] !== loading) return
      state = {
        ...state,
        live: {
          ...state.live,
          drawings: {
            ...state.live.drawings,
            [key]: Object.freeze({ loading: false, loaded: false, error: true }),
          },
        },
      }
      settled = true
    } finally {
      window.clearTimeout(timeout)
      if (settled && state.view === 'live') refreshLiveDrawingNodes(type, id)
    }
  }

  function drainLiveDrawingQueue() {
    if (state.view !== 'live' || document.hidden ||
        liveDrawingFetches >= LIVE_DRAWING_FETCH_CONCURRENCY || !liveDrawingQueue.length) return
    const [request, ...remaining] = liveDrawingQueue
    liveDrawingQueue = Object.freeze(remaining)
    if (state.live.drawings[request.key]) {
      drainLiveDrawingQueue()
      return
    }
    liveDrawingFetches += 1
    void fetchLiveDrawing(request.type, request.id).finally(() => {
      liveDrawingFetches = Math.max(0, liveDrawingFetches - 1)
      refillLiveDrawingQueue()
      drainLiveDrawingQueue()
    })
    drainLiveDrawingQueue()
  }

  function refillLiveDrawingQueue() {
    if (state.view !== 'live') {
      liveDrawingQueue = Object.freeze([])
      return
    }
    const queuedKeys = new Set()
    const requests = []
    for (const held of document.querySelectorAll(
      '#live-panel [data-live-drawing-type][data-live-drawing-id]')) {
      if (requests.length >= LIVE_DRAWING_QUEUE_LIMIT) break
      const plot = held.closest('.live-plot')
      if (plot?.dataset.liveDetail === 'false') continue
      const type = held.dataset.liveDrawingType
      const id = safeId(held.dataset.liveDrawingId)
      if (!['place', 'resident', 'thing'].includes(type) || !id) continue
      const key = liveDrawingKey(type, id)
      if (state.live.drawings[key] || queuedKeys.has(key)) continue
      queuedKeys.add(key)
      requests.push(Object.freeze({ type, id, key }))
    }
    liveDrawingQueue = Object.freeze(requests)
  }

  function loadLiveDrawing(type, id) {
    const key = liveDrawingKey(type, id)
    if (state.live.drawings[key] || liveDrawingQueue.some(request => request.key === key)) return
    if (liveDrawingQueue.length < LIVE_DRAWING_QUEUE_LIMIT) {
      liveDrawingQueue = Object.freeze([
        ...liveDrawingQueue,
        Object.freeze({ type, id, key }),
      ])
    }
    drainLiveDrawingQueue()
  }

  function refreshLiveDrawingNodes(type, id) {
    const key = liveDrawingKey(type, id)
    for (const held of document.querySelectorAll('[data-live-drawing-key="' + key + '"]')) {
      const replacement = drawingNode(
        type,
        id,
        held.dataset.liveDrawingLabel || type,
        Number(held.dataset.liveDrawingColumns) || 1,
        Number(held.dataset.liveDrawingRows) || 1,
      )
      for (const className of held.classList) {
        if (className.startsWith('live-')) replacement.classList.add(className)
      }
      replacement.style.width = held.style.width
      replacement.style.height = held.style.height
      if (held.hasAttribute('aria-hidden')) {
        replacement.setAttribute('aria-hidden', held.getAttribute('aria-hidden'))
      }
      held.replaceWith(replacement)
    }
    if (type !== 'place') return
    const entry = state.live.drawings[key]
    const undrawn = Boolean(entry?.loaded && entry.state === 'undrawn')
    for (const card of nodes.livePlates?.querySelectorAll(
      '.live-plot[data-place-id="' + String(id) + '"]') || []) {
      card.dataset.undrawn = String(undrawn)
      const owner = card.querySelector('.live-plot-owner')
      if (!owner) continue
      const plain = String(owner.textContent || '').replace(/^undrawn · /u, '')
      owner.textContent = undrawn ? 'undrawn · ' + plain : plain
    }
  }

  function paintedDrawingNode(drawing, columns, rows) {
    const tile = document.createElement('canvas')
    tile.width = 8
    tile.height = 8
    const tileContext = tile.getContext('2d')
    if (!tileContext) return null
    tileContext.imageSmoothingEnabled = false
    drawing.indices.forEach((paletteIndex, index) => {
      if (paletteIndex === null) return
      tileContext.fillStyle = drawing.palette[paletteIndex]
      tileContext.fillRect(index % 8, Math.floor(index / 8), 1, 1)
    })
    const canvas = document.createElement('canvas')
    canvas.classList.add('drawing-authored')
    canvas.width = columns * 8
    canvas.height = rows * 8
    const context = canvas.getContext('2d')
    const pattern = context?.createPattern(tile, 'repeat')
    if (!context || !pattern) return null
    context.imageSmoothingEnabled = false
    context.fillStyle = pattern
    context.fillRect(0, 0, canvas.width, canvas.height)
    return canvas
  }

  function applyDrawingData(node, entry) {
    node.dataset.drawingState = entry.state
    node.dataset.drawingPresentationState = entry.presentation_state
    node.dataset.drawingSource = entry.source
    if (entry.kind_id) node.dataset.drawingKindId = String(entry.kind_id)
    if (entry.kind_name) node.dataset.drawingKindName = entry.kind_name
    if (entry.revision) node.dataset.drawingRevision = String(entry.revision)
    if (entry.variant_name) node.dataset.drawingVariantName = entry.variant_name
  }

  function drawingAccessibleLabel(label, entry) {
    const stateLabel = windowDrawingStateLabel(entry.state, entry.drawing)
    const sourceLabel = windowDrawingSourceLabel(entry)
    return label + ' · ' + stateLabel + (sourceLabel ? ' · ' + sourceLabel : '')
  }

  function appendLiveDrawingLabels(node, entry) {
    const stateLabel = windowDrawingStateLabel(entry.state, entry.drawing)
    const stateNode = element('span', 'drawing-live-label drawing-state-label', stateLabel)
    node.append(stateNode)
    const sourceLabel = windowDrawingSourceLabel(entry)
    if (sourceLabel) {
      const sourceNode = element('span', 'drawing-live-label drawing-provenance', sourceLabel)
      sourceNode.title = sourceLabel
      node.append(sourceNode)
    }
  }

  function drawingNode(type, id, label, columns = 1, rows = 1) {
    const key = liveDrawingKey(type, id)
    const entry = state.live.drawings[key]
    if (!entry) void loadLiveDrawing(type, id)
    const safeColumns = Number.isSafeInteger(columns) && columns > 0
      ? Math.min(2_048, columns)
      : 1
    const safeRows = Number.isSafeInteger(rows) && rows > 0
      ? Math.min(2_048, rows)
      : 1
    const identify = node => {
      node.dataset.liveDrawingKey = key
      node.dataset.liveDrawingType = type
      node.dataset.liveDrawingId = String(id)
      node.dataset.liveDrawingLabel = label
      node.dataset.liveDrawingColumns = String(safeColumns)
      node.dataset.liveDrawingRows = String(safeRows)
      return node
    }
    if (entry?.error) {
      const unavailable = element('span', 'drawing-grid drawing-undrawn drawing-unavailable')
      unavailable.setAttribute('role', 'img')
      unavailable.setAttribute('aria-label', label + ' drawing could not be read')
      unavailable.append(element('span', 'drawing-undrawn-label', 'drawing unavailable'))
      return identify(unavailable)
    }
    if (!entry?.loaded) {
      const loading = element('span', 'drawing-grid drawing-undrawn drawing-loading')
      loading.setAttribute('role', 'img')
      loading.setAttribute('aria-label', 'Reading ' + label + ' drawing')
      loading.append(element('span', 'drawing-undrawn-label', 'reading drawing'))
      return identify(loading)
    }
    if (entry.drawing === null) {
      const standIn = element('span',
        'drawing-grid drawing-undrawn drawing-' + entry.presentation_state)
      standIn.setAttribute('role', 'img')
      standIn.setAttribute('aria-label', drawingAccessibleLabel(label, entry))
      applyDrawingData(standIn, entry)
      const visibleState = element('span',
        'drawing-undrawn-label drawing-state-label',
        windowDrawingStateLabel(entry.state, entry.drawing))
      standIn.append(visibleState)
      const sourceLabel = windowDrawingSourceLabel(entry)
      if (sourceLabel) {
        const sourceNode = element('span', 'drawing-live-label drawing-provenance', sourceLabel)
        sourceNode.title = sourceLabel
        standIn.append(sourceNode)
      }
      return identify(standIn)
    }
    const drawing = entry.drawing
    const sprite = paintedDrawingNode(drawing, safeColumns, safeRows)
    if (!sprite) {
      const unavailable = element('span', 'drawing-grid drawing-undrawn drawing-unavailable')
      unavailable.setAttribute('role', 'img')
      unavailable.setAttribute('aria-label', label + ' drawing could not be painted')
      unavailable.append(element('span', 'drawing-undrawn-label', 'drawing unavailable'))
      return identify(unavailable)
    }
    const shell = element('span',
      'drawing-grid drawing-authored-shell drawing-' + entry.presentation_state)
    shell.setAttribute('role', 'img')
    shell.setAttribute('aria-label', drawingAccessibleLabel(label, entry))
    applyDrawingData(shell, entry)
    applyDrawingData(sprite, entry)
    sprite.setAttribute('aria-hidden', 'true')
    shell.append(sprite)
    appendLiveDrawingLabels(shell, entry)
    return identify(shell)
  }

  async function fetchLiveNote(noteId) {
    const key = String(noteId)
    const held = state.live.noteBodies[key]
    if (held) return
    const loading = Object.freeze({ loading: true, error: false, body: null })
    state = {
      ...state,
      live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: loading,
      } },
    }
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let settled = false
    try {
      const response = await fetch('/api/note/' + key, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('note unavailable')
      const payload = await response.json()
      const body = safeExactText(payload?.note?.body, null, 4000, false)
      if (!body || safeId(payload?.note?.id) !== noteId) throw new Error('invalid note')
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: false, body }),
      } } }
      settled = true
    } catch {
      if (state.live.noteBodies[key] !== loading) return
      state = { ...state, live: { ...state.live, noteBodies: {
        ...state.live.noteBodies, [key]: Object.freeze({ loading: false, error: true, body: null }),
      } } }
      settled = true
    } finally {
      window.clearTimeout(timeout)
      if (settled && state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    }
  }

  function drainLiveNoteQueue() {
    if (state.view !== 'live' || document.hidden ||
        liveNoteFetches >= LIVE_NOTE_FETCH_CONCURRENCY || !liveNoteQueue.length) return
    const [noteId, ...remaining] = liveNoteQueue
    liveNoteQueue = Object.freeze(remaining)
    if (state.live.noteBodies[String(noteId)]) {
      drainLiveNoteQueue()
      return
    }
    liveNoteFetches += 1
    void fetchLiveNote(noteId).finally(() => {
      liveNoteFetches = Math.max(0, liveNoteFetches - 1)
      drainLiveNoteQueue()
    })
    drainLiveNoteQueue()
  }

  function loadLiveNote(noteId) {
    if (state.live.noteBodies[String(noteId)]) return
    if (!liveNoteQueue.includes(noteId) && liveNoteQueue.length < LIVE_NOTE_QUEUE_LIMIT) {
      liveNoteQueue = Object.freeze([...liveNoteQueue, noteId])
    }
    drainLiveNoteQueue()
  }

  function pruneLiveNoteBodies(now = Date.now()) {
    const retainedNoteIds = new Set(liveRecords()
      .filter(record => liveRecordType(record) === 'note' && liveRecordIsRecent(record, now))
      .map(record => record.detail.note_id))
    liveNoteQueue = Object.freeze(liveNoteQueue.filter(noteId => retainedNoteIds.has(noteId)))
    const entries = Object.entries(state.live.noteBodies)
      .filter(([key]) => retainedNoteIds.has(Number(key)))
    if (entries.length === Object.keys(state.live.noteBodies).length) return
    state = { ...state, live: { ...state.live, noteBodies: Object.fromEntries(entries) } }
  }

  function setLiveHighlight(key) {
    state = { ...state, live: { ...state.live, highlightedKey: key } }
    for (const node of document.querySelectorAll('[data-live-key]')) {
      node.dataset.highlighted = String(node.dataset.liveKey === key)
    }
  }

  function flattenPlaces(values, ancestors) {
    return values.flatMap(place => {
      const path = [...ancestors, place.name]
      const flat = [{ ...place, path: path.join(' / ') }]
      return [...flat, ...flattenPlaces(place.children, path)]
    })
  }

  function normalizePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSubplacePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_subplace_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeSubplaceId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public snapshot')
    const places = normalizePlaces(payload.places, 0, new Set())
    const residents = normalizeResidents(payload.residents)
    const notes = normalizeNotes(payload.notes)
    const things = normalizeThings(payload.things)
    const agreements = normalizeAgreements(payload.agreements)
    const events = normalizeEvents(payload.events)
    const liveSurvey = normalizeLiveSurvey(payload.live_survey)
    const shown = {
      places: flattenPlaces(places, []).length,
      residents: residents.length,
      conversations: notes.length,
      things: things.length,
      agreements: agreements.length,
      events: events.length,
    }
    const rawTotals = payload.totals && typeof payload.totals === 'object' ? payload.totals : {}
    const totals = Object.fromEntries(Object.entries(shown).map(([key, visible]) => [
      key,
      Math.max(safeCount(rawTotals[key]), visible),
    ]))
    const rawPages = payload.pages && typeof payload.pages === 'object' ? payload.pages : {}
    const pages = Object.freeze({
      places: normalizeSubplacePage(rawPages.places, places[0]?.children || [], totals.places),
      residents: normalizePage(rawPages.residents, residents, totals.residents),
      notes: normalizePage(rawPages.notes, notes, totals.conversations),
      things: normalizePage(rawPages.things, things, totals.things),
      agreements: normalizePage(rawPages.agreements, agreements, totals.agreements),
      events: normalizePage(rawPages.events, events, totals.events),
    })
    const rawBodyLimits = payload.body_limits && typeof payload.body_limits === 'object'
      ? payload.body_limits
      : {}
    const bodyLimits = Object.freeze({
      notes: safeId(rawBodyLimits.notes),
      things: safeId(rawBodyLimits.things),
      agreements: safeId(rawBodyLimits.agreements),
    })
    const hasBodyLimits = bodyLimits.notes && bodyLimits.things && bodyLimits.agreements
    return Object.freeze({
      places,
      flatPlaces: flattenPlaces(places, []),
      residents,
      notes,
      things,
      agreements,
      events,
      liveSurvey,
      shown,
      totals,
      pages,
      bodyLimits: hasBodyLimits ? bodyLimits : null,
      view: payload.view === 'outline' ? 'outline' : 'full',
      changeMarker: safeChangeMarker(payload.change_marker),
      refreshedAt: safeDate(payload.refreshed_at),
    })
  }

  function mergePlaceRows(currentChildren, incomingChildren) {
    const currentById = new Map(currentChildren.map(place => [place.id, place]))
    const incomingById = new Map(incomingChildren.map(place => [place.id, place]))
    return mergeWindowRows(currentChildren, incomingChildren).map(place => {
      const current = currentById.get(place.id)
      const incoming = incomingById.get(place.id)
      return Object.freeze({
        ...(current || {}),
        ...(incoming || place),
        children: mergePlaceRows(current?.children || [], incoming?.children || []),
      })
    })
  }

  function mergePlaceMetadata(values, incoming) {
    return values.map(place => Object.freeze({
      ...(place.id === incoming.id
        ? { ...place, ...incoming, children: place.children }
        : place),
      children: mergePlaceMetadata(place.children, incoming),
    }))
  }

  function mergeParentIntoBranches(branches, parent) {
    return Object.fromEntries(Object.entries(branches).map(([key, entry]) => [
      key,
      Object.freeze({ ...entry, rows: mergePlaceMetadata(entry.rows, parent) }),
    ]))
  }

  function materializePlaces(values, branches, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.flatMap(place => {
      if (!place || seen.has(place.id)) return []
      const entry = branches[String(place.id)]
      const source = entry?.loaded ? entry.rows : place.children
      return [Object.freeze({
        ...place,
        children: materializePlaces(source, branches, depth + 1, new Set([...seen, place.id])),
      })]
    })
  }

  function withNavigation(snapshot, branches, residents) {
    const places = materializePlaces(snapshot.places, branches, 0, new Set())
    const flatPlaces = flattenPlaces(places, [])
    return Object.freeze({
      ...snapshot,
      places,
      flatPlaces,
      residents,
      shown: Object.freeze({
        ...snapshot.shown,
        places: flatPlaces.length,
        residents: residents.length,
      }),
      totals: Object.freeze({
        ...snapshot.totals,
        places: Math.max(snapshot.totals.places, flatPlaces.length),
        residents: Math.max(snapshot.totals.residents, residents.length),
      }),
    })
  }

  function branchPageFromPayload(payload, placeId) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public map branch')
    const [parent] = normalizePlaces([payload.place], 0, new Set())
    if (!parent || parent.id !== placeId) throw new Error('wrong public map branch')
    const rows = normalizePlaces(payload.subplaces, 0, new Set([placeId]))
      .filter(child => child.parent_id === placeId)
    const page = normalizeSubplacePage(payload.subplaces_page, rows, parent.places)
    if (payload.subplaces_page?.has_more === true &&
        (!page.nextBeforeSubplaceId || !rows.some(row => row.id === page.nextBeforeSubplaceId))) {
      throw new Error('invalid public map cursor')
    }
    return Object.freeze({ parent, rows, page })
  }

  function branchCursorProgressed(requested, next, seen, rows) {
    return Boolean(next && rows.some(row => row.id === next) &&
      (!requested || next < requested) && !seen.includes(next))
  }

  function residentComesBefore(candidate, boundary) {
    const timeDifference = candidate.joined_at.getTime() - boundary.joined_at.getTime()
    return timeDifference < 0 || (timeDifference === 0 && candidate.id < boundary.id)
  }

  function residentCursorProgressed(requested, next, seen, rows, knownRows) {
    if (!next || seen.includes(next)) return false
    const nextResident = rows.find(row => row.id === next)
    if (!nextResident) return false
    if (!requested) return true
    const boundary = knownRows.find(row => row.id === requested)
    return requested !== next && Boolean(boundary && residentComesBefore(nextResident, boundary))
  }

  async function fetchBranchForwardPage(placeId, beforeId, minimumMarker, signal) {
    const url = branchRequestUrl(placeId, {
      initialized: Boolean(beforeId), nextBeforeSubplaceId: beforeId,
    }, minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public map branch unavailable')
    const payload = await response.json()
    requireExactReadMarker(payload?.change_marker, minimumMarker)
    return branchPageFromPayload(payload, placeId)
  }

  async function forwardReconcileBranch(
    placeId, current, firstPage, minimumMarker, signal, takeBudget,
  ) {
    const oldIds = new Set(current.rows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = []
    let pageResult = firstPage
    let lastParent = firstPage?.parent || null
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      if (!pageResult && !takeBudget()) break
      const result = pageResult || await fetchBranchForwardPage(
        placeId, beforeId, minimumMarker, signal)
      pageResult = null
      lastParent = result.parent
      const next = result.page.nextBeforeSubplaceId
      if (result.page.hasMore &&
          !branchCursorProgressed(beforeId, next, seen, result.rows)) {
        throw new Error('public map cursor did not progress')
      }
      collected = mergePlaceRows(collected, result.rows)
      const overlap = result.rows.some(row => oldIds.has(row.id))
      if (overlap || !result.page.hasMore) {
        return Object.freeze({
          parent: result.parent,
          rows: mergePlaceRows(current.rows, collected),
          complete: true,
        })
      }
      seen = [...seen, next]
      beforeId = next
    }
    if (lastParent && collected.length && beforeId) {
      return Object.freeze({
        parent: lastParent,
        rows: collected,
        complete: false,
        nextBeforeSubplaceId: beforeId,
        seenBeforeSubplaceIds: seen,
        deferredRows: current.rows,
      })
    }
    throw new Error('public map reconciliation limit reached')
  }

  async function fetchResidentForwardPage(beforeId, minimumMarker, signal) {
    const url = residentRequestUrl(
      { initialized: Boolean(beforeId), nextBeforeId: beforeId },
      minimumMarker,
    )
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public resident page unavailable')
    const payload = await response.json()
    if (!payload || typeof payload !== 'object') throw new Error('invalid public resident page')
    requireExactReadMarker(payload.change_marker, minimumMarker)
    const rows = normalizeResidents(payload.residents)
    const page = Object.freeze({
      hasMore: payload.has_more === true,
      nextBeforeId: payload.has_more === true ? safeId(payload.next_before_id) : null,
    })
    return Object.freeze({ rows, page })
  }

  async function forwardReconcileResidents(snapshot, previousRows, signal, takeBudget) {
    if (!previousRows.length) return Object.freeze({ rows: snapshot.residents, complete: true })
    const oldIds = new Set(previousRows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = snapshot.residents
    let rows = snapshot.residents
    let page = snapshot.pages.residents
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      const knownRows = mergeResidentRows(previousRows, collected)
      if (page.hasMore &&
          !residentCursorProgressed(beforeId, page.nextBeforeId, seen, rows, knownRows)) {
        throw new Error('public resident cursor did not progress')
      }
      const overlap = rows.some(row => oldIds.has(row.id))
      if (overlap || !page.hasMore) {
        return Object.freeze({ rows: mergeResidentRows(previousRows, collected), complete: true })
      }
      seen = [...seen, page.nextBeforeId]
      beforeId = page.nextBeforeId
      if (!takeBudget()) break
      const next = await fetchResidentForwardPage(beforeId, snapshot.changeMarker, signal)
      rows = next.rows
      page = next.page
      collected = mergeResidentRows(collected, rows)
    }
    if (collected.length && beforeId) {
      return Object.freeze({
        rows: collected,
        complete: false,
        nextBeforeId: beforeId,
        seenBeforeIds: seen,
        deferredResidents: previousRows,
      })
    }
    throw new Error('public resident reconciliation limit reached')
  }

  async function mergeFreshNavigation(snapshot, signal) {
    const previousBranches = state.branches
    let remainingReconcilePages = MAX_FORWARD_RECONCILE_PAGES
    const takeReconcileBudget = () => {
      if (remainingReconcilePages <= 0) return false
      remainingReconcilePages -= 1
      return true
    }
    let branches = { ...previousBranches }
    let refreshedPlaces = snapshot.places
    const rootIds = new Set(snapshot.places.map(root => root.id))

    for (const [index, root] of snapshot.places.entries()) {
      const current = previousBranches[String(root.id)]
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      if (!current) {
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            rows: root.children,
            loaded: true,
            initialized: true,
            hasMore: page.hasMore,
            nextBeforeSubplaceId: page.nextBeforeSubplaceId,
            seenBeforeSubplaceIds: [],
            loading: false,
            error: false,
          }),
        }
        continue
      }
      if (current.loading || (current.deferredRows || []).length) continue
      try {
        const reconciled = await forwardReconcileBranch(
          root.id,
          current,
          Object.freeze({ parent: root, rows: root.children, page }),
          snapshot.changeMarker,
          signal,
          takeReconcileBudget,
        )
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
      } catch {
        // Keep the last contiguous root page; the next bounded refresh retries.
      }
    }

    const nestedBranches = Object.entries(previousBranches).filter(([key, current]) => {
      const placeId = safeId(key)
      return placeId && !rootIds.has(placeId) && current.loaded && current.initialized &&
        !current.loading && !(current.deferredRows || []).length
    })
    const branchCount = Math.min(2, nestedBranches.length)
    const selectedBranches = Array.from({ length: branchCount }, (_, index) =>
      nestedBranches[(branchRefreshOffset + index) % nestedBranches.length])
    if (nestedBranches.length) branchRefreshOffset = (branchRefreshOffset + branchCount) % nestedBranches.length
    for (const [key, current] of selectedBranches) {
      const placeId = safeId(key)
      if (!placeId) continue
      try {
        const reconciled = await forwardReconcileBranch(
          placeId, current, null, snapshot.changeMarker, signal, takeReconcileBudget)
        branches = mergeParentIntoBranches(branches, reconciled.parent)
        branches = {
          ...branches,
          [key]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
        refreshedPlaces = mergePlaceMetadata(refreshedPlaces, reconciled.parent)
      } catch {
        // Silent revalidation never discards an already contiguous branch.
      }
    }

    let residents = snapshot.residents
    let residentPaging = state.residentPaging.initialized
      ? state.residentPaging
      : Object.freeze({
          initialized: true,
          hasMore: snapshot.pages.residents.hasMore,
          nextBeforeId: snapshot.pages.residents.nextBeforeId,
          seenBeforeIds: [],
          automaticPageCount: 0,
          automaticPaused: false,
          loading: false,
          error: false,
        })
    if ((state.residentPaging.deferredResidents || []).length) {
      residents = state.snapshot?.residents || snapshot.residents
    } else {
      try {
        const reconciled = await forwardReconcileResidents(
          snapshot, state.snapshot?.residents || [], signal, takeReconcileBudget)
        residents = reconciled.rows
        if (!reconciled.complete) {
          residentPaging = Object.freeze({
            ...residentPaging,
            hasMore: true,
            nextBeforeId: reconciled.nextBeforeId,
            seenBeforeIds: reconciled.seenBeforeIds,
            deferredResidents: reconciled.deferredResidents,
            error: false,
          })
        } else if (residentPaging.deferredResidents) {
          residentPaging = Object.freeze({ ...residentPaging, deferredResidents: [] })
        }
      } catch {
        residents = state.snapshot?.residents || snapshot.residents
      }
    }
    const refreshedSnapshot = Object.freeze({ ...snapshot, places: refreshedPlaces })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(refreshedSnapshot, branches, residents),
    })
  }

  function freshSnapshotNavigation(snapshot) {
    const branches = Object.fromEntries(snapshot.places.map((root, index) => {
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      return [String(root.id), Object.freeze({
        rows: root.children,
        loaded: true,
        initialized: true,
        hasMore: page.hasMore,
        nextBeforeSubplaceId: page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: [],
        loading: false,
        error: false,
      })]
    }))
    const residentPaging = Object.freeze({
      initialized: true,
      hasMore: snapshot.pages.residents.hasMore,
      nextBeforeId: snapshot.pages.residents.nextBeforeId,
      seenBeforeIds: [],
      automaticPageCount: 0,
      automaticPaused: false,
      loading: false,
      error: false,
    })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(snapshot, branches, snapshot.residents),
    })
  }

  function replaceBranch(placeId, entry) {
    const branches = { ...state.branches, [String(placeId)]: Object.freeze(entry) }
    const snapshot = state.snapshot
      ? withNavigation(state.snapshot, branches, state.snapshot.residents)
      : null
    state = { ...state, branches, snapshot }
  }

  function replaceBranchWithParent(placeId, entry, parent) {
    let branches = mergeParentIntoBranches(state.branches, parent)
    branches = { ...branches, [String(placeId)]: Object.freeze(entry) }
    const base = state.snapshot
      ? Object.freeze({
          ...state.snapshot,
          places: mergePlaceMetadata(state.snapshot.places, parent),
        })
      : null
    const snapshot = base ? withNavigation(base, branches, base.residents) : null
    state = { ...state, branches, snapshot }
  }

  function historyKey(collection, filters) {
    const place = collection === 'agreements' ? '' : String(filters.placeId || '')
    if (!place && !filters.resident) return 'all'
    return (filters.context ? 'context|' : '') +
      'place:' + place + '|resident:' + String(filters.resident || '')
  }

  function filterHistoryRows(collection, rows, filters, snapshot) {
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    if (collection === 'notes') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.author === filters.resident))
    if (collection === 'things') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.owner === filters.resident))
    if (collection === 'agreements') return rows.filter(row => !filters.resident ||
      row.created_by === filters.resident || row.parties.includes(filters.resident) ||
      row.parties_truncated)
    return rows.filter(row =>
      (!filters.resident || row.actor === filters.resident) &&
      (!placeIds || placeIds.has(eventPlaceId(row, snapshot))))
  }

  function historyTotal(collection, filters) {
    const snapshot = state.snapshot
    if (!snapshot) return 0
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    const places = placeIds
      ? snapshot.flatPlaces.filter(candidate => placeIds.has(candidate.id))
      : []
    if (collection === 'notes') return placeIds
      ? places.reduce((total, place) => total + place.notes, 0)
      : snapshot.totals.conversations
    if (collection === 'things') return placeIds
      ? places.reduce((total, place) => total + place.things, 0)
      : snapshot.totals.things
    if (collection === 'agreements') return snapshot.totals.agreements
    return snapshot.totals.events
  }

  function historyEntry(collection, filters) {
    const key = historyKey(collection, filters)
    const stored = state.histories[collection]?.[key]
    if (stored) return stored
    const global = state.histories[collection]?.all
    const snapshotRows = state.snapshot?.[collection] || []
    const rows = filterHistoryRows(collection, global?.rows || snapshotRows, filters, state.snapshot)
    return Object.freeze({
      rows,
      hasMore: historyTotal(collection, filters) > rows.length,
      nextBeforeId: null,
      automaticPageCount: 0,
      automaticPaused: false,
      initialized: false,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: false,
    })
  }

  function setHistoryEntry(collection, filters, entry) {
    const key = historyKey(collection, filters)
    state = {
      ...state,
      histories: {
        ...state.histories,
        [collection]: {
          ...state.histories[collection],
          [key]: Object.freeze({
            ...entry,
            filters: Object.freeze({
              placeId: filters.placeId,
              resident: filters.resident,
              context: filters.context === true,
            }),
          }),
        },
      },
    }
  }

  function freshSnapshotHistories(snapshot) {
    let histories = {}
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      histories = {
        ...histories,
        [collection]: {
          all: Object.freeze({
            rows: snapshot[collection],
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
            refreshing: false,
            refreshError: false,
          }),
        },
      }
    }
    return histories
  }

  function mergeUnchangedSnapshotHistories(snapshot) {
    let histories = state.histories
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const existing = histories[collection] || {}
      const refreshed = Object.fromEntries(Object.entries(existing).map(([key, entry]) => {
        if (key === 'all' || !entry?.filters) return [key, entry]
        const freshRows = filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
        return [key, Object.freeze({ ...entry, rows: mergeWindowRows(entry.rows, freshRows) })]
      }))
      const current = existing.all
      const rows = mergeWindowRows(current?.rows || [], snapshot[collection])
      const page = snapshot.pages[collection]
      const entry = current
        ? { ...current, rows }
        : {
            rows,
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
          }
      histories = {
        ...histories,
        [collection]: { ...refreshed, all: Object.freeze(entry) },
      }
    }
    return histories
  }

  function readLocationState() {
    const legacyHash = window.location.hash.slice(1)
    const params = new URLSearchParams(legacyHash || window.location.search)
    const parts = window.location.pathname.split('/').filter(Boolean)
    const pathKind = parts[0] === 'window' ? parts[1] || null : null
    const pathId = safeId(parts[2])
    const pathView = legacyHash
      ? null
      : VIEWS.includes(pathKind) ? pathKind
        : pathKind === 'thing' || pathKind === 'note' ? 'map' : null
    const view = legacyHash ? params.get('view') : pathView
    const resident = safeHandle(params.get('resident'))
    const mode = safeArchiveChoice(params.get('mode'), ['words', 'phrase'], 'words')
    const type = safeArchiveChoice(params.get('type'), ['all', 'note', 'thing'], 'all')
    const archiveQuery = validateWindowArchiveQuery(params.get('q') || '', mode)
    const query = archiveQuery.ok ? archiveQuery.value : ''
    const sharedDirectorySearch = validateWindowDirectorySearch(params.get('find') || '')
    const directorySearch = sharedDirectorySearch.ok ? sharedDirectorySearch.value : ''
    const sleeperPlaceIds = parseWindowSleeperPlaceIds(params.get('sleepers'))
    const archiveChanged = query !== state.archive.query || mode !== state.archive.mode ||
      type !== state.archive.type
    const selectedView = VIEWS.includes(view) ? view : 'map'
    const gazetteIssueId = selectedView === 'gazette' ? safeId(params.get('issue')) : null
    const gazetteChanged = gazetteIssueId !== state.gazetteIssueId
    const detail = !legacyHash && pathId && ['thing', 'note'].includes(pathKind)
      ? Object.freeze({ kind: pathKind, id: pathId })
      : null
    const pathPlaceId = pathKind === 'place' ? pathId : null
    return {
      view: selectedView,
      placeId: pathPlaceId || safeId(params.get('place')),
      resident,
      conversationContext: Boolean(resident && params.get('context') === 'place'),
      directorySearch,
      directorySearchIndex: directorySearch ? 0 : -1,
      sleeperPlaceIds,
      archive: archiveChanged
        ? {
            ...state.archive,
            query,
            mode,
            type,
            results: [],
            totalItems: 0,
            totalTextBytes: 0,
            nextBefore: null,
            hasMore: false,
            loading: false,
            initialized: false,
            error: null,
          }
        : state.archive,
      gazette: gazetteChanged
        ? {
            ...state.gazette,
            issue: null,
            entries: [],
            nextAfterOrdinal: null,
            hasMoreEntries: false,
            detailLoading: false,
            detailInitialized: false,
            detailError: null,
          }
        : state.gazette,
      gazetteIssueId,
      detail,
    }
  }

  function viewShareState() {
    return Object.freeze({
      view: state.view,
      placeId: state.placeId,
      resident: state.resident,
      conversationContext: state.conversationContext,
      directorySearch: state.directorySearch,
      sleeperPlaceIds: state.sleeperPlaceIds,
      archive: Object.freeze({
        query: state.archive.query,
        mode: state.archive.mode,
        type: state.archive.type,
      }),
      gazetteIssueId: state.gazetteIssueId,
      detail: state.detail,
    })
  }

  function writeLocation(push, entryState = null) {
    const path = windowSharePath(viewShareState())
    if (!path) {
      resetShareFeedback()
      return false
    }
    const current = window.location.pathname + window.location.search
    if (current === path && !window.location.hash) return true
    resetShareFeedback()
    if (push) history.pushState(entryState, '', path)
    else history.replaceState(entryState, '', path)
    return true
  }

  // Deliberate navigation — tabs, choosing a place or resident, filters —
  // creates a real back/forward entry. Background refresh never touches
  // history because renderAll only replaces when the hash is unchanged.
  // Arrow-key roving between tabs updates the address without pushing, so
  // walking the tab list never floods the back button.
  let rovingTabActivation = false
  function navigate(next) {
    const previousView = state.view
    const nextView = Object.hasOwn(next, 'view') ? next.view : state.view
    const nextResident = Object.hasOwn(next, 'resident') ? next.resident : state.resident
    const clearsLiveFocus = nextView === 'live' && Boolean(nextResident)
    const openingDetail = Boolean(next?.detail && (
      state.detail?.kind !== next.detail.kind || state.detail?.id !== next.detail.id
    ))
    if (openingDetail || (Object.hasOwn(next, 'detail') && next.detail === null)) {
      detailRequestRevision += 1
      detailDrawingRequestRevision += 1
      detailDrawingHistoryRequestRevision += 1
    }
    resetShareFeedback()
    const leavesReplayPlate = previousView === 'live' && (
      (Object.hasOwn(next, 'view') && next.view !== 'live') ||
      (Object.hasOwn(next, 'placeId') && next.placeId !== state.placeId) ||
      (Object.hasOwn(next, 'resident') && next.resident !== state.resident)
    )
    if (leavesReplayPlate && liveReplayHeldKeys().size) settleLiveReplays()
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...next,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    writeLocation(!rovingTabActivation, openingDetail ? { windowDetailEntry: true } : null)
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
    loadSharedGazette()
  }

  function closeDetail() {
    if (!state.detail) return
    detailRequestRevision += 1
    detailDrawingRequestRevision += 1
    detailDrawingHistoryRequestRevision += 1
    resetShareFeedback()
    if (nodes.detail?.open) nodes.detail.close()
    const historyBackClosesDetail = history.state?.windowDetailEntry === true
    state = { ...state, detail: null }
    if (historyBackClosesDetail) {
      renderDetail()
      void ensureFocusedSelection()
      history.back()
      return
    }
    writeLocation(false)
    renderAll()
    void ensureFocusedSelection()
  }

  function syncArchiveControls() {
    if (nodes.archiveQuery) nodes.archiveQuery.value = state.archive.query
    if (nodes.archiveMode) nodes.archiveMode.value = state.archive.mode
    if (nodes.archiveType) nodes.archiveType.value = state.archive.type
  }

  function loadSharedArchiveQuestion() {
    if (
      state.view === 'archive' && state.archive.query &&
      !state.archive.initialized && !state.archive.loading
    ) void loadArchive(true, true)
  }

  function activeSelectionKey() {
    return String(state.placeId || '') + '|resident:' + String(state.resident || '')
  }

  function activeFocusedPlaceIds(snapshot) {
    const followed = selectedResident(snapshot)
    const placeId = state.placeId || followed?.current_place_id || null
    return placeId ? [placeId] : []
  }

  function displayedDirectoryPlaces(snapshot) {
    const base = state.directory.loaded ? state.directory.places : snapshot.flatPlaces
    const replaced = base.map(place => focusedPlace(place.id) || place)
    const known = new Set(replaced.map(place => place.id))
    const additions = activeFocusedPlaceIds(snapshot).flatMap(placeId => {
      const place = known.has(placeId) ? null : focusedPlace(placeId)
      return place ? [place] : []
    })
    return [...replaced, ...additions]
  }

  function directorySearchSources(snapshot) {
    return {
      places: displayedDirectoryPlaces(snapshot),
      residents: state.directory.loaded ? state.directory.residents : snapshot.residents,
      complete: state.directory.loaded,
    }
  }

  function thingLookupSearchResults(snapshot) {
    return state.thingLookup.rows.map(thing => Object.freeze({
      kind: 'thing',
      id: thing.id,
      value: String(thing.id),
      label: thing.name + ' · Thing #' + String(thing.id),
      detail: thingHeadingPath(snapshot, thing),
      hasDrawing: thing.has_drawing === true,
    }))
  }

  function directorySearchPage(snapshot) {
    const sources = directorySearchSources(snapshot)
    const directoryPage = pageWindowDirectorySearch(
      sources.places,
      sources.residents,
      state.directorySearch,
    )
    const thingResults = state.thingLookup.query === state.directorySearch.trim()
      ? thingLookupSearchResults(snapshot)
      : []
    const reservedThingCount = Math.min(5, thingResults.length)
    const directoryResults = directoryPage.results.slice(0, 20 - reservedThingCount)
    const combined = [
      ...directoryResults,
      ...thingResults.slice(0, 20 - directoryResults.length),
    ]
    const total = directoryPage.total + thingResults.length
    return Object.freeze({
      ...directoryPage,
      results: Object.freeze(combined.slice(0, 20)),
      total,
      thingCount: thingResults.length,
      hasMore: total > combined.length || state.thingLookup.hasMore,
      thingHasMore: state.thingLookup.hasMore,
    })
  }

  function directorySearchRows(snapshot) {
    return directorySearchPage(snapshot).results
  }

  function closeDirectorySearchResults() {
    if (nodes.directorySearchResults) nodes.directorySearchResults.hidden = true
    if (nodes.directorySearch) {
      nodes.directorySearch.setAttribute('aria-expanded', 'false')
      nodes.directorySearch.removeAttribute('aria-activedescendant')
    }
  }

  function selectDirectorySearchResult(index) {
    if (!state.snapshot) return
    const result = directorySearchRows(state.snapshot)[index]
    if (!result) return
    state = { ...state, directorySearch: '', directorySearchIndex: -1 }
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    if (result.kind === 'place') choosePlace(result.id, false)
    else if (result.kind === 'thing') navigate({ detail: Object.freeze({ kind: 'thing', id: result.id }) })
    else chooseResident(result.value)
  }

  function renderDirectorySearch(snapshot, open = document.activeElement === nodes.directorySearch) {
    if (!nodes.directorySearch || !nodes.directorySearchResults || !nodes.directorySearchStatus) return
    if (nodes.directorySearch.value !== state.directorySearch) {
      nodes.directorySearch.value = state.directorySearch
    }
    const sources = directorySearchSources(snapshot)
    const query = state.directorySearch.trim()
    if (query && state.thingLookup.query !== query) scheduleThingLookup(query)
    const page = directorySearchPage(snapshot)
    const results = page.results
    const fallbackNotice = state.directory.error
      ? ' The complete city directory is unavailable, so more citywide matches may exist.'
      : ' The complete city directory is still loading, so more citywide matches may exist.'
    const thingNotice = state.thingLookup.loading
      ? ' Looking for matching public things…'
      : state.thingLookup.error
        ? ' Public thing lookup failed; places and residents remain available.'
        : page.thingHasMore
          ? ' Showing the newest matching things; narrow the name or use the Things tab to continue.'
          : ''
    if (!query) {
      nodes.directorySearchStatus.textContent = (sources.complete ? '' : 'Currently loaded fallback: ') +
        String(sources.places.length) +
        (sources.places.length === 1 ? ' place and ' : ' places and ') +
        String(sources.residents.length) +
        (sources.residents.length === 1 ? ' resident available.' : ' residents available.') +
        (sources.complete ? '' : fallbackNotice)
      nodes.directorySearchResults.replaceChildren()
      closeDirectorySearchResults()
      return
    }

    nodes.directorySearchStatus.textContent = sources.complete
      ? page.hasMore
        ? 'Showing the first ' + String(results.length) + ' of ' + String(page.total) +
          ' exact matches: ' + String(page.placeCount) +
          (page.placeCount === 1 ? ' place and ' : ' places and ') +
          String(page.residentCount) +
          (page.residentCount === 1 ? ' resident. ' : ' residents. ') +
          'Narrow this search or use the complete selectors and Things tab to reach more.'
        : String(page.total) + (page.total === 1 ? ' result: ' : ' results: ') +
          String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
          String(page.residentCount) +
          (page.residentCount === 1 ? ' resident.' : ' residents.') +
          (page.thingCount ? ' ' + String(page.thingCount) +
            (page.thingCount === 1 ? ' matching thing.' : ' matching things.') : '') + thingNotice
      : (page.hasMore
          ? 'Showing the first ' + String(results.length) + ' of ' + String(page.total) +
            ' matches in the currently loaded fallback: '
          : String(page.total) + (page.total === 1
              ? ' result in the currently loaded fallback: '
              : ' results in the currently loaded fallback: ')) +
        String(page.placeCount) + (page.placeCount === 1 ? ' place and ' : ' places and ') +
        String(page.residentCount) +
        (page.residentCount === 1 ? ' resident.' : ' residents.') + fallbackNotice + thingNotice
    if (!results.length) {
      const empty = element('div', 'directory-search-empty', sources.complete
        ? 'No places, residents, or things match this search.' + thingNotice
        : 'No places, residents, or things in the currently loaded fallback match this search.' +
          fallbackNotice + thingNotice)
      empty.setAttribute('role', 'option')
      empty.setAttribute('aria-disabled', 'true')
      nodes.directorySearchResults.replaceChildren(empty)
      nodes.directorySearch.removeAttribute('aria-activedescendant')
      state = { ...state, directorySearchIndex: -1 }
    } else {
      const activeIndex = Math.min(Math.max(state.directorySearchIndex, 0), results.length - 1)
      if (activeIndex !== state.directorySearchIndex) {
        state = { ...state, directorySearchIndex: activeIndex }
      }
      const options = results.map((result, index) => {
        const option = element('div', 'directory-search-option')
        option.id = 'directory-search-option-' + String(index)
        option.setAttribute('role', 'option')
        option.setAttribute('aria-selected', String(index === activeIndex))
        const copy = element('span', 'directory-search-option-copy')
        copy.append(
          element('strong', '', result.label),
          element('small', '', result.kind === 'place' ? 'Place · ' + result.detail :
            result.kind === 'thing' ? 'Thing · ' + result.detail : result.detail),
        )
        option.append(portraitNode(
          result.kind,
          result.id,
          result.label,
          result.kind === 'place' || result.hasDrawing === true,
        ), copy)
        option.addEventListener('mousedown', event => event.preventDefault())
        option.addEventListener('mouseenter', () => {
          if (state.directorySearchIndex === index) return
          state = { ...state, directorySearchIndex: index }
          for (const [optionIndex, searchOption] of [...nodes.directorySearchResults.children].entries()) {
            searchOption.setAttribute('aria-selected', String(optionIndex === index))
          }
          nodes.directorySearch.setAttribute('aria-activedescendant', option.id)
        })
        option.addEventListener('click', () => selectDirectorySearchResult(index))
        return option
      })
      nodes.directorySearchResults.replaceChildren(...options)
      nodes.directorySearch.setAttribute('aria-activedescendant', 'directory-search-option-' + String(activeIndex))
    }
    nodes.directorySearchResults.hidden = !open
    nodes.directorySearch.setAttribute('aria-expanded', String(open))
  }

  async function loadThingLookup(rawQuery) {
    const validated = validateWindowDirectorySearch(rawQuery)
    const query = validated.ok ? validated.value : ''
    const requestRevision = ++thingLookupRequestRevision
    if (!query) {
      state = {
        ...state,
        thingLookup: { query: '', rows: [], hasMore: false, loading: false, error: false },
      }
      if (state.snapshot) renderDirectorySearch(state.snapshot, false)
      return
    }
    state = {
      ...state,
      thingLookup: { query, rows: [], hasMore: false, loading: true, error: false },
    }
    if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    const controller = new AbortController()
    thingLookupController = controller
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('collection', 'things')
      url.searchParams.set('presentation', 'headings')
      url.searchParams.set('find', query)
      url.searchParams.set('limit', '20')
      if (state.changeMarker) url.searchParams.set('after_change_marker', state.changeMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('public thing lookup unavailable')
      const payload = await response.json()
      if (requestRevision !== thingLookupRequestRevision || state.directorySearch.trim() !== query) return
      requireCurrentReadMarker(payload?.change_marker, state.changeMarker)
      const rows = normalizeThingHeadings(payload.things)
      const hasMore = payload.has_more === true
      if (hasMore !== Boolean(safeId(payload.next_before_id))) {
        throw new Error('invalid public thing lookup')
      }
      state = {
        ...state,
        thingLookup: { query, rows, hasMore, loading: false, error: false },
      }
    } catch {
      if (requestRevision === thingLookupRequestRevision && state.directorySearch.trim() === query) {
        state = {
          ...state,
          thingLookup: { query, rows: [], hasMore: false, loading: false, error: true },
        }
      }
    } finally {
      window.clearTimeout(timeout)
      if (thingLookupController === controller) thingLookupController = null
      if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    }
  }

  function scheduleThingLookup(rawQuery, delay = 180) {
    const validated = validateWindowDirectorySearch(rawQuery)
    const query = validated.ok ? validated.value : ''
    if (
      query === scheduledThingLookupQuery &&
      (thingLookupTimer !== null || state.thingLookup.query === query)
    ) return
    scheduledThingLookupQuery = query
    if (thingLookupTimer !== null) window.clearTimeout(thingLookupTimer)
    thingLookupTimer = null
    if (thingLookupController) thingLookupController.abort()
    thingLookupController = null
    thingLookupRequestRevision += 1
    if (!query) {
      state = {
        ...state,
        thingLookup: { query: '', rows: [], hasMore: false, loading: false, error: false },
      }
      return
    }
    state = {
      ...state,
      thingLookup: { query, rows: [], hasMore: false, loading: true, error: false },
    }
    thingLookupTimer = window.setTimeout(() => {
      thingLookupTimer = null
      if (scheduledThingLookupQuery === query) void loadThingLookup(query)
    }, delay)
  }

  function populateFilters(snapshot) {
    const places = displayedDirectoryPlaces(snapshot)
    if (nodes.placeFilter) {
      const choices = listWindowDirectoryPlaces(places)
      const visiblePlaceIds = new Set(choices.map(option => option.id))
      const placeholder = element('option', '', 'All places')
      placeholder.value = ''
      const options = [placeholder, ...choices.map(choice => {
        const option = element('option', '', '\u00a0\u00a0'.repeat(choice.depth) + choice.label)
        option.value = String(choice.id)
        return option
      })]
      if (state.placeId && !visiblePlaceIds.has(state.placeId)) {
        const selected = focusedPlace(state.placeId) ||
          places.find(place => place.id === state.placeId)
        const focusedRead = state.focusedPlaces[String(state.placeId)]
        const option = element('option', '', selected
          ? selected.name + ' · Place #' + String(selected.id)
          : focusedRead?.notFound
            ? 'Place #' + String(state.placeId) + ' · no public place was found'
            : focusedRead?.error
              ? 'Place #' + String(state.placeId) + ' · public place could not be loaded'
              : 'Place #' + String(state.placeId) + ' · loading public place…')
        option.value = String(state.placeId)
        options.push(option)
      }
      nodes.placeFilter.replaceChildren(...options)
      nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    }
    if (nodes.residentFilter) {
      const residents = state.directory.loaded ? state.directory.residents : snapshot.residents
      const focusedRead = state.resident ? state.focusedResidents[state.resident] : null
      const missingResident = state.resident && !residents.some(resident => resident.handle === state.resident)
        ? [element('option', '', focusedRead?.notFound
          ? state.resident + ' · no public resident was found'
          : focusedRead?.error
            ? state.resident + ' · public resident could not be loaded'
            : state.resident + ' · loading public resident…')]
        : []
      if (missingResident[0]) missingResident[0].value = state.resident
      const options = [element('option', '', 'All residents'), ...residents.map(resident => {
        const option = element('option', '', resident.handle + ' · Resident #' + String(resident.id))
        option.value = resident.handle
        return option
      }), ...missingResident]
      options[0].value = ''
      nodes.residentFilter.replaceChildren(...options)
      nodes.residentFilter.value = state.resident || ''
    }
    renderDirectorySearch(snapshot)
  }

  function selectedResident(snapshot) {
    return state.resident
      ? focusedResident(state.resident) ||
        snapshot.residents.find(resident => resident.handle === state.resident)
      : null
  }

  function residentPresentationKey(snapshot) {
    return JSON.stringify(snapshot?.residents || [])
  }

  function directoryResident(handle) {
    return handle
      ? state.directory.residents.find(resident => resident.handle === handle) || null
      : null
  }

  function residentReference(snapshot, handle) {
    if (!handle) return null
    return focusedResident(handle) ||
      snapshot.residents.find(resident => resident.handle === handle) || directoryResident(handle)
  }

  function directoryPlace(placeId) {
    return placeId
      ? state.directory.places.find(place => place.id === placeId) || null
      : null
  }

  function placeScopeSet(placeId, snapshot) {
    const places = state.directory.loaded
      ? state.directory.places
      : snapshot?.flatPlaces || []
    return new Set(windowDirectoryPlaceScopeIds(places, placeId))
  }

  function placeReference(snapshot, placeId) {
    if (!placeId) return null
    return focusedPlace(placeId) ||
      snapshot.flatPlaces.find(place => place.id === placeId) || directoryPlace(placeId)
  }

  function focusedPlacePath(reference, place) {
    if (!reference) return place.name + ' · Place #' + String(place.id)
    const fallbackSuffix = ' · Place #' + String(place.id)
    if (reference.path.endsWith(fallbackSuffix)) return place.name + fallbackSuffix
    const names = reference.path.split(' / ')
    return [...names.slice(0, -1), place.name].join(' / ')
  }

  function focusedPlace(placeId) {
    if (!placeId) return null
    const entry = state.focusedPlaces[String(placeId)]
    const place = entry?.place || null
    if (place && state.changeMarker && !markerCovers(entry?.marker, state.changeMarker)) return null
    const reference = directoryPlace(placeId)
    return place
      ? Object.freeze({ ...place, path: focusedPlacePath(reference, place) })
      : null
  }

  function focusedResident(handle) {
    if (!handle) return null
    const entry = state.focusedResidents[handle]
    if (entry?.resident && state.changeMarker && !markerCovers(entry.marker, state.changeMarker)) {
      return null
    }
    return entry?.resident || null
  }

  function selectedPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const id = state.placeId || (followed && followed.current_place_id) || null
    return id
      ? focusedPlace(id) || snapshot.flatPlaces.find(place => place.id === id)
      : null
  }

  function liveSurveyCoversPlace(snapshot, placeId) {
    return Boolean(
      placeId &&
      state.view === 'live' &&
      state.directory.loaded &&
      liveSurveyIsComplete(snapshot) &&
      snapshot.liveSurvey.some(place => place.id === placeId),
    )
  }

  function displayedResidents(snapshot) {
    const residents = snapshot.residents.map(resident =>
      focusedResident(resident.handle) || resident)
    const followed = selectedResident(snapshot)
    return followed && !residents.some(resident => resident.handle === followed.handle)
      ? [...residents, followed]
      : residents
  }

  function residentsAt(snapshot, placeId) {
    const placeIds = placeScopeSet(placeId, snapshot)
    return displayedResidents(snapshot).filter(resident => placeIds.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
  }

  function selectionIssue(snapshot, includeCurrentPlace) {
    const resident = selectedResident(snapshot)
    if (state.resident && !resident) {
      const entry = state.focusedResidents[state.resident]
      return Object.freeze({
        kind: 'resident', value: state.resident,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    const placeId = state.placeId ||
      (includeCurrentPlace && resident ? resident.current_place_id : null)
    const place = placeId
      ? snapshot.flatPlaces.find(candidate => candidate.id === placeId) || focusedPlace(placeId)
      : null
    if (placeId && !place) {
      const entry = state.focusedPlaces[String(placeId)]
      return Object.freeze({
        kind: 'place', value: placeId,
        status: entry?.notFound ? 'not-found' : entry?.error ? 'error' : 'loading',
      })
    }
    return null
  }

  function renderSelectionIssue(target, issue, itemTag, focusFallbackId) {
    if (!target || !issue) return false
    const loadingMessage = issue.kind === 'resident'
      ? 'Loading public resident ' + String(issue.value) + '…'
      : 'Loading public place #' + String(issue.value) + '…'
    const notFoundMessage = issue.kind === 'resident'
      ? 'No public resident was found for ' + String(issue.value) + '.'
      : 'No public place was found for #' + String(issue.value) + '.'
    const failureMessage = issue.kind === 'resident'
      ? 'Public resident ' + String(issue.value) + ' could not be loaded.'
      : 'Public place #' + String(issue.value) + ' could not be loaded.'
    const row = element(itemTag || 'div', issue.status === 'error' ? 'error-row' :
      issue.status === 'not-found' ? 'empty-row' : 'loading-row')
    if (issue.status === 'loading') {
      row.textContent = loadingMessage
    } else if (issue.status === 'not-found') {
      row.textContent = notFoundMessage
    } else {
      row.setAttribute('role', 'alert')
      row.append(element('p', '', failureMessage))
      const retry = element('button', 'selection-retry', issue.kind === 'resident'
        ? 'Retry loading this resident'
        : 'Retry loading this place')
      retry.type = 'button'
      retry.dataset.focusKey = 'selection-retry:' + issue.kind + ':' + String(issue.value)
      retry.dataset.focusFallbackId = focusFallbackId || target.id
      retry.addEventListener('click', () => {
        if (issue.kind === 'resident') void ensureFocusedSelection({ forceResident: true })
        else void loadFocusedPlace(Number(issue.value), true)
      })
      row.append(retry)
    }
    target.replaceChildren(row)
    return true
  }

  function occupantChip(resident) {
    const chip = element('button', resident.asleep ? 'occupant-chip asleep' : 'occupant-chip')
    chip.type = 'button'
    chip.dataset.focusKey = 'occupant:' + resident.handle
    if (resident.asleep) chip.title = 'dimmed by a two-week public-activity display heuristic · not proof they are offline'
    chip.addEventListener('click', () => chooseResident(resident.handle))
    chip.append(
      portraitNode('resident', resident.id, resident.handle, resident.has_drawing, 'occupant-portrait'),
      document.createTextNode(resident.handle),
    )
    return chip
  }

  function toggleSleepers(placeId) {
    const sleeperPlaceIds = state.sleeperPlaceIds.includes(placeId)
      ? state.sleeperPlaceIds.filter(id => id !== placeId)
      : [...state.sleeperPlaceIds, placeId]
    state = { ...state, sleeperPlaceIds }
    writeLocation(true)
    if (state.snapshot) renderAll()
  }

  function occupantLine(place, occupants) {
    const line = element('div', 'occupant-line')
    const awake = occupants.filter(resident => !resident.asleep)
    const asleep = occupants.filter(resident => resident.asleep)
    line.append(...awake.map(occupantChip))
    if (asleep.length) {
      const shown = state.sleeperPlaceIds.includes(place.id)
      const toggle = element('button', 'sleeper-toggle',
        shown ? 'hide the asleep' : String(asleep.length) + ' asleep')
      toggle.type = 'button'
      toggle.dataset.focusKey = 'sleepers:' + String(place.id)
      toggle.setAttribute('aria-expanded', String(shown))
      toggle.setAttribute('aria-label', (shown ? 'Hide' : 'Show') +
        ' residents asleep in ' + place.name)
      toggle.addEventListener('click', () => toggleSleepers(place.id))
      line.append(toggle)
      if (shown) line.append(...asleep.map(occupantChip))
    }
    return line
  }

  function branchEntry(place) {
    const stored = state.branches[String(place.id)]
    if (stored) return stored
    const loaded = place.children.length > 0 || place.places === 0
    const hasMore = place.places > place.children.length
    return Object.freeze({
      rows: place.children,
      loaded,
      initialized: loaded,
      hasMore,
      nextBeforeSubplaceId: loaded && hasMore ? safeId(place.children.at(-1)?.id) : null,
      seenBeforeSubplaceIds: [],
      loading: false,
      error: false,
    })
  }

  function togglePlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const entry = branchEntry(place)
    if (!entry.loaded) {
      if (!entry.loading) void loadPlaceBranch(placeId)
      return
    }
    const collapsedPlaceIds = state.collapsedPlaceIds.includes(placeId)
      ? state.collapsedPlaceIds.filter(id => id !== placeId)
      : [...state.collapsedPlaceIds, placeId]
    state = { ...state, collapsedPlaceIds }
    if (state.snapshot) renderAll()
  }

  function branchRequestUrl(placeId, entry, minimumMarker) {
    const url = new URL('/api/map', window.location.origin)
    url.searchParams.set('view', 'outline')
    url.searchParams.set('parent_id', String(placeId))
    if (entry.initialized && entry.nextBeforeSubplaceId) {
      url.searchParams.set('before_subplace_id', String(entry.nextBeforeSubplaceId))
    }
    url.searchParams.set('subplace_limit', '25')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadPlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const current = branchEntry(place)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    const collapsedPlaceIds = state.collapsedPlaceIds.filter(id => id !== placeId)
    state = { ...state, collapsedPlaceIds }
    replaceBranch(placeId, { ...current, loading: true, error: false })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = state.branches[String(placeId)] || current
      const url = branchRequestUrl(placeId, requestEntry, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public map branch unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const result = branchPageFromPayload(payload, placeId)
      const requestedCursor = requestEntry.initialized
        ? requestEntry.nextBeforeSubplaceId
        : null
      const seenBeforeSubplaceIds = requestEntry.seenBeforeSubplaceIds || []
      if (result.page.hasMore && !branchCursorProgressed(
        requestedCursor,
        result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds,
        result.rows,
      )) throw new Error('public map cursor did not progress')
      const latest = state.branches[String(placeId)] || current
      const deferredRows = latest.deferredRows || []
      const reachedDeferred = result.rows.some(row =>
        deferredRows.some(deferred => deferred.id === row.id))
      const visibleRows = mergePlaceRows(latest.rows, result.rows)
      const reconcileComplete = reachedDeferred || !result.page.hasMore
      replaceBranchWithParent(placeId, {
        rows: reconcileComplete ? mergePlaceRows(deferredRows, visibleRows) : visibleRows,
        deferredRows: reconcileComplete ? [] : deferredRows,
        loaded: true,
        initialized: true,
        hasMore: result.page.hasMore,
        nextBeforeSubplaceId: result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: requestedCursor
          ? [...new Set([...seenBeforeSubplaceIds, requestedCursor])]
          : seenBeforeSubplaceIds,
        loading: false,
        error: false,
      }, result.parent)
      if (state.snapshot) populateFilters(state.snapshot)
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      const latest = state.branches[String(placeId)] || current
      replaceBranch(placeId, { ...latest, loading: false, error: true })
    } finally {
      window.clearTimeout(timeout)
      navigationRevision += 1
      renderAll()
    }
  }

  function branchPage(place, entry, childrenId) {
    const item = element('li', 'branch-page')
    if (entry.error) {
      item.setAttribute('role', 'alert')
      item.append(element('p', '', 'Could not load places inside ' + place.name + '.'))
      const retry = element('button', 'branch-load', 'Retry loading places inside ' + place.name)
      retry.type = 'button'
      retry.dataset.focusKey = 'branch-page:' + String(place.id)
      retry.dataset.focusFallbackKey = 'branch:' + String(place.id)
      retry.setAttribute('aria-busy', 'false')
      retry.setAttribute('aria-controls', childrenId)
      retry.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(retry)
      return item
    }
    if (entry.loading && !entry.loaded) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'Loading places inside ' + place.name + '…'))
      return item
    }
    if (entry.loaded && entry.hasMore) {
      const load = element('button', 'branch-load', entry.loading
        ? 'Loading more places inside ' + place.name + '…'
        : 'Load more places inside ' + place.name)
      load.type = 'button'
      load.dataset.focusKey = 'branch-page:' + String(place.id)
      load.dataset.focusFallbackKey = 'branch:' + String(place.id)
      load.setAttribute('aria-busy', String(entry.loading))
      load.setAttribute('aria-controls', childrenId)
      load.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(load)
      return item
    }
    if (entry.loaded && !entry.rows.length) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'No more public places were found inside ' + place.name + '.'))
    }
    return item
  }

  function placeList(values, snapshot, depth) {
    const list = element('ul', 'place-tree')
    if (!Array.isArray(values) || depth >= 32) return list
    for (const place of values) {
      const node = element('li', 'place-node')
      const card = element('article', 'place-card')
      card.dataset.watched = String(state.placeId === place.id)
      const hasChildren = place.places > 0
      const branch = branchEntry(place)
      const expanded = hasChildren && (branch.loaded || branch.loading || branch.error) &&
        !state.collapsedPlaceIds.includes(place.id)
      const watch = element('button', 'place-watch place-name', place.name)
      watch.type = 'button'
      watch.dataset.focusKey = 'watch:' + String(place.id)
      watch.addEventListener('click', () => choosePlace(place.id, true))
      const occupants = residentsAt(snapshot, place.id)
      const owner = element('span', 'place-owner')
      if (place.owner) {
        owner.append(
          document.createTextNode('kept by '),
          residentNode(place.owner, 'place-owner-resident',
            'place-owner:' + String(place.id)),
        )
      } else {
        owner.textContent = 'unowned · transit only'
      }
      card.append(
        portraitNode('place', place.id, place.name, true, 'place-portrait'),
        watch,
        owner,
        element('span', 'place-facts', String(place.places) +
          (place.places === 1 ? ' place inside · ' : ' places inside · ') +
          String(occupants.length) +
          (occupants.length === 1 ? ' resident shown inside · ' : ' residents shown inside · ') +
          String(place.things) + ' things · ' + String(place.notes) + ' notes'),
      )
      if (place.front_matter.length) {
        const headings = element('ul', 'place-card-things')
        headings.setAttribute('aria-label', 'Owner-chosen thing headings')
        headings.append(...place.front_matter.map(thing => {
          const item = element('li', 'place-card-thing')
          item.append(
            portraitNode('thing', thing.id, thing.name, thing.has_drawing),
            openDetailLink(
              'thing', thing.id, thing.name, 'detail-link place-card-thing-link',
            ),
          )
          return item
        }))
        card.append(headings)
      }
      if (place.status === 'retired' && place.retiredAt) {
        card.append(element(
          'p',
          'moderated-mark',
          'Retired ' + place.retiredAt.toLocaleString() +
            ' · founding name ' + place.foundingName + ' · stable place #' + String(place.id),
        ))
      }
      if (hasChildren) {
        const childrenId = 'place-children-' + String(place.id)
        const disclosure = element('button', 'place-disclosure', expanded ? 'Collapse inside' : 'Show inside')
        disclosure.type = 'button'
        disclosure.dataset.focusKey = 'branch:' + String(place.id)
        disclosure.setAttribute('aria-expanded', String(expanded))
        disclosure.setAttribute('aria-busy', String(branch.loading && !branch.loaded))
        disclosure.setAttribute('aria-controls', childrenId)
        disclosure.setAttribute('aria-label', (expanded ? 'Collapse' : 'Show') + ' places inside ' + place.name)
        disclosure.addEventListener('click', () => togglePlaceBranch(place.id))
        card.append(disclosure)
      }
      if (occupants.length) card.append(occupantLine(place, occupants))
      node.append(card)
      if (hasChildren) {
        const children = placeList(branch.rows, snapshot, depth + 1)
        children.id = 'place-children-' + String(place.id)
        children.hidden = !expanded
        if (expanded) {
          const page = branchPage(place, branch, children.id)
          if (page.childNodes.length) children.append(page)
        }
        node.append(children)
      }
      list.append(node)
    }
    return list
  }

  function mapRoots(snapshot) {
    const focus = selectedPlace(snapshot)
    if (focus) return [focus]
    const focused = focusedPlace(state.placeId)
    if (focused) return [focused]
    return state.placeId || state.resident ? [] : snapshot.places
  }

  function renderMap(snapshot) {
    if (!nodes.map) return
    const issue = selectionIssue(snapshot, true)
    if (issue) {
      renderSelectionIssue(nodes.map, issue)
      return
    }
    const roots = mapRoots(snapshot)
    if (!roots.length) {
      const missing = state.resident
        ? state.resident + ' is not currently standing in a public place.'
        : 'No public place in the currently loaded view matches this filter.'
      renderEmpty(nodes.map, 'empty-row', missing)
      return
    }
    nodes.map.replaceChildren(placeList(roots, snapshot, 0))
  }

  function residentRequestUrl(entry, minimumMarker) {
    const url = new URL('/api/residents', window.location.origin)
    url.searchParams.set('view', 'presence')
    url.searchParams.set('limit', state.view === 'live' ? '200' : '25')
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadResidents(automatic = false) {
    if (automatic && (state.view !== 'live' || document.hidden)) return
    const current = state.residentPaging
    if (!state.snapshot || current.loading || (!current.hasMore && !current.error)) return
    if (automatic && (current.automaticPageCount || 0) >= MAX_AUTO_HISTORY_PAGES) {
      state = {
        ...state,
        residentPaging: Object.freeze({
          ...current, loading: false, error: false, automaticPaused: true,
        }),
      }
      renderAll()
      return
    }
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    state = {
      ...state,
      residentPaging: Object.freeze({
        ...current, loading: true, error: false, automaticPaused: false,
      }),
    }
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = state.residentPaging
      const url = residentRequestUrl(requestEntry, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public resident page unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      if (!payload || typeof payload !== 'object') throw new Error('invalid public resident page')
      requireCurrentReadMarker(payload.change_marker, requestMarker)
      const incoming = normalizeResidents(payload.residents)
      const hasMore = payload.has_more === true
      const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
      const requestedCursor = requestEntry.initialized ? requestEntry.nextBeforeId : null
      const seenBeforeIds = requestEntry.seenBeforeIds || []
      if (hasMore && !residentCursorProgressed(
        requestedCursor,
        nextBeforeId,
        seenBeforeIds,
        incoming,
        state.snapshot.residents,
      )) throw new Error('public resident cursor did not progress')
      const deferredResidents = requestEntry.deferredResidents || []
      const reachedDeferred = incoming.some(row =>
        deferredResidents.some(deferred => deferred.id === row.id))
      const visibleResidents = mergeResidentRows(state.snapshot.residents, incoming)
      const reconcileComplete = reachedDeferred || !hasMore
      const residents = reconcileComplete
        ? mergeResidentRows(deferredResidents, visibleResidents)
        : visibleResidents
      const advertisedTotal = safeCount(payload.total)
      const base = Object.freeze({
        ...state.snapshot,
        totals: Object.freeze({
          ...state.snapshot.totals,
          residents: Math.max(state.snapshot.totals.residents, advertisedTotal, residents.length),
        }),
      })
      const snapshot = withNavigation(base, state.branches, residents)
      const automaticPageCount = automatic
        ? (state.residentPaging.automaticPageCount || 0) + 1
        : 0
      const automaticPaused = automatic && hasMore &&
        automaticPageCount >= MAX_AUTO_HISTORY_PAGES
      state = {
        ...state,
        snapshot,
        residentPaging: Object.freeze({
          initialized: true,
          hasMore,
          nextBeforeId,
          deferredResidents: reconcileComplete ? [] : deferredResidents,
          seenBeforeIds: requestedCursor
            ? [...new Set([...seenBeforeIds, requestedCursor])]
            : seenBeforeIds,
          automaticPageCount,
          automaticPaused,
          loading: false,
          error: false,
        }),
      }
      populateFilters(snapshot)
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        residentPaging: Object.freeze({ ...state.residentPaging, loading: false, error: true }),
      }
    } finally {
      window.clearTimeout(timeout)
      navigationRevision += 1
      renderAll()
    }
  }

  function renderResidentPage() {
    if (!nodes.residentPage) return
    const entry = state.residentPaging
    if (!entry.hasMore && !entry.loading && !entry.error) {
      nodes.residentPage.hidden = true
      nodes.residentPage.replaceChildren()
      return
    }
    const parts = []
    if (entry.error) {
      const message = element('p', 'navigation-error', 'Could not load more residents.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    const text = entry.loading
      ? 'Loading more residents…'
      : entry.error ? 'Retry loading residents' : 'Load more residents'
    const button = element('button', 'resident-load', text)
    button.type = 'button'
    button.dataset.focusKey = 'resident-page'
    button.dataset.focusFallbackKey = state.snapshot?.residents[0]
      ? 'roster:' + state.snapshot.residents[0].handle
      : ''
    button.dataset.focusFallbackId = 'resident-roster'
    button.setAttribute('aria-busy', String(entry.loading))
    button.setAttribute('aria-controls', 'resident-roster')
    button.addEventListener('click', () => void loadResidents())
    parts.push(button)
    nodes.residentPage.hidden = false
    nodes.residentPage.replaceChildren(...parts)
  }

  function renderRoster(snapshot) {
    if (!nodes.roster) return
    renderResidentPage()
    const issue = state.resident ? selectionIssue(snapshot, false) : null
    if (issue?.kind === 'resident') {
      renderSelectionIssue(nodes.roster, issue)
      return
    }
    const selectedPlaceIds = state.placeId ? placeScopeSet(state.placeId, snapshot) : null
    const availableResidents = displayedResidents(snapshot)
    const visible = availableResidents.filter(resident =>
      (!state.resident || resident.handle === state.resident) &&
      (!selectedPlaceIds || selectedPlaceIds.has(resident.current_place_id)))
    if (!visible.length) {
      const empty = element('p', 'empty-row', snapshot.residents.length
        ? 'Watching. No currently loaded resident matches this view.'
        : 'Watching. No residents are loaded in this view.')
      empty.setAttribute('role', 'status')
      nodes.roster.replaceChildren(empty)
      return
    }
    const groups = [...new Set(visible.map(resident => resident.current_place_id))]
    const fragment = document.createDocumentFragment()
    for (const placeId of groups) {
      const group = element('section', 'roster-group')
      const place = placeReference(snapshot, placeId)
      group.append(element('p', 'roster-place', place
        ? place.path
        : placeId
          ? state.focusedPlaces[String(placeId)]?.notFound
            ? 'Place #' + String(placeId) + ' · no public place was found'
            : state.focusedPlaces[String(placeId)]?.error
              ? 'Place #' + String(placeId) + ' · public place could not be loaded'
              : 'Place #' + String(placeId) + ' · loading public place…'
          : 'Between places'))
      const standing = visible.filter(candidate => candidate.current_place_id === placeId)
      for (const resident of [...standing.filter(r => !r.asleep), ...standing.filter(r => r.asleep)]) {
        const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
        const follow = element('button', 'resident-follow', resident.handle)
        follow.type = 'button'
        follow.dataset.focusKey = 'roster:' + resident.handle
        follow.addEventListener('click', () => chooseResident(resident.handle))
        row.append(follow, element('span', 'resident-number',
          'resident #' + String(resident.id) + (resident.asleep ? ' · asleep' : '')))
        row.prepend(portraitNode('resident', resident.id, resident.handle, resident.has_drawing))
        group.append(row)
      }
      fragment.append(group)
    }
    nodes.roster.replaceChildren(fragment)
  }

  function livePlaceRows(snapshot) {
    if (!state.directory.loaded) return snapshot.flatPlaces
    const rows = new Map(state.directory.places.map(place => [place.id, place]))
    for (const place of snapshot.flatPlaces) {
      rows.set(place.id, Object.freeze({ ...(rows.get(place.id) || {}), ...place }))
    }
    return Object.freeze([...rows.values()])
  }

  function liveSurveyIsComplete(snapshot) {
    if (!state.directory.loaded || !snapshot.liveSurvey?.length ||
        snapshot.liveSurvey.length !== state.directory.places.length) return false
    const directoryById = new Map(state.directory.places.map(place => [place.id, place]))
    const topologyMatches = snapshot.liveSurvey.every(place => {
      const directoryPlace = directoryById.get(place.id)
      return directoryPlace && directoryPlace.parent_id === place.parent_id
    })
    const surveyedThings = snapshot.liveSurvey.reduce((total, place) => total + place.things, 0)
    return topologyMatches && Number.isSafeInteger(surveyedThings) &&
      surveyedThings === snapshot.totals.things
  }

  function liveSurveyThingTotal(snapshot, placeId, includeDescendants) {
    if (!liveSurveyIsComplete(snapshot)) return null
    const placeIds = includeDescendants ? placeScopeSet(placeId, snapshot) : new Set([placeId])
    return snapshot.liveSurvey.reduce((total, place) =>
      placeIds.has(place.id) ? total + place.things : total, 0)
  }

  function liveExactThingTotal(snapshot, placeId, loadedCount, includeDescendants) {
    const surveyedTotal = liveSurveyThingTotal(snapshot, placeId, includeDescendants)
    return surveyedTotal !== null && surveyedTotal >= loadedCount ? surveyedTotal : null
  }

  function thingIndexScopeKey() {
    return state.placeId ? 'inside:' + String(state.placeId) : 'city'
  }

  function exactThingIndexTotal(snapshot) {
    if (!liveSurveyIsComplete(snapshot)) return null
    if (state.placeId) return liveSurveyThingTotal(snapshot, state.placeId, true)
    return snapshot.liveSurvey.reduce((total, place) => total + place.things, 0)
  }

  function thingHeadingPath(snapshot, thing) {
    return windowPlaceLabel(thing.place_id, placeReference(snapshot, thing.place_id)) ||
      'Place #' + String(thing.place_id)
  }

  function renderThingIndexPage() {
    if (!nodes.thingsPage) return
    const index = state.thingIndex
    const parts = []
    if (index.error && index.rows.length) {
      const message = element('p', 'navigation-error', 'More thing headings could not be loaded.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    if (index.hasMore && index.nextBeforeId) {
      const button = element('button', 'history-load', index.loading
        ? 'Loading more things…'
        : index.error ? 'Retry continuing things' : 'Continue things')
      button.type = 'button'
      button.disabled = index.loading
      button.setAttribute('aria-busy', String(index.loading))
      button.dataset.focusKey = 'things-continue'
      button.dataset.focusFallbackId = 'things-list'
      button.addEventListener('click', () => void loadThingIndex(false))
      parts.push(button)
    }
    nodes.thingsPage.hidden = parts.length === 0
    nodes.thingsPage.replaceChildren(...parts)
  }

  function renderThingIndex(snapshot) {
    if (!nodes.thingsList || !nodes.thingsSummary) return
    const expectedScopeKey = thingIndexScopeKey()
    const index = state.thingIndex.scopeKey === expectedScopeKey
      ? state.thingIndex
      : { ...state.thingIndex, rows: [], initialized: false, loading: false, error: false }
    if (!index.initialized && !index.loading) {
      void loadThingIndex(true)
      return
    }
    const exactTotal = exactThingIndexTotal(snapshot)
    if (exactTotal === null) {
      nodes.thingsSummary.textContent = 'The exact public thing count is unavailable. ' +
        'The completed headings below remain newest first.'
    } else {
      nodes.thingsSummary.textContent = String(index.rows.length) + ' of ' + String(exactTotal) +
        (exactTotal === 1 ? ' public thing shown. ' : ' public things shown. ') +
        'Bodies stay closed until you choose one.'
    }
    if (index.loading && !index.rows.length) {
      renderEmpty(nodes.thingsList, 'loading-row', 'Reading the newest public thing headings…')
      renderThingIndexPage()
      return
    }
    if (index.error && !index.rows.length) {
      const retry = element('button', 'history-load', 'Retry loading things')
      retry.type = 'button'
      retry.addEventListener('click', () => void loadThingIndex(true))
      nodes.thingsList.replaceChildren(
        element('p', 'error-row', 'Public thing headings could not be loaded.'),
        retry,
      )
      renderThingIndexPage()
      return
    }
    if (!index.rows.length) {
      renderEmpty(nodes.thingsList, 'empty-row', 'No public thing matches this place selection.')
      renderThingIndexPage()
      return
    }
    const list = element('ul', 'thing-index-list')
    list.append(...index.rows.map(thing => {
      const row = element('li', 'thing-index-row')
      row.dataset.thingId = String(thing.id)
      const title = element('h3', 'thing-index-title')
      title.append(
        portraitNode('thing', thing.id, thing.name, thing.has_drawing),
        openDetailLink('thing', thing.id, thing.name, 'detail-link thing-index-link'),
      )
      const kind = thing.kind ? thing.kind : 'one of a kind'
      const meta = element('p', 'thing-index-meta')
      meta.append(
        document.createTextNode('kind: ' + kind + ' · at ' + thingHeadingPath(snapshot, thing) +
          ' · made by '),
        residentNode(thing.made_by, 'thing-maker', 'things-maker:' + String(thing.id)),
        document.createTextNode(' · currently owned by '),
        residentNode(
          thing.current_owner,
          'thing-owner',
          'things-owner:' + String(thing.id),
        ),
        document.createTextNode(' · ' + String(thing.body_text_bytes) + ' UTF-8 body bytes'),
      )
      row.append(title, meta)
      return row
    }))
    nodes.thingsList.replaceChildren(list)
    renderThingIndexPage()
  }

  async function loadThingIndex(reset) {
    if (!state.snapshot) return
    const scopeKey = thingIndexScopeKey()
    if (state.thingIndex.loading && state.thingIndex.scopeKey === scopeKey) return
    const previous = state.thingIndex.scopeKey === scopeKey
      ? state.thingIndex
      : { ...state.thingIndex, scopeKey, rows: [], nextBeforeId: null, hasMore: false,
          initialized: false, error: false }
    if (!reset && (!previous.hasMore || !previous.nextBeforeId)) return
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      thingIndex: {
        ...(reset ? { ...previous, rows: [], nextBeforeId: null, hasMore: false } : previous),
        scopeKey, loading: true, initialized: true, error: false,
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('collection', 'things')
      url.searchParams.set('presentation', 'headings')
      url.searchParams.set('limit', '25')
      if (state.placeId) url.searchParams.set('within_place_id', String(state.placeId))
      if (!reset && previous.nextBeforeId) {
        url.searchParams.set('before_id', String(previous.nextBeforeId))
      }
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!response.ok) throw new Error('public things unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision || thingIndexScopeKey() !== scopeKey) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const rows = normalizeThingHeadings(payload.things)
      const hasMore = payload.has_more === true
      const nextBeforeId = safeId(payload.next_before_id)
      if (hasMore !== Boolean(nextBeforeId)) throw new Error('invalid public thing page')
      state = {
        ...state,
        thingIndex: {
          scopeKey,
          rows: reset ? rows : mergeWindowRows(previous.rows, rows),
          nextBeforeId: hasMore ? nextBeforeId : null,
          hasMore,
          loading: false,
          initialized: true,
          error: false,
        },
      }
    } catch {
      if (authoredRevision === requestAuthoredRevision && thingIndexScopeKey() === scopeKey) {
        state = {
          ...state,
          thingIndex: { ...state.thingIndex, loading: false, initialized: true, error: true },
        }
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  function liveFocusPlace(snapshot) {
    const chosen = selectedPlace(snapshot)
    if (chosen) return chosen
    const places = livePlaceRows(snapshot)
    if (state.placeId) {
      const surveyed = places.find(place => place.id === state.placeId)
      if (surveyed) return placeReference(snapshot, surveyed.id) || surveyed
    }
    const resident = selectedResident(snapshot)
    if (!state.placeId && resident?.current_place_id) {
      const surveyed = places.find(place => place.id === resident.current_place_id)
      if (surveyed) return placeReference(snapshot, surveyed.id) || surveyed
    }
    const world = places.find(place => place.parent_id === null && place.name === WORLD_ROOT_NAME)
    return world || places.find(place => place.parent_id === null) || snapshot.places[0] || null
  }

  function liveChildren(snapshot, focus) {
    return windowLivePlateChildren(livePlaceRows(snapshot), focus.id).map(place =>
      placeReference(snapshot, place.id) || place)
  }

  function livePath(snapshot, focus) {
    const places = livePlaceRows(snapshot)
    const byId = new Map(places.map(place => [place.id, place]))
    const path = []
    const seen = new Set()
    let current = focus
    while (current && !seen.has(current.id) && path.length < 32) {
      path.push(placeReference(snapshot, current.id) || current)
      seen.add(current.id)
      current = current.parent_id ? byId.get(current.parent_id) || null : null
    }
    return path.reverse()
  }

  function renderLiveBreadcrumbs(snapshot, focus) {
    if (!nodes.liveBreadcrumbs) return
    const parts = []
    livePath(snapshot, focus).forEach((place, index, path) => {
      const button = element('button', 'live-breadcrumb', place.name)
      button.type = 'button'
      button.dataset.focusKey = 'live-breadcrumb:' + String(place.id)
      button.setAttribute('aria-current', index === path.length - 1 ? 'location' : 'false')
      button.addEventListener('click', () => navigate({ view: 'live', placeId: place.id }))
      parts.push(button)
      if (index < path.length - 1) parts.push(element('span', 'live-breadcrumb-separator', '/'))
    })
    nodes.liveBreadcrumbs.replaceChildren(...parts)
  }

  function liveSpeechBubbles(records) {
    const bubbles = new Map()
    const claimedActors = new Set()
    for (const record of records) {
      if (liveRecordType(record) !== 'note' || !liveReplayRecordIsRevealed(record) ||
          claimedActors.has(record.actor)) continue
      claimedActors.add(record.actor)
      const noteId = record.detail.note_id
      const entry = state.live.noteBodies[String(noteId)]
      if (!entry && noteId) void loadLiveNote(noteId)
      if (!entry?.body) continue
      bubbles.set(record.actor, Object.freeze({
        record,
        text: windowLiveSpeechLine(entry.body),
      }))
    }
    return bubbles
  }

  function liveSpeechBubbleNode(bubble) {
    const node = element('span', 'live-speech-bubble', bubble.text)
    node.setAttribute('aria-hidden', 'true')
    node.dataset.liveAt = String(bubble.record.at.getTime())
    node.dataset.liveLifetime = String(LIVE_NOTE_LIFETIME_MS)
    node.style.opacity = String(windowLiveTraceOpacity(
      bubble.record.at.getTime(), Date.now(), LIVE_NOTE_LIFETIME_MS))
    return node
  }

  function livePortraitShell(portrait, bubble, className = 'live-portrait-wrap') {
    const shell = element('span', className)
    shell.append(portrait)
    if (bubble && !liveMotionReduced()) shell.append(liveSpeechBubbleNode(bubble))
    return shell
  }

  function liveDirectGroundHeight(placeId, width) {
    let height = 680
    if (!state.snapshot) return height
    if (state.live.expandedResidentPlaceIds.includes(placeId)) {
      const residents = displayedResidents(state.snapshot).filter(resident =>
        resident.current_place_id === placeId &&
        (!state.resident || resident.handle === state.resident))
      height = windowLiveScatterSurfaceHeight(
        height, width, residents.length, 56, 56, 12)
    }
    if (state.live.expandedThingPlaceIds.includes(placeId)) {
      const things = historyEntry('things', liveThingFilters(placeId)).rows
        .filter(thing => thing.place_id === placeId)
      height = windowLiveScatterSurfaceHeight(
        height, width, things.length, 144, 56, 12, true)
    }
    return Math.max(680, height)
  }

  function liveCreateRenderContext(
    snapshot,
    focus,
    children,
    survey,
  ) {
    const values = new Map()
    return Object.freeze({
      snapshot,
      focus,
      children,
      survey,
      expandedGrounds: survey.expandedGrounds,
      remember(key, build) {
        if (values.has(key)) return values.get(key)
        const value = build()
        values.set(key, value)
        return value
      },
    })
  }

  function liveRenderResidentIndex(snapshot, renderContext = null) {
    const build = () => {
      const residents = Object.freeze(displayedResidents(snapshot))
      const byHandle = new Map(residents.map(resident => [resident.handle, resident]))
      const byId = new Map(residents.map(resident => [resident.id, resident]))
      return Object.freeze({
        residents,
        residentByHandle: handle => byHandle.get(handle) || null,
        residentById: id => byId.get(id) || null,
      })
    }
    return renderContext
      ? renderContext.remember('resident-index', build)
      : build()
  }

  function liveResidentLayout(
    residents,
    placeId,
    focus,
    children,
    pinnedIds,
    renderContext = null,
    cacheable = true,
    persistPoints = true,
    persistVisibleIds = persistPoints,
    surfaceLayout = null,
  ) {
    if (renderContext && cacheable) {
      const key = 'resident-layout:' + String(persistPoints) + ':' +
        String(persistVisibleIds) + ':' +
        String(placeId) + ':' +
        residents.map(resident => resident.id).join(',') + ':' +
        (pinnedIds || []).join(',') + ':' +
        (surfaceLayout
          ? [surfaceLayout.surfaceWidth, surfaceLayout.surfaceHeight,
              surfaceLayout.inlineOffsetY].join(',')
          : '')
      return renderContext.remember(key, () => liveResidentLayout(
        residents,
        placeId,
        focus,
        children,
        pinnedIds,
        renderContext,
        false,
        persistPoints,
        persistVisibleIds,
        surfaceLayout,
      ))
    }
    const ordered = [...residents.filter(resident => !resident.asleep),
      ...residents.filter(resident => resident.asleep)]
    const isRoot = placeId === focus.id
    const plot = isRoot ? null : windowLiveSurveyedPlots(children, focus.id)
      .find(candidate => candidate.id === placeId)
    if (!isRoot && !plot) {
      return Object.freeze({ visible: [], hidden: ordered, overflowCount: ordered.length,
        badgePoint: null })
    }
    const expanded = state.live.expandedResidentPlaceIds.includes(placeId)
    const rootExpanded = isRoot && (
      state.live.expandedResidentPlaceIds.includes(placeId) ||
      state.live.expandedThingPlaceIds.includes(placeId)
    )
    const overflowing = !expanded && ordered.length > LIVE_PORTRAIT_LIMIT
    const capacity = overflowing
      ? Math.max(0, LIVE_PORTRAIT_LIMIT - 2)
      : expanded ? ordered.length : LIVE_PORTRAIT_LIMIT
    const preferredIds = Array.isArray(liveResidentVisibleIdsByPlaceId[String(placeId)])
      ? liveResidentVisibleIdsByPlaceId[String(placeId)]
      : []
    const selection = windowLiveCapacitySelection(
      ordered,
      capacity,
      pinnedIds || [],
      ordered.length,
      preferredIds,
    )
    const visibleResidents = selection.visible
    const border = focus.parent_id === null ? 4 : 3
    const survey = renderContext?.survey ||
      liveStageSurvey(livePlaceRows(state.snapshot), focus.id)
    const surfaceWidth = surfaceLayout
      ? surfaceLayout.surfaceWidth
      : isRoot
        ? windowLiveDirectGroundWidth(survey.width, LIVE_DIRECT_GROUND_WIDTH)
        : expanded ? 480 : plot.width
    const minimumHeight = isRoot ? 680 : expanded ? 320 : plot.height
    const itemWidth = 56
    const itemHeight = 56
    const thingItemWidth = isRoot ? 144 : 94
    const margin = isRoot ? 12 : 6
    const stablePointHeadroom = expanded && !isRoot
      ? Math.min(
          LIVE_PORTRAIT_LIMIT,
          Object.keys(liveResidentPointsByPlaceId[String(placeId)] || {}).length,
        )
      : 0
    const surfaceHeight = surfaceLayout
      ? surfaceLayout.surfaceHeight
      : isRoot
        ? rootExpanded ? liveDirectGroundHeight(placeId, surfaceWidth) : minimumHeight
        : !expanded
          ? minimumHeight
          : Math.max(
              minimumHeight,
              windowLiveScatterSurfaceHeight(
                0,
                surfaceWidth,
                visibleResidents.length + stablePointHeadroom,
                itemWidth,
                itemHeight,
                margin,
                selection.overflowCount > 0,
              ),
            )
    const reserved = isRoot
      ? windowLiveRootReservations(surfaceWidth, surfaceHeight)
      : Object.freeze([])
    const residentKeys = new Set(ordered.map(resident => String(resident.id)))
    const previous = Object.fromEntries(Object.entries(
      liveResidentPointsByPlaceId[String(placeId)] || {},
    ).filter(([key]) => residentKeys.has(key)))
    const selectedResidentIds = new Set(visibleResidents.map(resident => resident.id))
    const placementIds = Object.freeze([
      ...(pinnedIds || []).filter(id => selectedResidentIds.has(id)),
      ...visibleResidents.map(resident => resident.id)
        .filter(id => !(pinnedIds || []).includes(id)),
    ])
    const separated = windowLiveResidentPointsAroundThings(
      placementIds,
      surfaceWidth,
      surfaceHeight,
      placeId * 17 + 3,
      itemWidth,
      itemHeight,
      margin,
      liveThingPointsByPlaceId[String(placeId)] || Object.freeze({}),
      thingItemWidth,
      reserved,
      previous,
      isRoot || (
        !expanded && !state.live.expandedThingPlaceIds.includes(placeId)
      ),
    )
    if (persistPoints) {
      liveResidentPointsByPlaceId = Object.freeze({
        ...liveResidentPointsByPlaceId,
        [String(placeId)]: separated,
      })
    }
    const expandedGround = !isRoot && expanded
      ? survey.expandedGrounds[String(placeId)] || null
      : null
    const inlineOffsetY = surfaceLayout
      ? surfaceLayout.inlineOffsetY
      : expandedGround?.residentTop
        ? expandedGround.residentTop - plot.y
        : 0
    const visible = Object.freeze(visibleResidents.flatMap(resident => {
      const localPoint = separated[String(resident.id)]
      if (!localPoint) return []
      const stagePoint = isRoot
        ? localPoint
        : Object.freeze({
            x: plot.x + border + localPoint.x,
            y: plot.y + border + inlineOffsetY + localPoint.y,
          })
      return [Object.freeze({ resident, localPoint, stagePoint })]
    }))
    const visibleIds = new Set(visible.map(entry => entry.resident.id))
    if (persistVisibleIds) {
      liveResidentVisibleIdsByPlaceId = Object.freeze({
        ...liveResidentVisibleIdsByPlaceId,
        [String(placeId)]: Object.freeze(visible.map(entry => entry.resident.id)),
      })
    }
    const layout = Object.freeze({
      visible,
      hidden: Object.freeze(ordered.filter(resident => !visibleIds.has(resident.id))),
      overflowCount: Math.max(0, ordered.length - visible.length),
      expanded,
      surfaceWidth,
      surfaceHeight,
      inlineOffsetY,
      badgePoint: isRoot
        ? Object.freeze({ x: surfaceWidth - 58, y: surfaceHeight - 18 })
        : Object.freeze({ x: plot.x + plot.width - 28, y: plot.y + plot.height - 10 }),
    })
    if (renderContext) {
      for (const entry of visible) {
        renderContext.remember(
          'resident-point:' + String(placeId) + ':' + entry.resident.handle,
          () => entry.stagePoint,
        )
      }
    }
    return layout
  }

  function livePinnedResidentIds(snapshot, records, placeId) {
    const handle = state.live.focusResident
    if (!handle) return []
    const residents = displayedResidents(snapshot)
    const focused = residents.find(resident => resident.handle === handle)
    if (!focused) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const plate = liveFocusPlace(snapshot)
    const plateIds = plate ? placeScopeSet(plate.id, snapshot) : new Set()
    const pins = new Set(placeIds.has(focused.current_place_id) ? [focused.id] : [])
    const focusRecords = new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record]))
    for (const record of focusRecords.values()) {
      if (!plateIds.has(liveRecordPlaceId(record))) continue
      if (record.actor === handle && record.detail.resident_id) {
        const partner = residents.find(resident => resident.id === record.detail.resident_id)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
      if (record.detail.resident_id === focused.id) {
        const partner = residents.find(resident => resident.handle === record.actor)
        if (partner && placeIds.has(partner.current_place_id)) pins.add(partner.id)
      }
    }
    return Object.freeze([...pins])
  }

  function livePinnedThingIds(snapshot, records, placeId, interactionThings = null) {
    const focus = liveFocusPlace(snapshot)
    if (!focus) return []
    const placeIds = placeScopeSet(placeId, snapshot)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    return Object.freeze(things
      .filter(thing => placeIds.has(thing.place_id))
      .map(thing => thing.id))
  }

  function liveFocusedPlotIds(
    snapshot,
    focus,
    children,
    records,
    interactionThings,
    renderContext = null,
  ) {
    if (state.live.proofScene) return Object.freeze(children.map(place => place.id))
    const focused = new Set()
    const pinnedResidents = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    for (const resident of displayedResidents(snapshot)) {
      if (!pinnedResidents.has(resident.id)) continue
      const anchorId = livePlaceAnchor(
        resident.current_place_id, focus.id, children, renderContext)
      if (anchorId && anchorId !== focus.id) focused.add(anchorId)
    }
    const pinnedThings = new Set(livePinnedThingIds(
      snapshot, records, focus.id, interactionThings))
    for (const thing of interactionThings) {
      if (!pinnedThings.has(thing.id)) continue
      const anchorId = livePlaceAnchor(thing.place_id, focus.id, children, renderContext)
      if (anchorId && anchorId !== focus.id) focused.add(anchorId)
    }
    return Object.freeze([...focused])
  }

  function liveResidentReplayPoint(
    snapshot,
    placeId,
    actor,
    focus,
    children,
    renderContext = null,
    cacheable = true,
  ) {
    const anchorId = livePlaceAnchor(placeId, focus.id, children, renderContext)
    if (!anchorId) return null
    if (renderContext && cacheable) {
      return renderContext.remember(
        'resident-point:' + String(anchorId) + ':' + actor,
        () => liveResidentReplayPoint(
          snapshot, placeId, actor, focus, children, renderContext, false),
      )
    }
    const residentIndex = liveRenderResidentIndex(snapshot, renderContext)
    const resident = residentIndex.residentByHandle(actor)
    if (!resident) return null
    const buildAnchoredResidents = () => {
      const placeIds = anchorId === focus.id
        ? new Set([focus.id])
        : placeScopeSet(anchorId, snapshot)
      return Object.freeze(residentIndex.residents.filter(candidate =>
        placeIds.has(candidate.current_place_id) &&
        (!state.resident || candidate.handle === state.resident)))
    }
    const anchoredResidents = renderContext
      ? renderContext.remember(
          'resident-replay-rows:' + String(anchorId),
          buildAnchoredResidents,
        )
      : buildAnchoredResidents()
    const buildAnchoredResidentIds = () =>
      new Set(anchoredResidents.map(candidate => candidate.id))
    const anchoredResidentIds = renderContext
      ? renderContext.remember(
          'resident-replay-ids:' + String(anchorId),
          buildAnchoredResidentIds,
        )
      : buildAnchoredResidentIds()
    const records = renderContext?.records || visibleLiveRecords(
      snapshot, focus, children, renderContext)
    const buildPinnedIds = () => livePinnedResidentIds(snapshot, records, anchorId)
    const pinnedIds = renderContext
      ? renderContext.remember(
          'resident-replay-pins:' + String(anchorId),
          buildPinnedIds,
        )
      : buildPinnedIds()
    const buildBaseLayout = () => liveResidentLayout(
      anchoredResidents,
      anchorId,
      focus,
      children,
      pinnedIds,
      renderContext,
      true,
      true,
      true,
    )
    const baseLayout = renderContext
      ? renderContext.remember(
          'resident-replay-base:' + String(anchorId),
          buildBaseLayout,
        )
      : buildBaseLayout()
    const basePoint = baseLayout.visible
      .find(entry => entry.resident.id === resident.id)?.stagePoint
    if (basePoint) return basePoint

    const totalWithActor = baseLayout.visible.length + baseLayout.overflowCount +
      (anchoredResidentIds.has(resident.id) ? 0 : 1)
    const layerCapacity = baseLayout.expanded
      ? Math.min(LIVE_PORTRAIT_LIMIT, totalWithActor)
      : totalWithActor > LIVE_PORTRAIT_LIMIT
        ? Math.max(1, LIVE_PORTRAIT_LIMIT - 2)
        : Math.min(LIVE_PORTRAIT_LIMIT, totalWithActor)
    const layerIds = []
    for (const id of [
      resident.id,
      ...pinnedIds,
      ...baseLayout.visible.map(entry => entry.resident.id),
    ]) {
      if (layerIds.length >= layerCapacity) break
      if (!layerIds.includes(id)) layerIds.push(id)
    }
    const layerResidents = Object.freeze(layerIds.flatMap(id => {
      const candidate = residentIndex.residentById(id)
      return candidate ? [candidate] : []
    }))
    const layout = liveResidentLayout(
      layerResidents,
      anchorId,
      focus,
      children,
      Object.freeze([resident.id, ...pinnedIds.filter(id => id !== resident.id)]),
      renderContext,
      false,
      false,
      false,
      baseLayout,
    )
    return layout.visible.find(entry => entry.resident.handle === actor)?.stagePoint ||
      layout.badgePoint
  }

  function positionLiveRootOverflowControl(control, slot, width, height) {
    const rail = windowLiveRootReservations(width, height)[0]
    if (!rail) return
    const inset = 6
    const gap = 8
    const controlWidth = rail.width - inset * 2
    const controlHeight = (rail.height - inset * 2 - gap) / 2
    if (controlWidth < 44 || controlHeight < 44) return
    const slotIndex = slot === 'thing' ? 1 : 0
    control.dataset.liveRootControl = slot
    control.style.inset = 'auto'
    control.style.left = String(rail.x + inset) + 'px'
    control.style.top = String(
      rail.y + inset + slotIndex * (controlHeight + gap)
    ) + 'px'
    control.style.width = String(controlWidth) + 'px'
    control.style.height = String(controlHeight) + 'px'
    control.style.minWidth = '0'
  }

  function livePortraitGrid(
    residents,
    label,
    bubbles,
    placeId,
    pinnedIds,
    className = 'live-portrait-grid',
    renderContext = null,
  ) {
    const grid = element('div', className)
    grid.setAttribute('aria-label', label)
    const focus = renderContext?.focus || (state.snapshot ? liveFocusPlace(state.snapshot) : null)
    const children = renderContext?.children ||
      (focus && state.snapshot ? liveChildren(state.snapshot, focus) : [])
    if (!focus) return grid
    const layout = liveResidentLayout(
      residents, placeId, focus, children, pinnedIds, renderContext)
    if (placeId === focus.id) {
      grid.style.width = String(layout.surfaceWidth) + 'px'
      grid.style.height = String(layout.surfaceHeight) + 'px'
      grid.style.inset = '0 auto auto 0'
    }
    if (layout.expanded) {
      grid.dataset.liveExpanded = 'true'
      if (placeId !== focus.id) {
        grid.style.width = String(layout.surfaceWidth) + 'px'
        grid.style.height = String(layout.surfaceHeight) + 'px'
        grid.style.inset = 'auto'
        grid.style.left = '0'
        grid.style.top = String(layout.inlineOffsetY) + 'px'
      }
    }
    const pinned = new Set(pinnedIds || [])
    const overlayHandles = state.live.proofScene
      ? new Set()
      : new Set(Object.keys(state.live.replayPositions))
    layout.visible.forEach(entry => {
      const resident = entry.resident
      if (overlayHandles.has(resident.handle)) return
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + resident.handle
      portrait.dataset.liveResidentHandle = resident.handle
      portrait.title = state.live.focusResident === resident.handle
        ? 'Clear focus from ' + resident.handle
        : 'Focus on ' + resident.handle
      portrait.setAttribute('aria-label', portrait.title)
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      portrait.append(portraitNode(
        'resident', resident.id, resident.handle, resident.has_drawing, 'live-entity-portrait',
      ))
      const shell = livePortraitShell(
        portrait,
        bubbles?.get(resident.handle),
        'live-portrait-wrap live-walker',
      )
      shell.style.left = String(entry.localPoint.x) + 'px'
      shell.style.top = String(entry.localPoint.y) + 'px'
      const itemKey = 'resident:' + resident.handle
      shell.dataset.liveItemKey = itemKey
      if (state.live.raisedItemKey === itemKey) shell.dataset.liveRaised = 'true'
      if (state.live.focusResident === resident.handle) {
        shell.setAttribute('data-live-focus-resident', resident.handle)
      } else if (pinned.has(resident.id)) {
        shell.setAttribute('data-live-focus-partner', resident.handle)
      }
      bindLiveActivation(portrait, shell, itemKey,
        () => toggleLiveFocusResident(resident.handle))
      grid.append(shell)
    })
    const visibleOverflowActors = layout.hidden.filter(resident =>
      overlayHandles.has(resident.handle)).length
    const overflowCount = Math.max(0, layout.overflowCount - visibleOverflowActors)
    if (overflowCount) {
      const badge = element('button', 'live-overflow-badge live-resident-more',
        '+' + String(overflowCount) + ' more')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-resident-overflow:' + String(placeId)
      badge.dataset.liveOverflowPlaceId = String(placeId)
      badge.setAttribute('aria-label', 'Show ' + String(overflowCount) + ' more residents')
      badge.setAttribute('data-live-overflow-count', String(overflowCount))
      badge.title = String(residents.length) + ' residents here; showing ' +
        String(residents.length - overflowCount)
      if (Number(state.live.absorptionEndsAtByPlaceId[String(placeId)]) > Date.now()) {
        badge.classList.add('live-overflow-absorbing')
      }
      if (placeId === focus.id) {
        positionLiveRootOverflowControl(
          badge, 'resident', layout.surfaceWidth, layout.surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', placeId)
        state = { ...state, live: { ...state.live,
          expandedResidentPlaceIds: Object.freeze([
            ...new Set([...state.live.expandedResidentPlaceIds, placeId]),
          ]),
        } }
        if (state.snapshot) renderLive(state.snapshot)
      })
      grid.append(badge)
    }
    return grid
  }

  function liveTiledDrawing(place, className, columns, rows, tileSize = null) {
    const terrain = element('div', className)
    terrain.setAttribute('aria-label', 'Drawing tiled inside ' + place.name)
    const tile = drawingNode('place', place.id, place.name, columns, rows)
    tile.classList.add('live-tiled-drawing')
    if (tileSize) {
      tile.style.width = String(columns * tileSize) + 'px'
      tile.style.height = String(rows * tileSize) + 'px'
    }
    terrain.append(tile)
    return terrain
  }

  function liveThingFilters(focusId) {
    return Object.freeze({ placeId: focusId, resident: null })
  }

  function liveDisplayedThings(snapshot, placeId, focusId, includeDescendants = false) {
    const placeIds = includeDescendants ? placeScopeSet(placeId, snapshot) : new Set([placeId])
    return historyEntry('things', liveThingFilters(focusId)).rows
      .filter(thing => placeIds.has(thing.place_id))
  }

  function liveThingSelection(things, pinnedIds, exactTotal, placeId) {
    const total = exactTotal === null ? things.length : exactTotal
    const expanded = state.live.expandedThingPlaceIds.includes(placeId)
    const capacity = expanded
      ? things.length
      : total > LIVE_THING_LIMIT ? LIVE_THING_LIMIT - 1 : LIVE_THING_LIMIT
    const preferredIds = Array.isArray(liveThingVisibleIdsByPlaceId[String(placeId)])
      ? liveThingVisibleIdsByPlaceId[String(placeId)]
      : []
    const selection = windowLiveCapacitySelection(things, capacity, pinnedIds, total, preferredIds)
    liveThingVisibleIdsByPlaceId = Object.freeze({
      ...liveThingVisibleIdsByPlaceId,
      [String(placeId)]: Object.freeze(selection.visible.map(thing => thing.id)),
    })
    return selection
  }

  function liveThingPresentation(
    snapshot,
    placeId,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
    renderContext = null,
    cacheable = true,
  ) {
    if (renderContext && cacheable) {
      const key = 'thing-presentation:' + String(placeId) + ':' +
        String(focusId) + ':' + String(includeDescendants)
      return renderContext.remember(key, () => liveThingPresentation(
        snapshot,
        placeId,
        records,
        focusId,
        includeDescendants,
        interactionThings,
        renderContext,
        false,
      ))
    }
    const things = liveDisplayedThings(snapshot, placeId, focusId, includeDescendants)
    const pinnedIds = livePinnedThingIds(snapshot, records, placeId, interactionThings)
    const exactTotal = liveExactThingTotal(
      snapshot, placeId, things.length, includeDescendants)
    return Object.freeze({
      things,
      pinnedIds,
      exactTotal,
      selection: liveThingSelection(things, pinnedIds, exactTotal, placeId),
    })
  }

  function liveFocusInteractionThings(snapshot, focus, records) {
    const handle = state.live.focusResident
    if (!handle) return Object.freeze([])
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    const focusScope = placeScopeSet(focus.id, snapshot)
    const things = historyEntry('things', liveThingFilters(focus.id)).rows
    const thingsById = new Map(things.map(thing => [thing.id, thing]))
    const references = new Map()
    const addReference = (id, recordedPlaceId) => {
      if (!id || references.has(id)) return
      const thing = thingsById.get(id)
      const interactionPlaceId = recordedPlaceId || thing?.place_id || null
      if (!interactionPlaceId || !focusScope.has(interactionPlaceId)) return
      references.set(id, Object.freeze({
        id,
        place_id: thing?.place_id || interactionPlaceId,
        recorded_place_id: interactionPlaceId,
        name: thing?.name || null,
        loaded: Boolean(thing),
        has_drawing: thing?.has_drawing === true,
      }))
    }
    const focusRecords = [...new Map([...records, ...liveInteractionRecords()]
      .map(record => [liveTraceKey(record), record])).values()]
      .sort((left, right) => {
        const timeOrder = right.at.getTime() - left.at.getTime()
        if (timeOrder) return timeOrder
        const leftKey = liveTraceKey(left)
        const rightKey = liveTraceKey(right)
        return leftKey < rightKey ? 1 : leftKey > rightKey ? -1 : 0
      })
    for (const record of focusRecords) {
      if (record.kind === 'transfer' && record.detail.asset_type === 'thing') {
        const involvesFocus = record.actor === handle ||
          (focused && record.detail.resident_id === focused.id)
        if (involvesFocus) addReference(record.detail.asset_id, record.detail.place_id)
        continue
      }
      if (record.actor !== handle) continue
      const recordedPlaceId = liveRecordPlaceId(record)
      addReference(record.detail.source_thing_id, recordedPlaceId)
      addReference(record.detail.thing_id, recordedPlaceId)
    }
    return Object.freeze([...references.values()])
  }

  function liveThingShelf(
    snapshot,
    place,
    records,
    focusId,
    includeDescendants = false,
    interactionThings = null,
    renderContext = null,
  ) {
    const presentation = liveThingPresentation(
      snapshot,
      place.id,
      records,
      focusId,
      includeDescendants,
      interactionThings,
      renderContext,
    )
    const { things, pinnedIds, exactTotal, selection } = presentation
    if (!things.length && exactTotal !== null && exactTotal === 0) return null
    if (!things.length && exactTotal === null) return null
    const pinned = new Set(pinnedIds)
    const shelf = element('section', 'live-thing-shelf')
    const expanded = state.live.expandedThingPlaceIds.includes(place.id)
    const entry = historyEntry('things', liveThingFilters(focusId))
    const isRoot = place.id === focusId
    const rootExpanded = isRoot && (
      state.live.expandedResidentPlaceIds.includes(place.id) ||
      state.live.expandedThingPlaceIds.includes(place.id)
    )
    const survey = renderContext?.survey || liveStageSurvey(livePlaceRows(snapshot), focusId)
    const childPlot = isRoot ? null : survey.plots.find(candidate => candidate.id === place.id)
    const itemWidth = isRoot ? 144 : 94
    const itemHeight = 56
    const surfaceWidth = isRoot
      ? windowLiveDirectGroundWidth(survey.width, LIVE_DIRECT_GROUND_WIDTH)
      : expanded ? 480 : childPlot?.width || 440
    const margin = isRoot ? 12 : 6
    const hasOverflow = exactTotal === null
      ? things.length > selection.visible.length
      : selection.overflowCount > 0
    const surfaceHeight = isRoot
      ? rootExpanded ? liveDirectGroundHeight(place.id, surfaceWidth) : 680
      : !expanded
        ? childPlot?.height || 280
        : Math.max(
            320,
            windowLiveScatterSurfaceHeight(
              0,
              surfaceWidth,
              selection.visible.length,
              itemWidth,
              itemHeight,
              margin,
              hasOverflow,
            ),
          )
    const reserved = isRoot
      ? windowLiveRootReservations(surfaceWidth, surfaceHeight)
      : Object.freeze([])
    const thingKeys = new Set(things.map(thing => String(thing.id)))
    const previous = Object.fromEntries(Object.entries(
      liveThingPointsByPlaceId[String(place.id)] || {},
    ).filter(([key]) => thingKeys.has(key)))
    const selectedThingIds = new Set(selection.visible.map(thing => thing.id))
    const placementIds = Object.freeze([
      ...pinnedIds.filter(id => selectedThingIds.has(id)),
      ...selection.visible.map(thing => thing.id).filter(id => !pinned.has(id)),
    ])
    const separated = windowLiveThingPointsAroundResidents(
      placementIds,
      surfaceWidth,
      surfaceHeight,
      place.id * 29 + 11,
      itemWidth,
      itemHeight,
      margin,
      liveResidentPointsByPlaceId[String(place.id)] || Object.freeze({}),
      reserved,
      previous,
      isRoot || (
        !expanded && !state.live.expandedResidentPlaceIds.includes(place.id)
      ),
    )
    liveThingPointsByPlaceId = Object.freeze({
      ...liveThingPointsByPlaceId,
      [String(place.id)]: separated,
    })
    const expandedGround = !isRoot && expanded
      ? survey.expandedGrounds[String(place.id)] || null
      : null
    const inlineOffsetY = expandedGround?.thingTop
      ? expandedGround.thingTop - (childPlot?.y || 0)
      : 0
    if (expanded) shelf.dataset.liveExpanded = 'true'
    shelf.style.width = String(surfaceWidth) + 'px'
    shelf.style.height = String(surfaceHeight) + 'px'
    if (isRoot) {
      shelf.style.inset = '0 auto auto 0'
    } else if (inlineOffsetY) {
      shelf.style.inset = 'auto'
      shelf.style.left = '0'
      shelf.style.top = String(inlineOffsetY) + 'px'
    }
    shelf.setAttribute('aria-label', 'Things shown inside ' + place.name)
    const visibleThings = selection.visible.filter(thing => Boolean(separated[String(thing.id)]))
    liveThingVisibleIdsByPlaceId = Object.freeze({
      ...liveThingVisibleIdsByPlaceId,
      [String(place.id)]: Object.freeze(visibleThings.map(thing => thing.id)),
    })
    for (const thing of visibleThings) {
      const specimen = element('a', 'live-thing-specimen')
      specimen.href = '/api/thing/' + String(thing.id)
      specimen.title = 'Read ' + thing.name
      specimen.dataset.focusKey = 'live-thing:' + String(thing.id)
      specimen.dataset.liveThingId = String(thing.id)
      specimen.dataset.liveThingPlaceId = String(thing.place_id)
      const point = separated[String(thing.id)]
      specimen.style.left = String(point.x) + 'px'
      specimen.style.top = String(point.y) + 'px'
      const itemKey = 'thing:' + String(thing.id)
      specimen.dataset.liveItemKey = itemKey
      if (state.live.raisedItemKey === itemKey) specimen.dataset.liveRaised = 'true'
      if (pinned.has(thing.id)) specimen.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.place_id)
      if (pulse) {
        specimen.classList.add('live-pulse')
        specimen.dataset.livePulseFor = pulse.key
        bindLiveHighlight(specimen, pulse.key, 'pulse')
      }
      specimen.append(
        portraitNode('thing', thing.id, thing.name, thing.has_drawing, 'live-entity-portrait'),
        element('span', 'live-thing-name', thing.name),
      )
      bindLiveActivation(specimen, specimen, itemKey, null)
      shelf.append(specimen)
    }
    const overflowCount = selection.overflowCount + selection.visible.length - visibleThings.length
    if (exactTotal === null && (things.length > visibleThings.length || entry.hasMore)) {
      const badge = element('button', 'live-overflow-badge live-thing-more',
        'more · count unavailable')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-thing-overflow:' + String(place.id)
      badge.dataset.liveOverflowPlaceId = String(place.id)
      badge.setAttribute('aria-label', 'Show more things; exact count unavailable')
      badge.setAttribute('aria-busy', String(entry.loading))
      badge.title = 'Some named things are folded here; the exact count is unavailable.'
      if (isRoot) {
        positionLiveRootOverflowControl(badge, 'thing', surfaceWidth, surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', place.id)
        void expandLiveThings(place.id, focusId)
      })
      shelf.append(badge)
    } else if (overflowCount) {
      const badge = element('button', 'live-overflow-badge live-thing-more',
        '+' + String(overflowCount) + ' more')
      badge.type = 'button'
      badge.dataset.focusKey = 'live-thing-overflow:' + String(place.id)
      badge.dataset.liveOverflowPlaceId = String(place.id)
      badge.setAttribute('aria-label', 'Show ' + String(overflowCount) + ' more things')
      badge.setAttribute('aria-busy', String(entry.loading))
      badge.setAttribute('data-live-overflow-count', String(overflowCount))
      badge.title = String(exactTotal) + ' things here; showing ' +
        String(visibleThings.length)
      if (Object.values(state.live.replayActive).some(active =>
        active.type === 'make' && liveRecordPlaceId(active.record) === place.id)) {
        badge.classList.add('live-overflow-absorbing')
      }
      if (isRoot) {
        positionLiveRootOverflowControl(badge, 'thing', surfaceWidth, surfaceHeight)
      }
      badge.addEventListener('click', () => {
        requestLiveFocusRestore(
          badge.dataset.focusKey || '', 'live-plates', place.id)
        void expandLiveThings(place.id, focusId)
      })
      shelf.append(badge)
    }
    return shelf
  }

  async function expandLiveThings(placeId, focusId) {
    state = { ...state, live: { ...state.live,
      expandedThingPlaceIds: Object.freeze([
        ...new Set([...state.live.expandedThingPlaceIds, placeId]),
      ]),
    } }
    if (state.snapshot) renderLive(state.snapshot)
    const filters = liveThingFilters(focusId)
    const entry = historyEntry('things', filters)
    if (entry.hasMore && !entry.loading) await loadHistory('things', filters)
  }

  function mountLivePlaceDetail(card, renderContext, place) {
    if (card.dataset.liveDetailMounted === 'true') return
    const { snapshot, focus, bubbles, records, interactionThings } = renderContext
    const open = card.querySelector(':scope > .live-plot-open')
    if (!open) return
    const drawing = state.live.drawings[liveDrawingKey('place', place.id)]
    const undrawn = drawing?.loaded && drawing.drawing === null
    card.dataset.undrawn = String(Boolean(undrawn))
    const owner = Object.hasOwn(place, 'owner')
      ? place.owner ? (undrawn ? 'undrawn · ' : '') + 'kept by ' + place.owner : 'ownerless world ground'
      : 'Place #' + String(place.id)
    const terrain = liveTiledDrawing(place, 'live-plot-terrain', 8, 5)
    card.prepend(terrain)
    card.append(element('p', 'live-plot-owner', owner))
    const drawingDetail = openDrawingDetailButton(
      'place',
      place.id,
      place.name,
      'live-plot-drawing-detail drawing-detail-open',
    )
    drawingDetail.style.left = String(LIVE_PLOT_DRAWING_DETAIL_RECT.x) + 'px'
    drawingDetail.style.top = String(LIVE_PLOT_DRAWING_DETAIL_RECT.y) + 'px'
    drawingDetail.style.width = String(LIVE_PLOT_DRAWING_DETAIL_RECT.width) + 'px'
    drawingDetail.style.height = String(LIVE_PLOT_DRAWING_DETAIL_RECT.height) + 'px'
    card.append(drawingDetail)
    const residents = residentsAt(snapshot, place.id)
    if (residents.length) {
      card.append(livePortraitGrid(
        residents,
        'Residents inside ' + place.name,
        bubbles,
        place.id,
        livePinnedResidentIds(snapshot, records, place.id),
        'live-portrait-grid',
        renderContext,
      ))
    }
    const shelf = liveThingShelf(
      snapshot, place, records, focus.id, true, interactionThings, renderContext)
    if (shelf) card.append(shelf)
    card.dataset.liveDetailMounted = 'true'
  }

  function unmountLivePlaceDetail(card) {
    if (card.dataset.liveDetailMounted !== 'true') return
    const open = card.querySelector(':scope > .live-plot-open')
    if (open) card.replaceChildren(open)
    card.dataset.liveDetailMounted = 'false'
  }

  function livePlacePlot(renderContext, place, plot, detailed, focused) {
    const { snapshot, focus } = renderContext
    const card = element('article', 'live-plot')
    card.dataset.placeId = String(place.id)
    card.dataset.livePlotX = String(plot.x)
    card.dataset.livePlotY = String(plot.y)
    card.dataset.livePlotWidth = String(plot.width)
    card.dataset.livePlotHeight = String(plot.height)
    card.dataset.liveFocusPlot = String(Boolean(focused))
    card.dataset.liveDetail = String(Boolean(detailed || focused))
    card.dataset.liveDetailMounted = 'false'
    const itemKey = 'place:' + String(place.id)
    card.dataset.liveItemKey = itemKey
    if (state.live.raisedItemKey === itemKey) card.dataset.liveRaised = 'true'
    card.style.left = String(plot.x) + 'px'
    card.style.top = String(plot.y) + 'px'
    card.style.width = String(plot.width) + 'px'
    card.style.height = String(plot.height) + 'px'
    const open = element('button', 'live-plot-open')
    open.type = 'button'
    open.dataset.focusKey = 'live-place:' + String(place.id)
    open.title = 'Open the live plate for ' + place.name
    bindLiveActivation(open, card, itemKey,
      () => navigate({ view: 'live', placeId: place.id }))
    open.append(element('span', 'live-plot-name', place.name),
      element('span', 'live-plot-number', '#' + String(place.id)))
    card.dataset.undrawn = 'false'
    card.dataset.placeKind = focus.parent_id === null ? 'continent' : 'place'
    card.append(open)
    if (detailed || focused) mountLivePlaceDetail(card, renderContext, place)
    return card
  }

  function liveStageSurvey(places, parentId) {
    const plots = windowLiveSurveyedPlots(places, parentId)
    let width = Math.max(1_100, ...plots.map(plot => plot.x + plot.width + 64))
    const occupiedHeight = Math.max(680, ...plots.map(plot => plot.y + plot.height + 96))
    let height = occupiedHeight
    let expandedGrounds = Object.freeze({})
    if (state.snapshot && (state.live.expandedResidentPlaceIds.includes(parentId) ||
        state.live.expandedThingPlaceIds.includes(parentId))) {
      const directWidth = windowLiveDirectGroundWidth(width, LIVE_DIRECT_GROUND_WIDTH)
      height = Math.max(height, liveDirectGroundHeight(parentId, directWidth))
    }
    if (state.snapshot) {
      const expansions = plots.flatMap(plot => {
        const residentsExpanded = state.live.expandedResidentPlaceIds.includes(plot.id)
        const thingsExpanded = state.live.expandedThingPlaceIds.includes(plot.id)
        if (!residentsExpanded && !thingsExpanded) return []
        const residentHeight = residentsExpanded
          ? Math.max(320, windowLiveScatterSurfaceHeight(
              0,
              480,
              residentsAt(state.snapshot, plot.id).length + Math.min(
                LIVE_PORTRAIT_LIMIT,
                Object.keys(liveResidentPointsByPlaceId[String(plot.id)] || {}).length,
              ),
              56,
              56,
              6,
            ))
          : 0
        const things = thingsExpanded
          ? liveDisplayedThings(state.snapshot, plot.id, parentId, true)
          : []
        const thingHeight = thingsExpanded
          ? Math.max(320, windowLiveScatterSurfaceHeight(
              0, 480, things.length, 94, 56, 6, true))
          : 0
        return [Object.freeze({ id: plot.id, residentHeight, thingHeight })]
      })
      const expandedLayout = windowLiveExpandedGroundLayout(plots, expansions)
      expandedGrounds = expandedLayout.grounds
      width = Math.max(width, expandedLayout.width + 64)
      height = Math.max(height, expandedLayout.height + 96)
    }
    return Object.freeze({ plots, width, height, expandedGrounds })
  }

  function renderLiveResidentPage() {
    if (!nodes.liveResidentPage) return
    const entry = state.residentPaging
    if (!entry.hasMore && !entry.loading && !entry.error) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
      return
    }
    const parts = []
    if (entry.error) {
      const message = element('p', 'navigation-error', 'Could not load more residents.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    const button = element('button', 'resident-load', entry.loading
      ? 'Loading more residents…'
      : entry.error ? 'Retry loading residents' : 'Load more residents')
    button.type = 'button'
    button.dataset.focusKey = 'live-resident-page'
    button.dataset.focusFallbackId = 'live-roster'
    button.setAttribute('aria-busy', String(entry.loading))
    button.setAttribute('aria-controls', 'live-roster')
    button.addEventListener('click', () => void loadResidents())
    parts.push(button)
    nodes.liveResidentPage.hidden = false
    nodes.liveResidentPage.replaceChildren(...parts)
  }

  function liveFocusInteractionsPanel(snapshot, focus, records, interactionThings) {
    const handle = state.live.focusResident
    if (!handle) return null
    const partnerIds = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    if (focused) partnerIds.delete(focused.id)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    const panel = element('section', 'live-focus-interactions')
    panel.id = 'live-focus-interactions'
    panel.append(
      element('p', 'block-number', 'FOCUS / INTERACTIONS'),
      element('h3', '', handle),
      element('p', 'live-focus-interactions-copy',
        String(partnerIds.size) + ' resident ' + (partnerIds.size === 1 ? 'partner stays' : 'partners stay') +
        ' marked in the complete roster. Every safely identified thing stays listed here.'),
    )
    const focusScope = placeScopeSet(focus.id, snapshot)
    if (focused && !focusScope.has(focused.current_place_id)) {
      const currentPlace = focused.current_place_id
        ? placeReference(snapshot, focused.current_place_id)
        : null
      const location = currentPlace
        ? currentPlace.name
        : focused.current_place_id ? 'Place #' + String(focused.current_place_id) : 'Between places'
      const card = element('div', 'live-focus-resident-card')
      card.dataset.liveFocusResident = focused.handle
      card.dataset.liveResidentHandle = focused.handle
      card.dataset.liveResidentScope = 'outside'
      card.setAttribute('aria-label', focused.handle + ' is outside this plate at ' + location)
      const copy = element('span', 'live-focus-resident-card-copy')
      copy.append(
        element('strong', 'live-focus-resident-card-name', focused.handle),
        element('span', 'live-focus-resident-card-location', 'Outside this plate · ' + location),
      )
      card.append(
        portraitNode(
          'resident', focused.id, focused.handle, focused.has_drawing, 'live-entity-portrait',
        ),
        copy,
        openDrawingDetailButton(
          'resident',
          focused.id,
          focused.handle,
          'resident-drawing-detail drawing-detail-open',
        ),
      )
      panel.append(card)
    }
    if (!things.length) {
      panel.append(element('p', 'empty-row', 'No exact thing interaction is on this plate.'))
      return panel
    }
    const list = element('div', 'live-focus-thing-list')
    for (const thing of things) {
      const place = placeReference(snapshot, thing.place_id)
      const recordedPlace = placeReference(snapshot, thing.recorded_place_id)
      const location = place ? place.name : 'place #' + String(thing.place_id)
      const recordedLocation = recordedPlace
        ? recordedPlace.name
        : 'place #' + String(thing.recorded_place_id)
      const movedSinceInteraction = thing.loaded && thing.place_id !== thing.recorded_place_id
      const label = thing.loaded
        ? thing.name + (movedSinceInteraction
          ? ' · now in ' + location + ' · recorded in ' + recordedLocation
          : ' · ' + location)
        : 'Thing #' + String(thing.id) + ' · recorded in ' + recordedLocation
      const link = element('a', 'live-focus-thing-card', label)
      link.href = '/api/thing/' + String(thing.id)
      link.title = thing.loaded ? 'Read ' + thing.name : 'Read Thing #' + String(thing.id)
      link.dataset.focusKey = 'live-focus-thing:' + String(thing.id)
      link.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.recorded_place_id)
      if (pulse) {
        link.classList.add('live-pulse')
        link.dataset.livePulseFor = pulse.key
        bindLiveHighlight(link, pulse.key, 'pulse')
      }
      link.prepend(portraitNode(
        'thing',
        thing.id,
        thing.loaded ? thing.name : 'Thing #' + String(thing.id),
        thing.has_drawing,
        'live-entity-portrait',
      ))
      list.append(link)
    }
    panel.append(list)
    return panel
  }

  function renderLiveRoster(snapshot, focus, records, interactionThings) {
    if (!nodes.liveRoster) return
    renderLiveResidentPage()
    const scope = placeScopeSet(focus.id, snapshot)
    const residents = displayedResidents(snapshot).filter(resident =>
      scope.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
    const pinned = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const parts = []
    const focusPanel = liveFocusInteractionsPanel(snapshot, focus, records, interactionThings)
    if (focusPanel) parts.push(focusPanel)
    if (!residents.length) {
      const empty = element('p', 'empty-row', 'Nobody is here right now. The room keeps its things.')
      empty.setAttribute('role', 'status')
      nodes.liveRoster.replaceChildren(...parts, empty)
      return
    }
    const list = element('div', 'live-roster-list')
    for (const resident of [...residents.filter(row => !row.asleep),
      ...residents.filter(row => row.asleep)]) {
      const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
      if (state.live.focusResident === resident.handle) {
        row.dataset.liveFocusResident = resident.handle
      } else if (pinned.has(resident.id)) {
        row.dataset.liveFocusPartner = resident.handle
      }
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'live-roster:' + resident.handle
      follow.dataset.liveResidentHandle = resident.handle
      follow.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      follow.addEventListener('click', () => toggleLiveFocusResident(resident.handle))
      const place = placeReference(snapshot, resident.current_place_id)
      const location = place ? place.name : resident.current_place_id
        ? 'Place #' + String(resident.current_place_id)
        : 'Between places'
      row.append(
        portraitNode(
          'resident', resident.id, resident.handle, resident.has_drawing, 'live-entity-portrait',
        ),
        follow,
        element('span', 'resident-number', location + (resident.asleep ? ' · asleep' : '')),
        openDrawingDetailButton(
          'resident',
          resident.id,
          resident.handle,
          'resident-drawing-detail drawing-detail-open',
        ),
      )
      list.append(row)
    }
    nodes.liveRoster.replaceChildren(...parts, list)
  }

  function liveAnchorPoint(anchorId, focusId, children) {
    if (anchorId === focusId) return Object.freeze({ x: 72, y: 58 })
    const plot = windowLiveSurveyedPlots(children, focusId)
      .find(candidate => candidate.id === anchorId)
    return plot ? Object.freeze({
      x: plot.x + plot.width / 2,
      y: plot.y + plot.height - 18,
    }) : null
  }

  function liveReplayPoint(placeId, focus, children, renderContext = null) {
    const anchor = livePlaceAnchor(placeId, focus.id, children, renderContext)
    return liveAnchorPoint(anchor, focus.id, children)
  }

  function liveReplayMoveGeometry(
    record,
    snapshot,
    focus,
    children,
    renderContext = null,
    cacheable = true,
  ) {
    if (renderContext && cacheable) {
      return renderContext.remember(
        'move-geometry:' + liveTraceKey(record),
        () => liveReplayMoveGeometry(
          record, snapshot, focus, children, renderContext, false),
      )
    }
    const from = liveResidentReplayPoint(
      snapshot,
      record.detail.from_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    const to = liveResidentReplayPoint(
      snapshot,
      record.detail.to_place_id,
      record.actor,
      focus,
      children,
      renderContext,
    )
    if (!from || !to || (from.x === to.x && from.y === to.y)) return null
    return Object.freeze({ from, to })
  }

  function queueLiveReplayCompletion(actor, key) {
    const held = state.live.replayActive[actor]
    if (!held || held.key !== key || liveReplayCompletions.some(completion =>
      completion.actor === actor && completion.key === key)) return
    liveReplayCompletions = Object.freeze([
      ...liveReplayCompletions,
      Object.freeze({ actor, key }),
    ])
    if (!liveReplayCompletionFrame) {
      liveReplayCompletionFrame = window.requestAnimationFrame(flushLiveReplayCompletions)
    }
  }

  function flushLiveReplayCompletions() {
    liveReplayCompletionFrame = 0
    const completions = liveReplayCompletions
    liveReplayCompletions = Object.freeze([])
    if (!completions.length) return
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const absorptionEndsAtByPlaceId = { ...state.live.absorptionEndsAtByPlaceId }
    const replayReadyAtByActor = { ...state.live.replayReadyAtByActor }
    const focus = state.snapshot ? liveFocusPlace(state.snapshot) : null
    const children = focus && state.snapshot ? liveChildren(state.snapshot, focus) : []
    const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
      livePlotDetailContext.focus.id === focus?.id
      ? livePlotDetailContext
      : null
    const now = Date.now()
    const absorptionDeadlines = new Map()
    let changed = false
    for (const completion of completions) {
      const held = active[completion.actor]
      if (!held || held.key !== completion.key) continue
      const absorbingPlaceId = held.type === 'move' && focus
        ? livePlaceAnchor(held.toPlaceId, focus.id, children, renderContext)
        : null
      delete active[completion.actor]
      if (held.type === 'move') {
        positions[completion.actor] = held.toPlaceId
        trailStarts[completion.key] = now
        if (absorbingPlaceId) {
          const deadline = now + LIVE_ABSORPTION_MS
          absorptionEndsAtByPlaceId[String(absorbingPlaceId)] = deadline
          absorptionDeadlines.set(String(absorbingPlaceId), deadline)
        }
      }
      if (!state.live.replayQueues[completion.actor]?.length) {
        if (!absorbingPlaceId) delete positions[completion.actor]
        delete replayReadyAtByActor[completion.actor]
      } else {
        const pendingCount = Object.values(state.live.replayQueues)
          .reduce((total, queue) => total + queue.length, 0)
        const pace = windowLiveReplayPace(
          pendingCount,
          Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
        )
        replayReadyAtByActor[completion.actor] = now + Math.max(
          0,
          pace.startGapMs - Math.max(0, Number(held.duration) || 0),
        )
      }
      changed = true
    }
    if (!changed) return
    state = { ...state, live: {
      ...state.live,
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      trailStarts: Object.freeze(trailStarts),
      absorptionEndsAtByPlaceId: Object.freeze(absorptionEndsAtByPlaceId),
      replayReadyAtByActor: Object.freeze(replayReadyAtByActor),
    } }
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
    for (const [placeId, absorptionEndsAt] of absorptionDeadlines) {
      const absorbedActors = Object.entries(positions)
        .filter(([actor, placeIdAtRest]) =>
          !active[actor] &&
          !state.live.replayQueues[actor]?.length &&
          livePlaceAnchor(
            placeIdAtRest, focus.id, children, renderContext) === Number(placeId))
        .map(([actor]) => actor)
      window.setTimeout(() => {
        if (state.live.absorptionEndsAtByPlaceId[placeId] !== absorptionEndsAt) return
        const remaining = { ...state.live.absorptionEndsAtByPlaceId }
        const remainingPositions = { ...state.live.replayPositions }
        delete remaining[placeId]
        for (const actor of absorbedActors) {
          if (!state.live.replayActive[actor] &&
              !state.live.replayQueues[actor]?.length) delete remainingPositions[actor]
        }
        state = { ...state, live: {
          ...state.live,
          absorptionEndsAtByPlaceId: Object.freeze(remaining),
          replayPositions: Object.freeze(remainingPositions),
        } }
        if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      }, LIVE_ABSORPTION_MS)
    }
  }

  function liveReplayThingIsDisplayed(
    record,
    snapshot,
    focus,
    children,
    renderContext = null,
  ) {
    if (liveRecordType(record) !== 'use') return false
    const placeId = record.detail.place_id
    const anchorId = livePlaceAnchor(placeId, focus.id, children, renderContext)
    if (!anchorId) return false
    const includeDescendants = anchorId !== focus.id
    const records = renderContext?.records || visibleLiveRecords(
      snapshot, focus, children, renderContext)
    const interactionThings = renderContext?.interactionThings ||
      liveFocusInteractionThings(snapshot, focus, records)
    const presentation = liveThingPresentation(
      snapshot,
      anchorId,
      records,
      focus.id,
      includeDescendants,
      interactionThings,
      renderContext,
    )
    const matches = thing => thing.id === record.detail.source_thing_id &&
      (thing.place_id === placeId || thing.recorded_place_id === placeId)
    return presentation.selection.visible.some(matches) ||
      interactionThings.some(matches)
  }

  function startLiveReplays() {
    window.clearTimeout(liveReplayStartTimer)
    liveReplayStartTimer = 0
    if (state.view !== 'live' || document.hidden || !state.snapshot || state.live.paused) return
    if (state.live.streamMarker && !markerCovers(state.changeMarker, state.live.streamMarker)) return
    if (liveMotionReduced()) {
      if (liveReplayHeldKeys().size) {
        settleLiveReplays()
        renderLive(state.snapshot)
      }
      return
    }
    const focus = liveFocusPlace(state.snapshot)
    if (!focus) return
    const children = liveChildren(state.snapshot, focus)
    const renderContext = livePlotDetailContext?.snapshot === state.snapshot &&
      livePlotDetailContext.focus.id === focus.id
      ? livePlotDetailContext
      : null
    const residentIndex = liveRenderResidentIndex(state.snapshot, renderContext)
    const now = Date.now()
    const queues = Object.fromEntries(Object.entries(state.live.replayQueues)
      .map(([actor, queue]) => [actor, [...queue]]))
    const active = { ...state.live.replayActive }
    const positions = { ...state.live.replayPositions }
    const trailStarts = { ...state.live.trailStarts }
    const replayReadyAtByActor = { ...state.live.replayReadyAtByActor }
    const revealed = new Set(state.live.replayRevealedKeys)
    const starts = []
    let nextReadyAt = Number.POSITIVE_INFINITY
    let changed = false

    const queuedCount = Object.values(queues).reduce((total, queue) => total + queue.length, 0)
    const longestActorQueue = Math.max(
      0,
      ...Object.values(queues).map(queue => queue.length),
    )
    const busyReplay = queuedCount + Object.keys(active).length > 12
    const pace = windowLiveReplayPace(
      queuedCount + Object.keys(active).length,
      Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
    )
    const busyDurationCap = Object.keys(queues).length * 2 >= Math.max(1, queuedCount)
      ? Math.max(1_200, pace.actionDurationMs)
      : pace.actionDurationMs

    const unscheduledActors = Object.keys(queues).filter(actor =>
      !active[actor] && !Object.hasOwn(replayReadyAtByActor, actor))
    if (unscheduledActors.length) {
      const unscheduled = new Set(unscheduledActors)
      const offsets = windowLiveReplayStartOffsets(
        Object.entries(queues).flatMap(([actor, queue]) =>
          unscheduled.has(actor) ? queue : []),
        Math.max(1, (state.live.nextReadAt || now + 25_000) - now),
      )
      for (const actor of unscheduledActors) {
        replayReadyAtByActor[actor] = now + (offsets[actor] || 0)
      }
      changed = true
    }

    for (const actor of Object.keys(queues)) {
      if (active[actor]) continue
      const readyAt = Number(replayReadyAtByActor[actor]) || 0
      if (readyAt > now) {
        nextReadyAt = Math.min(nextReadyAt, readyAt)
        continue
      }
      if (state.resident && actor !== state.resident) {
        for (const record of queues[actor]) revealed.add(liveTraceKey(record))
        delete queues[actor]
        delete positions[actor]
        delete replayReadyAtByActor[actor]
        changed = true
        continue
      }
      let queue = windowLiveReplayOrder(queues[actor], Number.NEGATIVE_INFINITY)
        .filter(record => liveRecordIsRecent(record, now))
      if (queue.length !== queues[actor].length) changed = true
      while (queue.length) {
        const record = queue[0]
        const type = liveRecordType(record)
        const key = liveTraceKey(record)
        const point = liveReplayPoint(
          liveRecordPlaceId(record), focus, children, renderContext)
        if (type === 'note' && point) {
          const noteId = record.detail.note_id
          const entry = state.live.noteBodies[String(noteId)]
          if (!entry) {
            if (noteId) void loadLiveNote(noteId)
            break
          }
          if (entry.loading) break
        }

        if (type === 'move') {
          const resident = residentIndex.residentByHandle(actor)
          const geometry = resident
            ? liveReplayMoveGeometry(
                record, state.snapshot, focus, children, renderContext)
            : null
          if (!geometry) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          const fromPlaceId = record.detail.from_place_id
          const distance = Math.hypot(
            geometry.to.x - geometry.from.x,
            geometry.to.y - geometry.from.y,
          )
          const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
          const naturalDuration = windowLiveReplayDuration(distance, remainingLifetime)
          const pacedDurationCap = longestActorQueue > 1
            ? Math.max(3_200, pace.actionDurationMs)
            : Number.POSITIVE_INFINITY
          const duration = Math.min(
            naturalDuration,
            busyReplay ? busyDurationCap || Number.POSITIVE_INFINITY : pacedDurationCap,
          )
          if (!duration) {
            queue = queue.slice(1)
            changed = true
            revealed.add(key)
            continue
          }
          queue = queue.slice(1)
          changed = true
          revealed.add(key)
          positions[actor] = fromPlaceId
          trailStarts[key] = Date.now()
          active[actor] = Object.freeze({
            key, record, type,
            fromPlaceId,
            toPlaceId: record.detail.to_place_id,
            startedAt: Date.now(), duration,
          })
          starts.push(Object.freeze({ actor, key, duration }))
          break
        }

        queue = queue.slice(1)
        changed = true
        revealed.add(key)
        const canReplayHere = point && (type !== 'use' ||
          liveReplayThingIsDisplayed(
            record, state.snapshot, focus, children, renderContext))
        if (!canReplayHere) continue
        const naturalDuration = type === 'note' ? LIVE_NOTE_REPLAY_MS : LIVE_PULSE_MS
        const ordinaryDurationCap = longestActorQueue > 1
          ? Math.max(LIVE_PULSE_MS, pace.actionDurationMs)
          : Number.POSITIVE_INFINITY
        const duration = Math.min(
          naturalDuration,
          busyReplay ? busyDurationCap || Number.POSITIVE_INFINITY : ordinaryDurationCap,
        )
        const remainingLifetime = record.at.getTime() + liveRecordLifetime(record) - now
        if (remainingLifetime < duration) continue
        active[actor] = Object.freeze({
          key, record, type, placeId: liveRecordPlaceId(record),
          startedAt: Date.now(), duration,
        })
        starts.push(Object.freeze({ actor, key, duration }))
        break
      }
      if (queue.length) queues[actor] = Object.freeze(queue)
      else delete queues[actor]
      if (!active[actor] && !queue.length) {
        delete positions[actor]
        delete replayReadyAtByActor[actor]
      }
    }
    if (!changed) {
      if (Number.isFinite(nextReadyAt)) {
        liveReplayStartTimer = window.setTimeout(
          startLiveReplays,
          Math.max(0, nextReadyAt - Date.now()) + 1,
        )
      }
      return
    }
    state = { ...state, live: {
      ...state.live,
      replayQueues: Object.freeze(queues),
      replayActive: Object.freeze(active),
      replayPositions: Object.freeze(positions),
      replayReadyAtByActor: Object.freeze(replayReadyAtByActor),
      trailStarts: Object.freeze(trailStarts),
      replayRevealedKeys: Object.freeze([...revealed]),
    } }
    renderLive(state.snapshot)
    for (const start of starts) {
      window.setTimeout(() => queueLiveReplayCompletion(start.actor, start.key), start.duration)
    }
    if (Number.isFinite(nextReadyAt)) {
      liveReplayStartTimer = window.setTimeout(
        startLiveReplays,
        Math.max(0, nextReadyAt - Date.now()) + 1,
      )
    }
  }

  function renderLiveReplayPortraits(
    layer,
    snapshot,
    focus,
    children,
    bubbles,
    renderContext = null,
  ) {
    const residentIndex = liveRenderResidentIndex(snapshot, renderContext)
    for (const [actor, placeId] of Object.entries(state.live.replayPositions)) {
      if (state.resident && actor !== state.resident) continue
      const resident = residentIndex.residentByHandle(actor)
      if (!resident) continue
      const held = state.live.replayActive[actor]
      let point = liveResidentReplayPoint(
        snapshot, placeId, actor, focus, children, renderContext)
      let destination = null
      let remaining = 0
      if (held?.type === 'move') {
        const geometry = liveReplayMoveGeometry(
          held.record, snapshot, focus, children, renderContext)
        if (!geometry) continue
        const progress = Math.max(0, Math.min(1,
          (Date.now() - held.startedAt) / held.duration))
        point = Object.freeze({
          x: geometry.from.x + (geometry.to.x - geometry.from.x) * progress,
          y: geometry.from.y + (geometry.to.y - geometry.from.y) * progress,
        })
        destination = geometry.to
        remaining = Math.max(0, held.duration - (Date.now() - held.startedAt))
      }
      if (!point) continue
      const portrait = element('button', resident.asleep
        ? 'live-portrait asleep'
        : 'live-portrait')
      portrait.type = 'button'
      portrait.dataset.focusKey = 'live-resident:' + actor
      portrait.dataset.liveResidentHandle = actor
      portrait.title = state.live.focusResident === actor
        ? 'Clear focus from ' + actor
        : 'Focus on ' + actor
      portrait.setAttribute('aria-label', portrait.title)
      portrait.setAttribute('aria-pressed', String(state.live.focusResident === actor))
      const shell = livePortraitShell(
        portrait,
        bubbles.get(actor),
        'live-portrait-wrap live-replay-portrait',
      )
      shell.dataset.liveReplayKey = held?.key || ''
      if (state.live.focusResident === actor) {
        shell.setAttribute('data-live-focus-resident', actor)
      }
      if (held) {
        shell.dataset.liveAt = String(held.record.at.getTime())
        shell.dataset.liveLifetime = String(liveRecordLifetime(held.record))
      }
      shell.style.left = String(point.x) + 'px'
      shell.style.top = String(point.y) + 'px'
      if (destination && remaining > 0) {
        shell.style.setProperty('--live-replay-delta-x', String(destination.x - point.x) + 'px')
        shell.style.setProperty('--live-replay-delta-y', String(destination.y - point.y) + 'px')
        shell.style.animationDuration = String(remaining) + 'ms'
        shell.dataset.fromPlaceId = String(held.fromPlaceId)
        shell.dataset.toPlaceId = String(held.toPlaceId)
        shell.dataset.replayDuration = String(held.duration)
      }
      portrait.addEventListener('click', () => toggleLiveFocusResident(actor))
      portrait.append(portraitNode(
        'resident', resident.id, actor, resident.has_drawing, 'live-entity-portrait',
      ))
      layer.append(shell)
    }
  }

  function visibleLiveRecords(snapshot, focus, children, renderContext = null) {
    const now = Date.now()
    return liveRecords().filter(record => {
      const type = liveRecordType(record)
      if (!type || (state.resident && record.actor !== state.resident)) return false
      if (windowLiveTraceOpacity(record.at.getTime(), now, liveRecordLifetime(record)) <= 0) {
        return false
      }
      if (type === 'move') {
        return Boolean(
          livePlaceAnchor(
            record.detail.from_place_id, focus.id, children, renderContext) ||
          livePlaceAnchor(
            record.detail.to_place_id, focus.id, children, renderContext)
        )
      }
      return Boolean(livePlaceAnchor(
        liveRecordPlaceId(record), focus.id, children, renderContext))
    })
  }

  function bindLiveHighlight(node, key, surface) {
    node.dataset.liveKey = key
    if (!node.dataset.focusKey) node.dataset.focusKey = 'live-record:' + surface + ':' + key
    node.dataset.highlighted = String(state.live.highlightedKey === key)
    node.addEventListener('mouseenter', () => setLiveHighlight(key))
    node.addEventListener('mouseleave', () => setLiveHighlight(null))
    node.addEventListener('focus', () => setLiveHighlight(key))
    node.addEventListener('blur', () => setLiveHighlight(null))
    node.addEventListener('click', () => setLiveHighlight(
      state.live.highlightedKey === key ? null : key))
  }

  function liveTrailTiming(record, key) {
    const active = Object.values(state.live.replayActive).find(candidate =>
      candidate.type === 'move' && candidate.key === key)
    if (active) {
      return Object.freeze({
        at: active.startedAt,
        lifetime: active.duration + LIVE_TRAIL_LIFETIME_MS,
        duration: active.duration,
        replaying: true,
      })
    }
    const startedAt = Number(state.live.trailStarts[key]) || record.at.getTime()
    return Object.freeze({
      at: startedAt,
      lifetime: LIVE_TRAIL_LIFETIME_MS,
      duration: 0,
      replaying: false,
    })
  }

  function scheduleLiveTrailExpiry() {
    window.clearTimeout(liveTrailExpiryTimer)
    liveTrailExpiryTimer = 0
    if (state.view !== 'live' || !nodes.livePlates) return
    const trails = [...nodes.livePlates.querySelectorAll('.live-trail')]
    const nextExpiry = Math.min(...trails.map(trail =>
      Number(trail.dataset.liveAt) + Number(trail.dataset.liveLifetime)))
    if (!Number.isFinite(nextExpiry)) return
    liveTrailExpiryTimer = window.setTimeout(() => {
      liveTrailExpiryTimer = 0
      const now = Date.now()
      for (const trail of nodes.livePlates?.querySelectorAll('.live-trail') || []) {
        if (Number(trail.dataset.liveAt) + Number(trail.dataset.liveLifetime) > now) continue
        const active = document.activeElement
        const movesFocus = active === trail || trail.contains(active)
        const key = trail.dataset.liveKey
        trail.remove()
        if (movesFocus) moveLiveFocusAfterExpiry(key)
      }
      scheduleLiveTrailExpiry()
    }, Math.max(0, nextExpiry - Date.now()) + 1)
  }

  function renderLiveTraceLayer(
    snapshot,
    focus,
    children,
    records,
    bubbles,
    survey,
    renderContext = null,
  ) {
    const layer = element('div', 'live-trace-layer')
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.classList.add('live-traces')
    svg.setAttribute('viewBox', '0 0 ' + String(survey.width) + ' ' + String(survey.height))
    svg.setAttribute('preserveAspectRatio', 'none')
    svg.setAttribute('aria-label', 'Recent movement trails')
    const definitions = document.createElementNS('http://www.w3.org/2000/svg', 'defs')
    const marker = document.createElementNS('http://www.w3.org/2000/svg', 'marker')
    marker.setAttribute('id', 'live-trace-arrow')
    marker.setAttribute('markerWidth', '6')
    marker.setAttribute('markerHeight', '6')
    marker.setAttribute('refX', '5')
    marker.setAttribute('refY', '3')
    marker.setAttribute('orient', 'auto')
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    arrow.setAttribute('d', 'M0,0 L6,3 L0,6 Z')
    arrow.classList.add('live-trace-arrowhead')
    marker.append(arrow)
    definitions.append(marker)
    svg.append(definitions)

    const noteNumbers = new Map(records.map((record, index) => [liveTraceKey(record), index + 1]))
    const trailKeys = new Set(windowLiveSelectTrailKeys(
      records.filter(record => liveRecordType(record) === 'move' &&
        liveReplayRecordIsRevealed(record)).map(liveTraceKey),
      LIVE_TRAIL_DOM_LIMIT,
      [...liveReplayHeldKeys()],
    ))
    for (const record of records) {
      const type = liveRecordType(record)
      const key = liveTraceKey(record)
      if (!liveReplayRecordIsRevealed(record)) continue
      const recordOpacity = windowLiveTraceOpacity(
        record.at.getTime(), Date.now(), liveRecordLifetime(record))
      if (type === 'move') {
        if (!trailKeys.has(key)) continue
        const geometry = liveReplayMoveGeometry(
          record, snapshot, focus, children, renderContext)
        const from = geometry?.from
        const to = geometry?.to
        if (!from || !to || (from.x === to.x && from.y === to.y)) continue
        const timing = liveTrailTiming(record, key)
        const opacity = windowLiveTraceOpacity(timing.at, Date.now(), timing.lifetime)
        if (opacity <= 0) continue
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'line')
        trail.classList.add('live-trail')
        if (timing.replaying) trail.classList.add('live-trail-inking')
        trail.setAttribute('x1', String(from.x))
        trail.setAttribute('y1', String(from.y))
        trail.setAttribute('x2', String(to.x))
        trail.setAttribute('y2', String(to.y))
        trail.setAttribute('marker-end', 'url(#live-trace-arrow)')
        trail.setAttribute('tabindex', '0')
        trail.setAttribute('role', 'button')
        trail.setAttribute('aria-label', record.actor + ' moved from ' +
          String(record.detail.from_place_id) + ' to ' + String(record.detail.to_place_id))
        trail.dataset.liveAt = String(timing.at)
        trail.dataset.liveLifetime = String(timing.lifetime)
        trail.dataset.replaying = String(timing.replaying)
        if (timing.duration) {
          trail.style.setProperty('--live-trail-duration', String(timing.duration) + 'ms')
        }
        trail.style.opacity = String(opacity)
        bindLiveHighlight(trail, key, 'trail')
        svg.append(trail)
        continue
      }
      const placeId = liveRecordPlaceId(record)
      const anchor = livePlaceAnchor(placeId, focus.id, children, renderContext)
      const point = liveAnchorPoint(anchor, focus.id, children)
      if (!point) continue
      if (type === 'note') {
        const mark = element('button', 'live-footnote-mark', String(noteNumbers.get(key)))
        mark.type = 'button'
        mark.style.left = String(point.x) + 'px'
        mark.style.top = String(point.y) + 'px'
        mark.dataset.liveAt = String(record.at.getTime())
        mark.dataset.liveLifetime = String(liveRecordLifetime(record))
        mark.style.opacity = String(recordOpacity)
        mark.setAttribute('aria-label', 'Show ' + record.actor + "'s note in the plate ledger")
        bindLiveHighlight(mark, key, 'mark')
        const bubble = bubbles.get(record.actor)
        if (liveMotionReduced() && bubble?.record === record) {
          mark.append(liveSpeechBubbleNode(bubble))
        }
        layer.append(mark)
      } else if (type === 'make' && state.live.replayActive[record.actor]?.key === key) {
        const pulse = element('span', 'live-action-mark live-pulse', type === 'make' ? '+' : '×')
        pulse.style.left = String(point.x) + 'px'
        pulse.style.top = String(point.y) + 'px'
        pulse.setAttribute('role', 'img')
        pulse.setAttribute('aria-label', record.actor + (type === 'make'
          ? ' made something here'
          : ' used something here'))
        bindLiveHighlight(pulse, key, 'pulse')
        layer.append(pulse)
      }
    }
    layer.prepend(svg)
    renderLiveReplayPortraits(
      layer, snapshot, focus, children, bubbles, renderContext)
    return layer
  }

  function livePlaceName(snapshot, id) {
    const place = placeReference(snapshot, id)
    return place ? place.name : id ? 'Place #' + String(id) : 'between places'
  }

  function liveLedgerText(snapshot, record) {
    const type = liveRecordType(record)
    if (type === 'move') {
      const carrying = record.detail.mode === 'carry' && record.detail.thing_id
        ? ' carrying Thing #' + String(record.detail.thing_id)
        : ''
      return record.actor + ' moved' + carrying + ': ' +
        livePlaceName(snapshot, record.detail.from_place_id) +
        ' → ' + livePlaceName(snapshot, record.detail.to_place_id)
    }
    if (type === 'note') {
      const noteId = record.detail.note_id
      const entry = state.live.noteBodies[String(noteId)]
      if (!entry && noteId) void loadLiveNote(noteId)
      if (entry?.body) {
        return record.actor + ': ' + entry.body
      }
      if (entry?.error) return record.actor + "'s note #" + String(noteId) + ' could not be read.'
      return 'Reading ' + record.actor + "'s note #" + String(noteId) + '…'
    }
    const placeId = liveRecordPlaceId(record)
    if (type === 'make') {
      return record.actor + ' made thing #' + String(record.detail.thing_id || '?') +
        ' in ' + livePlaceName(snapshot, placeId)
    }
    return record.actor + ' used thing #' + String(record.detail.source_thing_id || '?') +
      ' in ' + livePlaceName(snapshot, placeId)
  }

  function renderLiveLedger(snapshot, focus, children, suppliedRecords) {
    if (!nodes.liveLedger) return
    const liveFocus = focus || liveFocusPlace(snapshot)
    if (!liveFocus) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row', 'No public plate is available.'))
      return
    }
    const liveChildrenRows = children || liveChildren(snapshot, liveFocus)
    const records = suppliedRecords || visibleLiveRecords(snapshot, liveFocus, liveChildrenRows)
    if (!records.length) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row',
        'No recent marks reach this plate. The city moves only when residents act.'))
      return
    }
    nodes.liveLedger.replaceChildren(...records.map((record, index) => {
      const row = element('li', 'live-ledger-row')
      const key = liveTraceKey(record)
      const number = element('span', 'live-ledger-number', String(index + 1).padStart(2, '0'))
      const copy = element('p', 'live-ledger-copy', liveLedgerText(snapshot, record))
      const age = windowLiveTraceOpacity(record.at.getTime(), Date.now(), liveRecordLifetime(record))
      row.dataset.liveAt = String(record.at.getTime())
      row.dataset.liveLifetime = String(liveRecordLifetime(record))
      row.style.opacity = String(Math.max(0.25, age))
      row.append(number, copy, timeNode(record.at, 'live-ledger-time'))
      const thingId = activityThingId(record)
      if (thingId) {
        const thing = namedThingReference(snapshot, thingId)
        const label = thing?.name || 'Thing #' + String(thingId)
        const reference = openDetailLink(
          'thing', thingId, label, 'detail-link live-ledger-thing-reference',
        )
        reference.prepend(portraitNode(
          'thing', thingId, label,
          thing ? thing.has_drawing === true : record.thingHasDrawing,
          'live-entity-portrait',
        ))
        row.append(reference)
      }
      row.tabIndex = 0
      bindLiveHighlight(row, key, 'ledger')
      return row
    }))
  }

  function renderLiveHistoryStatus() {
    if (!nodes.liveHistoryStatus) return
    if (state.live.proofScene) {
      const exit = element('button', 'live-history-retry', 'Exit preview proof scene')
      exit.type = 'button'
      exit.dataset.focusKey = 'live-proof-exit'
      exit.dataset.focusFallbackId = 'live-proof'
      exit.addEventListener('click', exitLiveProofScene)
      nodes.liveHistoryStatus.replaceChildren(
        document.createTextNode(
          'Preview proof: movement, speech, use, concurrency, crowding, inline Show more, failure, and Retry are repeatable here. '
        ),
        exit,
      )
      return
    }
    const parts = []
    if (state.live.openingLoading) {
      parts.push(document.createTextNode('Reading backward to the 30-minute trace edge…'))
    } else if (state.live.openingPaused) {
      parts.push(document.createTextNode(
        'Automatic recent-history reading pauses after 1,600 public events. Continue recent history to read the next pages; this viewer will not call the history complete while pages remain. '
      ))
      const continueButton = element('button', 'live-history-retry', 'Continue recent history')
      continueButton.type = 'button'
      continueButton.dataset.focusKey = 'live-history-opening-continue'
      continueButton.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(continueButton)
    } else if (state.live.openingError) {
      parts.push(document.createTextNode(
        'Recent history is incomplete before the 30-minute edge. The plate shows only records it could verify. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry recent history')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-opening-retry'
      retry.addEventListener('click', () => {
        if (state.snapshot) void loadLiveOpeningHistory(state.snapshot, true)
      })
      parts.push(retry)
    } else if (state.live.openingComplete) {
      parts.push(document.createTextNode('Recent history is complete through the 30-minute trace edge.'))
    } else {
      parts.push(document.createTextNode('Preparing the recent public record…'))
    }
    if (state.live.streamError) {
      parts.push(document.createTextNode(
        ' The latest change pages could not be completed; this plate is holding its last verified cursor. '
      ))
      const retry = element('button', 'live-history-retry', 'Retry the latest read')
      retry.type = 'button'
      retry.dataset.focusKey = 'live-history-stream-retry'
      retry.addEventListener('click', () => void refreshCity())
      parts.push(retry)
    }
    const snapshot = state.snapshot
    const focus = snapshot ? liveFocusPlace(snapshot) : null
    if (snapshot && focus) {
      const thingFilters = liveThingFilters(focus.id)
      const thingsPage = historyEntry('things', thingFilters)
      const namedThingCount = liveDisplayedThings(
        snapshot, focus.id, focus.id, true).length
      const exactThingTotal = liveExactThingTotal(
        snapshot, focus.id, namedThingCount, true)
      if (exactThingTotal === null) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts are unavailable because the fixed survey is incomplete or disagrees with the named cards.'
        ))
      } else if (thingsPage.error) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts stay verified, but newest named thing cards could not be read. '
        ))
        const retry = element('button', 'live-history-retry', 'Retry named thing cards')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-things-retry'
        retry.addEventListener('click', () => void loadHistory('things', thingFilters))
        parts.push(retry)
      } else if (thingsPage.loading || !thingsPage.initialized) {
        parts.push(document.createTextNode(
          ' Exact +N thing counts come from the fixed survey while newest named cards load. ' +
          'The named-card sample stops after one page of at most 50 public things.'
        ))
      } else if (thingsPage.hasMore) {
        parts.push(document.createTextNode(
          ' Showing the newest ' + String(thingsPage.rows.length) +
          ' named thing cards, from a one-page limit of 50; exact +N includes every other public thing in this plate.'
        ))
      }
    }
    nodes.liveHistoryStatus.replaceChildren(...parts)
  }

  async function loadLiveOpeningHistory(snapshot, force) {
    if (state.view !== 'live' || document.hidden || state.live.openingLoading ||
        (state.live.openingLoaded && !force)) return
    const visibilityRevisionAtStart = liveVisibilityRevision
    const requestMarker = state.live.openingMarker || snapshot.changeMarker || state.changeMarker
    if (!requestMarker) return
    const startingEvents = force ? state.live.openingEvents : []
    const startingBeforeId = force ? state.live.openingNextBeforeId : null
    state = {
      ...state,
      live: {
        ...state.live,
        openingMarker: requestMarker,
        openingEvents: startingEvents,
        openingLoaded: false,
        openingLoading: true,
        openingComplete: false,
        openingPaused: false,
        openingError: false,
        openingReplaySuppressed: force ? state.live.openingReplaySuppressed : false,
        openingNextBeforeId: startingBeforeId,
        changes: state.live.openingMarker ? state.live.changes : [],
        streamMarker: state.live.openingMarker ? state.live.streamMarker : requestMarker,
      },
    }
    renderLiveHistoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let events = startingEvents
    let beforeId = startingBeforeId
    let heldMarker = startingBeforeId ? requestMarker : null
    const seenCursors = new Set()
    let complete = false
    let automaticPaused = false
    let visibilityPaused = false
    let pageCount = 0
    try {
      while (!complete) {
        if (state.view !== 'live' || document.hidden) {
          visibilityPaused = true
          break
        }
        const url = new URL('/api/events', window.location.origin)
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        url.searchParams.set('within_seconds', String(LIVE_MOVE_LIFETIME_MS / 1000))
        url.searchParams.set('after_change_marker', heldMarker || requestMarker)
        if (beforeId) url.searchParams.set('before_id', String(beforeId))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
          redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
        })
        if (!response.ok) throw new Error('recent public events unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid recent public events')
        const pageMarker = safeChangeMarker(payload.change_marker)
        if (!pageMarker || !markerCovers(pageMarker, heldMarker || requestMarker)) {
          throw new Error('recent public event marker did not cover its page')
        }
        if (!heldMarker) heldMarker = pageMarker
        const incoming = normalizeEvents(payload.events, LIVE_OPENING_PAGE_LIMIT)
        const covered = incoming.filter(event => event.change_id &&
          BigInt(event.change_id) <= BigInt(heldMarker))
        const previousLength = events.length
        events = mergeWindowRows(events, covered)
        pageCount += 1
        if (payload.has_more !== true) {
          complete = true
          beforeId = null
          break
        }
        const nextBeforeId = safeId(payload.next_before_id)
        if (!incoming.length || !nextBeforeId || seenCursors.has(nextBeforeId) ||
            !incoming.some(event => event.id === nextBeforeId) ||
            (beforeId && nextBeforeId >= beforeId) || events.length <= previousLength) {
          throw new Error('recent public event cursor did not progress')
        }
        seenCursors.add(nextBeforeId)
        beforeId = nextBeforeId
        if (pageCount >= MAX_AUTO_HISTORY_PAGES) {
          automaticPaused = true
          break
        }
      }
      const latestAt = events.length
        ? Math.max(...events.map(event => event.at.getTime()))
        : state.live.lastChangeAt
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      const streamMarker = markerCovers(state.live.streamMarker, streamBase)
        ? state.live.streamMarker
        : streamBase
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: !visibilityPaused,
          openingLoading: false,
          openingComplete: complete,
          openingPaused: automaticPaused,
          openingError: false,
          openingReplaySuppressed: state.live.openingReplaySuppressed ||
            visibilityRevisionAtStart !== liveVisibilityRevision,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker,
          lastChangeAt: latestAt || null,
        },
      }
    } catch {
      const streamBase = heldMarker || requestMarker
      const changes = Object.freeze(state.live.changes.filter(change =>
        BigInt(change.change_id) > BigInt(streamBase)))
      state = {
        ...state,
        live: {
          ...state.live,
          openingEvents: Object.freeze(events),
          openingMarker: streamBase,
          openingLoaded: true,
          openingLoading: false,
          openingComplete: false,
          openingPaused: false,
          openingError: true,
          openingReplaySuppressed: state.live.openingReplaySuppressed ||
            visibilityRevisionAtStart !== liveVisibilityRevision,
          openingNextBeforeId: beforeId,
          changes,
          streamMarker: markerCovers(state.live.streamMarker, streamBase)
            ? state.live.streamMarker
            : streamBase,
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (state.live.openingComplete && !state.live.openingError) {
        // Opening history is context, not a burst of actions happening now.
        // Paint its final residue immediately, then animate only changes
        // learned after that completed baseline.
        queueLiveReplays(state.live.openingEvents, false)
        queueLiveReplays(
          state.live.changes,
          !document.hidden && !state.live.suppressReplayOnNextRead &&
            !state.live.openingReplaySuppressed &&
            visibilityRevisionAtStart === liveVisibilityRevision,
        )
      }
      if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
      if (state.view === 'live' && !document.hidden && heldMarker &&
          !markerCovers(state.changeMarker, heldMarker)) void refreshCity()
    }
  }

  function liveAgeLabel(milliseconds) {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000))
    if (seconds < 60) return String(seconds) + 's'
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return String(minutes) + (minutes === 1 ? ' minute' : ' minutes')
    const hours = Math.floor(minutes / 60)
    return String(hours) + (hours === 1 ? ' hour' : ' hours')
  }

  function renderLiveClock() {
    if (!nodes.liveClock) return
    if (document.hidden) {
      nodes.liveClock.textContent = 'Reads pause while this tab is hidden. The last completed plate stays visible.'
      return
    }
    const now = Date.now()
    const next = state.live.nextReadAt
      ? ' · next read in ' + String(Math.max(0, Math.ceil((state.live.nextReadAt - now) / 1000))) + 's'
      : ' · next read pending'
    if (!state.live.lastChangeAt) {
      nodes.liveClock.textContent =
        'The city has been still for longer than this plate can show. It moves only when residents act.' + next
      return
    }
    const elapsed = Math.max(0, now - state.live.lastChangeAt)
    nodes.liveClock.textContent = elapsed >= 60000
      ? 'The city has been still for ' + liveAgeLabel(elapsed) +
        '. It moves only when residents act.' + next
      : 'last change ' + liveAgeLabel(elapsed) + ' ago' + next
  }

  function moveLiveFocusAfterExpiry(key) {
    const candidates = [
      ...(nodes.livePlates?.querySelectorAll('[data-live-key]') || []),
      ...(nodes.liveLedger?.querySelectorAll('[data-live-key]') || []),
    ]
    const paired = candidates.find(candidate =>
      candidate.isConnected && candidate.dataset.liveKey === key)
    const fallback = paired || nodes.liveViewport || nodes.livePause
    if (typeof fallback?.focus === 'function') fallback.focus()
  }

  function renderLiveAging() {
    if (state.view !== 'live' || document.hidden) return
    const now = Date.now()
    const trailStarts = windowLivePruneTrailStarts(
      state.live.trailStarts,
      now,
      LIVE_TRAIL_LIFETIME_MS,
      [...liveReplayHeldKeys()],
    )
    if (trailStarts !== state.live.trailStarts) {
      state = { ...state, live: { ...state.live, trailStarts } }
    }
    pruneLiveNoteBodies(now)
    const agedNodes = [
      ...(nodes.livePlates?.querySelectorAll('[data-live-at][data-live-lifetime]') || []),
      ...(nodes.liveLedger?.querySelectorAll('[data-live-at][data-live-lifetime]') || []),
    ]
    let expiredLedgerRow = false
    for (const node of agedNodes) {
      const opacity = windowLiveTraceOpacity(
        Number(node.dataset.liveAt), now, Number(node.dataset.liveLifetime))
      if (opacity <= 0) {
        expiredLedgerRow ||= node.classList.contains('live-ledger-row')
        const active = document.activeElement
        const movesFocus = active === node || node.contains(active)
        const key = node.dataset.liveKey
        node.remove()
        if (movesFocus) moveLiveFocusAfterExpiry(key)
      } else {
        node.style.opacity = String(node.classList.contains('live-ledger-row')
          ? Math.max(0.25, opacity)
          : opacity)
      }
    }
    if (expiredLedgerRow && nodes.liveLedger &&
        !nodes.liveLedger.querySelector('.live-ledger-row')) {
      nodes.liveLedger.replaceChildren(element('li', 'empty-row',
        'No recent marks reach this plate. The city moves only when residents act.'))
    }
  }

  function scheduleLiveClock() {
    window.clearTimeout(state.live.clockTimer)
    if (state.view !== 'live') {
      if (state.live.clockTimer) {
        state = { ...state, live: { ...state.live, clockTimer: 0 } }
      }
      return
    }
    renderLiveClock()
    renderLiveAging()
    const clockTimer = window.setTimeout(scheduleLiveClock, 1000)
    state = { ...state, live: { ...state.live, clockTimer } }
  }

  function renderLivePopulationGate(message, retryLabel, retry) {
    clearLiveScopeSurfaces('Waiting for this plate to finish loading…')
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const row = element('div', retry ? 'error-row' : 'loading-row')
    row.append(element('p', '', message))
    if (retry) {
      const button = element('button', 'selection-retry', retryLabel)
      button.type = 'button'
      button.dataset.focusKey = 'live-population-retry'
      button.addEventListener('click', retry)
      row.append(button)
    }
    nodes.livePlates.replaceChildren(row)
    renderLiveHistoryStatus()
    scheduleLiveClock()
  }

  function clearLiveScopeSurfaces(message) {
    if (nodes.liveWorldGround) nodes.liveWorldGround.replaceChildren()
    if (nodes.liveLedger) {
      nodes.liveLedger.replaceChildren(element('li', 'loading-row', message))
    }
    if (nodes.liveRoster) {
      nodes.liveRoster.replaceChildren(element('p', 'loading-row', message))
    }
    if (nodes.liveResidentPage) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
    }
  }

  function renderLive(snapshot) {
    resetPortraitImages()
    if (!nodes.livePlates || !nodes.liveStage) return
    livePlotDetailContext = null
    if (nodes.liveMapCaption) nodes.liveMapCaption.hidden = true
    const active = document.activeElement
    const focusKey = active?.closest?.('#live-panel') && active.dataset
      ? active.dataset.focusKey || null
      : null
    const residentCensusComplete = !state.residentPaging.loading &&
      !state.residentPaging.hasMore && !state.residentPaging.error
    if (state.live.focusResident && state.directory.loaded && residentCensusComplete &&
        !state.directory.residents.some(resident =>
          resident.handle === state.live.focusResident) &&
        !displayedResidents(snapshot).some(resident =>
          resident.handle === state.live.focusResident)) {
      storeLiveFocusResident(null)
      state = { ...state, live: { ...state.live, focusResident: null } }
    }
    renderLiveFocusStatus()
    if (nodes.livePause) {
      nodes.livePause.setAttribute('aria-pressed', String(state.live.paused))
      nodes.livePause.textContent = state.live.paused ? 'Resume walks' : 'Pause walks'
    }
    const selectedIssue = selectionIssue(snapshot, true)
    const issue = selectedIssue?.kind === 'place' &&
      liveSurveyCoversPlace(snapshot, Number(selectedIssue.value))
      ? null
      : selectedIssue
    if (issue) {
      clearLiveScopeSurfaces('Waiting for a valid current plate…')
      renderSelectionIssue(nodes.livePlates, issue)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    if (!state.directory.loaded) {
      clearLiveScopeSurfaces('Waiting for the fixed public survey…')
      const message = element('div', state.directory.error ? 'error-row' : 'loading-row')
      message.append(element('p', '', state.directory.error
        ? 'The complete public place list could not be read, so this viewer will not guess where fixed plots belong.'
        : 'Reading the complete public place list before fixing every plot to its ground…'))
      if (state.directory.error) {
        const retry = element('button', 'selection-retry', 'Retry the fixed survey')
        retry.type = 'button'
        retry.dataset.focusKey = 'live-directory-retry'
        retry.addEventListener('click', () => void loadDirectory(true))
        message.append(retry)
      }
      nodes.livePlates.replaceChildren(message)
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const residentPage = state.residentPaging
    if (residentPage.loading || residentPage.hasMore || residentPage.error ||
        residentPage.automaticPaused) {
      renderLivePopulationGate(
        residentPage.automaticPaused
          ? 'Automatic census reading pauses after 1,600 public residents. Continue the exact census to read the next pages; this viewer will not guess while pages remain.'
          : residentPage.error
          ? 'The complete public resident census could not be read, so this viewer will not print a guessed crowd count.'
          : 'Reading the complete public resident census before printing exact crowd counts…',
        residentPage.automaticPaused
          ? 'Continue the exact resident census'
          : 'Retry the complete resident census',
        residentPage.error || residentPage.automaticPaused
          ? () => void loadResidents()
          : null,
      )
      if (!residentPage.loading && residentPage.hasMore && !residentPage.error &&
          !residentPage.automaticPaused && !document.hidden) {
        window.queueMicrotask(() => {
          if (state.view === 'live' && !document.hidden) void loadResidents(true)
        })
      }
      restoreFocus(focusKey, null, null)
      return
    }
    const focus = liveFocusPlace(snapshot)
    if (!focus) {
      clearLiveScopeSurfaces('No public plate is available.')
      renderEmpty(nodes.livePlates, 'empty-row', 'No public plate is available.')
      renderLiveHistoryStatus()
      scheduleLiveClock()
      restoreFocus(focusKey, null, null)
      return
    }
    const thingFilters = liveThingFilters(focus.id)
    const thingsPage = historyEntry('things', thingFilters)
    const children = liveChildren(snapshot, focus)
    const survey = liveStageSurvey(livePlaceRows(snapshot), focus.id)
    const renderContextBase = liveCreateRenderContext(snapshot, focus, children, survey)
    const records = visibleLiveRecords(snapshot, focus, children, renderContextBase)
    const interactionThings = liveFocusInteractionThings(snapshot, focus, records)
    const bubbles = liveSpeechBubbles(records)
    const directResidents = displayedResidents(snapshot).filter(resident =>
      resident.current_place_id === focus.id &&
      (!state.resident || resident.handle === state.resident))
    const renderContext = Object.freeze({
      ...renderContextBase,
      records,
      interactionThings,
      bubbles,
    })
    livePlotDetailContext = renderContext
    const stageId = String(focus.id)
    const stageChanged = liveCamera.stageId !== stageId
    let defaultCenterTarget = null
    if (stageChanged && nodes.liveViewport) {
      defaultCenterTarget = liveDefaultCenterTarget(snapshot, focus, survey, renderContext)
      const centered = liveCameraForStageTarget(defaultCenterTarget, true)
      if (centered) {
        liveCamera = Object.freeze({
          ...liveCamera,
          ...centered,
          stageId,
          panStart: null,
          pinchStart: null,
        })
      }
    }
    const detailedPlotIds = liveDetailedPlotIds(survey.plots, survey.expandedGrounds)
    const focusedPlotIds = liveFocusedPlotIds(
      snapshot, focus, children, records, interactionThings, renderContext)
    renderLiveBreadcrumbs(snapshot, focus)

    nodes.liveStage.style.setProperty('--live-stage-width', String(survey.width) + 'px')
    nodes.liveStage.style.setProperty('--live-stage-height', String(survey.height) + 'px')
    nodes.liveStage.dataset.liveStageWidth = String(survey.width)
    nodes.liveStage.dataset.liveStageHeight = String(survey.height)
    nodes.liveStage.setAttribute('aria-label', 'Live surveyed plate for ' + focus.name)

    if (nodes.liveMapCaption) {
      nodes.liveMapCaption.hidden = false
      nodes.liveMapCaption.replaceChildren(
        element('p', 'block-number', 'LIVE PLATE / PLACE #' + String(focus.id)),
        element('h3', 'live-plate-title', focus.name),
        element('p', 'live-plate-legend',
          'brick dash = recorded endpoints + drawn-in glide · brick pulse on a thing = recorded use · walkers move above fixed plots · +N more = an exact hidden crowd · click a resident to focus'),
        openDrawingDetailButton(
          'place',
          focus.id,
          focus.name,
          'live-map-caption-drawing-detail drawing-detail-open',
        ),
      )
    }

    if (nodes.liveWorldGround) {
      const tileSize = 56
      const tiled = liveTiledDrawing(
        focus,
        'live-world-ground-tiles',
        Math.ceil(survey.width / tileSize),
        Math.ceil(survey.height / tileSize),
        tileSize,
      )
      nodes.liveWorldGround.replaceChildren(...tiled.children)
      nodes.liveWorldGround.title = focus.name + ' authored ground'
    }

    const plateParts = []
    for (const plot of survey.plots) {
      const place = children.find(candidate => candidate.id === plot.id)
      if (place) {
        plateParts.push(livePlacePlot(
          renderContext,
          place,
          plot,
          detailedPlotIds.has(plot.id),
          focusedPlotIds.includes(plot.id),
        ))
      }
    }
    const proofLoad = liveProofLoadNode(focus, survey)
    if (proofLoad) plateParts.push(proofLoad)
    if (directResidents.length) {
      plateParts.push(livePortraitGrid(
        directResidents,
        'Residents standing directly in ' + focus.name,
        bubbles,
        focus.id,
        livePinnedResidentIds(snapshot, records, focus.id),
        'live-walker-layer live-root-walkers',
        renderContext,
      ))
    }
    const focusShelf = liveThingShelf(
      snapshot, focus, records, focus.id, false, interactionThings, renderContext)
    if (focusShelf) {
      focusShelf.classList.add('live-focus-thing-shelf', 'live-root-thing-shelf')
      plateParts.push(focusShelf)
    }
    if (!children.length && !directResidents.length && !focusShelf) {
      plateParts.push(element('p', 'live-room-empty live-stage-empty',
        directResidents.length
          ? 'No smaller public places are drawn inside this room.'
          : 'Nobody is here right now. The room keeps its things.'))
    }
    plateParts.push(renderLiveTraceLayer(
      snapshot, focus, children, records, bubbles, survey, renderContext))
    nodes.livePlates.replaceChildren(...plateParts)
    scheduleLiveResidentLabels(true)
    scheduleLiveTrailExpiry()

    applyLiveCamera({ stageId })
    if (stageChanged) {
      const preferredKey = state.live.focusResident
        ? 'resident:' + state.live.focusResident
        : state.live.raisedItemKey
      const preferredTargets = preferredKey
        ? [...nodes.livePlates.querySelectorAll(
            '[data-live-item-key="' + CSS.escape(preferredKey) + '"]')]
        : []
      const firstPaintTargets = state.live.proofScene && state.live.proofFailure
        ? [...nodes.livePlates.querySelectorAll('[data-focus-key="live-proof-retry"]')]
        : preferredTargets.length
          ? preferredTargets
          : defaultCenterTarget?.preservesChildDetail
            ? liveChildDetailRevealTargets(defaultCenterTarget)
            : liveRevealTargetsForPlace(focus.id)
      revealLiveElements(firstPaintTargets)
    }
    renderLiveLedger(snapshot, focus, children, records)
    renderLiveRoster(snapshot, focus, records, interactionThings)
    refillLiveDrawingQueue()
    drainLiveDrawingQueue()
    renderLiveHistoryStatus()
    scheduleLiveClock()
    restoreFocus(focusKey, null, null)
    flushLiveFocusRestore()
    if (!state.live.proofScene && !state.live.openingLoaded && !state.live.openingLoading) {
      void loadLiveOpeningHistory(snapshot, Boolean(
        state.live.openingNextBeforeId || state.live.openingEvents.length))
    }
    if (!state.live.proofScene && !thingsPage.loading && !thingsPage.initialized && !thingsPage.error &&
        !document.hidden) {
      window.queueMicrotask(() => {
        const latest = historyEntry('things', thingFilters)
        if (state.view === 'live' && !document.hidden && !latest.loading &&
            !latest.initialized && !latest.error) {
          void loadHistory('things', thingFilters)
        }
      })
    }
    if (Object.keys(state.live.replayQueues).length) {
      window.queueMicrotask(startLiveReplays)
    }
  }

  function renderPeople(target, residents, placeOf) {
    if (!target) return
    if (!residents.length) {
      renderEmpty(target, 'empty-row', 'No included resident matching this view is standing inside this place.')
      return
    }
    const list = element('ul', 'person-list')
    list.append(...[...residents.filter(r => !r.asleep), ...residents.filter(r => r.asleep)].map(resident => {
      const item = element('li', resident.asleep ? 'person-card asleep' : 'person-card')
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'person:' + resident.handle
      follow.addEventListener('click', () => chooseResident(resident.handle))
      const location = windowPlaceLabel(
        resident.current_place_id,
        placeOf ? placeOf(resident.current_place_id) : null,
      )
      item.append(follow, element('span', 'resident-number',
        'resident #' + String(resident.id) + (resident.asleep ? ' · asleep' : '') +
        (location ? ' · at ' + location : '')))
      item.prepend(portraitNode('resident', resident.id, resident.handle, resident.has_drawing))
      return item
    }))
    target.replaceChildren(list)
  }

  // Context neighbours are picked by position in the room, never by clock, so
  // a quiet room can put a day between a note and the one before it. Say the
  // real distance rather than implying a closeness the rule never promised.
  function relativeGap(fromIso, toIso) {
    const difference = new Date(fromIso).getTime() - new Date(toIso).getTime()
    if (!Number.isFinite(difference)) return 'same room'
    const direction = difference < 0 ? ' earlier' : ' later'
    const minutes = Math.round(Math.abs(difference) / 60000)
    if (minutes < 1) return 'same room · moments apart'
    if (minutes < 60) return 'same room · ' + String(minutes) + 'm' + direction
    const hours = Math.round(minutes / 60)
    if (hours < 48) return 'same room · ' + String(hours) + 'h' + direction
    return 'same room · ' + String(Math.round(hours / 24)) + 'd' + direction
  }

  // A handle earns a button when any public source can resolve it. The complete
  // directory deliberately knows more names than the bounded presence page.
  function residentNode(handle, className, focusKey) {
    const known = state.snapshot && residentReference(state.snapshot, handle)
    if (!known) return element('span', className, handle)
    const follow = element('button', className + ' resident-follow-inline', handle)
    follow.type = 'button'
    follow.dataset.focusKey = focusKey
    follow.title = 'Follow ' + handle
    follow.addEventListener('click', () => chooseResident(handle))
    const reference = element('span', 'resident-reference')
    reference.append(portraitNode('resident', known.id, handle, known.has_drawing), follow)
    return reference
  }

  function openDetailLink(kind, id, label, className) {
    const link = element('a', className || 'detail-link', label)
    link.href = '/window/' + kind + '/' + String(id)
    link.addEventListener('click', event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
      event.preventDefault()
      navigate({ detail: Object.freeze({ kind, id }) })
    })
    return link
  }

  function openDrawingDetailButton(kind, id, label, className) {
    const button = element('button', className || 'drawing-detail-open', 'Current drawing')
    button.type = 'button'
    button.dataset.focusKey = 'drawing-detail:' + kind + ':' + String(id)
    button.setAttribute('aria-label', 'Open current drawing for ' + label)
    button.addEventListener('click', () => navigate({ detail: Object.freeze({ kind, id }) }))
    return button
  }

  function normalizeDetailRecord(kind, id, payload) {
    const raw = payload && typeof payload === 'object'
      ? kind === 'place' ? payload.place || payload.tombstone : payload[kind]
      : null
    if (!raw || typeof raw !== 'object' || safeId(raw.id) !== id) return null
    if (kind === 'place') {
      const description = raw.moderated === true
        ? MODERATED_TEXT
        : safeExactText(raw.description, null, 8000, true)
      return description !== null && Array.from(description).length <= 4000
        ? Object.freeze({ kind, id, description })
        : null
    }
    const placeId = safeId(raw.place_id)
    const body = safeText(raw.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
    if (!placeId || body === null) return null
    if (kind === 'note') {
      const author = safeHandle(raw.author)
      const createdAt = safeDate(raw.created_at)
      return author && createdAt ? Object.freeze({
        kind, id, placeId, author, body, createdAt, moderated: raw.moderated === true,
      }) : null
    }
    const name = safeText(raw.name, '', 120, false)
    const madeBy = safeHandle(raw.made_by)
    const currentOwner = safeHandle(raw.current_owner)
    return name && madeBy && currentOwner ? Object.freeze({
      kind, id, placeId, name, madeBy, currentOwner, body,
      moderated: raw.moderated === true,
      has_drawing: raw.has_drawing === true,
    }) : null
  }

  async function loadDrawingHistory(type, id, before = null, append = false) {
    if (!['place', 'resident', 'thing'].includes(type) ||
        state.detail?.kind !== type || state.detail.id !== id) return
    const key = detailDrawingKey(type, id)
    const current = state.detailDrawingHistories[key] || Object.freeze({
      expanded: true, initialized: false, loading: false, error: false,
      revisions: Object.freeze([]), hasMore: false, nextBefore: null,
      failedBefore: null, failedAppend: false,
    })
    if (current.loading) return
    const requestAuthoredRevision = authoredRevision
    const requestRevision = ++detailDrawingHistoryRequestRevision
    const requestIsCurrent = () => authoredRevision === requestAuthoredRevision &&
      detailDrawingHistoryRequestRevision === requestRevision &&
      state.detail?.kind === type && state.detail?.id === id
    state = {
      ...state,
      detailDrawingHistories: {
        ...state.detailDrawingHistories,
        [key]: Object.freeze({
          ...current, expanded: true, loading: true, error: false,
          failedBefore: null, failedAppend: false,
        }),
      },
    }
    renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id) + '/history',
        window.location.origin)
      url.searchParams.set('limit', '20')
      if (before) url.searchParams.set('before', String(before))
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (!response.ok) throw new Error('drawing history unavailable')
      const page = normalizeDrawingHistory(type, id, await response.json())
      if (!page) throw new Error('invalid drawing history')
      if (!requestIsCurrent()) return
      const previousRows = append ? current.revisions : []
      const rowsById = new Map(previousRows.map(revision => [revision.id, revision]))
      for (const revision of page.revisions) rowsById.set(revision.id, revision)
      const revisions = Object.freeze([...rowsById.values()]
        .sort((left, right) => right.id - left.id))
      state = {
        ...state,
        detailDrawingHistories: {
          ...state.detailDrawingHistories,
          [key]: Object.freeze({
            expanded: true, initialized: true, loading: false, error: false,
            revisions, hasMore: page.hasMore, nextBefore: page.nextBefore,
            failedBefore: null, failedAppend: false,
          }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawingHistories: {
          ...state.detailDrawingHistories,
          [key]: Object.freeze({
            ...current, expanded: true, loading: false, error: true,
            failedBefore: before, failedAppend: append,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestIsCurrent()) renderDetail()
    }
  }

  async function ensureDetail(force, placeId = null) {
    const target = placeId ? Object.freeze({ kind: 'place', id: placeId }) : state.detail
    if (!target || (target.kind === 'place' && !placeId) || target.kind === 'resident') return
    const key = target.kind + ':' + String(target.id)
    const current = state.details[key]
    if (current?.loading || (!force && (current?.record || current?.notFound ||
        (placeId && current?.error)))) return
    const requestAuthoredRevision = authoredRevision
    const requestDetailRevision = placeId ? null : ++detailRequestRevision
    const pending = Object.freeze({ loading: true, error: false, notFound: false, record: null })
    const requestIsCurrent = () => (
      authoredRevision === requestAuthoredRevision &&
      (placeId ? state.details[key] === pending : (
        detailRequestRevision === requestDetailRevision &&
        state.detail?.kind === target.kind &&
        state.detail?.id === target.id
      ))
    )
    state = {
      ...state,
      details: {
        ...state.details,
        [key]: pending,
      },
    }
    if (placeId) renderAll()
    else renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + target.kind + '/' + String(target.id), window.location.origin)
      if (placeId) {
        url.searchParams.set('view', 'outline')
        url.searchParams.set('limit', '1')
      }
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (response.status === 404) {
        state = {
          ...state,
          details: {
            ...state.details,
            [key]: Object.freeze({ loading: false, error: false, notFound: true, record: null }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('public detail unavailable')
      const record = normalizeDetailRecord(target.kind, target.id, await response.json())
      if (!requestIsCurrent()) return
      if (!record) throw new Error('invalid public detail')
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: false, notFound: false, record }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        details: {
          ...state.details,
          [key]: Object.freeze({ loading: false, error: true, notFound: false, record: null }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (placeId) {
        if (authoredRevision === requestAuthoredRevision) renderAll()
      } else if (requestIsCurrent()) renderDetail()
    }
  }

  function detailDrawingKey(type, id) {
    return type + ':' + String(id)
  }

  async function ensureDetailDrawing(type, id, force = false) {
    if (!['place', 'resident', 'thing'].includes(type) ||
        state.detail?.kind !== type || state.detail.id !== id) return
    const key = detailDrawingKey(type, id)
    const current = state.detailDrawings[key]
    if (current?.loading || (!force && (current?.drawing || current?.unavailable))) return
    const requestAuthoredRevision = authoredRevision
    const requestRevision = ++detailDrawingRequestRevision
    const requestIsCurrent = () => authoredRevision === requestAuthoredRevision &&
      detailDrawingRequestRevision === requestRevision &&
      state.detail?.kind === type && state.detail?.id === id
    state = {
      ...state,
      detailDrawings: {
        ...state.detailDrawings,
        [key]: Object.freeze({ loading: true, error: false, unavailable: false, drawing: null }),
      },
    }
    renderDetail()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/drawing/' + type + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit', headers: { Accept: 'application/json' }, mode: 'same-origin',
        redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
      })
      if (!requestIsCurrent()) return
      if (response.status === 404) {
        state = {
          ...state,
          detailDrawings: {
            ...state.detailDrawings,
            [key]: Object.freeze({
              loading: false, error: false, unavailable: true, drawing: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('drawing unavailable')
      const drawing = normalizeDrawingRead(type, id, await response.json())
      if (!drawing) throw new Error('invalid drawing')
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawings: {
          ...state.detailDrawings,
          [key]: Object.freeze({
            loading: false, error: false, unavailable: false, drawing,
          }),
        },
      }
    } catch {
      if (!requestIsCurrent()) return
      state = {
        ...state,
        detailDrawings: {
          ...state.detailDrawings,
          [key]: Object.freeze({ loading: false, error: true, unavailable: false, drawing: null }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (requestIsCurrent()) renderDetail()
    }
  }

  function drawingExactReadback(snapshot) {
    if (!snapshot.drawing) return null
    const exact = element('section', 'drawing-exact-readback')
    exact.append(element('h4', '', 'Exact drawing readback'))
    const palette = element('p', 'drawing-exact-line')
    palette.append(document.createTextNode('Palette · '))
    const paletteValue = element('code', '', snapshot.drawing.palette.join(' '))
    paletteValue.dataset.drawingPalette = 'true'
    palette.append(paletteValue)
    const indices = element('p', 'drawing-exact-line')
    indices.append(document.createTextNode('64 indices · '))
    const indexValue = element('code', '', JSON.stringify(snapshot.drawing.indices))
    indexValue.dataset.drawingIndices = 'true'
    indices.append(indexValue)
    const rowsTitle = element('p', 'drawing-exact-line', 'Canonical eight rows')
    const rows = element('ol', 'drawing-canonical-rows')
    for (const row of snapshot.rows) {
      const item = document.createElement('li')
      const code = element('code', '', row)
      code.dataset.drawingRow = 'true'
      item.append(code)
      rows.append(item)
    }
    exact.append(palette, indices, rowsTitle, rows)
    return exact
  }

  function drawingSnapshotNode(snapshot, title, compact = false, descriptionId = null) {
    const section = element('section', compact ? 'drawing-snapshot drawing-snapshot-compact' :
      'drawing-snapshot')
    if (title) section.append(element('h4', '', title))
    const stateLabel = windowDrawingStateLabel(snapshot.state, snapshot.drawing)
    section.append(element('p', 'drawing-state-label', stateLabel))
    const sourceLabel = windowDrawingSourceLabel(snapshot)
    if (sourceLabel) section.append(element('p', 'drawing-provenance', sourceLabel))
    let descriptionNode = null
    if (snapshot.description !== null) {
      descriptionNode = element('p', 'drawing-owner-description', snapshot.description)
      if (descriptionId) descriptionNode.id = descriptionId
      section.append(descriptionNode)
    }
    if (snapshot.drawing) {
      const canvas = paintedDrawingNode(snapshot.drawing, 1, 1)
      if (canvas) {
        canvas.classList.add('drawing-detail-canvas')
        canvas.setAttribute('role', 'img')
        canvas.setAttribute('aria-label', stateLabel + (sourceLabel ? ' · ' + sourceLabel : ''))
        if (descriptionNode?.id) canvas.setAttribute('aria-describedby', descriptionNode.id)
        applyDrawingData(canvas, snapshot)
        section.append(canvas)
      }
    } else {
      section.append(element('p', 'drawing-no-pixels',
        snapshot.state === 'refused' ? 'The owner explicitly refused to draw.' :
          'No owner-authored pixels are set.'))
    }
    const exact = drawingExactReadback(snapshot)
    if (exact) section.append(exact)
    return section
  }

  function drawingHistoryNode(type, id, history) {
    const historyNode = element('section', 'drawing-history')
    historyNode.id = 'drawing-history-' + type + '-' + String(id)
    historyNode.setAttribute('aria-live', 'polite')
    historyNode.append(element('h4', '', 'Drawing history'))
    if (history.loading) {
      historyNode.append(element('p', 'loading-row', history.revisions.length
        ? 'Reading earlier drawing revisions…'
        : 'Reading drawing history…'))
    } else if (history.error) {
      historyNode.append(element('p', 'error-row', 'Drawing history could not be read.'))
      const retry = element('button', 'drawing-history-control', 'Retry drawing history')
      retry.type = 'button'
      retry.dataset.focusKey = 'drawing-history-retry'
      retry.addEventListener('click', () => void loadDrawingHistory(
        type, id, history.failedBefore, history.failedAppend))
      historyNode.append(retry)
    }
    for (const revision of history.revisions) {
      const row = element('article', 'drawing-history-revision')
      const when = new Date(revision.created_at).toLocaleString()
      row.append(element('h5', '', 'Revision #' + String(revision.id)))
      row.append(element('p', 'drawing-history-meta',
        'by ' + (revision.author.handle || revision.author.relation) + ' · ' +
        revision.author.relation + ' · ' + when +
        (revision.slot_variant_name ? ' · slot ' + revision.slot_variant_name : '')))
      row.append(
        drawingSnapshotNode(
          revision.previous,
          'Before',
          true,
          'drawing-description-' + type + '-' + String(id) + '-revision-' + String(revision.id) + '-before',
        ),
        drawingSnapshotNode(
          revision.current,
          'After',
          true,
          'drawing-description-' + type + '-' + String(id) + '-revision-' + String(revision.id) + '-after',
        ),
      )
      historyNode.append(row)
    }
    if (!history.loading && !history.error && history.initialized && !history.revisions.length) {
      historyNode.append(element('p', 'empty-row', 'No drawing changes have been recorded yet.'))
    }
    if (!history.loading && !history.error && history.hasMore && history.nextBefore) {
      const earlier = element('button', 'drawing-history-control', 'Load earlier drawing revisions')
      earlier.type = 'button'
      earlier.dataset.focusKey = 'drawing-history-earlier'
      earlier.addEventListener('click', () => void loadDrawingHistory(
        type, id, history.nextBefore, true))
      historyNode.append(earlier)
    }
    return historyNode
  }

  function drawingDetailNode(type, id, label) {
    const key = detailDrawingKey(type, id)
    const entry = state.detailDrawings[key]
    const section = element('section', 'drawing-detail')
    section.setAttribute('aria-label', label + ' drawing details')
    section.append(element('h3', '', 'Owner drawing'))
    if (!entry || entry.loading) {
      section.append(element('p', 'loading-row', 'Reading the current drawing…'))
      if (!entry) window.queueMicrotask(() => void ensureDetailDrawing(type, id))
      return section
    }
    if (entry.unavailable) {
      section.append(element('p', 'drawing-unavailable', 'Drawing unavailable'))
      return section
    }
    if (entry.error || !entry.drawing) {
      section.append(element('p', 'error-row', 'The current drawing could not be read.'))
      const retry = element('button', 'drawing-history-control', 'Retry current drawing')
      retry.type = 'button'
      retry.dataset.focusKey = 'drawing-current-retry'
      retry.addEventListener('click', () => void ensureDetailDrawing(type, id, true))
      section.append(retry)
      return section
    }
    section.append(drawingSnapshotNode(
      entry.drawing,
      '',
      false,
      'drawing-description-' + type + '-' + String(id) + '-current',
    ))
    const history = state.detailDrawingHistories[key] || null
    const expanded = history?.expanded === true
    const toggle = element('button', 'drawing-history-control', expanded
      ? 'Hide drawing history'
      : 'Show drawing history')
    toggle.type = 'button'
    toggle.dataset.focusKey = 'drawing-history-toggle'
    toggle.setAttribute('aria-expanded', String(expanded))
    toggle.setAttribute('aria-controls', 'drawing-history-' + type + '-' + String(id))
    toggle.addEventListener('click', () => {
      const held = state.detailDrawingHistories[key]
      if (held?.expanded) {
        state = {
          ...state,
          detailDrawingHistories: {
            ...state.detailDrawingHistories,
            [key]: Object.freeze({ ...held, expanded: false }),
          },
        }
        renderDetail()
        return
      }
      const next = held
        ? Object.freeze({ ...held, expanded: true })
        : Object.freeze({
            expanded: true, initialized: false, loading: false, error: false,
            revisions: Object.freeze([]), hasMore: false, nextBefore: null,
            failedBefore: null, failedAppend: false,
          })
      state = {
        ...state,
        detailDrawingHistories: { ...state.detailDrawingHistories, [key]: next },
      }
      renderDetail()
      if (!next.initialized && !next.loading) void loadDrawingHistory(type, id)
    })
    section.append(toggle)
    if (expanded && history) section.append(drawingHistoryNode(type, id, history))
    return section
  }

  function currentDrawingDetailSubject(target) {
    if (!state.snapshot || !target) return null
    if (target.kind === 'place') {
      const place = placeReference(state.snapshot, target.id) ||
        state.snapshot.flatPlaces.find(candidate => candidate.id === target.id)
      if (!place) return null
      return Object.freeze({
        title: place.name,
        meta: place.path + (place.owner
          ? ' · kept by ' + place.owner
          : ' · nobody owns it · transit only'),
      })
    }
    if (target.kind === 'resident') {
      const resident = displayedResidents(state.snapshot).find(candidate => candidate.id === target.id) ||
        Object.values(state.focusedResidents)
          .map(entry => entry?.resident || null)
          .find(candidate => candidate?.id === target.id) ||
        null
      if (!resident) return null
      const location = windowPlaceLabel(
        resident.current_place_id,
        resident.current_place_id ? placeReference(state.snapshot, resident.current_place_id) : null,
      )
      return Object.freeze({
        title: resident.handle,
        meta: 'resident #' + String(resident.id) +
          (resident.asleep ? ' · asleep' : '') +
          (location ? ' · at ' + location : ' · between places'),
      })
    }
    return null
  }

  function renderDetail() {
    const previousFocusKey = nodes.detailBody?.contains(document.activeElement)
      ? document.activeElement?.dataset?.focusKey || null
      : null
    const target = state.detail
    if (detailShareButton) {
      const shareLabel = target?.kind === 'place' ? 'Share this place' : 'Share this detail'
      detailShareButton.hidden = !target || target.kind === 'resident'
      if (detailShareButton.dataset.shareLabel !== shareLabel) {
        detailShareButton.dataset.shareLabel = shareLabel
        detailShareButton.textContent = shareLabel
      }
    }
    if (!nodes.detail) return
    if (!target) {
      if (nodes.detail.open) nodes.detail.close()
      return
    }
    if (target.kind === 'place' || target.kind === 'resident') {
      const subject = currentDrawingDetailSubject(target)
      if (nodes.detailKind) nodes.detailKind.textContent = target.kind === 'place'
        ? 'Public place · live current drawing'
        : 'Public resident · live current drawing'
      if (nodes.detailTitle) nodes.detailTitle.textContent = subject?.title || (
        target.kind === 'place' ? 'Place #' + String(target.id) : 'Resident #' + String(target.id)
      )
      if (nodes.detailBody) {
        if (!subject) {
          nodes.detailBody.replaceChildren(element(
            'p',
            'empty-row',
            'This public ' + target.kind + ' is not available now.',
          ))
        } else {
          nodes.detailBody.replaceChildren(
            element('p', 'record-detail-meta', subject.meta),
            drawingDetailNode(target.kind, target.id, subject.title),
          )
        }
      }
      if (!nodes.detail.open) nodes.detail.showModal()
      if (previousFocusKey) {
        window.queueMicrotask(() => nodes.detailBody?.querySelector(
          '[data-focus-key="' + CSS.escape(previousFocusKey) + '"]')?.focus())
      }
      return
    }
    const key = target.kind + ':' + String(target.id)
    const entry = state.details[key]
    if (nodes.detailKind) nodes.detailKind.textContent = target.kind === 'thing'
      ? 'Public thing · live current record'
      : 'Public note · live current record'
    if (nodes.detailTitle) {
      if (target.kind === 'thing') {
        const title = entry?.record?.name || 'Thing #' + String(target.id)
        nodes.detailTitle.replaceChildren(
          portraitNode('thing', target.id, title, entry?.record?.has_drawing === true),
          document.createTextNode(title),
        )
      } else {
        nodes.detailTitle.textContent = 'Public note #' + String(target.id)
      }
    }
    if (nodes.detailBody) {
      if (!entry || entry.loading) {
        nodes.detailBody.replaceChildren(element('p', 'loading-row', 'Reading the live public record…'))
      } else if (entry.notFound) {
        nodes.detailBody.replaceChildren(element(
          'p', 'empty-row', 'This public ' + target.kind + ' is not available now.',
        ))
      } else if (entry.error || !entry.record) {
        const message = element('p', 'error-row', 'This public detail could not be read.')
        const retry = element('button', 'detail-retry', 'Retry reading this detail')
        retry.type = 'button'
        retry.addEventListener('click', () => void ensureDetail(true))
        nodes.detailBody.replaceChildren(message, retry)
      } else {
        const record = entry.record
        const meta = record.kind === 'thing'
          ? 'made by ' + record.madeBy + ' · currently owned by ' + record.currentOwner +
            ' · place #' + String(record.placeId)
          : 'by ' + record.author + ' · place #' + String(record.placeId) + ' · ' +
            new Date(record.createdAt).toLocaleString()
        const body = element('p', 'record-detail-text public-body', record.body)
        nodes.detailBody.replaceChildren(element('p', 'record-detail-meta', meta), body)
        if (record.kind === 'thing') {
          nodes.detailBody.append(drawingDetailNode('thing', record.id, record.name))
        }
        if (record.moderated) {
          nodes.detailBody.append(element(
            'p', 'moderated-mark', 'Maintainer removal is shown as a current tombstone.',
          ))
        }
      }
    }
    if (!nodes.detail.open) nodes.detail.showModal()
    if (previousFocusKey) {
      window.queueMicrotask(() => nodes.detailBody?.querySelector(
        '[data-focus-key="' + CSS.escape(previousFocusKey) + '"]')?.focus())
    }
  }

  async function loadFullBody(kind, id) {
    if (kind !== 'note' && kind !== 'thing') return
    const bodyKey = kind + ':' + String(id)
    const current = state.fullBodies[bodyKey] || Object.freeze({
      body: null, loading: false, error: false,
    })
    if (current.loading || current.body !== null) return
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      fullBodies: {
        ...state.fullBodies,
        [bodyKey]: Object.freeze({ ...current, loading: true, error: false }),
      },
    }
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/' + kind + '/' + String(id), window.location.origin)
      const response = await fetch(url.pathname, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('complete public body unavailable')
      const payload = await response.json()
      const record = payload && typeof payload === 'object' ? payload[kind] : null
      const recordId = record && typeof record === 'object' ? safeId(record.id) : null
      const fullBody = record && typeof record === 'object'
        ? safeText(record.body, null, kind === 'note' ? 4000 : 65536, kind === 'thing')
        : null
      if (recordId !== id || fullBody === null) throw new Error('invalid complete public body')
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        expandedBodies: state.expandedBodies.includes(bodyKey)
          ? state.expandedBodies
          : [...state.expandedBodies, bodyKey],
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: fullBody, loading: false, error: false }),
        },
      }
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      state = {
        ...state,
        fullBodies: {
          ...state.fullBodies,
          [bodyKey]: Object.freeze({ body: null, loading: false, error: true }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  function bodyDisclosureLabel(kind, truncated, expanded, hasFullBody, fullEntry) {
    const canComplete = truncated && !hasFullBody && (kind === 'note' || kind === 'thing')
    if (canComplete && expanded) {
      if (fullEntry?.loading) return 'Loading the whole ' + kind + '…'
      if (fullEntry?.error) return 'Retry reading the whole ' + kind
      return 'Read the whole ' + kind
    }
    return expanded ? 'Show less' : 'Show more'
  }

  function renderExpandableBody(kind, id, body, truncated) {
    const block = element('div', 'body-block')
    const bodyKey = kind + ':' + String(id)
    const fullEntry = state.fullBodies[bodyKey] || null
    const hasFullBody = typeof fullEntry?.body === 'string'
    const bodyNode = element('p', kind + '-body public-body',
      hasFullBody ? fullEntry.body : body + (truncated ? '…' : ''))
    const bodyId = 'public-body-' + kind + '-' + String(id) + '-' + String(++bodyIdSequence)
    const startExpanded = state.expandedBodies.includes(bodyKey)
    bodyNode.id = bodyId
    bodyNode.dataset.expanded = String(startExpanded)
    bodyNode.dataset.bodyKey = bodyKey
    bodyNode.dataset.bodyKind = kind
    bodyNode.dataset.truncated = String(truncated)
    block.append(bodyNode)

    let availability = null
    if (truncated && !hasFullBody) {
      // The bounded view caps every body: Excerpt only — this bounded view carries only the first part.
      // "Show more" first reveals that excerpt. The existing single-record endpoint is then one deliberate,
      // anonymous read whose result survives re-rendering in this browser session.
      availability = element('p', 'body-availability')
      const availabilityText = fullEntry?.loading
        ? 'Loading the complete public ' + kind + '… '
        : fullEntry?.error
          ? 'The complete public ' + kind + ' could not be read. '
          : 'Excerpt only — the full text is not included in this bounded view. '
      availability.append(document.createTextNode(availabilityText))
      if (kind === 'agreement') {
        availability.append(document.createTextNode(
          'The full text is not served through the glass.'))
      }
      availability.id = bodyId + '-availability'
      block.append(availability)
    }

    // The browser decides whether the five-line clamp actually hides text.
    // Keep the control hidden until the connected element can be measured.
    const disclosure = element('button', truncated && (kind === 'note' || kind === 'thing')
      ? 'body-disclosure body-full-link'
      : 'body-disclosure',
      bodyDisclosureLabel(kind, truncated, startExpanded, hasFullBody, fullEntry))
    disclosure.type = 'button'
    disclosure.hidden = true
    disclosure.setAttribute('aria-expanded', String(startExpanded))
    disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
    disclosure.setAttribute('aria-controls', bodyId)
    disclosure.dataset.focusKey = 'body:' + bodyKey
    if (availability) disclosure.setAttribute('aria-describedby', availability.id)
    disclosure.addEventListener('click', () => {
      const expanded = state.expandedBodies.includes(bodyKey)
      const canComplete = truncated && !hasFullBody &&
        (kind === 'note' || kind === 'thing') && expanded
      if (canComplete) {
        void loadFullBody(kind, id)
        return
      }
      const nextExpanded = !expanded
      state = {
        ...state,
        expandedBodies: nextExpanded
          ? [...state.expandedBodies, bodyKey]
          : state.expandedBodies.filter(key => key !== bodyKey),
      }
      bodyNode.dataset.expanded = String(nextExpanded)
      disclosure.setAttribute('aria-expanded', String(nextExpanded))
      disclosure.textContent = bodyDisclosureLabel(
        kind, truncated, nextExpanded, hasFullBody, fullEntry)
    })
    block.append(disclosure)
    return block
  }

  function syncBodyDisclosures() {
    const entries = []
    for (const block of document.querySelectorAll('.body-block')) {
      if (block.closest('[hidden]')) continue
      const bodyNode = block.querySelector('.public-body')
      const disclosure = block.querySelector('.body-disclosure')
      const bodyKey = bodyNode?.dataset.bodyKey
      const kind = bodyNode?.dataset.bodyKind
      if (!bodyNode || !disclosure || !bodyKey || !kind) continue
      bodyNode.dataset.expanded = 'false'
      entries.push({
        bodyNode,
        disclosure,
        bodyKey,
        kind,
        truncated: bodyNode.dataset.truncated === 'true',
      })
    }

    const collapsedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)
    for (const entry of entries) entry.bodyNode.dataset.expanded = 'true'
    const expandedHeights = entries.map(entry => entry.bodyNode.getBoundingClientRect().height)

    entries.forEach((entry, index) => {
      const collapsible = expandedHeights[index] > collapsedHeights[index] + 1
      const fullEntry = state.fullBodies[entry.bodyKey] || null
      const hasFullBody = typeof fullEntry?.body === 'string'
      const requiresCompletion = entry.truncated && !hasFullBody &&
        (entry.kind === 'note' || entry.kind === 'thing')
      const expanded = (collapsible || requiresCompletion) &&
        state.expandedBodies.includes(entry.bodyKey)
      entry.bodyNode.dataset.expanded = String(!collapsible || expanded)
      entry.disclosure.hidden = !collapsible && !requiresCompletion
      entry.disclosure.setAttribute('aria-expanded', String(expanded))
      entry.disclosure.setAttribute('aria-busy', String(fullEntry?.loading === true))
      entry.disclosure.textContent = bodyDisclosureLabel(
        entry.kind, entry.truncated, expanded, hasFullBody, fullEntry)
    })
  }

  let bodyDisclosureFrame = 0
  function scheduleBodyDisclosureSync() {
    if (bodyDisclosureFrame) return
    bodyDisclosureFrame = window.requestAnimationFrame(() => {
      bodyDisclosureFrame = 0
      syncBodyDisclosures()
    })
  }

  function renderThings(target, things, placeOf) {
    if (!target) return
    if (!things.length) {
      renderEmpty(target, 'empty-row', 'No public thing matches this selection.')
      return
    }
    const list = element('ul', 'thing-list')
    list.append(...things.map(thing => {
      const item = element('li', 'thing-card')
      const thingMeta = element('p', 'thing-meta')
      thingMeta.append(document.createTextNode('made by '))
      thingMeta.append(thing.made_by
        ? residentNode(thing.made_by, 'thing-maker', 'thing-maker:' + String(thing.id))
        : document.createTextNode('maker unavailable'))
      thingMeta.append(
        document.createTextNode(' · currently owned by '),
        residentNode(thing.current_owner, 'thing-owner', 'thing-owner:' + String(thing.id)),
      )
      if (thing.kind) {
        thingMeta.append(document.createTextNode(' · kind: '))
        if (thing.kind_id) {
          thingMeta.append(portraitNode('kind', thing.kind_id, thing.kind, true, 'kind-portrait'))
        }
        thingMeta.append(document.createTextNode(thing.kind))
      } else {
        thingMeta.append(document.createTextNode(' · one of a kind'))
      }
      thingMeta.append(document.createTextNode(
        thing.open_to_use ? ' · open to shared use' : ' · owner use only'))
      const location = windowPlaceLabel(
        thing.place_id,
        placeOf ? placeOf(thing.place_id) : null,
      )
      if (location) {
        thingMeta.append(
          document.createTextNode(' · at '),
          element('span', 'thing-location', location),
        )
      }
      const heading = element('h4', '')
      heading.append(
        portraitNode('thing', thing.id, thing.name, thing.has_drawing),
        openDetailLink('thing', thing.id, thing.name, 'detail-link thing-detail-link'),
      )
      item.append(heading, thingMeta)
      if (thing.body) item.append(renderExpandableBody('thing', thing.id, thing.body, thing.truncated))
      const traits = element('div', 'trait-list')
      if (thing.traits.length) {
        traits.append(...thing.traits.map(trait => {
          const chip = element('span', 'trait-chip', trait)
          chip.dataset.moderated = String(trait === MODERATED_TEXT)
          return chip
        }))
      } else {
        traits.append(element('span', 'thing-meta', 'no public traits'))
      }
      item.append(traits)
      if (thing.moderated || thing.kind_moderated) {
        item.append(element('span', 'moderated-mark', 'Maintainer removal shown as a tombstone'))
      }
      return item
    }))
    target.replaceChildren(list)
  }

  function noteCard(note, place) {
    const card = element('article', 'note-card')
    const meta = element('p', 'note-meta')
    meta.append(
      residentNode(note.author, 'note-author', 'note-author:' + String(note.id)),
      document.createTextNode(' · '),
      timeNode(note.created_at, ''),
    )
    const location = windowPlaceLabel(note.place_id, place)
    if (location) {
      meta.append(
        document.createTextNode(' · '),
        element('span', 'note-location', location),
      )
    }
    meta.append(
      document.createTextNode(' · '),
      openDetailLink(
        'note', note.id, 'Open note #' + String(note.id), 'detail-link note-detail-link',
      ),
    )
    card.append(meta, renderExpandableBody('note', note.id, note.body, note.truncated))
    if (note.moderated) card.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
    return card
  }

  function renderNotes(target, notes, emptyMessage, placeOf) {
    if (!target) return
    if (!notes.length) {
      renderEmpty(target, 'empty-row', emptyMessage)
      return
    }
    const list = element('div', 'note-list')
    list.append(...notes.map(note => noteCard(
      note,
      typeof placeOf === 'function' ? placeOf(note.place_id) : placeOf,
    )))
    target.replaceChildren(list)
  }

  function renderHistoryOutcome(target, entry, messages, itemTag) {
    if (!target || entry.rows.length) return false
    const waiting = entry.loading || entry.refreshing ||
      (!entry.initialized && !entry.error && !entry.refreshError)
    const failed = entry.error || entry.refreshError
    const message = waiting
      ? messages.loading
      : failed
        ? messages.failure
        : messages.empty
    const className = failed ? 'error-row' : waiting ? 'loading-row' : 'empty-row'
    target.replaceChildren(element(itemTag || 'p', className, message))
    return true
  }

  function hideHistoryControl(target) {
    if (!target) return
    target.hidden = true
    target.replaceChildren()
  }

  function renderOccupants(snapshot, place) {
    const occupants = residentsAt(snapshot, place.id)
    const completePresence = displayedResidents(snapshot).length >= snapshot.totals.residents
    if (occupants.length) {
      renderPeople(nodes.occupants, occupants,
        placeId => placeReference(snapshot, placeId))
    } else {
      renderEmpty(nodes.occupants, 'empty-row', completePresence
        ? 'No public resident is standing inside this place.'
        : 'No resident from the bounded presence view is shown inside this place.')
    }
    if (!completePresence && nodes.occupants) {
      nodes.occupants.append(element('p', 'presence-boundary',
        'Other occupants may be omitted: no narrow place-specific presence read exists yet.'))
    }
  }

  function renderPlaceOrientation(place) {
    if (nodes.placePurposeLabel) nodes.placePurposeLabel.textContent = 'Owner-written purpose'
    if (nodes.placeFrontMatterLabel) {
      nodes.placeFrontMatterLabel.textContent = 'Owner-chosen front matter'
    }
    if (!place) {
      renderEmpty(nodes.placeDescription, 'empty-row', 'No loaded place description is available.')
      renderEmpty(nodes.placePurpose, 'empty-row', 'No loaded place purpose is available.')
      renderEmpty(nodes.placeFrontMatter, 'empty-row', 'No loaded front matter is available.')
      return
    }
    const description = state.details['place:' + String(place.id)]
    if (place.moderated) {
      renderEmpty(nodes.placeDescription, 'place-description-text', MODERATED_TEXT)
    } else if (!description || description.loading) {
      renderEmpty(nodes.placeDescription, 'loading-row', 'Reading the owner-written description…')
      if (!description) window.queueMicrotask(() => void ensureDetail(false, place.id))
    } else if (description.notFound) {
      renderEmpty(nodes.placeDescription, 'empty-row', 'This public place is not available now.')
    } else if (description.error || !description.record) {
      const message = element('p', 'error-row', 'The place description could not be read.')
      const retry = element('button', 'detail-retry', 'Retry reading this description')
      retry.type = 'button'
      retry.dataset.focusKey = 'place-description-retry:' + String(place.id)
      retry.dataset.focusFallbackId = 'place-description-title'
      retry.addEventListener('click', () => void ensureDetail(true, place.id))
      nodes.placeDescription?.replaceChildren(message, retry)
    } else {
      renderEmpty(nodes.placeDescription,
        description.record.description ? 'place-description-text' : 'empty-row',
        description.record.description || 'No owner-written description is set for this place.')
    }
    if (nodes.placePurpose) {
      nodes.placePurpose.replaceChildren(element(
        'p',
        place.purpose ? 'place-purpose-text' : 'empty-row',
        place.purpose || 'No owner-written purpose is set for this place.',
      ))
    }
    if (!nodes.placeFrontMatter) return
    if (!place.front_matter.length) {
      renderEmpty(
        nodes.placeFrontMatter,
        'empty-row',
        'No owner-chosen front matter is available.',
      )
      return
    }
    const list = element('ol', 'front-matter-list')
    list.setAttribute('aria-labelledby', 'place-front-matter-title')
    list.append(...place.front_matter.map(heading => {
      const item = element('li', 'front-matter-heading')
      const link = openDetailLink(
        'thing', heading.id, heading.name, 'front-matter-link detail-link',
      )
      const meta = element('p', 'front-matter-meta thing-meta')
      meta.append(
        document.createTextNode('made by '),
        residentNode(heading.made_by, 'thing-maker', 'front-matter-maker:' + String(heading.id)),
        document.createTextNode(' · currently owned by '),
        residentNode(
          heading.current_owner,
          'thing-owner',
          'front-matter-owner:' + String(heading.id),
        ),
        document.createTextNode(' · ' + String(heading.body_text_bytes) + ' UTF-8 bytes'),
      )
      const title = element('span', 'front-matter-title')
      title.append(portraitNode('thing', heading.id, heading.name, heading.has_drawing), link)
      item.append(title, meta)
      return item
    }))
    nodes.placeFrontMatter.replaceChildren(list)
  }

  function renderPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const place = selectedPlace(snapshot) ||
      (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
    if (!place) {
      const issue = selectionIssue(snapshot, true)
      if (issue) {
        const issueTitle = issue.status === 'not-found'
          ? issue.kind === 'resident' ? 'No public resident was found' : 'No public place was found'
          : issue.status === 'error'
            ? issue.kind === 'resident' ? 'Public resident could not be loaded' : 'Public place could not be loaded'
            : issue.kind === 'resident' ? 'Loading public resident…' : 'Loading public place…'
        if (nodes.placeTitle) nodes.placeTitle.textContent = issueTitle
        if (nodes.placeSummary) nodes.placeSummary.textContent = issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? issueTitle + '. Use Retry to try the focused read again.'
            : issueTitle + ' The requested content will follow that focused read.'
        if (nodes.placePurpose) {
          renderSelectionIssue(nodes.placePurpose, issue, null, 'place-focus-title')
        }
        renderEmpty(nodes.placeDescription, issue.status === 'error' ? 'error-row' :
          issue.status === 'not-found' ? 'empty-row' : 'loading-row',
        issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? 'The description is unavailable until the focused read succeeds.'
            : 'Waiting for the focused read before reading the description…')
        renderEmpty(nodes.placeFrontMatter, issue.status === 'error' ? 'error-row' :
          issue.status === 'not-found' ? 'empty-row' : 'loading-row',
        issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? 'Front matter is unavailable until the focused read succeeds.'
            : 'Loading public front matter…')
        for (const target of [nodes.occupants, nodes.placeThings, nodes.placeConversation]) {
          renderEmpty(target, issue.status === 'error' ? 'error-row' :
            issue.status === 'not-found' ? 'empty-row' : 'loading-row',
          issue.status === 'not-found'
            ? issueTitle + ' for this selection.'
            : issue.status === 'error'
              ? 'This section is unavailable until the focused read succeeds.'
              : 'Waiting for the focused read…')
        }
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (followed?.current_place_id === null) {
        if (nodes.placeTitle) nodes.placeTitle.textContent = followed.handle + ' is between places'
        if (nodes.placeSummary) {
          nodes.placeSummary.textContent = 'This resident is not currently standing in a public place.'
        }
        renderPlaceOrientation(null)
        renderEmpty(nodes.occupants, 'empty-row', 'There is no doorway around this resident right now.')
        renderEmpty(nodes.placeThings, 'empty-row', 'No current public place is available for visible things.')
        renderEmpty(nodes.placeConversation, 'empty-row', 'No current public place is available for conversation.')
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (nodes.placeTitle) nodes.placeTitle.textContent = 'No public place is selected'
      if (nodes.placeSummary) nodes.placeSummary.textContent = 'Choose a public place to inspect it.'
      renderPlaceOrientation(null)
      renderEmpty(nodes.occupants, 'empty-row', 'No public place is selected for occupants.')
      renderEmpty(nodes.placeThings, 'empty-row', 'No public place is selected for visible things.')
      renderEmpty(nodes.placeConversation, 'empty-row', 'No public place is selected for conversation.')
      hideHistoryControl(nodes.placeThingsPage)
      hideHistoryControl(nodes.placeNotesPage)
      return
    }
    if (nodes.placeTitle) nodes.placeTitle.textContent = place.name +
      (place.status === 'retired' ? ' · retired' : '')
    if (nodes.placeSummary) {
      if (place.status === 'retired' && place.retiredAt) {
        const history = place.nameHistory.length
          ? ' Name history: ' + place.nameHistory.map(span => span.name + ' (' +
            span.startedAt.toLocaleDateString() + '–' +
            (span.endedAt ? span.endedAt.toLocaleDateString() : 'current') + ')').join(' → ') + '.'
          : ''
        nodes.placeSummary.textContent = 'This place was retired ' +
          place.retiredAt.toLocaleString() + '. Founding name: ' + place.foundingName + '.' + history +
          ' Its stable address is place #' + String(place.id) + '; its notes remain public below.'
      } else {
        nodes.placeSummary.textContent = place.path + (place.owner
          ? ' · kept by ' + place.owner
          : ' · nobody owns it · transit only') +
          (state.placeId ? ' · showing this place and everything inside it' : '')
      }
    }
    renderPlaceOrientation(place)
    renderOccupants(snapshot, place)
    const filters = Object.freeze({ placeId: place.id, resident: state.resident })
    autoLoadFilteredHistory('things', filters, historyEntry('things', filters))
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const thingsEntry = historyEntry('things', filters)
    const notesEntry = historyEntry('notes', filters)
    if (!renderHistoryOutcome(nodes.placeThings, thingsEntry, Object.freeze({
      loading: 'Fetching things that match this place…',
      failure: 'Things could not be loaded. Retry below.',
      empty: 'No public thing matches this selection.',
    }))) {
      renderThings(nodes.placeThings, thingsEntry.rows,
        placeId => placeReference(snapshot, placeId))
    }
    if (!renderHistoryOutcome(nodes.placeConversation, notesEntry, Object.freeze({
      loading: 'Fetching conversation that matches this place…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this place selection.',
    }))) {
      renderNotes(nodes.placeConversation, notesEntry.rows,
        'No public conversation matches this place selection.',
        placeId => placeReference(snapshot, placeId))
    }
    renderHistoryControl(nodes.placeThingsPage, 'things', 'things', filters)
    renderHistoryControl(nodes.placeNotesPage, 'notes', 'notes', filters)
  }

  function renderConversationMode() {
    if (!nodes.conversationMode) return
    if (!state.resident) {
      nodes.conversationMode.hidden = true
      nodes.conversationMode.replaceChildren()
      return
    }
    const question = element('p', 'conversation-question', state.conversationContext
      ? 'Question: What was said around ' + state.resident + '?'
      : 'Question: What did ' + state.resident + ' say?')
    const choices = element('div', 'conversation-choices')
    const residentOnly = element('button', 'conversation-mode-button',
      'What ' + state.resident + ' said')
    residentOnly.type = 'button'
    residentOnly.setAttribute('aria-pressed', String(!state.conversationContext))
    residentOnly.dataset.focusKey = 'conversation-mode:resident'
    residentOnly.addEventListener('click', () => navigate({ conversationContext: false }))
    const roomContext = element('button', 'conversation-mode-button',
      'What was said around ' + state.resident)
    roomContext.type = 'button'
    roomContext.setAttribute('aria-pressed', String(state.conversationContext))
    roomContext.dataset.focusKey = 'conversation-mode:context'
    roomContext.addEventListener('click', () => navigate({ conversationContext: true }))
    choices.append(residentOnly, roomContext)
    nodes.conversationMode.hidden = false
    nodes.conversationMode.replaceChildren(question, choices)
  }

  function renderConversations(snapshot) {
    if (!nodes.conversations) return
    renderConversationMode()
    // Following one resident defaults to only their authored notes. Room
    // context remains a separate, labelled question with its own cache key.
    const filters = Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.resident && state.conversationContext),
    })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.conversations, issue)
      hideHistoryControl(nodes.conversationPage)
      return
    }
    const place = state.placeId
      ? placeReference(snapshot, state.placeId)
      : null
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const entry = historyEntry('notes', filters)
    const notes = entry.rows
    const placeOf = placeId => placeReference(snapshot, placeId)
    if (renderHistoryOutcome(nodes.conversations, entry, Object.freeze({
      loading: 'Fetching this conversation…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this selection.',
    }))) {
      renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
      return
    }
    if (place && !state.resident) {
      const group = element('section', 'conversation-group')
      const heading = element('header', '')
      heading.append(
        element('h3', '', 'Inside ' + place.name),
        element('span', 'place-facts', place.path + ' · ' + String(notes.length) + ' shown'),
      )
      const list = element('div', 'note-list')
      list.append(...notes.map(note => noteCard(note, placeReference(snapshot, note.place_id))))
      group.append(heading, list)
      nodes.conversations.replaceChildren(group)
    } else {
      // The server pages notes newest first, so retain that order and name each
      // room without regrouping. Only the explicit room-context question marks
      // neighbours; the resident-only default contains authored notes alone.
      const ownNotes = notes.filter(note => note.author === state.resident)
      const nearestOwn = note => ownNotes.reduce((closest, own) => {
        if (own.place_id !== note.place_id) return closest
        if (!closest) return own
        const candidate = Math.abs(new Date(own.created_at).getTime() - new Date(note.created_at).getTime())
        const held = Math.abs(new Date(closest.created_at).getTime() - new Date(note.created_at).getTime())
        return candidate < held ? own : closest
      }, null)
      const list = element('div', 'note-list')
      list.append(...notes.map(note => {
        const card = noteCard(note, placeOf(note.place_id))
        if (filters.context && note.author !== state.resident) {
          const anchor = nearestOwn(note)
          card.classList.add('context-note')
          card.append(element('span', 'context-mark', anchor
            ? relativeGap(note.created_at, anchor.created_at)
            : 'same room'))
        }
        return card
      }))
      nodes.conversations.replaceChildren(list)
    }
    renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
  }

  function eventPlaceId(event, snapshot) {
    if (event.detail.to_place_id) return event.detail.to_place_id
    if (event.detail.place_id) return event.detail.place_id
    if (!snapshot) return null
    if (event.detail.thing_id) {
      return snapshot.things.find(thing => thing.id === event.detail.thing_id)?.place_id || null
    }
    if (event.detail.note_id) {
      return snapshot.notes.find(note => note.id === event.detail.note_id)?.place_id || null
    }
    return null
  }

  function actionVerb(action) {
    return {
      talk: 'talked',
      move: 'moved',
      use: 'used',
      give: 'gave',
      consume: 'consumed',
      make: 'made',
      go_home: 'went home',
    }[action] || action
  }

  function actionAttempt(action) {
    return action === 'go_home' ? 'go home' : action
  }

  function activitySemantics(event, snapshot) {
    const placeId = eventPlaceId(event, snapshot)
    const place = placeReference(snapshot, placeId)
    const location = windowPlaceLabel(placeId, place)
    let description = event.verb
    if (event.kind === 'action' && event.detail.action) {
      const applied = !event.detail.status || event.detail.status === 'applied'
      description = applied
        ? actionVerb(event.detail.action)
        : 'tried to ' + actionAttempt(event.detail.action)
      if ((event.detail.action === 'move' || event.detail.action === 'go_home') &&
          event.detail.from_place_id && event.detail.to_place_id) {
        const from = windowPlaceLabel(
          event.detail.from_place_id,
          placeReference(snapshot, event.detail.from_place_id),
        )
        const to = windowPlaceLabel(
          event.detail.to_place_id,
          placeReference(snapshot, event.detail.to_place_id),
        )
        if (from && to) description += ' from ' + from + ' to ' + to
      }
      if (applied && event.detail.mode === 'carry' && event.detail.thing_id) {
        description += ' carrying Thing #' + String(event.detail.thing_id)
      }
      if (event.detail.status) {
        description += ' · ' + (event.detail.status === 'noop'
          ? 'no change'
          : event.detail.status)
      }
      if (event.detail.status === 'blocked' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'thing_moved' && event.detail.mode === 'carry' &&
        event.detail.thing_id) {
      description = 'carried Thing #' + String(event.detail.thing_id) + ' with them'
      const from = windowPlaceLabel(
        event.detail.from_place_id,
        placeReference(snapshot, event.detail.from_place_id),
      )
      if (from && location) description += ' from ' + from + ' to ' + location
    } else if (event.kind === 'effect_resolved' && event.detail.status) {
      description += ' · ' + event.detail.status
      if (event.detail.status === 'skipped' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'gazette_printed') {
      const submissions = event.detail.entry_count === 1 ? 'submission' : 'submissions'
      description += ' · Issue ' + String(event.detail.issue_number) +
        ' · ' + String(event.detail.entry_count) + ' ' + submissions + ' from Room #454'
    }
    return Object.freeze({
      description,
      location,
      key: event.actor + '|' + description + '|' + String(location || '') +
        '|thing:' + String(activityThingId(event) || ''),
    })
  }

  function eventCause(detail) {
    const cause = detail.error || 'no cause was recorded'
    return detail.error_truncated
      ? cause + ' (cause excerpt; the rest is not shown in this window)'
      : cause
  }

  function collapseActivity(events, snapshot) {
    return events.reduce((groups, event) => {
      const semantics = activitySemantics(event, snapshot)
      const previous = groups.at(-1)
      if (previous?.semantics.key === semantics.key) {
        return [
          ...groups.slice(0, -1),
          Object.freeze({ ...previous, count: previous.count + 1 }),
        ]
      }
      return [...groups, Object.freeze({ event, semantics, count: 1 })]
    }, [])
  }

  function activityThingId(event) {
    if (event.detail.asset_type === 'thing' && event.detail.asset_id) return event.detail.asset_id
    return event.detail.thing_id || event.detail.source_thing_id || null
  }

  function namedThingReference(snapshot, id) {
    if (!id) return null
    const indexed = state.thingIndex.rows.find(thing => thing.id === id)
    if (indexed) return indexed
    const recent = snapshot.things.find(thing => thing.id === id)
    if (recent) return recent
    for (const place of snapshot.flatPlaces) {
      const heading = place.front_matter.find(thing => thing.id === id)
      if (heading) return heading
    }
    return null
  }

  function renderActivity(snapshot) {
    if (!nodes.activity) return
    const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.activity, issue, 'li')
      hideHistoryControl(nodes.happeningsPage)
      return
    }
    // Kick the auto-load before reading the entry: loadHistory stores
    // loading:true synchronously, so this render already says "fetching"
    // instead of falsely reporting an empty view.
    autoLoadFilteredHistory('events', filters, historyEntry('events', filters))
    const entry = historyEntry('events', filters)
    const events = entry.rows
    if (renderHistoryOutcome(nodes.activity, entry, Object.freeze({
      loading: 'Fetching happenings that match this view…',
      failure: 'Happenings could not be loaded. Retry below.',
      empty: 'No public happening matches this selection.',
    }), 'li')) {
      renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
      return
    }
    const rows = collapseActivity(events, snapshot).map(group => {
      const event = group.event
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      const description = element('span', '', ' ' + group.semantics.description)
      if (group.count > 1) {
        description.append(
          element('span', 'activity-count', ' · ' + String(group.count) + ' times'),
        )
      }
      description.append('.')
      copy.append(
        SAFE_SYSTEM_EVENT_ACTORS.has(event.actor)
          ? element('span', 'activity-actor activity-system-actor', event.actor)
          : residentNode(event.actor, 'activity-actor', 'activity-actor:' + String(event.id)),
        description,
      )
      row.append(copy, timeNode(event.at, 'activity-time'))
      const thingId = activityThingId(event)
      if (thingId) {
        const thing = namedThingReference(snapshot, thingId)
        const label = thing?.name || 'Thing #' + String(thingId)
        const reference = element('span', 'activity-thing-reference')
        reference.append(
          portraitNode('thing', thingId, label,
            thing ? thing.has_drawing === true : event.thingHasDrawing),
          openDetailLink('thing', thingId, label, 'detail-link activity-thing-link'),
        )
        row.append(reference)
      }
      if (group.semantics.location) {
        row.append(element('span', 'activity-context',
          'Observed at ' + group.semantics.location))
      }
      return row
    })
    nodes.activity.replaceChildren(...rows)
    renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
  }

  function renderAgreements(snapshot) {
    if (!nodes.agreements) return
    const filters = Object.freeze({ placeId: null, resident: state.resident })
    const issue = state.resident ? selectionIssue(snapshot, false) : null
    if (issue?.kind === 'resident') {
      renderSelectionIssue(nodes.agreements, issue)
      hideHistoryControl(nodes.agreementsPage)
      return
    }
    autoLoadFilteredHistory('agreements', filters, historyEntry('agreements', filters))
    const entry = historyEntry('agreements', filters)
    const agreements = entry.rows
    if (renderHistoryOutcome(nodes.agreements, entry, Object.freeze({
      loading: 'Fetching agreements that match this resident…',
      failure: 'Agreements could not be loaded. Retry below.',
      empty: 'No public agreement matches this resident selection.',
    }))) {
      renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
      return
    }
    nodes.agreements.replaceChildren(...agreements.map(agreement => {
      const card = element('article', 'agreement-card')
      const copy = element('div', '')
      const agreementMeta = element('p', 'agreement-meta')
      agreementMeta.append(
        document.createTextNode('agreement #' + String(agreement.id) + ' · written by '),
        residentNode(agreement.created_by, 'agreement-author',
          'agreement-author:' + String(agreement.id)),
      )
      copy.append(
        agreementMeta,
        renderExpandableBody('agreement', agreement.id, agreement.body, agreement.truncated),
        timeNode(agreement.created_at, 'agreement-meta'),
      )
      if (state.resident && agreement.parties_truncated &&
          agreement.created_by !== state.resident && !agreement.parties.includes(state.resident)) {
        copy.append(element('p', 'agreement-filter-note',
          'Party preview is incomplete; this agreement stays visible in filtered views.'))
      }
      if (agreement.moderated) copy.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
      const side = element('aside', 'agreement-side')
      side.append(element('h3', '', 'Parties & signatures'))
      const signatures = element('div', 'signature-list')
      // Named parties first, then whoever acceded later. An acceded party has
      // always signed -- joining is the signing -- so it gets its own mark
      // rather than a tick that would read as an invitation the author wrote.
      const named = agreement.parties.filter(party => !agreement.acceded.includes(party))
      signatures.append(...named.concat(agreement.acceded).map(party => {
        const acceded = agreement.acceded.includes(party)
        const signed = agreement.signatures.includes(party)
        const chip = element('span', 'signature-chip')
        const resident = residentReference(snapshot, party)
        if (resident) {
          chip.append(portraitNode(
            'resident', resident.id, party, resident.has_drawing, 'signature-portrait',
          ))
        }
        chip.append(document.createTextNode((acceded ? '+ ' : signed ? '✓ ' : '○ ') + party))
        chip.dataset.signed = String(signed)
        if (acceded) {
          chip.dataset.acceded = 'true'
          chip.title = 'acceded after the agreement was written'
        }
        return chip
      }))
      const hiddenPartyCount = Math.max(0, agreement.party_count - agreement.parties.length)
      if (agreement.parties_truncated && hiddenPartyCount) {
        signatures.append(element('span', 'signature-overflow',
          '+' + String(hiddenPartyCount) + ' more not shown here'))
      }
      side.append(signatures, element('span', agreement.open ? 'badge badge-open' : 'badge badge-complete',
        agreement.open ? 'Awaiting signatures' : 'Fully signed'))
      side.append(element('span', agreement.accession_open ? 'badge badge-open' : 'badge badge-complete',
        agreement.accession_open ? 'Open to later signers' : 'Closed to later signers'))
      card.append(copy, side)
      return card
    }))
    renderHistoryControl(nodes.agreementsPage, 'agreements', 'agreements', filters)
  }

  // A filtered view whose slice has never been fetched from the server only
  // holds whatever happened to sit in the newest city-wide page. Fetch the
  // real filtered slice once instead of leaving the view falsely quiet.
  function autoLoadFilteredHistory(collection, filters, entry) {
    if (!filters.placeId && !filters.resident) return
    if (entry.initialized || entry.loading || entry.error) return
    void loadHistory(collection, filters)
  }

  function renderHistoryControl(target, collection, label, filters) {
    if (!target) return
    const entry = historyEntry(collection, filters)
    const hasRefreshState = entry.refreshing || entry.refreshError
    const hasPagingState = entry.hasMore || entry.loading || entry.error
    if (!hasRefreshState && !hasPagingState) {
      target.hidden = true
      target.replaceChildren()
      return
    }
    const parts = []
    if (entry.refreshing) {
      parts.push(element('p', 'loading-row', 'Loading updated ' + label + '…'))
    } else if (entry.refreshError) {
      const message = element('p', 'navigation-error',
        'Updated ' + label + ' could not be loaded. Showing the previous completed results.')
      message.setAttribute('role', 'alert')
      const retry = element('button', 'history-load', 'Retry refreshing ' + label)
      retry.type = 'button'
      retry.dataset.focusKey = 'refresh:' + collection + ':' + historyKey(collection, filters)
      retry.addEventListener('click', () => void forwardRefreshHistory(collection, filters))
      parts.push(message, retry)
    }
    if (!hasPagingState) {
      target.hidden = false
      target.replaceChildren(...parts)
      return
    }
    // While the first filtered slice is being fetched nothing "older" is
    // involved yet; every click-driven state keeps the familiar wording.
    const older = entry.initialized ? 'older ' : ''
    const text = entry.loading
      ? 'Loading ' + older + label + '…'
      : entry.error ? 'Retry loading ' + older + label : 'Load ' + older + label
    const button = element('button', 'history-load', text)
    button.type = 'button'
    // Never disabled: a disabled control cannot take restored focus, and
    // loadHistory already ignores clicks while a fetch is in flight.
    button.setAttribute('aria-busy', String(entry.loading))
    button.dataset.focusKey = 'load:' + collection + ':' + historyKey(collection, filters)
    button.dataset.focusFallbackId = collection === 'events'
      ? 'activity-list'
      : collection === 'agreements'
        ? 'agreement-list'
        : collection === 'things'
          ? 'place-things'
          : label === 'conversations' ? 'conversation-stream' : 'place-conversation'
    button.addEventListener('click', () => void loadHistory(collection, filters))
    if (entry.error && entry.rows.length) {
      const message = element('p', 'navigation-error',
        (older ? 'Older ' : '') + label + ' could not be loaded.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    parts.push(button)
    target.hidden = false
    target.replaceChildren(...parts)
  }

  function historyRequestUrl(collection, entry, filters, minimumMarker) {
    const url = new URL(
      collection === 'events' ? '/api/events' : '/api/window',
      window.location.origin,
    )
    // Context pages carry up to four neighbors per own note, so they use a
    // smaller page to stay well inside the client's 200-row safety cap.
    url.searchParams.set('limit', filters.context ? '25' : '50')
    if (collection === 'events') {
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('actor', filters.resident)
    } else {
      url.searchParams.set('collection', collection)
      if (filters.placeId) url.searchParams.set('within_place_id', String(filters.placeId))
      if (filters.resident) url.searchParams.set('resident', filters.resident)
      if (filters.context) url.searchParams.set('context', 'place')
    }
    if (entry.initialized && entry.nextBeforeId) {
      url.searchParams.set('before_id', String(entry.nextBeforeId))
    }
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  function normalizeHistoryRows(collection, payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public history page')
    if (collection === 'notes') return normalizeNotes(payload.notes)
    if (collection === 'things') return normalizeThings(payload.things)
    if (collection === 'agreements') return normalizeAgreements(payload.agreements)
    return normalizeEvents(payload.events)
  }

  // A filtered entry only pages backward once initialized, and the snapshot
  // merge can only place-match events it can resolve client-side. Refetching
  // the newest filtered page after each snapshot refresh keeps an open
  // filtered view complete without touching its backward cursor.
  const forwardRefreshKeys = new Set()
  async function forwardRefreshHistory(collection, filters) {
    const key = collection + '|' + historyKey(collection, filters)
    if (forwardRefreshKeys.has(key)) return
    forwardRefreshKeys.add(key)
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    const current = historyEntry(collection, filters)
    setHistoryEntry(collection, filters, {
      ...current,
      refreshing: true,
      refreshError: false,
    })
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = historyRequestUrl(
        collection, { initialized: false, nextBeforeId: null }, filters, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('updated public history unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const incoming = normalizeHistoryRows(collection, payload)
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, {
        ...latest,
        rows: mergeWindowRows(latest.rows, incoming),
        refreshing: false,
        refreshError: false,
      })
      renderAll()
    } catch {
      if (authoredRevision === requestAuthoredRevision) {
        const latest = historyEntry(collection, filters)
        setHistoryEntry(collection, filters, {
          ...latest,
          refreshing: false,
          refreshError: true,
        })
        renderAll()
      }
    } finally {
      window.clearTimeout(timeout)
      forwardRefreshKeys.delete(key)
    }
  }

  function refreshFilteredViews() {
    if (state.view === 'happenings') {
      const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
      if (!filters.placeId && !filters.resident) return
      const entry = historyEntry('events', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('events', filters)
    } else if (state.view === 'conversations' && state.resident) {
      const filters = Object.freeze({
        placeId: state.placeId,
        resident: state.resident,
        context: Boolean(state.conversationContext),
      })
      const entry = historyEntry('notes', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('notes', filters)
    } else if (state.view === 'agreements' && state.resident) {
      const filters = Object.freeze({ placeId: null, resident: state.resident })
      const entry = historyEntry('agreements', filters)
      if (!entry.initialized || entry.loading) return
      void forwardRefreshHistory('agreements', filters)
    }
  }

  async function loadHistory(collection, filters, automatic = false) {
    if (automatic && (state.view !== 'live' || document.hidden)) return
    const current = historyEntry(collection, filters)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    if (automatic && (current.automaticPageCount || 0) >= MAX_AUTO_HISTORY_PAGES) {
      setHistoryEntry(collection, filters, {
        ...current, loading: false, error: false, automaticPaused: true,
      })
      renderAll()
      return
    }
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    setHistoryEntry(collection, filters, {
      ...current,
      loading: true,
      error: false,
      automaticPaused: false,
      refreshing: false,
      refreshError: false,
    })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = historyEntry(collection, filters)
      const url = historyRequestUrl(collection, requestEntry, filters, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public history unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const incoming = normalizeHistoryRows(collection, payload)
      const hasMore = payload.has_more === true
      const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
      const requestedBeforeId = requestEntry.initialized ? requestEntry.nextBeforeId : null
      const latest = historyEntry(collection, filters)
      const rows = mergeWindowRows(latest.rows, incoming)
      if (hasMore && (!nextBeforeId ||
          !incoming.some(row => row.id === nextBeforeId) ||
          (requestedBeforeId && nextBeforeId >= requestedBeforeId))) {
        throw new Error('public history cursor did not progress')
      }
      if (hasMore && requestEntry.initialized && rows.length <= latest.rows.length) {
        throw new Error('public history page did not add a row')
      }
      const automaticPageCount = automatic
        ? (latest.automaticPageCount || 0) + 1
        : 0
      const automaticLimitReached = automatic && hasMore &&
        automaticPageCount >= MAX_AUTO_HISTORY_PAGES
      setHistoryEntry(collection, filters, {
        rows,
        hasMore,
        nextBeforeId,
        automaticPageCount,
        automaticPaused: automaticLimitReached,
        initialized: true,
        loading: false,
        error: false,
      })
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      const latest = historyEntry(collection, filters)
      setHistoryEntry(collection, filters, { ...latest, loading: false, error: true })
    } finally {
      window.clearTimeout(timeout)
      renderAll()
    }
  }

  function loadedHistoryRows(collection, snapshot) {
    if (state.view === 'place' && (collection === 'notes' || collection === 'things')) {
      const place = selectedPlace(snapshot) ||
        (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
      if (!place || selectionIssue(snapshot, true)) return []
      return historyEntry(collection, { placeId: place.id, resident: state.resident }).rows
    }
    if (state.view === 'conversations' && collection === 'notes') {
      if (selectionIssue(snapshot, false)) return []
      return historyEntry('notes', {
        placeId: state.placeId,
        resident: state.resident,
        context: Boolean(state.resident && state.conversationContext),
      }).rows
    }
    if (state.view === 'happenings' && collection === 'events') {
      if (selectionIssue(snapshot, false)) return []
      return historyEntry('events', {
        placeId: state.placeId,
        resident: state.resident,
      }).rows
    }
    if (state.view === 'agreements' && collection === 'agreements') {
      if (state.resident && selectionIssue(snapshot, false)?.kind === 'resident') return []
      return historyEntry('agreements', { placeId: null, resident: state.resident }).rows
    }
    return snapshot[collection]
  }

  function loadedShown(snapshot) {
    const places = new Map(snapshot.flatPlaces.map(place => [place.id, place]))
    for (const placeId of activeFocusedPlaceIds(snapshot)) {
      const place = focusedPlace(placeId)
      if (place) places.set(place.id, place)
    }
    const residents = new Map(displayedResidents(snapshot).map(resident => [resident.id, resident]))
    return Object.freeze({
      places: places.size,
      residents: residents.size,
      conversations: loadedHistoryRows('notes', snapshot).length,
      things: loadedHistoryRows('things', snapshot).length,
      agreements: loadedHistoryRows('agreements', snapshot).length,
      events: loadedHistoryRows('events', snapshot).length,
    })
  }

  function renderCounts(snapshot) {
    if (!nodes.counts) return
    nodes.counts.textContent = String(snapshot.totals.places) + ' places · ' +
      String(snapshot.totals.residents) + ' residents · ' + String(snapshot.totals.things) +
      ' things · ' + String(snapshot.totals.conversations) + ' notes · public and read only'
  }

  function activeFilteredScopeKeys(snapshot) {
    const keys = new Set()
    if (state.view === 'things') keys.add('things')
    if (state.view === 'place' && selectedPlace(snapshot)) {
      keys.add('conversations')
      keys.add('things')
    }
    if (state.view === 'conversations' && (state.placeId || state.resident)) {
      keys.add('conversations')
    }
    if (state.view === 'happenings' && (state.placeId || state.resident)) {
      keys.add('events')
    }
    if (state.view === 'agreements' && state.resident) keys.add('agreements')
    return keys
  }

  function renderScope(snapshot) {
    if (!nodes.scope) return
    const shown = loadedShown(snapshot)
    const labels = {
      places: 'places', residents: 'residents', conversations: 'conversations',
      things: 'things', agreements: 'agreements', events: 'happenings',
    }
    const filteredKeys = activeFilteredScopeKeys(snapshot)
    const partial = Object.keys(labels).filter(key =>
      !filteredKeys.has(key) && snapshot.totals[key] > shown[key])
      .map(key => (key === 'places' || key === 'residents' ? 'currently loaded ' : '') +
        String(shown[key]) + ' of ' + String(snapshot.totals[key]) + ' ' + labels[key])
    const filters = [
      state.placeId ? 'place #' + String(state.placeId) : '',
      state.resident ? 'resident ' + state.resident : '',
    ].filter(Boolean)
    const hasExcerpts = snapshot.notes.some(note => note.truncated) ||
      snapshot.things.some(thing => thing.truncated) ||
      snapshot.agreements.some(agreement => agreement.truncated)
    const excerptNotice = !hasExcerpts
      ? ''
      : snapshot.bodyLimits
        ? ' Excerpt limits are ' + snapshot.bodyLimits.notes.toLocaleString() +
          ' characters for notes, ' + snapshot.bodyLimits.things.toLocaleString() +
          ' for things, and ' + snapshot.bodyLimits.agreements.toLocaleString() +
          ' for agreements.'
        : ' Long text may appear as an excerpt.'
    // Following a resident fetches a separately paged answer beyond the initial
    // bounded view. Name the exact question instead of asking scope disclosure
    // to compensate for an ambiguous default.
    const followedFilters = state.resident && state.view === 'conversations' ? Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.conversationContext),
    }) : null
    const followedEntry = followedFilters ? historyEntry('notes', followedFilters) : null
    const followedRows = followedEntry?.rows || []
    const ownRows = followedRows.filter(note => note.author === state.resident).length
    const followedQuestion = followedFilters
      ? state.conversationContext
        ? 'what was said around ' + state.resident
        : 'what ' + state.resident + ' said'
      : ''
    const followedWaiting = followedEntry && (
      followedEntry.loading || followedEntry.refreshing ||
      (!followedEntry.initialized && !followedEntry.error && !followedEntry.refreshError)
    )
    const followedFailed = followedEntry && (followedEntry.error || followedEntry.refreshError)
    const followNotice = !followedFilters
      ? ''
      : followedWaiting
        ? ' Conversation question: ' + followedQuestion + '. Loading that public read.'
        : followedFailed
          ? ' Conversation question: ' + followedQuestion +
            '. That public read failed; retry is available in the conversation panel.'
          : followedRows.length === 0
            ? ' Conversation question: ' + followedQuestion + '. Nothing was found.'
            : state.conversationContext
              ? ' Conversation question: ' + followedQuestion + '. Showing ' +
                String(ownRows) + (ownRows === 1 ? ' note' : ' notes') + ' by ' + state.resident +
                ' plus ' + String(followedRows.length - ownRows) + ' fetched from the same rooms' +
                (followedEntry?.hasMore ? '; older pages remain.' : '.')
              : ' Conversation question: ' + followedQuestion + '. Showing ' +
                String(followedRows.length) + ' fetched ' +
                (followedRows.length === 1 ? 'note' : 'notes') +
                (followedEntry?.hasMore ? '; older pages remain.' : '.')
    const directoryNotice = state.directory.loaded
      ? ' Selectors use the complete city directory; map, presence, and authored content remain currently loaded views.'
      : ' Selectors currently use the loaded fallback while the complete city directory is unavailable.'
    nodes.scope.textContent = (partial.length
      ? 'Current bounded public view shows ' + partial.join(' · ') + '.'
      : filteredKeys.size
        ? 'The other currently loaded public rows are within their display limits.'
        : 'The currently loaded public view is within every display limit.') +
      directoryNotice +
      excerptNotice +
      (filters.length ? ' Active filter: ' + filters.join(' + ') + '.' : '') +
      followNotice
  }

  function renderDirectoryStatus() {
    if (!nodes.directoryStatus) return
    nodes.directoryStatus.removeAttribute('role')
    if (state.directory.error) {
      nodes.directoryStatus.setAttribute('role', 'alert')
      const message = element('span', '',
        'The complete city directory could not be loaded. Selectors show the currently loaded fallback. ')
      const retry = element('button', 'directory-retry', 'Retry loading the complete directory')
      retry.type = 'button'
      retry.dataset.focusKey = 'directory-retry'
      retry.addEventListener('click', () => void loadDirectory())
      nodes.directoryStatus.replaceChildren(message, retry)
      return
    }
    if (state.directory.loading || !state.directory.loaded) {
      nodes.directoryStatus.textContent =
        'Loading the complete city directory. Map and content below are currently loaded separately.'
      return
    }
    nodes.directoryStatus.textContent = 'Complete city directory: ' +
      String(state.directory.places.length) + ' places and ' +
      String(state.directory.residents.length) +
      ' residents. Map, presence, and content below are currently loaded separately.'
  }

  function renderView() {
    const gazetteView = state.view === 'gazette'
    if (nodes.directorySearchField) nodes.directorySearchField.hidden = gazetteView
    if (nodes.viewFilters) nodes.viewFilters.hidden = gazetteView
    for (const tab of tabs) {
      const active = tab.dataset.view === state.view
      tab.setAttribute('aria-selected', String(active))
      tab.tabIndex = active ? 0 : -1
      if (active && tab.parentElement) {
        const tabList = tab.parentElement
        const tabBox = tab.getBoundingClientRect()
        const tabListBox = tabList.getBoundingClientRect()
        if (tabBox.left < tabListBox.left) {
          tabList.scrollLeft -= Math.ceil(tabListBox.left - tabBox.left)
        } else if (tabBox.right > tabListBox.right) {
          tabList.scrollLeft += Math.ceil(tabBox.right - tabListBox.right)
        }
      }
    }
    for (const panel of panels) panel.hidden = panel.id !== state.view + '-panel'
    const live = state.view === 'live'
    if (nodes.liveAlpha) nodes.liveAlpha.hidden = !live
    if (nodes.liveAlphaNote) nodes.liveAlphaNote.hidden = !live
    scheduleLiveClock()
  }

  // A refresh rebuilds the DOM, which would silently drop the reader's
  // keyboard position. Every rebuilt interactive control carries a stable
  // data-focus-key so focus can land back on its replacement.
  function restoreFocus(focusKey, focusFallbackKey, focusFallbackId) {
    if (!focusKey || document.activeElement !== document.body) return
    // Hidden panels keep their previous DOM, so the same key can exist in a
    // stale copy; only a visible replacement can actually take focus.
    const replacements = document.querySelectorAll(
      '[data-focus-key="' + CSS.escape(focusKey) + '"]')
    for (const replacement of replacements) {
      if (replacement.closest('[hidden]')) continue
      replacement.focus({ preventScroll: true })
      return
    }
    const fallback = focusFallbackKey
      ? document.querySelector('[data-focus-key="' + CSS.escape(focusFallbackKey) + '"]')
      : null
    if (fallback && !fallback.closest('[hidden]')) {
      fallback.focus({ preventScroll: true })
      return
    }
    const fallbackTarget = focusFallbackId ? document.getElementById(focusFallbackId) : null
    if (fallbackTarget && !fallbackTarget.closest('[hidden]')) {
      fallbackTarget.tabIndex = -1
      fallbackTarget.focus({ preventScroll: true })
    }
  }

  function renderAll() {
    resetPortraitImages()
    const snapshot = state.snapshot
    const active = document.activeElement
    const focusKey = active && active.dataset ? active.dataset.focusKey || null : null
    const focusFallbackKey = active && active.dataset
      ? active.dataset.focusFallbackKey || null
      : null
    const focusFallbackId = active && active.dataset
      ? active.dataset.focusFallbackId || null
      : null
    renderView()
    renderDirectoryStatus()
    writeLocation(false)
    renderDetail()
    if (state.view === 'archive') renderArchive()
    if (state.view === 'gazette') renderGazette()
    if (!snapshot) return
    renderCounts(snapshot)
    renderScope(snapshot)
    if (state.view === 'map') {
      renderMap(snapshot)
      renderRoster(snapshot)
    } else if (state.view === 'live') {
      renderLive(snapshot)
    } else if (state.view === 'things') {
      renderThingIndex(snapshot)
    } else if (state.view === 'place') {
      renderPlace(snapshot)
    } else if (state.view === 'conversations') {
      renderConversations(snapshot)
    } else if (state.view === 'happenings') {
      renderActivity(snapshot)
    } else if (state.view === 'agreements') {
      renderAgreements(snapshot)
    }
    syncBodyDisclosures()
    if (nodes.placeFilter) nodes.placeFilter.value = state.placeId ? String(state.placeId) : ''
    renderDirectorySearch(snapshot)
    if (nodes.residentFilter) nodes.residentFilter.value = state.resident || ''
    restoreFocus(focusKey, focusFallbackKey, focusFallbackId)
  }

  function choosePlace(id, openPlace) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === id) ||
      directoryPlace(id) || focusedPlace(id)
    if (!place) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: id,
      directorySearch: '',
      directorySearchIndex: -1,
      view: openPlace ? 'place' : state.view,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  }

  function chooseResident(handle) {
    const resident = state.snapshot?.residents.find(candidate => candidate.handle === handle) ||
      state.directory.residents.find(candidate => candidate.handle === handle) ||
      focusedResident(handle)
    if (!resident) return
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: handle,
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  }

  async function loadDirectory(force, scheduleRecheck = true) {
    if (state.directory.loading) return
    if (force) window.clearTimeout(state.directory.recheckTimer)
    state = {
      ...state,
      directory: Object.freeze({ ...state.directory, loading: true, error: false }),
    }
    renderDirectoryStatus()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/window', window.location.origin)
      url.searchParams.set('view', 'directory')
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        cache: force ? 'reload' : 'default',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public directory unavailable')
      const directory = normalizeDirectory(await response.json())
      state = {
        ...state,
        directory: Object.freeze({
          ...directory,
          loaded: true,
          loading: false,
          error: false,
          marker: state.changeMarker || null,
          recheckTimer: 0,
        }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
      void ensureFocusedSelection()
    } catch {
      state = {
        ...state,
        directory: Object.freeze({ ...state.directory, loading: false, error: true }),
      }
      if (state.snapshot) populateFilters(state.snapshot)
      renderAll()
    } finally {
      window.clearTimeout(timeout)
      if (force && scheduleRecheck) {
        const recheckTimer = window.setTimeout(() => void loadDirectory(true, false), 31_000)
        state = {
          ...state,
          directory: Object.freeze({ ...state.directory, recheckTimer }),
        }
      }
    }
  }

  async function loadFocusedPlace(placeId, force) {
    if (!state.snapshot || state.snapshot.flatPlaces.some(place => place.id === placeId)) return
    const current = state.focusedPlaces[String(placeId)]
    if (current?.loading || (!force && current?.place)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedPlaces: {
        ...state.focusedPlaces,
        [String(placeId)]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          place: current?.place || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/map', window.location.origin)
      url.searchParams.set('view', 'outline')
      url.searchParams.set('parent_id', String(placeId))
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused place reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedPlaces: {
            ...state.focusedPlaces,
            [String(placeId)]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              place: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused place unavailable')
      const payload = await response.json()
      const responseMarker = safeChangeMarker(payload?.change_marker)
      requireCurrentReadMarker(responseMarker, requestMarker)
      const [normalized] = normalizePlaces([payload?.place], 0, new Set())
      if (!normalized || normalized.id !== placeId) throw new Error('wrong focused place')
      const reference = directoryPlace(placeId)
      const place = Object.freeze({
        ...normalized,
        children: [],
        path: focusedPlacePath(reference, normalized),
      })
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: responseMarker || requestMarker || null,
            place,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.place) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedPlaces: {
          ...state.focusedPlaces,
          [String(placeId)]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            place: current?.place || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function loadFocusedResident(handle, force) {
    if (!state.snapshot || state.snapshot.residents.some(resident => resident.handle === handle)) return
    const current = state.focusedResidents[handle]
    if (current?.loading || (!force && current?.resident)) return
    const selectionAtStart = activeSelectionKey()
    const requestMarker = state.changeMarker
    const requestAuthoredRevision = authoredRevision
    state = {
      ...state,
      focusedResidents: {
        ...state.focusedResidents,
        [handle]: Object.freeze({
          loading: true,
          error: false,
          notFound: false,
          marker: current?.marker || null,
          resident: current?.resident || null,
        }),
      },
    }
    renderAll()
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('handle', handle)
      if (requestMarker) url.searchParams.set('after_change_marker', requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (response.status === 404) {
        const payload = await response.json().catch(() => null)
        requireCurrentReadMarker(payload?.change_marker, requestMarker)
        if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
          throw new Error('focused resident reply was overtaken by a newer public snapshot')
        }
        state = {
          ...state,
          focusedResidents: {
            ...state.focusedResidents,
            [handle]: Object.freeze({
              loading: false,
              error: false,
              notFound: true,
              marker: requestMarker || current?.marker || null,
              resident: null,
            }),
          },
        }
        return
      }
      if (!response.ok) throw new Error('focused resident unavailable')
      const payload = await response.json()
      const [resident] = normalizeResidents([payload?.resident])
      if (!resident || resident.handle !== handle) throw new Error('wrong focused resident')
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      if (authoredRevision !== requestAuthoredRevision || state.changeMarker !== requestMarker) {
        throw new Error('focused resident reply was overtaken by a newer public snapshot')
      }
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: false,
            notFound: false,
            marker: safeChangeMarker(payload?.change_marker) || requestMarker || null,
            resident,
          }),
        },
      }
    } catch {
      const retainedCovers = Boolean(current?.resident) &&
        (!state.changeMarker || markerCovers(current?.marker, state.changeMarker))
      state = {
        ...state,
        focusedResidents: {
          ...state.focusedResidents,
          [handle]: Object.freeze({
            loading: false,
            error: !retainedCovers,
            notFound: false,
            marker: current?.marker || null,
            resident: current?.resident || null,
          }),
        },
      }
    } finally {
      window.clearTimeout(timeout)
      if (activeSelectionKey() === selectionAtStart) {
        if (state.snapshot) populateFilters(state.snapshot)
        renderAll()
      }
    }
  }

  async function ensureFocusedSelection(options) {
    const forcePlace = options?.forcePlace === true
    const forceResident = options?.forceResident === true
    if (!state.snapshot) return
    const selectionAtStart = activeSelectionKey()
    const selectedHandle = state.resident
    const explicitPlaceId = state.placeId

    if (selectedHandle &&
        !state.snapshot.residents.some(resident => resident.handle === selectedHandle)) {
      const entry = state.focusedResidents[selectedHandle]
      if (!entry || forceResident) {
        await loadFocusedResident(selectedHandle, forceResident)
      }
      if (activeSelectionKey() !== selectionAtStart || state.resident !== selectedHandle) return
      const latest = state.focusedResidents[selectedHandle]
      if (latest?.error || latest?.notFound || !latest?.resident) return
    }

    if (explicitPlaceId &&
        !state.snapshot.flatPlaces.some(place => place.id === explicitPlaceId)) {
      if (liveSurveyCoversPlace(state.snapshot, explicitPlaceId)) return
      const entry = state.focusedPlaces[String(explicitPlaceId)]
      if (!entry || (forcePlace && Boolean(entry.place))) {
        await loadFocusedPlace(explicitPlaceId, forcePlace)
      }
      return
    }

    if (!explicitPlaceId && selectedHandle) {
      const resident = selectedResident(state.snapshot)
      const currentPlaceId = resident?.current_place_id || null
      if (currentPlaceId &&
          !state.snapshot.flatPlaces.some(place => place.id === currentPlaceId)) {
        if (liveSurveyCoversPlace(state.snapshot, currentPlaceId)) return
        const entry = state.focusedPlaces[String(currentPlaceId)]
        if (!entry || (forcePlace && Boolean(entry.place))) {
          await loadFocusedPlace(currentPlaceId, forcePlace)
        }
      }
    }
  }

  async function getSnapshot(signal, minimumMarker) {
    const url = new URL('/api/window', window.location.origin)
    url.searchParams.set('view', 'outline')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public snapshot unavailable')
    return response.json()
  }

  async function checkPublicChanges() {
    const visibilityRevision = liveVisibilityRevision
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const startingMarker = state.live.streamMarker || state.changeMarker
      let cursor = startingMarker
      let marker = startingMarker
      let heldMarker = null
      let changes = []
      let unchanged = true
      const seenCursors = new Set()
      while (true) {
        const url = new URL('/api/changes', window.location.origin)
        if (state.live.streamMarker && cursor === state.live.streamMarker) {
          url.searchParams.set('since', state.live.streamMarker)
        } else if (state.changeMarker && cursor === state.changeMarker) {
          url.searchParams.set('since', state.changeMarker)
        } else if (cursor) {
          url.searchParams.set('since', cursor)
        }
        url.searchParams.set('limit', String(LIVE_OPENING_PAGE_LIMIT))
        const response = await fetch(url.pathname + url.search, {
          credentials: 'omit',
          headers: { Accept: 'application/json' },
          mode: 'same-origin',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error('public changes unavailable')
        const payload = await response.json()
        if (!payload || typeof payload !== 'object') throw new Error('invalid public changes')
        const nextMarker = safeChangeMarker(payload.change_marker ?? payload.checkpoint)
        if (!nextMarker || (cursor && !markerCovers(nextMarker, cursor)) ||
            (startingMarker && !markerCovers(nextMarker, startingMarker))) {
          throw new Error('public change marker did not cover its page')
        }
        heldMarker = heldMarker || nextMarker
        if (!markerCovers(nextMarker, heldMarker)) {
          throw new Error('public change marker moved behind the held page')
        }
        marker = heldMarker
        unchanged = unchanged && payload.unchanged === true
        if (!startingMarker) {
          return Object.freeze({
            status: 'unchanged', marker, changes: Object.freeze([]), visibilityRevision,
          })
        }
        const incoming = normalizeLiveChanges(payload.changes)
        if (incoming.some(change =>
          (cursor && BigInt(change.change_id) <= BigInt(cursor)) ||
          BigInt(change.change_id) > BigInt(nextMarker))) {
          throw new Error('public change page crossed its cursor')
        }
        changes = mergeLiveChanges(changes, incoming.filter(change =>
          BigInt(change.change_id) <= BigInt(heldMarker)))
        if (payload.has_more !== true) break
        const nextSince = safeChangeMarker(payload.next_since)
        if (!nextSince || !cursor || BigInt(nextSince) <= BigInt(cursor) ||
            BigInt(nextSince) > BigInt(nextMarker) || seenCursors.has(nextSince)) {
          throw new Error('public change cursor did not progress')
        }
        if (BigInt(nextSince) >= BigInt(heldMarker)) break
        seenCursors.add(nextSince)
        cursor = nextSince
      }
      return Object.freeze({
        status: changes.length || marker !== startingMarker || !unchanged ? 'changed' : 'unchanged',
        marker,
        changes,
        visibilityRevision,
      })
    } catch {
      return Object.freeze({
        status: 'unavailable', marker: null, changes: Object.freeze([]), visibilityRevision,
      })
    } finally {
      window.clearTimeout(timeout)
    }
  }

  function invalidateLiveCaches(drawings, noteBodies, changes) {
    const drawingKeys = new Set()
    let clearAll = false
    for (const change of changes) {
      if (change.kind === 'resident_edited' && change.detail.resident_id) {
        drawingKeys.add('resident:' + String(change.detail.resident_id))
      } else if (change.kind === 'place_edited' && change.detail.place_id) {
        drawingKeys.add('place:' + String(change.detail.place_id))
      } else if (
        (change.kind === 'thing_edited' || change.kind === 'thing_upgraded') &&
        change.detail.thing_id
      ) {
        drawingKeys.add('thing:' + String(change.detail.thing_id))
      } else if (change.kind === 'kind_revised' && change.detail.kind_id) {
        drawingKeys.add('kind:' + String(change.detail.kind_id))
      } else if (change.kind === 'moderation') {
        clearAll = true
      }
    }
    const filteredDrawings = clearAll
      ? {}
      : Object.fromEntries(Object.entries(drawings).filter(([key]) => !drawingKeys.has(key)))
    return Object.freeze({
      drawings: clearAll || drawingKeys.size ? filteredDrawings : drawings,
      noteBodies: clearAll ? {} : noteBodies,
    })
  }

  function commitLiveChangeRead(changeState) {
    const visibilityInterrupted = Number.isSafeInteger(changeState.visibilityRevision) &&
      changeState.visibilityRevision !== liveVisibilityRevision
    if (changeState.status === 'unavailable') {
      state = { ...state, live: { ...state.live, streamError: true } }
      return visibilityInterrupted ? 0 : BASE_REFRESH_MS
    }
    const incoming = changeState.changes || []
    const hadStreamError = state.live.streamError
    const openingMarker = state.live.openingMarker
    const streamIncoming = openingMarker
      ? incoming.filter(change => BigInt(change.change_id) > BigInt(openingMarker))
      : incoming
    const known = new Set(state.live.changes.map(change => change.change_id))
    const suppressReplay = state.live.suppressReplayOnNextRead || document.hidden ||
      visibilityInterrupted
    const replayIncoming = state.live.openingLoaded && !suppressReplay
      ? streamIncoming.filter(change => !known.has(change.change_id))
      : []
    const cutoff = Date.now() - LIVE_MOVE_LIFETIME_MS
    const merged = Object.freeze(mergeLiveChanges(state.live.changes, streamIncoming)
      .filter(change => change.at.getTime() >= cutoff &&
        (!openingMarker || BigInt(change.change_id) > BigInt(openingMarker))))
    const latestAt = streamIncoming.length
      ? Math.max(...streamIncoming.map(change => change.at.getTime()), state.live.lastChangeAt || 0)
      : state.live.lastChangeAt
    const hadEvents = incoming.length > 0
    const invalidatedCaches = invalidateLiveCaches(
      state.live.drawings,
      state.live.noteBodies,
      incoming,
    )
    const quietReadsBefore = state.live.quietReads
    const nextDelay = visibilityInterrupted
      ? 0
      : state.view === 'live'
      ? windowLivePollDelay(hadEvents, quietReadsBefore)
      : BASE_REFRESH_MS
    state = {
      ...state,
      live: {
        ...state.live,
        changes: merged,
        drawings: invalidatedCaches.drawings,
        noteBodies: invalidatedCaches.noteBodies,
        streamError: false,
        streamMarker: changeState.marker || state.live.streamMarker,
        quietReads: state.view === 'live'
          ? hadEvents ? 0 : quietReadsBefore + 1
          : 0,
        lastChangeAt: latestAt || null,
        nextReadAt: document.hidden ? null : Date.now() + nextDelay,
        suppressReplayOnNextRead: document.hidden || visibilityInterrupted,
      },
    }
    if (suppressReplay && streamIncoming.length) {
      queueLiveReplays(streamIncoming, false)
    } else if (replayIncoming.length) {
      queueLiveReplays(replayIncoming)
    }
    if ((incoming.length || hadStreamError) && state.view === 'live' && state.snapshot) {
      renderLive(state.snapshot)
    }
    return nextDelay
  }

  async function refreshUnchangedPresence(signal, minimumMarker) {
    const targetCount = state.snapshot?.residents.length || 0
    if (!targetCount) return []
    let residents = []
    let beforeId = null
    const seenCursors = new Set()
    while (residents.length < targetCount) {
      const url = new URL('/api/residents', window.location.origin)
      url.searchParams.set('view', 'presence')
      url.searchParams.set('limit', String(Math.min(200, targetCount - residents.length)))
      if (beforeId) url.searchParams.set('before_id', String(beforeId))
      if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal,
      })
      if (!response.ok) throw new Error('public presence unavailable')
      const payload = await response.json()
      if (!payload || typeof payload !== 'object') throw new Error('invalid public presence')
      requireExactReadMarker(payload.change_marker, minimumMarker)
      const incoming = normalizeResidents(payload.residents)
      const merged = mergeResidentRows(residents, incoming)
      if (merged.length === residents.length && residents.length < targetCount) {
        throw new Error('public presence did not advance')
      }
      residents = merged
      if (residents.length >= targetCount) break
      if (payload.has_more !== true) throw new Error('public presence ended early')
      const nextBeforeId = safeId(payload.next_before_id)
      if (!nextBeforeId || seenCursors.has(nextBeforeId)) {
        throw new Error('invalid public presence cursor')
      }
      seenCursors.add(nextBeforeId)
      beforeId = nextBeforeId
    }
    return residents.slice(0, targetCount)
  }

  function scheduleRefresh(delay) {
    window.clearTimeout(state.pollTimer)
    if (state.live.proofScene) {
      state = { ...state, pollTimer: 0, live: { ...state.live, nextReadAt: null } }
      renderLiveClock()
      return
    }
    const pollTimer = window.setTimeout(() => {
      if (document.hidden) {
        scheduleRefresh(BASE_REFRESH_MS)
        return
      }
      void refreshCity()
    }, delay)
    state = {
      ...state,
      pollTimer,
      live: { ...state.live, nextReadAt: document.hidden ? null : Date.now() + delay },
    }
    if (state.view === 'live') renderLiveClock()
  }

  async function finishWatchingPublicStreets() {
    const gazetteFresh = state.view !== 'gazette' || await loadGazetteIssues(
      state.gazette.listInitialized ? 'refresh' : 'initial',
    )
    if (state.view === 'gazette' && !gazetteFresh) {
      setStatus('The public streets are current. The Gazette could not be refreshed.', 'stale')
      return
    }
    setStatus('Watching the public streets', 'live')
  }

  async function refreshCity() {
    if (state.refreshing || state.live.proofScene) return
    const hadSnapshot = state.hasSnapshot
    const navigationRevisionAtStart = navigationRevision
    state = { ...state, refreshing: true }
    if (!state.hasSnapshot) setStatus('Loading the current public city view…', 'working')
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let nextDelay = BASE_REFRESH_MS
    try {
      // A confirmed unchanged marker lets the window avoid downloading the
      // same authored text. Presence is refreshed separately because asleep is
      // time-derived and can change without a database event. If the marker or
      // presence read is unavailable, the complete bounded snapshot remains the
      // safe fallback.
      const changeState = await checkPublicChanges()
      if (state.live.proofScene) return
      nextDelay = commitLiveChangeRead(changeState)
      if (state.hasSnapshot && changeState.status === 'unchanged' &&
          state.changeMarker === changeState.marker) {
        try {
          const residents = await refreshUnchangedPresence(
            controller.signal,
            changeState.marker,
          )
          if (navigationRevision !== navigationRevisionAtStart) {
            await finishWatchingPublicStreets()
            return
          }
          const residentPresentationChanged =
            residentPresentationKey({ residents }) !== residentPresentationKey(state.snapshot)
          if (!residentPresentationChanged) {
            state = {
              ...state,
              changeMarker: changeState.marker,
              failures: 0,
            }
            await finishWatchingPublicStreets()
            return
          }
          const snapshot = Object.freeze({
            ...state.snapshot,
            residents,
            shown: Object.freeze({ ...state.snapshot.shown, residents: residents.length }),
            refreshedAt: new Date(),
          })
          state = {
            ...state,
            snapshot,
            changeMarker: changeState.marker,
            failures: 0,
          }
          populateFilters(snapshot)
          renderAll()
          void ensureFocusedSelection({ forceResident: true })
          await finishWatchingPublicStreets()
          return
        } catch {
          // Presence is time-derived. If its small read fails, continue into a
          // marker-covered authored snapshot instead of retaining an unproven
          // mixed refresh.
        }
      }
      const requiredMarker = changeState.marker || state.changeMarker
      const payload = await getSnapshot(controller.signal, requiredMarker)
      if (state.live.proofScene) return
      const freshSnapshot = normalizeSnapshot(payload)
      if (requiredMarker && !markerCovers(freshSnapshot.changeMarker, requiredMarker)) {
        throw new Error('public snapshot does not cover the requested change marker')
      }
      const replaceAuthored = !state.hasSnapshot || !state.changeMarker ||
        changeState.status === 'changed' || freshSnapshot.changeMarker !== state.changeMarker
      const navigation = replaceAuthored
        ? freshSnapshotNavigation(freshSnapshot)
        : await mergeFreshNavigation(freshSnapshot, controller.signal)
      if (navigationRevision !== navigationRevisionAtStart) {
        await finishWatchingPublicStreets()
        return
      }
      const snapshot = navigation.snapshot
      const histories = replaceAuthored
        ? freshSnapshotHistories(snapshot)
        : mergeUnchangedSnapshotHistories(snapshot)
      const archive = replaceAuthored
        ? {
            ...state.archive,
            results: [], totalItems: 0, totalTextBytes: 0, nextBefore: null,
            hasMore: false, loading: false, initialized: false, error: null,
          }
        : state.archive
      const invalidateSnapshotCaches = hadSnapshot && replaceAuthored &&
        changeState.status !== 'changed'
      if (replaceAuthored) authoredRevision += 1
      state = {
        ...state,
        snapshot,
        branches: navigation.branches,
        residentPaging: navigation.residentPaging,
        histories,
        archive,
        thingIndex: replaceAuthored
          ? {
              scopeKey: '', rows: [], nextBeforeId: null, hasMore: false,
              loading: false, initialized: false, error: false,
            }
          : state.thingIndex,
        thingLookup: replaceAuthored
          ? { query: '', rows: [], hasMore: false, loading: false, error: false }
          : state.thingLookup,
        live: invalidateSnapshotCaches
          ? {
              ...state.live,
              drawings: {},
              noteBodies: {},
            }
          : state.live,
        fullBodies: replaceAuthored ? {} : state.fullBodies,
        details: replaceAuthored ? {} : state.details,
        detailDrawings: replaceAuthored ? {} : state.detailDrawings,
        detailDrawingHistories: replaceAuthored ? {} : state.detailDrawingHistories,
        changeMarker: freshSnapshot.changeMarker || requiredMarker,
        hasSnapshot: true,
        failures: 0,
      }
      populateFilters(snapshot)
      renderAll()
      void ensureDetail(replaceAuthored)
      loadSharedArchiveQuestion()
      if (hadSnapshot && replaceAuthored &&
          (state.directory.loaded || state.directory.error) && !state.directory.loading) {
        void loadDirectory(true)
      }
      void ensureFocusedSelection({ forcePlace: replaceAuthored, forceResident: true })
      refreshFilteredViews()
      await finishWatchingPublicStreets()
    } catch {
      const failures = state.failures + 1
      state = {
        ...state,
        failures,
        live: {
          ...state.live,
          // A failed snapshot did not prove the new rows belong to a completed
          // view. Re-read them from the last completed marker; queued keys stay
          // held and cannot replay twice when the covering snapshot succeeds.
          streamMarker: state.changeMarker,
        },
      }
      nextDelay = Math.min(BASE_REFRESH_MS * Math.pow(2, failures), MAX_REFRESH_MS)
      if (state.hasSnapshot) {
        renderGlobalReadRetry(
          'The updated public city view could not be read. Showing the previous completed view.',
          'stale',
        )
      } else {
        renderGlobalReadFailure()
      }
    } finally {
      window.clearTimeout(timeout)
      state = { ...state, refreshing: false }
      scheduleRefresh(nextDelay)
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      const view = tab.dataset.view
      if (!VIEWS.includes(view)) return
      const openingGazette = view === 'gazette'
      let placeId = state.placeId
      if (view === 'place' && !state.resident && !state.placeId &&
        !selectedPlace(state.snapshot || { residents: [], flatPlaces: [] })) {
        placeId = state.snapshot?.flatPlaces[0]?.id || null
      }
      if (!openingGazette && state.view !== 'gazette') {
        navigate({ view, placeId, detail: null })
        return
      }
      if (openingGazette && nodes.directorySearch) nodes.directorySearch.value = ''
      navigate({
        view,
        placeId: openingGazette ? null : placeId,
        resident: openingGazette ? null : state.resident,
        conversationContext: openingGazette ? false : state.conversationContext,
        directorySearch: openingGazette ? '' : state.directorySearch,
        directorySearchIndex: openingGazette ? -1 : state.directorySearchIndex,
        sleeperPlaceIds: openingGazette ? [] : state.sleeperPlaceIds,
        gazetteIssueId: openingGazette
          ? state.view === 'gazette' ? state.gazetteIssueId : null
          : null,
        detail: null,
      })
    })
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const current = tabs.indexOf(tab)
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
        (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
      tabs[index]?.focus()
      rovingTabActivation = true
      try {
        tabs[index]?.click()
      } finally {
        rovingTabActivation = false
      }
    })
  }

  for (const button of viewShareButtons) {
    button.addEventListener('click', () => void copyCurrentShareLink(button))
  }
  detailShareButton?.addEventListener('click', () => void copyCurrentShareLink(detailShareButton))
  nodes.detailClose?.addEventListener('click', closeDetail)
  nodes.detail?.addEventListener('click', event => {
    if (event.target === nodes.detail) closeDetail()
  })
  nodes.detail?.addEventListener('cancel', event => {
    event.preventDefault()
    closeDetail()
  })

  nodes.directorySearch?.addEventListener('input', () => {
    state = {
      ...state,
      directorySearch: String(nodes.directorySearch.value || '').slice(0, 100),
      directorySearchIndex: 0,
    }
    writeLocation(false)
    if (state.snapshot) renderDirectorySearch(state.snapshot, true)
    scheduleThingLookup(state.directorySearch)
  })
  nodes.directorySearch?.addEventListener('focus', () => {
    if (state.snapshot && state.directorySearch) renderDirectorySearch(state.snapshot, true)
  })
  nodes.directorySearch?.addEventListener('blur', () => {
    window.setTimeout(() => {
      if (document.activeElement !== nodes.directorySearch) closeDirectorySearchResults()
    }, 0)
  })
  nodes.directorySearch?.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.directorySearch) {
      event.preventDefault()
      nodes.directorySearch.value = ''
      state = { ...state, directorySearch: '', directorySearchIndex: -1 }
      scheduleThingLookup('', 0)
      writeLocation(false)
      if (state.snapshot) renderDirectorySearch(state.snapshot, false)
      return
    }
    if (!state.snapshot || !['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
    const results = directorySearchRows(state.snapshot)
    if (!results.length) return
    event.preventDefault()
    if (event.key === 'Enter') {
      selectDirectorySearchResult(Math.max(0, state.directorySearchIndex))
      return
    }
    const offset = event.key === 'ArrowDown' ? 1 : -1
    const current = Math.max(0, state.directorySearchIndex)
    state = {
      ...state,
      directorySearchIndex: (current + offset + results.length) % results.length,
    }
    renderDirectorySearch(state.snapshot, true)
  })
  nodes.placeFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      placeId: safeId(nodes.placeFilter.value),
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
    if (state.snapshot) populateFilters(state.snapshot)
  })
  nodes.residentFilter?.addEventListener('change', () => {
    if (nodes.directorySearch) nodes.directorySearch.value = ''
    closeDirectorySearchResults()
    navigate({
      resident: safeHandle(nodes.residentFilter.value),
      conversationContext: false,
      directorySearch: '',
      directorySearchIndex: -1,
      detail: null,
    })
  })
  nodes.archiveSearch?.addEventListener('click', () => void loadArchive(true))
  nodes.archiveQuery?.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    void loadArchive(true)
  })
  function syncStateFromLocation() {
    const previousView = state.view
    const previousReplayScope = [state.view, state.placeId, state.resident].join(':')
    const nextLocationState = readLocationState()
    const clearsLiveFocus = nextLocationState.view === 'live' &&
      Boolean(nextLocationState.resident)
    const nextReplayScope = [
      nextLocationState.view, nextLocationState.placeId, nextLocationState.resident,
    ].join(':')
    if (previousReplayScope !== nextReplayScope && liveReplayHeldKeys().size) {
      settleLiveReplays()
    }
    if (nextLocationState.archive !== state.archive) archiveRequestRevision += 1
    if (
      nextLocationState.gazetteIssueId !== state.gazetteIssueId ||
      nextLocationState.view !== state.view
    ) gazetteDetailRequestRevision += 1
    if (
      nextLocationState.detail?.kind !== state.detail?.kind ||
      nextLocationState.detail?.id !== state.detail?.id
    ) {
      detailRequestRevision += 1
      detailDrawingRequestRevision += 1
      detailDrawingHistoryRequestRevision += 1
    }
    resetShareFeedback()
    if (clearsLiveFocus && state.live.focusResident) storeLiveFocusResident(null)
    state = {
      ...state,
      ...nextLocationState,
      live: clearsLiveFocus ? { ...state.live, focusResident: null } : state.live,
    }
    syncLiveFullscreenFromHistory()
    syncArchiveControls()
    renderAll()
    void ensureFocusedSelection()
    void ensureDetail()
    loadSharedArchiveQuestion()
    if (state.view !== previousView) {
      scheduleRefresh(state.view === 'live' && !document.hidden ? 0 : BASE_REFRESH_MS)
    }
    loadSharedGazette()
  }
  nodes.liveViewport?.addEventListener('wheel', event => {
    event.preventDefault()
    const factor = Math.exp(-event.deltaY * 0.0015)
    zoomLivePlateAt(event.clientX, event.clientY, liveCamera.scale * factor)
  }, { passive: false })
  nodes.liveViewport?.addEventListener('keydown', event => {
    if (event.target !== nodes.liveViewport) return
    const pan = 48
    if (event.key === '0') {
      event.preventDefault()
      centerLivePlate()
      return
    }
    if (event.key === '+' || event.key === '=' || event.key === '-') {
      event.preventDefault()
      const rect = nodes.liveViewport.getBoundingClientRect()
      const factor = event.key === '-' ? 1 / 1.2 : 1.2
      zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
        liveCamera.scale * factor)
      return
    }
    const offset = {
      ArrowLeft: [pan, 0], ArrowRight: [-pan, 0],
      ArrowUp: [0, pan], ArrowDown: [0, -pan],
    }[event.key]
    if (!offset) return
    event.preventDefault()
    applyLiveCamera({
      offsetX: liveCamera.offsetX + offset[0],
      offsetY: liveCamera.offsetY + offset[1],
    })
  })
  nodes.liveViewport?.addEventListener('pointerdown', event => {
    if (event.target instanceof Element &&
        event.target.closest('button, a, input, select, textarea, [role="button"]')) return
    event.preventDefault()
    nodes.liveViewport.dataset.liveDragging = 'true'
    beginLivePointer(event)
  })
  nodes.liveViewport?.addEventListener('pointermove', event => {
    if (!Object.hasOwn(livePointers, String(event.pointerId))) return
    event.preventDefault()
    moveLivePointer(event)
  })
  for (const eventName of ['pointerup', 'pointercancel']) {
    nodes.liveViewport?.addEventListener(eventName, event => {
      endLivePointer(event)
      if (!livePointerValues().length && nodes.liveViewport) {
        nodes.liveViewport.dataset.liveDragging = 'false'
      }
    })
  }
  for (const eventName of ['pointerover', 'pointerout', 'focusin', 'focusout']) {
    nodes.livePlates?.addEventListener(eventName, event => {
      if (event.target?.closest?.('.live-walker, .live-replay-portrait')) {
        scheduleLiveResidentLabels(true)
      }
    })
  }
  nodes.liveZoomIn?.addEventListener('click', () => {
    const rect = nodes.liveViewport?.getBoundingClientRect()
    if (rect) zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
      liveCamera.scale * 1.2)
  })
  nodes.liveZoomOut?.addEventListener('click', () => {
    const rect = nodes.liveViewport?.getBoundingClientRect()
    if (rect) zoomLivePlateAt(rect.left + rect.width / 2, rect.top + rect.height / 2,
      liveCamera.scale / 1.2)
  })
  nodes.liveCenter?.addEventListener('click', centerLivePlate)
  nodes.liveProof?.addEventListener('click', startLiveProofScene)
  nodes.liveFullscreen?.addEventListener('click', () => {
    if (document.getElementById('live-panel')?.dataset.liveFullscreen === 'true') {
      exitLiveFullscreen()
    } else {
      enterLiveFullscreen()
    }
  })
  nodes.livePause?.addEventListener('click', () => {
    const paused = !state.live.paused
    state = { ...state, live: { ...state.live, paused } }
    nodes.livePause.setAttribute('aria-pressed', String(paused))
    nodes.livePause.textContent = paused ? 'Resume walks' : 'Pause walks'
    if (!paused) window.queueMicrotask(startLiveReplays)
  })
  window.addEventListener('hashchange', syncStateFromLocation)
  window.addEventListener('popstate', syncStateFromLocation)
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' ||
        document.getElementById('live-panel')?.dataset.liveFullscreen !== 'true') return
    event.preventDefault()
    exitLiveFullscreen()
  })
  window.addEventListener('resize', () => {
    scheduleBodyDisclosureSync()
    if (state.view === 'live' && state.snapshot) {
      renderLive(state.snapshot)
    }
  })
  document.addEventListener('visibilitychange', () => {
    const hidden = document.hidden
    if (hidden !== liveWasHidden) {
      liveWasHidden = hidden
      liveVisibilityRevision += 1
    }
    window.clearTimeout(state.pollTimer)
    if (hidden) {
      if (liveReplayHeldKeys().size) settleLiveReplays()
      state = { ...state, pollTimer: 0, live: {
        ...state.live,
        nextReadAt: null,
        openingReplaySuppressed: true,
        suppressReplayOnNextRead: true,
      } }
      renderLiveClock()
    } else {
      drainLiveDrawingQueue()
      drainLiveNoteQueue()
      if (state.view === 'live' && state.snapshot) {
        renderLive(state.snapshot)
        if (!state.live.openingLoaded && !state.live.openingLoading) {
          void loadLiveOpeningHistory(state.snapshot, Boolean(
            state.live.openingNextBeforeId || state.live.openingEvents.length))
        }
      }
      void refreshCity()
    }
  })
  LIVE_MOTION_PREFERENCE.addEventListener?.('change', () => {
    if (LIVE_MOTION_PREFERENCE.matches) settleLiveReplays()
    if (state.view === 'live' && state.snapshot) renderLive(state.snapshot)
  })

  const initialLocationState = readLocationState()
  let initialFocusResident = readLiveFocusResident()
  if (initialLocationState.view === 'live' && initialLocationState.resident) {
    if (initialFocusResident) storeLiveFocusResident(null)
    initialFocusResident = null
  }
  state = {
    ...state,
    ...initialLocationState,
    live: { ...state.live, focusResident: initialFocusResident },
  }
  syncArchiveControls()
  renderView()
  writeLocation(false)
  syncLiveFullscreenFromHistory()
  void ensureDetail()
  loadSharedGazette()
  void loadDirectory(false)
  void refreshCity()
})()
`
