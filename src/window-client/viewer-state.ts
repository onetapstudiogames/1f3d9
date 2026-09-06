export const WINDOW_VIEWER_OPEN_STORAGE_KEY = '1f3d9:window:open-records'

export function parseWindowViewerOpenKeys(
  value: string | null,
): string[] {
  if (
    typeof value !== 'string' ||
    value.length > 16_384
  ) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []

  const keys: string[] = []
  const seen = new Set<string>()
  for (const value of parsed) {
    if (typeof value !== 'string') continue
    const match = /^(?:note|thing|agreement):([1-9]\d*)$/u.exec(value)
    if (!match || !Number.isSafeInteger(Number(match[1]))) continue
    if (!seen.has(value)) {
      seen.add(value)
      keys.push(value)
    }
  }
  return keys.slice(-200)
}
