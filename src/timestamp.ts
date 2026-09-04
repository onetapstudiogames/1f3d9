export function isoTimestamp(value: unknown): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(String(value))
  if (Number.isNaN(date.getTime())) throw new TypeError('invalid timestamp row')
  return date.toISOString()
}
