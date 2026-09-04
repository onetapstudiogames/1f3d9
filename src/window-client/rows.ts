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
