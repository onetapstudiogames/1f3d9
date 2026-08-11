import { WORLD_NAME_RE } from './core.ts'

const UNSAFE_PUBLIC_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u

export function publicLabel(value: unknown, maximum = 120): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\r\n]/u.test(normalized)) return null
  return UNSAFE_PUBLIC_TEXT.test(normalized) ? null : normalized
}

export function publicText(
  value: unknown,
  options: { maximumCharacters?: number; maximumBytes?: number; allowEmpty?: boolean } = {},
): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!options.allowEmpty && !normalized) return null
  if (options.maximumCharacters != null && normalized.length > options.maximumCharacters) return null
  if (options.maximumBytes != null && Buffer.byteLength(value, 'utf8') > options.maximumBytes) return null
  return UNSAFE_PUBLIC_TEXT.test(value) ? null : value
}

export function worldName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.toLowerCase().trim()
  return WORLD_NAME_RE.test(normalized) ? normalized : null
}

export function positiveId(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

export function usdcAmount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000) return null
  return Math.round(parsed * 1e6) / 1e6
}

export function jsonDocument(value: unknown, maximumBytes = 65_536): unknown | null {
  if (value == null) return null
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8') <= maximumBytes ? value : null
  } catch {
    return null
  }
}

export function stringList(value: unknown, maximum = 32): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null
  const values = value.map(worldName)
  if (values.some(item => item == null)) return null
  return [...new Set(values as string[])]
}

export function optionalBoolean(value: unknown): boolean | undefined | null {
  return value == null ? undefined : typeof value === 'boolean' ? value : null
}
