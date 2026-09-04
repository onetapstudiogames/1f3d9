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
