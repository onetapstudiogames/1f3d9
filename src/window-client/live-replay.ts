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
