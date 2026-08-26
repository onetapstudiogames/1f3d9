import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context, Hono } from 'hono'
import { err } from './core.ts'
import type { RuntimeLogRecord } from './runtime-logs.ts'

const LOG_DRAIN_SECRET = /^[0-9a-f]{64}$/u
const VERCEL_SIGNATURE = /^[0-9a-f]{40}$/u
const VERCEL_CHALLENGE = /^[\x21-\x7e]{1,512}$/u
const CITY_CREDENTIAL = /\b1f3(?:d9|ea)_(?:sk|at|rt|ac|rc)_[A-Za-z0-9_-]{24,256}\b/giu
const BEARER_CREDENTIAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,2048}/giu
const DATABASE_URL = /\b(?:postgres|postgresql):\/\/[^\s"'<>]+/giu
const CREDENTIAL_URL = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'<>]{1,512}:[^\s/@"'<>]{1,512}@/giu
const COMMON_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,512}|github_pat_[A-Za-z0-9_]{16,512}|gh[pousr]_[A-Za-z0-9]{16,512}|xox[baprs]-[A-Za-z0-9-]{16,512}|AKIA[A-Z0-9]{16})\b/gu
const SENSITIVE_HEADER = /(?:^|[^A-Za-z0-9_-])(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]|(?:^|[^A-Za-z0-9_-])(?:authorization|proxy-authorization)\s+(?:Basic|Bearer|Digest|ApiKey|Token)\b/iu
const ASSIGNED_KEY = /(?:^|[^A-Za-z0-9_-])["']?([A-Za-z][A-Za-z0-9_-]{0,511})["']?\s*[:=]/gu
const REDACTED_LOG_TEXT = '[redacted: log text contained credential material]'
const EARLIEST_LOG_TIMESTAMP = Date.UTC(2000, 0, 1)
const LATEST_LOG_TIMESTAMP = Date.UTC(2200, 0, 1)

export const LOG_DRAIN_LIMITS = Object.freeze({
  batchBytes: 4 * 1_024 * 1_024,
  batchLines: 10_000,
  insertRows: 500,
  lineBytes: 300 * 1_024,
  idBytes: 128,
  projectBytes: 128,
  sourceBytes: 64,
  levelBytes: 32,
  requestPathBytes: 2_048,
  requestMethodBytes: 16,
  userAgentBytes: 1_024,
  messageBytes: 4_096,
  deploymentIdBytes: 128,
})

export interface LogDrainRouteDependencies {
  environment: Readonly<Record<string, string | undefined>>
  insert(records: readonly RuntimeLogRecord[]): Promise<number>
}

function privateHeaders(c: Context): void {
  c.header('Cache-Control', 'no-store')
  c.header('Pragma', 'no-cache')
  c.header('Vary', 'X-Vercel-Signature, X-Vercel-Verify')
}

function configuredSecret(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const secret = environment.LOG_DRAIN_SECRET
  return secret && LOG_DRAIN_SECRET.test(secret) ? secret : null
}

function containsSensitiveAssignment(value: string): boolean {
  for (const match of value.matchAll(ASSIGNED_KEY)) {
    const normalizedKey = (match[1] ?? '')
      .replace(/([A-Z]+)([A-Z][a-z])/gu, '$1_$2')
      .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
      .replace(/-/gu, '_')
      .toLowerCase()
    const segments = normalizedKey.split('_').filter(Boolean)
    const compact = segments.join('')
    if (
      segments.some(segment => [
        'password', 'passwd', 'secret', 'token', 'session', 'sessionid', 'credential',
      ].includes(segment))
      || ['apikey', 'privatekey', 'accesskey', 'databaseurl'].some(
        suffix => compact.endsWith(suffix),
      )
    ) return true
  }
  return false
}

function validChallenge(value: string | undefined): value is string {
  return value !== undefined && VERCEL_CHALLENGE.test(value)
}

function verificationQuery(c: Context): Readonly<{
  valid: boolean
  challenge: string | null
}> {
  const queries = c.req.queries()
  const keys = Object.keys(queries)
  if (keys.length === 0) return Object.freeze({ valid: true, challenge: null })
  if (keys.length !== 1 || keys[0] !== 'verification') {
    return Object.freeze({ valid: false, challenge: null })
  }
  const values = queries.verification
  if (values?.length !== 1 || !validChallenge(values[0])) {
    return Object.freeze({ valid: false, challenge: null })
  }
  return Object.freeze({ valid: true, challenge: values[0] })
}

function validSignature(rawBody: Buffer, supplied: string | undefined, secret: string): boolean {
  if (!supplied || !VERCEL_SIGNATURE.test(supplied)) return false
  const expected = createHmac('sha1', secret).update(rawBody).digest()
  const received = Buffer.from(supplied, 'hex')
  return received.length === expected.length && timingSafeEqual(received, expected)
}

async function readBoundedBody(c: Context): Promise<Buffer | null> {
  const contentLength = c.req.header('content-length')
  if (contentLength) {
    if (!/^\d+$/u.test(contentLength)) return null
    if (Number(contentLength) > LOG_DRAIN_LIMITS.batchBytes) return null
  }

  const stream = c.req.raw.body
  if (!stream) return Buffer.alloc(0)
  const reader = stream.getReader()
  const body = Buffer.allocUnsafe(LOG_DRAIN_LIMITS.batchBytes)
  let totalBytes = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    totalBytes += next.value.byteLength
    if (totalBytes > LOG_DRAIN_LIMITS.batchBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    Buffer.from(next.value).copy(body, totalBytes - next.value.byteLength)
  }
  return body.subarray(0, totalBytes)
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maximumBytes) return value
  let result = ''
  let resultBytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, 'utf8')
    if (resultBytes + characterBytes > maximumBytes) break
    result += character
    resultBytes += characterBytes
  }
  return result
}

function redactSecrets(value: string, secret: string): string {
  const normalized = value.replace(/\0/gu, '')
  if (SENSITIVE_HEADER.test(normalized) || containsSensitiveAssignment(normalized)) {
    return REDACTED_LOG_TEXT
  }
  return normalized
    .split(secret).join('[redacted log-drain secret]')
    .replace(CITY_CREDENTIAL, '[redacted city credential]')
    .replace(BEARER_CREDENTIAL, 'Bearer [redacted]')
    .replace(DATABASE_URL, '[redacted database URL]')
    .replace(CREDENTIAL_URL, '$1[redacted]@')
    .replace(COMMON_TOKEN, '[redacted token]')
}

function boundedText(
  value: unknown,
  maximumBytes: number,
  secret: string,
): string | null {
  if (typeof value !== 'string') return null
  const bounded = truncateUtf8(redactSecrets(value, secret), maximumBytes)
  return bounded || null
}

function boundedRequiredIdentifier(value: unknown, maximumBytes: number, secret: string): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (Buffer.byteLength(value, 'utf8') > maximumBytes || value.includes('\0')) return null
  const redacted = redactSecrets(value, secret)
  return redacted === value ? value : null
}

function plainObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function normalizedTimestamp(value: unknown): string | null {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < EARLIEST_LOG_TIMESTAMP
    || value >= LATEST_LOG_TIMESTAMP
  ) return null
  try {
    return new Date(value).toISOString()
  } catch {
    return null
  }
}

function normalizedStatusCode(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) >= -1 && Number(value) <= 599
    ? Number(value)
    : null
}

function requestPath(value: unknown, secret: string): string | null {
  if (typeof value !== 'string') return null
  const withoutPrivateSuffix = value.split(/[?#]/u, 1)[0] ?? ''
  return boundedText(withoutPrivateSuffix, LOG_DRAIN_LIMITS.requestPathBytes, secret)
}

function userAgent(value: unknown, secret: string): string | null {
  if (typeof value === 'string') {
    return boundedText(value, LOG_DRAIN_LIMITS.userAgentBytes, secret)
  }
  if (!Array.isArray(value)) return null
  const joined = value
    .filter((entry): entry is string => typeof entry === 'string')
    .slice(0, 8)
    .join(', ')
  return boundedText(joined, LOG_DRAIN_LIMITS.userAgentBytes, secret)
}

function normalizeRecord(value: unknown, secret: string): RuntimeLogRecord | null {
  const input = plainObject(value)
  if (!input) return null
  const proxy = plainObject(input.proxy)
  const id = boundedRequiredIdentifier(input.id, LOG_DRAIN_LIMITS.idBytes, secret)
  const deploymentId = boundedRequiredIdentifier(
    input.deploymentId,
    LOG_DRAIN_LIMITS.deploymentIdBytes,
    secret,
  )
  const timestamp = normalizedTimestamp(input.timestamp)
  const project = boundedRequiredIdentifier(
    input.projectId,
    LOG_DRAIN_LIMITS.projectBytes,
    secret,
  )
  const source = boundedText(input.source, LOG_DRAIN_LIMITS.sourceBytes, secret)
  const level = boundedText(input.level, LOG_DRAIN_LIMITS.levelBytes, secret)
  if (!id || !deploymentId || !timestamp || !project || !source || !level) return null

  const method = boundedText(
    typeof proxy?.method === 'string' ? proxy.method.toUpperCase() : proxy?.method,
    LOG_DRAIN_LIMITS.requestMethodBytes,
    secret,
  )

  return Object.freeze({
    id,
    timestamp,
    project,
    source,
    level,
    requestPath: requestPath(proxy?.path ?? input.path, secret),
    requestMethod: method,
    statusCode: normalizedStatusCode(proxy?.statusCode ?? input.statusCode),
    durationMs: null,
    userAgent: userAgent(proxy?.userAgent, secret),
    message: boundedText(input.message, LOG_DRAIN_LIMITS.messageBytes, secret),
    deploymentId,
  })
}

function parseDelivery(
  rawBody: Buffer,
  secret: string,
): Readonly<{
  records: readonly RuntimeLogRecord[]
  skipped: number
  tooManyLines: boolean
}> {
  const records: RuntimeLogRecord[] = []
  let skipped = 0
  let nonblankLines = 0
  let lineStart = 0
  while (lineStart <= rawBody.length) {
    const newline = rawBody.indexOf(0x0a, lineStart)
    const lineEnd = newline === -1 ? rawBody.length : newline
    let line = rawBody.subarray(lineStart, lineEnd)
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1)
    lineStart = newline === -1 ? rawBody.length + 1 : newline + 1

    let blank = true
    for (const byte of line) {
      if (byte !== 0x09 && byte !== 0x20) {
        blank = false
        break
      }
    }
    if (blank) continue

    nonblankLines += 1
    if (nonblankLines > LOG_DRAIN_LIMITS.batchLines) {
      return Object.freeze({
        records: Object.freeze([]),
        skipped: 0,
        tooManyLines: true,
      })
    }
    if (line.byteLength > LOG_DRAIN_LIMITS.lineBytes) {
      skipped += 1
      continue
    }
    try {
      const normalized = normalizeRecord(JSON.parse(line.toString('utf8')) as unknown, secret)
      if (normalized) records.push(normalized)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  return Object.freeze({
    records: Object.freeze(records),
    skipped,
    tooManyLines: false,
  })
}

/** Mount the dormant, operator-only Vercel NDJSON log-drain receiver. */
export function mountLogDrainRoutes(app: Hono, deps: LogDrainRouteDependencies): void {
  app.post('/api/internal/log-drain', async c => {
    privateHeaders(c)
    const queryVerification = verificationQuery(c)
    if (!queryVerification.valid) return err(c, 400, 'log drain verification query is invalid')

    const secret = configuredSecret(deps.environment)
    if (!secret) return err(c, 503, 'log drain is unavailable')

    const headerVerification = c.req.header('x-vercel-verify')
    const signature = c.req.header('x-vercel-signature')
    if (headerVerification !== undefined && !validChallenge(headerVerification)) {
      return err(c, 403, 'log drain verification challenge is invalid')
    }
    if (
      headerVerification !== undefined
      && queryVerification.challenge !== null
      && headerVerification !== queryVerification.challenge
    ) {
      return err(c, 403, 'log drain verification challenge does not match')
    }

    const rawBody = await readBoundedBody(c)
    if (!rawBody) return c.json({ error: 'log drain batch is too large' }, 413)
    const verification = headerVerification ?? queryVerification.challenge
    if (signature === undefined && verification !== null && verification !== undefined) {
      c.header('X-Vercel-Verify', verification)
      return c.json({ ok: true, verification: true })
    }
    if (!validSignature(rawBody, signature, secret)) {
      return err(c, 403, 'log drain signature verification failed')
    }
    const contentEncoding = c.req.header('content-encoding')
    if (
      contentEncoding !== undefined
      && contentEncoding.trim().toLowerCase() !== 'identity'
    ) {
      return c.json({ error: 'log drain content encoding is unsupported' }, 415)
    }
    if (headerVerification !== undefined) {
      c.header('X-Vercel-Verify', headerVerification)
      return c.json({ ok: true, verification: true })
    }
    if (queryVerification.challenge !== null) {
      c.header('X-Vercel-Verify', queryVerification.challenge)
    }

    const delivery = parseDelivery(rawBody, secret)
    if (delivery.tooManyLines) {
      return c.json({ error: 'log drain batch has too many lines' }, 413)
    }
    try {
      for (let offset = 0; offset < delivery.records.length; offset += LOG_DRAIN_LIMITS.insertRows) {
        await deps.insert(delivery.records.slice(offset, offset + LOG_DRAIN_LIMITS.insertRows))
      }
    } catch {
      c.header('Retry-After', '1')
      return err(c, 503, 'log drain storage is temporarily unavailable')
    }
    return c.json({
      ok: true,
      accepted: delivery.records.length,
      skipped: delivery.skipped,
    })
  })
}
