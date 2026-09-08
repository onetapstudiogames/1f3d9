export function windowLivePollDelay(hadEvents: boolean, quietReads: number): number {
  if (hadEvents) return 25000
  return [60000, 120000, 240000, 300000][Math.min(3, Math.max(0, quietReads))]!
}

export type WindowResidentLooking = Readonly<{
  place_id: number
  started_at: Date
  expires_at: Date
}>

export function normalizeWindowResidentLooking(
  value: unknown,
  currentPlaceId: number | null,
): WindowResidentLooking | null {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(currentPlaceId) ||
      Number(currentPlaceId) <= 0) return null
  const raw = value as Readonly<Record<string, unknown>>
  const placeId = raw.place_id
  if (!Number.isSafeInteger(placeId) || Number(placeId) <= 0 || placeId !== currentPlaceId) return null
  const startedAt = raw.started_at instanceof Date
    ? new Date(raw.started_at.getTime())
    : typeof raw.started_at === 'string' ? new Date(raw.started_at) : new Date(Number.NaN)
  const expiresAt = raw.expires_at instanceof Date
    ? new Date(raw.expires_at.getTime())
    : typeof raw.expires_at === 'string' ? new Date(raw.expires_at) : new Date(Number.NaN)
  if (!Number.isFinite(startedAt.getTime()) || !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= startedAt.getTime()) return null
  return Object.freeze({ place_id: Number(placeId), started_at: startedAt, expires_at: expiresAt })
}

export function windowLiveLookingUpdate(
  previousBurstsByHandle: Readonly<Record<string, string>>,
  residents: readonly Readonly<{
    handle: string
    current_place_id: number | null
    looking?: WindowResidentLooking | null
  }>[],
  visiblePlaceIds: ReadonlySet<number>,
  quietPlaceIds: ReadonlySet<number>,
  now: number,
  announce: boolean,
  clockSkewMs = 5_000,
): Readonly<{
  burstsByHandle: Readonly<Record<string, string>>
  activeHandles: readonly string[]
  announcements: readonly Readonly<{
    burst: string
    handle: string
    place_id: number
    message: string
  }>[]
}> {
  const safeNow = Number.isFinite(now) ? now : 0
  const safeClockSkew = Number.isFinite(clockSkewMs)
    ? Math.max(0, Math.min(30_000, clockSkewMs))
    : 0
  const next: Record<string, string> = {}
  const activeHandles: string[] = []
  const announcements: Array<Readonly<{
    burst: string
    handle: string
    place_id: number
    message: string
  }>> = []
  const seenHandles = new Set<string>()
  for (const resident of residents) {
    if (!resident || typeof resident.handle !== 'string' || !resident.handle ||
        seenHandles.has(resident.handle)) continue
    seenHandles.add(resident.handle)
    const looking = normalizeWindowResidentLooking(resident.looking, resident.current_place_id)
    if (!looking || looking.expires_at.getTime() <= safeNow) continue
    const burst = String(looking.place_id) + ':' + looking.started_at.toISOString()
    next[resident.handle] = burst
    if (looking.started_at.getTime() > safeNow + safeClockSkew) continue
    const visible = visiblePlaceIds.has(looking.place_id) && !quietPlaceIds.has(looking.place_id)
    if (!visible) continue
    activeHandles.push(resident.handle)
    if (announce && previousBurstsByHandle[resident.handle] !== burst) {
      announcements.push(Object.freeze({
        burst,
        handle: resident.handle,
        place_id: looking.place_id,
        message: resident.handle + ' is looking around.',
      }))
    }
  }
  return Object.freeze({
    burstsByHandle: Object.freeze(next),
    activeHandles: Object.freeze(activeHandles),
    announcements: Object.freeze(announcements),
  })
}

export function windowLiveResidentIsDimmed(asleep: boolean, lookingActive: boolean): boolean {
  return asleep === true && lookingActive !== true
}

export function windowLiveActiveLookingAfterExpiry(
  activeHandles: readonly string[],
  cues: readonly Readonly<{ handle: string; expiresAt: number }>[],
  now: number,
): readonly string[] {
  const safeNow = Number.isFinite(now) ? now : 0
  const expired = new Set(cues.filter(cue => !Number.isFinite(cue.expiresAt) ||
    cue.expiresAt <= safeNow).map(cue => cue.handle))
  return Object.freeze([...new Set(activeHandles.filter(handle =>
    typeof handle === 'string' && handle && !expired.has(handle)))])
}

export function windowLiveTraceOpacity(at: number, now: number, lifetime: number): number {
  if (!Number.isFinite(at) || !Number.isFinite(now) || !Number.isFinite(lifetime) || lifetime <= 0) {
    return 0
  }
  return Math.max(0, Math.min(1, 1 - Math.max(0, now - at) / lifetime))
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

export function windowLiveDetailMoverSelection(
  movers: readonly Readonly<{ actor: string; x: number; y: number; order: number }>[],
  attentionActors: readonly string[],
  viewportCenter: Readonly<{ x: number; y: number }>,
  nearestLimit = 6,
): Readonly<{ detailed: readonly string[]; simple: readonly string[] }> {
  const unique = new Map<string, Readonly<{
    actor: string; x: number; y: number; order: number
  }>>()
  for (const mover of movers) {
    if (!mover || typeof mover.actor !== 'string' || !mover.actor ||
        ![mover.x, mover.y, mover.order].every(Number.isFinite) ||
        unique.has(mover.actor)) continue
    unique.set(mover.actor, mover)
  }
  const ordered = [...unique.values()]
  // attentionActors is followed-resident-first, so the cap keeps that first entry.
  const attention = new Set([...new Set(attentionActors.filter(actor => unique.has(actor)))]
    .slice(0, 3))
  const center = [viewportCenter?.x, viewportCenter?.y].every(Number.isFinite)
    ? viewportCenter
    : Object.freeze({ x: 0, y: 0 })
  const limit = Number.isFinite(nearestLimit)
    ? Math.max(0, Math.floor(nearestLimit))
    : 0
  const detailed = ordered.filter(mover => attention.has(mover.actor))
    .map(mover => mover.actor)
  detailed.push(...ordered.filter(mover => !attention.has(mover.actor))
    .sort((left, right) => {
      const leftDistance = (left.x - center.x) ** 2 + (left.y - center.y) ** 2
      const rightDistance = (right.x - center.x) ** 2 + (right.y - center.y) ** 2
      return leftDistance - rightDistance || left.order - right.order ||
        left.actor.localeCompare(right.actor)
    })
    .slice(0, limit)
    .map(mover => mover.actor))
  const detailedSet = new Set(detailed)
  return Object.freeze({
    detailed: Object.freeze(detailed),
    simple: Object.freeze(ordered.filter(mover => !detailedSet.has(mover.actor))
      .map(mover => mover.actor)),
  })
}

export function windowLiveRouteVisibilityIntervals(
  points: readonly Readonly<{ x: number; y: number }>[],
  viewport: Readonly<{ left: number; top: number; right: number; bottom: number }>,
  visibilityMargin = 0,
): readonly Readonly<{ start: number; end: number }>[] {
  if (points.length < 2 || !points.every(point => [point.x, point.y].every(Number.isFinite)) ||
      ![viewport.left, viewport.top, viewport.right, viewport.bottom, visibilityMargin]
        .every(Number.isFinite) || viewport.right < viewport.left ||
      viewport.bottom < viewport.top || visibilityMargin < 0) return Object.freeze([])
  const lengths = points.slice(1).map((point, index) =>
    Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y))
  const total = lengths.reduce((sum, length) => sum + length, 0)
  if (!(total > 0)) return Object.freeze([])
  const bounds = Object.freeze({
    left: viewport.left - visibilityMargin,
    top: viewport.top - visibilityMargin,
    right: viewport.right + visibilityMargin,
    bottom: viewport.bottom + visibilityMargin,
  })
  const intervals: Array<Readonly<{ start: number; end: number }>> = []
  let covered = 0
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!
    if (!(length > 0)) continue
    const from = points[index]!
    const to = points[index + 1]!
    const dx = to.x - from.x
    const dy = to.y - from.y
    let entry = 0
    let exit = 1
    let visible = true
    for (const [p, q] of [
      [-dx, from.x - bounds.left],
      [dx, bounds.right - from.x],
      [-dy, from.y - bounds.top],
      [dy, bounds.bottom - from.y],
    ] as const) {
      if (p === 0) {
        if (q < 0) visible = false
        continue
      }
      const ratio = q / p
      if (p < 0) entry = Math.max(entry, ratio)
      else exit = Math.min(exit, ratio)
      if (entry > exit) visible = false
    }
    if (visible) intervals.push(Object.freeze({
      start: (covered + length * entry) / total,
      end: (covered + length * exit) / total,
    }))
    covered += length
  }
  return Object.freeze(intervals)
}

export function windowLiveShouldScheduleRedraw(input: Readonly<{
  liveViewActive: boolean
  documentVisible: boolean
  panelVisible: boolean
  framePending: boolean
}>): boolean {
  return input.liveViewActive === true && input.documentVisible === true &&
    input.panelVisible === true && input.framePending === false
}

export function windowLiveFootstepBeat(
  lastAt: number | null | undefined,
  survivingMarks: number,
  now: number,
  intervalMs = 650,
): Readonly<{ due: boolean; first: boolean; nextAt: number }> {
  const safeNow = Number.isFinite(now) ? now : 0
  const previous = Number.isFinite(lastAt) && Number(lastAt) > 0 ? Number(lastAt) : 0
  const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 650
  const due = previous === 0 || safeNow - previous >= interval
  return Object.freeze({
    due,
    first: !Number.isFinite(survivingMarks) || survivingMarks <= 0,
    nextAt: due ? safeNow : previous + interval,
  })
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
