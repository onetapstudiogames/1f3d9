import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const PUBLIC_ORIGIN = 'https://1f3d9.com'
const RESIDENT = 'thog' as const
const COMPARISON_NOTE =
  'A later increase proves only that more public actions appeared. No change is inconclusive and is not a release gate.'

type OutcomeOptions = Readonly<{
  fetcher?: typeof fetch
  now?: () => Date
}>

export type ThogPublicActionOutcome = Readonly<{
  captured_at: string
  source: string
  resident: typeof RESIDENT
  public_action_total: number
  comparison_note: typeof COMPARISON_NOTE
}>

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null
}

function positiveInteger(value: unknown): number | null {
  const number = nonnegativeInteger(value)
  return number !== null && number > 0 ? number : null
}

function outcomeUrl(): URL {
  const url = new URL('/api/events', PUBLIC_ORIGIN)
  url.searchParams.set('actor', RESIDENT)
  url.searchParams.set('kind', 'action')
  url.searchParams.set('limit', '1')
  return url
}

export async function readThogPublicActionOutcome(
  options: OutcomeOptions = {},
): Promise<ThogPublicActionOutcome> {
  const url = outcomeUrl()
  const response = await (options.fetcher ?? fetch)(url, {
    method: 'GET',
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  })
  if (!response.ok) {
    throw new Error(`public action response failed with HTTP ${response.status}`)
  }

  const payload = object(await response.json().catch(() => null))
  const events = Array.isArray(payload?.events) ? payload.events : null
  const total = nonnegativeInteger(payload?.total_items)
  if (
    payload === null || events === null || events.length > 1 || total === null ||
    payload.returned_items !== events.length ||
    (total === 0 && events.length !== 0) || (total > 0 && events.length !== 1)
  ) {
    throw new Error('public action response is invalid')
  }

  const latest = events.length === 0 ? null : object(events[0])
  if (
    latest !== null && (
      positiveInteger(latest.id) === null || latest.kind !== 'action' || latest.actor !== RESIDENT
    )
  ) {
    throw new Error('public action response is invalid')
  }

  return Object.freeze({
    captured_at: (options.now ?? (() => new Date()))().toISOString(),
    source: url.toString(),
    resident: RESIDENT,
    public_action_total: total,
    comparison_note: COMPARISON_NOTE,
  })
}

export function parseThogPublicActionArguments(
  arguments_: readonly string[],
): Readonly<Record<string, never>> {
  if (arguments_.length !== 0) {
    throw new Error('The Thog public-action check takes no arguments')
  }
  return Object.freeze({})
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  return resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
}

if (isMainModule()) {
  try {
    parseThogPublicActionArguments(process.argv.slice(2))
    console.log(JSON.stringify(await readThogPublicActionOutcome(), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
