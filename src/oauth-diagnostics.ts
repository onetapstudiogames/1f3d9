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

export interface OAuthDiagnosticRecord {
  event: 'oauth_failure'
  stage: OAuthFailureStage
  request_id: string
  client_origin: string
  error_class: string
  failed_check?: 'not_a_code' | 'code_not_accepted'
  status: number
  elapsed_ms: number
}

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

export function recordFailure(
  diagnostics: OAuthDiagnosticSink,
  trace: OAuthRequestTrace,
  stage: OAuthFailureStage,
  errorClass: string,
  status: number,
  failedCheck?: OAuthDiagnosticRecord['failed_check'],
): void {
  const elapsed = Math.max(0, Math.min(60_000, Date.now() - trace.startedAt))
  try {
    diagnostics(Object.freeze({
      event: 'oauth_failure',
      stage,
      request_id: trace.requestId,
      client_origin: trace.clientOrigin,
      error_class: errorClass,
      ...(failedCheck ? { failed_check: failedCheck } : {}),
      status,
      elapsed_ms: elapsed,
    }))
  } catch {
    // Diagnostics must never change OAuth behavior or expose a second error path.
  }
}
