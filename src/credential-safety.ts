export const PUBLIC_CREDENTIAL_PATTERN_SOURCE =
  '1f3d9_(?:sk|at|rt|ac|rc)_[0-9a-f]{8,}'

export const CREDENTIAL_LIKE_INPUT_RE = new RegExp(PUBLIC_CREDENTIAL_PATTERN_SOURCE, 'i')
export const RESIDENT_CREDENTIAL_RE = CREDENTIAL_LIKE_INPUT_RE
const EXACT_RESIDENT_CREDENTIAL_RE =
  /1f3d9_(?:sk_[0-9a-f]{48}|(?:at|rt|ac|rc)_[0-9a-f]{64})/ig

export const PUBLIC_CREDENTIAL_REDACTION =
  '[redacted: this text contained a resident credential]'
export const CREDENTIAL_TEXT_REDACTION = PUBLIC_CREDENTIAL_REDACTION
export const PUBLIC_RESPONSE_WITHHELD =
  'The city withheld a response that contained a resident credential.'
export const CREDENTIAL_RESPONSE_WITHHELD = PUBLIC_RESPONSE_WITHHELD

const MAX_PUBLIC_VALUE_DEPTH = 32
const MAX_PUBLIC_VALUE_NODES = 20_000

export type ResidentCredentialKind =
  | 'resident_key'
  | 'oauth_access_token'
  | 'oauth_refresh_token'
  | 'oauth_authorization_code'
  | 'recovery_code'

export interface ResidentCredentialMatch {
  readonly token: string
  readonly kind: ResidentCredentialKind
}

export interface PublicValueSafety {
  readonly value: unknown
  readonly changed: boolean
  readonly withheld: boolean
}

export interface PublicPayloadSafety {
  readonly text: string
  readonly changed: boolean
  readonly withheld: boolean
}

interface TraversalState {
  nodes: number
  changed: boolean
  uncertain: boolean
  readonly seen: WeakSet<object>
}

function classifyResidentCredential(token: string): ResidentCredentialKind {
  if (/^1f3d9_sk_/i.test(token)) return 'resident_key'
  if (/^1f3d9_at_/i.test(token)) return 'oauth_access_token'
  if (/^1f3d9_rt_/i.test(token)) return 'oauth_refresh_token'
  if (/^1f3d9_rc_/i.test(token)) return 'recovery_code'
  return 'oauth_authorization_code'
}

/**
 * Internal incident tooling hashes these exact matches before comparing them
 * with identity records. Callers must never log or return the token field.
 */
export function extractResidentCredentials(value: unknown): readonly ResidentCredentialMatch[] {
  if (typeof value !== 'string') return Object.freeze([])
  return Object.freeze([...value.matchAll(EXACT_RESIDENT_CREDENTIAL_RE)].map(match => Object.freeze({
    token: match[0],
    kind: classifyResidentCredential(match[0]),
  })))
}

export function containsPublicCredential(value: unknown): boolean {
  return typeof value === 'string' && CREDENTIAL_LIKE_INPUT_RE.test(value)
}

export const containsResidentCredential = containsPublicCredential
export const containsCredentialLikeInput = containsPublicCredential

export function redactResidentCredentialText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return containsPublicCredential(value) ? PUBLIC_CREDENTIAL_REDACTION : value
}

function plainDataProperties(value: object): readonly [string, unknown][] | null {
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) return null
  const descriptors = Object.getOwnPropertyDescriptors(value)
  const entries: [string, unknown][] = []
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) return null
    entries.push([key, descriptor.value])
  }
  return entries
}

function sanitizeValue(value: unknown, depth: number, state: TraversalState): unknown {
  state.nodes += 1
  if (depth > MAX_PUBLIC_VALUE_DEPTH || state.nodes > MAX_PUBLIC_VALUE_NODES) {
    state.uncertain = true
    return null
  }
  if (typeof value === 'string') {
    if (!containsPublicCredential(value)) return value
    state.changed = true
    return PUBLIC_CREDENTIAL_REDACTION
  }
  if (!value || typeof value !== 'object' || value instanceof Date) return value
  if (state.seen.has(value)) {
    state.uncertain = true
    return null
  }
  state.seen.add(value)

  if (Array.isArray(value)) {
    const keys = Reflect.ownKeys(value)
    const dense = keys.length === value.length + 1 && keys.every(key => (
      key === 'length' || (typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key))
    ))
    if (!dense) {
      state.uncertain = true
      return null
    }
    return Object.freeze(value.map(item => sanitizeValue(item, depth + 1, state)))
  }

  const entries = plainDataProperties(value)
  if (!entries) {
    state.uncertain = true
    return null
  }
  return Object.freeze(Object.fromEntries(entries.map(([key, nested]) => [
    key,
    sanitizeValue(nested, depth + 1, state),
  ])))
}

export function sanitizePublicValue(value: unknown): PublicValueSafety {
  const state: TraversalState = {
    nodes: 0,
    changed: false,
    uncertain: false,
    seen: new WeakSet(),
  }
  const sanitized = sanitizeValue(value, 0, state)
  if (state.uncertain) {
    return Object.freeze({
      value: PUBLIC_RESPONSE_WITHHELD,
      changed: true,
      withheld: true,
    })
  }
  return Object.freeze({ value: sanitized, changed: state.changed, withheld: false })
}

export function sanitizePublicReadValue<T>(value: T): T {
  return sanitizePublicValue(value).value as T
}

const JSON_CONTENT_TYPE = /(?:^|\s|;)application\/(?:[^;]+\+)?json(?:\s|;|$)/i

function withheldPayload(contentType: string): string {
  return JSON_CONTENT_TYPE.test(contentType)
    ? JSON.stringify({ error: PUBLIC_RESPONSE_WITHHELD })
    : PUBLIC_RESPONSE_WITHHELD
}

export function safeguardPublicPayload(
  rawText: string,
  contentType = 'application/json',
): PublicPayloadSafety {
  if (!containsPublicCredential(rawText)) {
    return Object.freeze({ text: rawText, changed: false, withheld: false })
  }

  if (JSON_CONTENT_TYPE.test(contentType)) {
    try {
      const result = sanitizePublicValue(JSON.parse(rawText) as unknown)
      if (!result.withheld) {
        const text = JSON.stringify(result.value)
        if (!containsPublicCredential(text)) {
          return Object.freeze({ text, changed: true, withheld: false })
        }
      }
    } catch {
      // A malformed credential-bearing response stays fail-closed.
    }
  }

  return Object.freeze({
    text: withheldPayload(contentType),
    changed: true,
    withheld: true,
  })
}

export function sanitizePublicReadText(
  rawText: string,
): Readonly<{ text: string; withheld: boolean }> {
  const result = safeguardPublicPayload(rawText, 'application/json')
  return Object.freeze({ text: result.text, withheld: result.withheld })
}
