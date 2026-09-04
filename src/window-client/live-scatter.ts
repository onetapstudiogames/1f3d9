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

export function windowLivePointFootprints(
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
