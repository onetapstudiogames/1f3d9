export type StageGroundPlace = Readonly<{
  id: string | number
  parent_id: string | number | null
  name?: string
}>

export type StageRoomBox = Readonly<{
  id: string | number
  parentId: string | number
  x: number
  y: number
  width: number
  height: number
  door: Readonly<{ x: number; y: number; side: 'left' | 'right' }>
}>

export type StageCellEntry = Readonly<{
  key: string
  kind: 'resident' | 'thing'
  label: string
}>

export type StageCell = Readonly<{
  key: string
  kind: 'resident' | 'thing'
  x: number
  y: number
  width: number
  height: number
  row: number
  column: number
}>

export type StageExpandedGround = Readonly<{
  x: number
  residentTop: number | null
  thingTop: number | null
  width: number
  bottom: number
}>

export type StageCorridorNode = Readonly<{
  id: string
  kind: 'door' | 'corner'
  roomId: string | null
  x: number
  y: number
}>

export type StageCorridorGraph = Readonly<{
  nodes: Readonly<Record<string, StageCorridorNode>>
  edges: readonly Readonly<{ from: string; to: string; distance: number }>[]
  roomDoors: Readonly<Record<string, string>>
}>

export const STAGE_ROOM_DRAWING_CONTROL_RECT = Object.freeze({
  x: 6,
  y: 286,
  width: 100,
  height: 44,
})
export const STAGE_PARENT_ROOM_HEIGHT = 680

export function stageChildPlaces<T extends Readonly<{
  id: string | number
  parent_id: string | number | null
}>>(places: readonly T[], parentId: string | number): readonly T[] {
  const parentKey = String(parentId)
  return Object.freeze(places.filter(place => String(place.parent_id) === parentKey)
    .sort((left, right) => {
      const leftNumber = Number(left.id)
      const rightNumber = Number(right.id)
      if (Number.isSafeInteger(leftNumber) && Number.isSafeInteger(rightNumber)) {
        return leftNumber - rightNumber
      }
      return String(left.id).localeCompare(String(right.id))
    }))
}

export function stageRoomLayout(
  places: readonly StageGroundPlace[],
  parentId: string | number,
): Readonly<{
  rooms: Readonly<Record<string, StageRoomBox>>
  width: number
  height: number
}> {
  const roomWidth = 440
  const roomHeight = 280
  const parentWidth = 1_100
  const corridorWidth = 80
  const roomGap = 80
  const top = 48
  const rooms: Record<string, StageRoomBox> = {}
  const children = stageChildPlaces(places, parentId)
  for (const [index, place] of children.entries()) {
    const id = String(place.id)
    const x = parentWidth + corridorWidth
    const y = top + index * (roomHeight + roomGap)
    rooms[id] = Object.freeze({
      id: place.id,
      parentId,
      x,
      y,
      width: roomWidth,
      height: roomHeight,
      door: Object.freeze({ x, y: y + roomHeight / 2, side: 'left' as const }),
    })
  }
  return Object.freeze({
    rooms: Object.freeze(rooms),
    width: children.length ? parentWidth + corridorWidth + roomWidth + 64 : parentWidth,
    height: Math.max(STAGE_PARENT_ROOM_HEIGHT,
      top + children.length * (roomHeight + roomGap)),
  })
}

export function stageAssignCells(
  entries: readonly StageCellEntry[],
  room: Readonly<{ x: number; y: number; width: number; height: number }>,
  previous: Readonly<Record<string, StageCell>> = {},
): Readonly<Record<string, StageCell>> {
  if (![room.x, room.y, room.width, room.height].every(Number.isFinite) ||
      room.width <= 0 || room.height <= 0) return Object.freeze({})
  const spriteSize = 32
  const clearance = spriteSize / 2
  const pitch = spriteSize + clearance
  const inset = 24
  const columns = Math.max(1, Math.floor((room.width - inset * 2 + clearance) / pitch))
  const rows = Math.max(1, Math.floor((room.height - inset * 2 + clearance) / pitch))
  const ordered = [...new Map(entries.filter(entry =>
    (entry.kind === 'resident' || entry.kind === 'thing') &&
      typeof entry.key === 'string' && entry.key.length > 0 &&
      typeof entry.label === 'string')
    .map(entry => [entry.key, entry])).values()]
    .sort((left, right) => left.label.localeCompare(right.label) ||
      left.key.localeCompare(right.key))
  const validKeys = new Set(ordered.map(entry => entry.key))
  const occupied = new Set<number>()
  const result: Record<string, StageCell> = {}
  for (const entry of ordered) {
    const cell = previous[entry.key]
    if (!cell || !validKeys.has(entry.key) || cell.kind !== entry.kind ||
        !Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column) ||
        cell.row < 0 || cell.row >= rows || cell.column < 0 || cell.column >= columns) continue
    const slot = cell.row * columns + cell.column
    if (occupied.has(slot)) continue
    const expectedX = room.x + inset + cell.column * pitch
    const expectedY = room.y + inset + cell.row * pitch
    if (cell.x !== expectedX || cell.y !== expectedY ||
        cell.width !== spriteSize || cell.height !== spriteSize) continue
    occupied.add(slot)
    result[entry.key] = Object.freeze({ ...cell, key: entry.key, kind: entry.kind })
  }
  for (const entry of ordered) {
    if (result[entry.key]) continue
    let slot = -1
    for (let candidate = 0; candidate < columns * rows; candidate += 1) {
      if (!occupied.has(candidate)) {
        slot = candidate
        break
      }
    }
    if (slot < 0) continue
    const row = Math.floor(slot / columns)
    const column = slot % columns
    occupied.add(slot)
    result[entry.key] = Object.freeze({
      key: entry.key,
      kind: entry.kind,
      x: room.x + inset + column * pitch,
      y: room.y + inset + row * pitch,
      width: spriteSize,
      height: spriteSize,
      row,
      column,
    })
  }
  return Object.freeze(result)
}

export function stageCellRoomHeight(
  width: number,
  count: number,
  minimumHeight = 280,
): number {
  if (![width, count, minimumHeight].every(Number.isFinite) ||
      width <= 0 || count < 0 || minimumHeight <= 0) return 0
  const spriteSize = 32
  const clearance = spriteSize / 2
  const pitch = spriteSize + clearance
  const inset = 24
  const columns = Math.max(1, Math.floor((width - inset * 2 + clearance) / pitch))
  const rows = Math.ceil(Math.floor(count) / columns)
  return Math.max(Math.ceil(minimumHeight), inset * 2 + rows * pitch - clearance)
}

export function stageExpandedGroundLayout(
  rooms: readonly Readonly<{
    id: string | number
    x: number
    y: number
    width: number
    height: number
  }>[],
  expansions: readonly Readonly<{
    id: string | number
    residentHeight: number
    thingHeight: number
  }>[],
  groundWidth = 440,
  gap = 16,
  controlRailDepth = 64,
): Readonly<{
  grounds: Readonly<Record<string, StageExpandedGround>>
  width: number
  height: number
}> {
  const safeGroundWidth = Number.isFinite(groundWidth) && groundWidth > 0
    ? groundWidth
    : 440
  const safeGap = Number.isFinite(gap) && gap >= 0 ? gap : 16
  const safeRailDepth = Number.isFinite(controlRailDepth) && controlRailDepth >= 0
    ? controlRailDepth
    : 64
  const roomById = new Map(rooms.filter(room =>
    [room.x, room.y, room.width, room.height].every(Number.isFinite) &&
      room.width > 0 && room.height > 0)
    .map(room => [String(room.id), room]))
  const fixed = [...roomById.values()].map(room => Object.freeze({
    x: room.x,
    y: room.y,
    width: room.width,
    height: room.height + safeRailDepth,
  }))
  const obstacles = [...fixed]
  const grounds: Record<string, StageExpandedGround> = {}
  const ordered = expansions.filter(expansion =>
    roomById.has(String(expansion.id)) &&
      [expansion.residentHeight, expansion.thingHeight].every(Number.isFinite) &&
      expansion.residentHeight >= 0 && expansion.thingHeight >= 0 &&
      (expansion.residentHeight > 0 || expansion.thingHeight > 0))
    .sort((left, right) => {
      const leftRoom = roomById.get(String(left.id))!
      const rightRoom = roomById.get(String(right.id))!
      return leftRoom.y - rightRoom.y || leftRoom.x - rightRoom.x ||
        String(left.id).localeCompare(String(right.id))
    })
  for (const expansion of ordered) {
    const room = roomById.get(String(expansion.id))!
    const totalHeight = expansion.residentHeight + expansion.thingHeight +
      (expansion.residentHeight > 0 && expansion.thingHeight > 0 ? safeGap : 0)
    let top = room.y + room.height + safeRailDepth + safeGap
    while (true) {
      const overlapping = obstacles.filter(obstacle =>
        room.x < obstacle.x + obstacle.width + safeGap &&
        room.x + safeGroundWidth + safeGap > obstacle.x &&
        top < obstacle.y + obstacle.height + safeGap &&
        top + totalHeight + safeGap > obstacle.y)
      if (!overlapping.length) break
      top = Math.max(...overlapping.map(obstacle =>
        obstacle.y + obstacle.height + safeGap))
    }
    const residentTop = expansion.residentHeight > 0 ? top : null
    const thingTop = expansion.thingHeight > 0
      ? top + expansion.residentHeight +
        (expansion.residentHeight > 0 ? safeGap : 0)
      : null
    const ground = Object.freeze({
      x: room.x,
      residentTop,
      thingTop,
      width: safeGroundWidth,
      bottom: top + totalHeight,
    })
    grounds[String(expansion.id)] = ground
    obstacles.push(Object.freeze({
      x: ground.x,
      y: top,
      width: ground.width,
      height: totalHeight,
    }))
  }
  return Object.freeze({
    grounds: Object.freeze(grounds),
    width: Math.max(0, ...fixed.map(area => area.x + area.width),
      ...Object.values(grounds).map(ground => ground.x + ground.width)),
    height: Math.max(0, ...fixed.map(area => area.y + area.height),
      ...Object.values(grounds).map(ground => ground.bottom)),
  })
}

export function stageBuildCorridorGraph(
  rooms: readonly StageRoomBox[],
): StageCorridorGraph {
  const validRooms = rooms.filter(room =>
    [room.x, room.y, room.width, room.height, room.door.x, room.door.y]
      .every(Number.isFinite) && room.width > 0 && room.height > 0)
    .sort((left, right) => left.door.y - right.door.y ||
      String(left.id).localeCompare(String(right.id)))
  const nodes: Record<string, StageCorridorNode> = {}
  const roomDoors: Record<string, string> = {}
  const edges: Array<Readonly<{ from: string; to: string; distance: number }>> = []
  const railX = validRooms.length ? Math.max(...validRooms.map(room => room.door.x)) - 40 : 0
  const corners: string[] = []
  for (const room of validRooms) {
    const roomId = String(room.id)
    const doorId = 'door:' + roomId
    const cornerId = 'corner:' + roomId
    nodes[doorId] = Object.freeze({
      id: doorId, kind: 'door', roomId, x: room.door.x, y: room.door.y,
    })
    nodes[cornerId] = Object.freeze({
      id: cornerId, kind: 'corner', roomId: null, x: railX, y: room.door.y,
    })
    roomDoors[roomId] = doorId
    corners.push(cornerId)
    edges.push(Object.freeze({
      from: doorId,
      to: cornerId,
      distance: Math.abs(room.door.x - railX),
    }))
  }
  for (let index = 1; index < corners.length; index += 1) {
    const from = nodes[corners[index - 1]!]
    const to = nodes[corners[index]!]
    if (!from || !to) continue
    edges.push(Object.freeze({ from: from.id, to: to.id, distance: Math.abs(to.y - from.y) }))
  }
  return Object.freeze({
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    roomDoors: Object.freeze(roomDoors),
  })
}

export function stageShortestPath(
  graph: StageCorridorGraph,
  fromRoomId: string | number,
  toRoomId: string | number,
): readonly StageCorridorNode[] {
  const start = graph.roomDoors[String(fromRoomId)]
  const finish = graph.roomDoors[String(toRoomId)]
  if (!start || !finish || !graph.nodes[start] || !graph.nodes[finish]) return Object.freeze([])
  if (start === finish) return Object.freeze([graph.nodes[start]!])
  const neighbours = new Map<string, Array<Readonly<{ id: string; distance: number }>>>()
  for (const edge of graph.edges) {
    neighbours.set(edge.from, [...(neighbours.get(edge.from) || []),
      Object.freeze({ id: edge.to, distance: edge.distance })])
    neighbours.set(edge.to, [...(neighbours.get(edge.to) || []),
      Object.freeze({ id: edge.from, distance: edge.distance })])
  }
  const distance = new Map<string, number>([[start, 0]])
  const previous = new Map<string, string>()
  const remaining = new Set(Object.keys(graph.nodes))
  while (remaining.size) {
    const current = [...remaining].sort((left, right) =>
      (distance.get(left) ?? Number.POSITIVE_INFINITY) -
        (distance.get(right) ?? Number.POSITIVE_INFINITY) || left.localeCompare(right))[0]
    if (!current || !Number.isFinite(distance.get(current))) break
    remaining.delete(current)
    if (current === finish) break
    for (const neighbour of neighbours.get(current) || []) {
      if (!remaining.has(neighbour.id)) continue
      const nextDistance = distance.get(current)! + neighbour.distance
      const heldDistance = distance.get(neighbour.id) ?? Number.POSITIVE_INFINITY
      if (nextDistance < heldDistance ||
          (nextDistance === heldDistance && current < (previous.get(neighbour.id) || ''))) {
        distance.set(neighbour.id, nextDistance)
        previous.set(neighbour.id, current)
      }
    }
  }
  if (!previous.has(finish)) return Object.freeze([])
  const ids = [finish]
  while (ids[0] !== start) {
    const prior = previous.get(ids[0]!)
    if (!prior) return Object.freeze([])
    ids.unshift(prior)
  }
  return Object.freeze(ids.map(id => graph.nodes[id]!))
}

export function stageQuietRoom(
  place: Readonly<{
    name: string
    owner: string | null
    quiet: boolean
    counts: Readonly<{ residents: number; things: number }>
  }>,
  box: StageRoomBox,
): Readonly<{
  box: StageRoomBox
  name: string
  owner: string | null
  counts: Readonly<{ residents: number; things: number }>
  cells: readonly never[]
}> | null {
  if (place.quiet !== true || typeof place.name !== 'string' ||
      (place.owner !== null && typeof place.owner !== 'string') ||
      !Number.isSafeInteger(place.counts.residents) || place.counts.residents < 0 ||
      !Number.isSafeInteger(place.counts.things) || place.counts.things < 0) return null
  return Object.freeze({
    box,
    name: place.name,
    owner: place.owner,
    counts: Object.freeze({
      residents: place.counts.residents,
      things: place.counts.things,
    }),
    cells: Object.freeze([]),
  })
}
