import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redactLogSecrets } from '../src/log-redaction.ts'

const REQUEST_LOGS_URL = 'https://vercel.com/api/logs/request-logs'
const DAY_MS = 24 * 60 * 60 * 1_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_WINDOWS = 10_000
const MIN_CHRONOLOGICAL_WINDOW_MS = 30_000
const MAX_CHRONOLOGICAL_WINDOW_MS = 2 * 60 * 60 * 1_000
const REQUIRED_PROJECTS = Object.freeze(['1f3d9', '1f3ea'] as const)
const STATUS_CLASSES = Object.freeze(['4xx', '5xx'] as const)
const DIAGNOSTIC_KEYS = Object.freeze([
  'event', 'request_id', 'error_class', 'status', 'method', 'path', 'error_name',
  'error_code', 'error_fingerprint',
] as const)
const FUNCTION_EVENT_KEYS = Object.freeze([
  'durationMs', 'functionStartType', 'functionColdStartDurationMs', 'region', 'concurrency',
  'functionMaxMemoryUsed',
] as const)

type Fetcher = (input: URL | string, init?: RequestInit) => Promise<Response>

export interface VercelFailureRow extends Record<string, unknown> {
  readonly requestId: string
  readonly timestamp: number
}

export interface FailureFetchInput {
  readonly fetcher?: Fetcher
  readonly token: string
  readonly teamId: string
  readonly project: string
  readonly statusClass: '4xx' | '5xx'
  readonly startMs: number
  readonly endMs: number
}

function boundedText(value: unknown, limit = 2_048): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const redacted = redactLogSecrets(value)
  if (redacted.length <= limit) return redacted
  if (redacted !== value) return '[redacted]'
  return redacted.slice(0, limit)
}

function requestPath(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const pathOnly = value.split(/[?#]/u, 1)[0] ?? ''
  let decodedPath = pathOnly
  try { decodedPath = decodeURIComponent(pathOnly) } catch { /* Keep malformed URL escapes as written. */ }
  return boundedText(decodedPath)
}

function finiteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function timestampMillis(value: unknown): number | null {
  const numeric = finiteInteger(value)
  if (numeric !== null) return numeric
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function failureRow(value: unknown): VercelFailureRow | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const row = value as Record<string, unknown>
  const requestId = boundedText(row.requestId, 256)
  const timestamp = timestampMillis(row.timestamp)
  if (requestId === null || timestamp === null || timestamp < 0) return null
  return Object.freeze({ ...row, requestId, timestamp }) as VercelFailureRow
}

async function readWindow(
  input: FailureFetchInput,
  startMs: number,
  endMs: number,
): Promise<{ readonly rows: readonly VercelFailureRow[]; readonly hasMoreRows: boolean }> {
  const url = new URL(REQUEST_LOGS_URL)
  url.searchParams.set('projectId', input.project)
  url.searchParams.set('ownerId', input.teamId)
  url.searchParams.set('startDate', String(startMs))
  url.searchParams.set('endDate', String(endMs))
  url.searchParams.set('statusCode', input.statusClass)
  url.searchParams.set('environment', 'production')
  const response = await (input.fetcher ?? fetch)(url, {
    headers: { authorization: `Bearer ${input.token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Vercel request-log read failed with HTTP ${response.status}`)
  const declaredBytes = Number(response.headers.get('content-length') ?? 0)
  if (declaredBytes > MAX_RESPONSE_BYTES) {
    throw new Error('Vercel request-log response exceeded the export size limit')
  }
  const bodyText = await response.text()
  if (Buffer.byteLength(bodyText, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Vercel request-log response exceeded the export size limit')
  }
  let body: unknown
  try {
    body = JSON.parse(bodyText)
  } catch {
    throw new Error('Vercel request-log response was not JSON')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Vercel request-log response had an invalid shape')
  }
  const record = body as Record<string, unknown>
  if (!Array.isArray(record.rows) || typeof record.hasMoreRows !== 'boolean') {
    throw new Error('Vercel request-log response had an invalid rows page')
  }
  const rows = record.rows.map(failureRow)
  if (rows.some(row => row === null)) throw new Error('Vercel request-log row lacked an id or timestamp')
  return Object.freeze({ rows: Object.freeze(rows as VercelFailureRow[]), hasMoreRows: record.hasMoreRows })
}

export async function fetchVercelFailureRows(
  input: FailureFetchInput,
): Promise<readonly VercelFailureRow[]> {
  if (!input.token || !input.teamId || !input.project) throw new Error('Vercel export credentials and project are required')
  if (!['4xx', '5xx'].includes(input.statusClass)) throw new Error('Vercel export status class must be 4xx or 5xx')
  if (!Number.isSafeInteger(input.startMs) || !Number.isSafeInteger(input.endMs)
    || input.startMs < 0 || input.endMs < input.startMs) {
    throw new Error('Vercel export time range is invalid')
  }
  const retained = new Map<string, VercelFailureRow>()
  let windowStart = input.startMs
  let windowSize = MIN_CHRONOLOGICAL_WINDOW_MS
  let requestCount = 0

  const readChronologicalWindow = async (startMs: number, endMs: number): Promise<void> => {
    if (requestCount >= MAX_WINDOWS) throw new Error('Vercel chronological request-log scan exceeded its safety limit')
    requestCount += 1
    const page = await readWindow(input, startMs, endMs)
    for (const row of page.rows) {
      if (row.timestamp < startMs || row.timestamp > endMs) {
        throw new Error('Vercel returned a request-log row outside the requested time window')
      }
      if (!retained.has(row.requestId)) retained.set(row.requestId, row)
    }
    if (!page.hasMoreRows) return
    if (startMs === endMs) throw new Error(`more than 50 failure rows share timestamp ${startMs}`)
    const midpoint = startMs + Math.floor((endMs - startMs) / 2)
    await readChronologicalWindow(startMs, midpoint)
    await readChronologicalWindow(midpoint + 1, endMs)
  }

  while (windowStart <= input.endMs) {
    const windowEnd = Math.min(input.endMs, windowStart + windowSize - 1)
    const retainedBefore = retained.size
    await readChronologicalWindow(windowStart, windowEnd)
    const retainedInWindow = retained.size - retainedBefore
    windowSize = retainedInWindow < 25
      ? Math.min(MAX_CHRONOLOGICAL_WINDOW_MS, windowSize * 2)
      : retainedInWindow > 100
        ? Math.max(MIN_CHRONOLOGICAL_WINDOW_MS, Math.floor(windowSize / 2))
        : windowSize
    windowStart = windowEnd + 1
  }
  return Object.freeze([...retained.values()].toSorted((left, right) => (
    left.timestamp - right.timestamp || left.requestId.localeCompare(right.requestId)
  )))
}

function allowListedObject(
  value: unknown,
  keys: readonly string[],
  pathKeys: ReadonlySet<string> = new Set(),
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const entries: [string, unknown][] = []
  for (const key of keys) {
    const raw = source[key]
    if (raw === null || raw === undefined) continue
    if (typeof raw === 'number' && Number.isFinite(raw)) entries.push([key, raw])
    if (typeof raw === 'boolean') entries.push([key, raw])
    if (typeof raw === 'string') {
      const clean = pathKeys.has(key) ? requestPath(raw) : boundedText(raw)
      if (clean !== null) entries.push([key, clean])
    }
  }
  return Object.freeze(Object.fromEntries(entries))
}

function diagnosticRows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value)) return Object.freeze([])
  const diagnostics: Readonly<Record<string, unknown>>[] = []
  for (const log of value.slice(0, 100)) {
    if (!log || typeof log !== 'object' || Array.isArray(log)) continue
    const message = (log as Record<string, unknown>).message
    if (typeof message !== 'string' || !message.startsWith('request_failure ')) continue
    try {
      const parsed = JSON.parse(message.slice('request_failure '.length)) as unknown
      const kept = allowListedObject(parsed, DIAGNOSTIC_KEYS, new Set(['path']))
      if (kept && kept.event === 'request_failure') diagnostics.push(kept)
    } catch {
      // Raw or malformed log bodies are deliberately discarded.
    }
  }
  return Object.freeze(diagnostics)
}

export function sanitizeFailureRow(
  project: string,
  row: Record<string, unknown>,
): Readonly<Record<string, unknown>> {
  const sanitized: Record<string, unknown> = {
    project: boundedText(project, 128),
    requestId: boundedText(row.requestId, 256),
    timestamp: finiteInteger(row.timestamp),
    requestMethod: boundedText(row.requestMethod, 16),
    requestPath: requestPath(row.requestPath),
    statusCode: finiteInteger(row.statusCode),
    errorCode: boundedText(row.errorCode, 128),
    clientUserAgent: boundedText(row.clientUserAgent),
    requestReferer: requestPath(row.requestReferer),
    requestDurationMs: finiteInteger(row.requestDurationMs),
    diagnostics: diagnosticRows(row.logs),
    functionEvents: Object.freeze(Array.isArray(row.functionEvents)
      ? row.functionEvents.slice(0, 100).map(event => allowListedObject(event, FUNCTION_EVENT_KEYS))
        .filter(event => event !== null)
      : []),
  }
  return Object.freeze(Object.fromEntries(Object.entries(sanitized).filter(([, value]) => value !== null)))
}

async function configuredProjects(): Promise<typeof REQUIRED_PROJECTS> {
  const configText = await readFile(new URL('../config/cost-tripwire.json', import.meta.url), 'utf8')
  let config: unknown
  try { config = JSON.parse(configText) } catch { throw new Error('Cost tripwire project configuration was not JSON') }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Cost tripwire project configuration had an invalid shape')
  }
  const vercel = (config as Record<string, unknown>).vercel
  const projects = vercel && typeof vercel === 'object' && !Array.isArray(vercel)
    ? (vercel as Record<string, unknown>).projects
    : undefined
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)
    || REQUIRED_PROJECTS.some(project => !(project in projects))) {
    throw new Error('Cost tripwire project configuration must include 1f3d9 and 1f3ea')
  }
  return REQUIRED_PROJECTS
}

export async function runFailureLogExport(input: Readonly<{
  environment?: NodeJS.ProcessEnv
  fetcher?: Fetcher
  now?: Date
  outDir?: string
}> = {}): Promise<Readonly<{ path: string; rowCount: number }>> {
  const environment = input.environment ?? process.env
  const token = environment.VERCEL_TOKEN ?? ''
  const teamId = environment.VERCEL_TEAM_ID ?? ''
  const outDir = input.outDir ?? 'logs/failures'
  if (!outDir || !token || !teamId) throw new Error('VERCEL_TOKEN and VERCEL_TEAM_ID are required')
  const now = input.now ?? new Date()
  const endMs = now.getTime()
  const startMs = endMs - DAY_MS
  const projects = await configuredProjects()
  const fetcher = input.fetcher ?? fetch
  const reads = projects.flatMap(project => STATUS_CLASSES.map(async statusClass => {
    const rows = await fetchVercelFailureRows({
      fetcher, token, teamId, project, statusClass, startMs, endMs,
    })
    return rows.map(row => sanitizeFailureRow(project, row))
  }))
  const retained = (await Promise.all(reads)).flat().toSorted((left, right) => (
    Number(left.timestamp) - Number(right.timestamp)
    || String(left.project).localeCompare(String(right.project))
    || String(left.requestId).localeCompare(String(right.requestId))
  ))
  await mkdir(outDir, { recursive: true })
  const day = now.toISOString().slice(0, 10)
  const path = join(outDir, `failure-logs-${day}.json`)
  await writeFile(path, `${JSON.stringify({ exported_at: new Date(endMs).toISOString(), start_ms: startMs, end_ms: endMs, rows: retained }, null, 2)}\n`, { flag: 'wx' })
  return Object.freeze({ path, rowCount: retained.length })
}

async function main(): Promise<void> {
  const outIndex = process.argv.indexOf('--out')
  const outDir = outIndex >= 0 ? process.argv[outIndex + 1] : undefined
  const result = await runFailureLogExport({ ...(outDir ? { outDir } : {}) })
  console.log(`Exported ${result.rowCount} sanitized failure rows to ${result.path}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
