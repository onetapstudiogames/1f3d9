import { WORLD_NAME_RE } from './core.ts'

const UNSAFE_PUBLIC_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uD800-\uDFFF\u061C\u200E\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/u
const MOJIBAKE_CONTINUATION = '\\u00A0-\\u00BF\\u0152\\u0153\\u0160\\u0161\\u0178\\u017D\\u017E\\u0192\\u02C6\\u02DC\\u2013-\\u2022\\u2026\\u2030\\u2039\\u203A\\u20AC\\u2122'
const MALFORMED_PUBLIC_TEXT = new RegExp(
  `(?:\\uFFFD|[\\u00C2\\u00C3][${MOJIBAKE_CONTINUATION}]|` +
    `\\u00E2[${MOJIBAKE_CONTINUATION}]{2}|\\u00F0[${MOJIBAKE_CONTINUATION}]{3})`,
  'u',
)

function unsafePublicText(value: string): boolean {
  return UNSAFE_PUBLIC_TEXT.test(value) || MALFORMED_PUBLIC_TEXT.test(value)
}

export function publicLabel(value: unknown, maximum = 120): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum || /[\r\n]/u.test(normalized)) return null
  return unsafePublicText(normalized) ? null : normalized
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
  return unsafePublicText(value) ? null : value
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
