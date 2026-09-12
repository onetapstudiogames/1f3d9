import { randomUUID } from 'node:crypto'
import type { Context, MiddlewareHandler } from 'hono'
import { containsPublicCredential } from './credential-safety.ts'
import { errorClassForStatus, type ErrorClass } from './error-class.ts'
import { configuredPublicDomain } from './public-reference-facts.ts'

const MAX_FAILURE_BODY_BYTES = 262_144
const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/u

export type ApiFailureStatus =
  | 400 | 401 | 402 | 403 | 404 | 405 | 409 | 413 | 429 | 500 | 502 | 503

export interface ApiFailureReference {
  readonly requestId: string
  readonly errorClass: ErrorClass
}

export interface ApiFailureReport {
  readonly event: string
  readonly request_id: string
  readonly error_class: ErrorClass
  readonly status: number
  readonly method: string
  readonly path: string
}

type ApiFailureReporter = (record: ApiFailureReport) => void

interface ApiFailureResponseOptions {
  readonly publicOrigin?: string
  readonly requestId?: string
  readonly event?: string
  readonly report?: ApiFailureReporter
}

function normalizedOrigin(value: string): string {
  return value.replace(/\/+$/u, '')
}

function safeRequestId(value: unknown): string | null {
  return typeof value === 'string'
    && REQUEST_ID_RE.test(value)
    && !containsPublicCredential(value)
    ? value
    : null
}

function jsonContentType(value: string): boolean {
  return /^application\/(?:[^;]+\+)?json(?:\s*;|$)/iu.test(value.trim())
}

function withFailureFields(
  payload: Readonly<Record<string, unknown>>,
  status: number,
  reference: ApiFailureReference,
  publicOrigin: string,
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...payload,
    request_id: reference.requestId,
    error_class: reference.errorClass,
    http_status: status,
    front_door_tool: 'front_door',
    front_door: `${normalizedOrigin(publicOrigin)}/`,
  })
}

export function markApiFailure(
  c: Context,
  status: number,
  requestedId?: unknown,
): ApiFailureReference {
  const requestId = safeRequestId(c.res.headers.get('X-Request-ID'))
    ?? safeRequestId(requestedId)
    ?? randomUUID()
  const errorClass = errorClassForStatus(status)
  c.header('X-Request-ID', requestId)
  c.header('X-1F3D9-Error-Class', errorClass)
  return Object.freeze({ requestId, errorClass })
}

export function apiFailureResponse(
  c: Context,
  status: ApiFailureStatus,
  payload: Readonly<Record<string, unknown>>,
  options: ApiFailureResponseOptions = {},
): Response {
  const publicOrigin = options.publicOrigin ?? configuredPublicDomain().domain
  const reference = markApiFailure(c, status, options.requestId ?? payload.request_id)
  if (options.event) {
    const record = Object.freeze({
      event: options.event,
      request_id: reference.requestId,
      error_class: reference.errorClass,
      status,
      method: c.req.method,
      path: c.req.routePath || 'unmatched',
    })
    if (options.report) options.report(record)
    else console.error(options.event, JSON.stringify(record))
  }
  return c.json(withFailureFields(payload, status, reference, publicOrigin), status)
}

/** Give every plain /api failure the same trace, class, status, and front-door pointer as MCP. */
export function apiFailureContract(
  publicOrigin: () => string = () => configuredPublicDomain().domain,
): MiddlewareHandler {
  return async (c, next) => {
    await next()
    if (
      !c.req.path.startsWith('/api/')
      || c.res.status < 400
      || c.req.method === 'HEAD'
      || c.res.body === null
      || !jsonContentType(c.res.headers.get('content-type') ?? '')
    ) return

    const rawText = await c.res.clone().text()
    if (Buffer.byteLength(rawText, 'utf8') > MAX_FAILURE_BODY_BYTES) return
    let parsed: unknown
    try {
      parsed = JSON.parse(rawText) as unknown
    } catch {
      return
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const payload = parsed as Record<string, unknown>
    if (typeof payload.error !== 'string') return

    const reference = markApiFailure(c, c.res.status, payload.request_id)
    const headers = new Headers(c.res.headers)
    headers.delete('content-length')
    headers.set('X-Request-ID', reference.requestId)
    headers.set('X-1F3D9-Error-Class', reference.errorClass)
    c.res = new Response(JSON.stringify(withFailureFields(
      payload,
      c.res.status,
      reference,
      publicOrigin(),
    )), {
      status: c.res.status,
      statusText: c.res.statusText,
      headers,
    })
  }
}
