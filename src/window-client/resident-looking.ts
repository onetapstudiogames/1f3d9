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
