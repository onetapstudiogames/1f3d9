import { randomUUID } from 'node:crypto'
import type { Context } from 'hono'

export type OAuthFailureStage =
  | 'authorization_request'
  | 'client_metadata'
  | 'authorization_store'
  | 'browser_approval'
  | 'token_request'
  | 'token_exchange'
  | 'token_refresh'
  | 'revocation'

/**
 * Decision 189: the closed list of reasons a chat app's sign-in client is refused.
 * The host log records exactly one of these, never the client address, callback,
 * query values or document body. The first three are temporary: the city could not
 * check the chat app's details, so the person may try again.
 */
export const CLIENT_REFUSAL_CHECKS = [
  'metadata_unreachable',
  'metadata_timeout',
  'metadata_error_status',
  'client_unknown',
  'client_address_query_or_fragment',
  'metadata_redirect',
  'metadata_not_json',
  'metadata_too_large',
  'metadata_invalid_json',
  'metadata_identity_mismatch',
  'auth_method_missing',
  'auth_method_unsupported',
  'public_pkce_missing',
  'client_name_invalid',
  'callback_invalid',
  'claude_code_callbacks_mismatch',
  'gemini_client_unrecognized',
] as const

export type ClientRefusalCheck = typeof CLIENT_REFUSAL_CHECKS[number]

const TEMPORARY_CLIENT_CHECKS: ReadonlySet<ClientRefusalCheck> = new Set([
  'metadata_unreachable',
  'metadata_timeout',
  'metadata_error_status',
])

export function clientCheckIsTemporary(check: ClientRefusalCheck): boolean {
  return TEMPORARY_CLIENT_CHECKS.has(check)
}

/** Only the hundreds digit of an answer from the chat app's site, never the answer itself. */
export type UpstreamStatusClass = '2xx' | '3xx' | '4xx' | '5xx'

export type OAuthFailedCheck =
  | 'not_a_code' | 'code_not_accepted' | 'connection_allowance' | 'junk_allowance'
  | ClientRefusalCheck

export interface OAuthStageFailureRecord {
  event: 'oauth_failure'
  stage: OAuthFailureStage
  request_id: string
  client_origin: string
  error_class: string
  failed_check?: OAuthFailedCheck
  upstream_status_class?: UpstreamStatusClass
  status: number
  elapsed_ms: number
}

/** The shape of one submitted return address: enums, booleans and integers, never its text. */
export interface RedirectShape {
  host_class: 'main' | 'test' | 'sandbox' | 'other'
  scheme_ok: boolean
  path_class: 'r' | 'a' | 'other'
  prefix_match: boolean
  segment_length: number
  segment_class: 'empty' | 'digits' | 'hex_lower' | 'alnum' | 'old_this_city' | 'old_other_host'
    | 'base64url' | 'has_dot_slash_percent' | 'other'
  has_port_query_fragment_userinfo_whitespace: boolean
  non_string: boolean
}

export interface RegistrationShapes {
  addressCount: number
  addresses: readonly RedirectShape[]
  userAgentClass: 'OpenAuth' | 'other'
}

/** Decision 186: a refused Gemini registration, described by shape only. */
export interface OAuthRegistrationRefusalRecord {
  event: 'oauth_failure'
  stage: 'client_registration'
  request_id: string
  error_class: 'invalid_redirect_uri'
  status: 400
  elapsed_ms: number
  address_count: number
  ua_class: RegistrationShapes['userAgentClass']
  addresses: readonly RedirectShape[]
  client_origin?: never
  failed_check?: never
  upstream_status_class?: never
}

export type OAuthDiagnosticRecord = OAuthStageFailureRecord | OAuthRegistrationRefusalRecord

export type OAuthDiagnosticSink = (record: Readonly<OAuthDiagnosticRecord>) => void

export interface OAuthRequestTrace {
  requestId: string
  startedAt: number
  clientOrigin: string
}

export function defaultDiagnostics(record: Readonly<OAuthDiagnosticRecord>): void {
  console.error('oauth_failure', JSON.stringify(record))
}

export function beginTrace(c: Context): OAuthRequestTrace {
  const requestId = randomUUID()
  c.header('X-Request-ID', requestId)
  return { requestId, startedAt: Date.now(), clientOrigin: 'unknown' }
}

function safeClientOrigin(
  clientId: unknown,
  staticClients: readonly { clientId: string }[],
): string {
  if (typeof clientId !== 'string' || !clientId) return 'unknown'
  if (staticClients.some(client => client.clientId === clientId)) return 'pre-registered'
  try {
    const parsed = new URL(clientId)
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) return parsed.origin
  } catch {
    // A non-URL client ID is named only by its configured/non-configured class.
  }
  return 'unknown'
}

export function traceForClient(
  trace: OAuthRequestTrace,
  clientId: unknown,
  staticClients: readonly { clientId: string }[],
): OAuthRequestTrace {
  return { ...trace, clientOrigin: safeClientOrigin(clientId, staticClients) }
}

function elapsedSince(trace: OAuthRequestTrace): number {
  return Math.max(0, Math.min(60_000, Date.now() - trace.startedAt))
}

export function recordFailure(
  diagnostics: OAuthDiagnosticSink,
  trace: OAuthRequestTrace,
  stage: OAuthFailureStage,
  errorClass: string,
  status: number,
  failedCheck?: OAuthFailedCheck,
  upstreamStatusClass?: UpstreamStatusClass,
): void {
  const elapsed = elapsedSince(trace)
  try {
    diagnostics(Object.freeze({
      event: 'oauth_failure',
      stage,
      request_id: trace.requestId,
      client_origin: trace.clientOrigin,
      error_class: errorClass,
      ...(failedCheck ? { failed_check: failedCheck } : {}),
      ...(upstreamStatusClass ? { upstream_status_class: upstreamStatusClass } : {}),
      status,
      elapsed_ms: elapsed,
    }))
  } catch {
    // Diagnostics must never change OAuth behavior or expose a second error path.
  }
}

/** Describing the request happens inside the guard, so logging never changes the answer. */
export function recordRegistrationRefusal(
  diagnostics: OAuthDiagnosticSink,
  trace: OAuthRequestTrace,
  describe: () => RegistrationShapes,
): void {
  try {
    const shapes = describe()
    diagnostics(Object.freeze({
      event: 'oauth_failure',
      stage: 'client_registration',
      request_id: trace.requestId,
      error_class: 'invalid_redirect_uri',
      status: 400,
      elapsed_ms: elapsedSince(trace),
      address_count: shapes.addressCount,
      ua_class: shapes.userAgentClass,
      addresses: shapes.addresses,
    }))
  } catch {
    // Diagnostics must never change OAuth behavior or expose a second error path.
  }
}
