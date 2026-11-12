// Provider reads for the cost tripwire. Every read is a GET, is bounded in size and time,
// and throws in plain words when the answer is missing, too large, or the wrong shape.
// The caller turns any throw into a FAILED line and a red run, never into zero.

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const MAX_PAGES = 100
const PAGE_SIZE = 100
const MAX_NEON_BRANCHES = 10_000
const VERCEL_PARALLEL_DAY_READS = 4
const DAY_MS = 24 * 60 * 60 * 1000

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readBoundedResponse(response: Response, provider: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`${provider} response exceeded size limit`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${provider} response exceeded size limit`)
  if (!response.ok) throw new Error(`${provider} API returned HTTP ${response.status}`)
  return text
}

export async function fetchBounded(url: URL, init: RequestInit, provider: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  return readBoundedResponse(response, provider)
}

function parseJson(text: string, provider: string): unknown {
  try { return JSON.parse(text) } catch { throw new Error(`${provider} API returned invalid JSON`) }
}

function neonHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/json' }
}

function neonProjectUrl(projectId: string, resource: string): URL {
  return new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/${resource}`)
}

export async function listNeonBranches(projectId: string, token: string, fetcher: typeof fetch): Promise<readonly string[]> {
  const names: string[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = neonProjectUrl(projectId, 'branches')
    url.searchParams.set('limit', String(PAGE_SIZE))
    if (cursor) url.searchParams.set('cursor', cursor)
    const value = parseJson(await fetchBounded(url, { headers: neonHeaders(token) }, 'Neon', fetcher), 'Neon')
    if (!isPlainObject(value) || !Array.isArray(value.branches)) throw new Error('Neon API returned an invalid branch list')
    for (const branch of value.branches) {
      if (!isPlainObject(branch) || typeof branch.name !== 'string') throw new Error('Neon API returned an invalid branch')
      names.push(branch.name)
    }
    const pagination = isPlainObject(value.pagination) ? value.pagination : undefined
    cursor = typeof pagination?.next === 'string' && pagination.next ? pagination.next : undefined
    if (!cursor) return Object.freeze(names)
    if (seenCursors.has(cursor)) throw new Error('Neon pagination cursor repeated')
    seenCursors.add(cursor)
    if (names.length > MAX_NEON_BRANCHES) throw new Error('Neon branch list exceeded safety limit')
  }
  throw new Error('Neon branch pagination exceeded page limit')
}

export type SnapshotCounts = Readonly<{ total: number; manualWithoutExpiry: number }>

export function countSnapshots(value: unknown): SnapshotCounts {
  if (!isPlainObject(value) || !Array.isArray(value.snapshots)) throw new Error('Neon API returned an invalid snapshot list')
  if (value.pagination !== undefined && isPlainObject(value.pagination) && value.pagination.next) {
    throw new Error('Neon snapshot list has more pages than the tripwire reads')
  }
  const manualWithoutExpiry = value.snapshots.filter(snapshot => {
    if (!isPlainObject(snapshot) || typeof snapshot.name !== 'string' || typeof snapshot.manual !== 'boolean') {
      throw new Error('Neon API returned an invalid snapshot')
    }
    const expiry = snapshot.expires_at
    if (expiry !== undefined && expiry !== null && typeof expiry !== 'string') {
      throw new Error('Neon API returned an invalid snapshot end date')
    }
    return snapshot.manual && !expiry
  }).length
  return Object.freeze({ total: value.snapshots.length, manualWithoutExpiry })
}

export async function readNeonSnapshots(projectId: string, token: string, fetcher: typeof fetch): Promise<SnapshotCounts> {
  const text = await fetchBounded(neonProjectUrl(projectId, 'snapshots'), { headers: neonHeaders(token) }, 'Neon', fetcher)
  return countSnapshots(parseJson(text, 'Neon'))
}

function vercelHeaders(token: string, accept: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: accept }
}

// Vercel bills in Pacific days. Asking for the UTC window [D+1, D+2) returns exactly the
// one charge day whose ChargePeriodStart falls on D (00:00 Pacific, 07:00 or 08:00 UTC);
// this was observed live on 2026-11-12. The caller checks every answer against the asked
// day, so a change in that mapping fails loudly instead of shifting days.
async function readVercelChargeDay(day: string, teamId: string, token: string, fetcher: typeof fetch): Promise<string> {
  const from = Date.parse(`${day}T00:00:00.000Z`) + DAY_MS
  const url = new URL('https://api.vercel.com/v1/billing/charges')
  url.searchParams.set('teamId', teamId)
  url.searchParams.set('from', new Date(from).toISOString())
  url.searchParams.set('to', new Date(from + DAY_MS).toISOString())
  try {
    return await fetchBounded(url, { headers: vercelHeaders(token, 'application/x-ndjson') }, 'Vercel', fetcher)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown error'
    throw new Error(`${detail} (charge day ${day})`)
  }
}

export async function readVercelChargeDays(
  days: readonly string[], teamId: string, token: string, fetcher: typeof fetch,
): Promise<readonly Readonly<{ day: string; text: string }>[]> {
  const results: Readonly<{ day: string; text: string }>[] = []
  for (let index = 0; index < days.length; index += VERCEL_PARALLEL_DAY_READS) {
    const batch = days.slice(index, index + VERCEL_PARALLEL_DAY_READS)
    const texts = await Promise.all(batch.map(day => readVercelChargeDay(day, teamId, token, fetcher)))
    results.push(...batch.map((day, offset) => Object.freeze({ day, text: texts[offset] ?? '' })))
  }
  return Object.freeze(results)
}

export async function readVercelIntegrations(teamId: string, token: string, fetcher: typeof fetch): Promise<unknown> {
  const url = new URL('https://api.vercel.com/v1/integrations/configurations')
  url.searchParams.set('view', 'account')
  url.searchParams.set('teamId', teamId)
  const text = await fetchBounded(url, { headers: vercelHeaders(token, 'application/json') }, 'Vercel', fetcher)
  return parseJson(text, 'Vercel')
}

export function githubHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
}

export async function readGitHubPages(
  path: string, query: Readonly<Record<string, string>>, token: string, fetcher: typeof fetch,
): Promise<readonly Record<string, unknown>[]> {
  const values: Record<string, unknown>[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(`https://api.github.com${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    url.searchParams.set('per_page', String(PAGE_SIZE))
    url.searchParams.set('page', String(page))
    const list = parseJson(await fetchBounded(url, { headers: githubHeaders(token) }, 'GitHub', fetcher), 'GitHub')
    if (!Array.isArray(list)) throw new Error('GitHub returned an invalid list')
    values.push(...list.filter(isPlainObject))
    if (list.length < PAGE_SIZE) return Object.freeze(values)
  }
  throw new Error('GitHub pagination exceeded safety limit')
}

export async function listOpenPullRequestHeads(repository: string, token: string, fetcher: typeof fetch): Promise<readonly string[]> {
  const pulls = await readGitHubPages(`/repos/${repository}/pulls`, { state: 'open' }, token, fetcher)
  return Object.freeze(pulls.map(pull => {
    if (!isPlainObject(pull.head) || typeof pull.head.ref !== 'string' || !pull.head.ref) {
      throw new Error('GitHub returned a pull request without a branch name')
    }
    return pull.head.ref
  }))
}
