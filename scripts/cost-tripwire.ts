import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const ALERT_MULTIPLIER = 3
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 20_000
const ISSUE_TITLE = 'Cost tripwire'
const ISSUE_OWNERSHIP_MARKER = '<!-- cost-tripwire-owner:github-actions -->'
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]'

type FocusBillingRow = Readonly<{
  BillingCurrency: 'USD'
  ChargePeriodStart: string
  ConsumedQuantity: number | null
  EffectiveCost: number
  ServiceName: string
  Tags: Readonly<{ ProjectName: string }>
}>

export type CostThresholds = Readonly<{
  schemaVersion: 1
  vercel: Readonly<{
    maxDailySpendUsd: number
    projects: Readonly<Record<string, Readonly<{
      edgeRequestsPerDay: number
      functionInvocationsPerDay: number
    }>>>
  }>
  neon: Readonly<{ maxPreviewBranches: number }>
}>

export type BillingSummary = Readonly<{
  projectDays: readonly Readonly<{
    date: string
    project: string
    edgeRequests: number
    functionInvocations: number
    effectiveCostUsd: number
  }>[]
  teamSpendByDay: readonly Readonly<{ date: string; effectiveCostUsd: number }>[]
}>

type Violation = Readonly<{
  metric: 'edge_requests' | 'function_invocations' | 'daily_spend_usd' | 'preview_branches'
  label: string
  actual: number
  limit: number
}>

type CheckStatus = Readonly<{ provider: 'Vercel' | 'Neon'; status: 'ok' | 'skipped' | 'failed'; detail: string }>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGitHubActionsBotAuthored(value: Record<string, unknown>): boolean {
  return isPlainObject(value.user) && value.user.login === GITHUB_ACTIONS_BOT_LOGIN
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing threshold keys`)
  }
}

function positiveFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} threshold must be a positive finite number`)
  }
  return value
}

export function validateCostThresholds(value: unknown): CostThresholds {
  if (!isPlainObject(value)) throw new Error('Cost threshold configuration must be an object')
  exactKeys(value, ['schemaVersion', 'vercel', 'neon'], 'Cost threshold configuration')
  if (value.schemaVersion !== 1) throw new Error('Cost threshold schemaVersion must be 1')
  if (!isPlainObject(value.vercel) || !isPlainObject(value.neon)) {
    throw new Error('Vercel and Neon threshold sections are required')
  }
  exactKeys(value.vercel, ['maxDailySpendUsd', 'projects'], 'Vercel thresholds')
  exactKeys(value.neon, ['maxPreviewBranches'], 'Neon thresholds')
  if (!isPlainObject(value.vercel.projects) || Object.keys(value.vercel.projects).length === 0) {
    throw new Error('At least one Vercel project threshold is required')
  }

  const projects = Object.fromEntries(Object.entries(value.vercel.projects).map(([name, limits]) => {
    if (!name.trim() || !isPlainObject(limits)) throw new Error('Each Vercel project needs thresholds')
    exactKeys(limits, ['edgeRequestsPerDay', 'functionInvocationsPerDay'], `Thresholds for ${name}`)
    return [name, Object.freeze({
      edgeRequestsPerDay: positiveFinite(limits.edgeRequestsPerDay, `${name} Edge Requests`),
      functionInvocationsPerDay: positiveFinite(limits.functionInvocationsPerDay, `${name} Function Invocations`),
    })]
  }))

  return Object.freeze({
    schemaVersion: 1,
    vercel: Object.freeze({
      maxDailySpendUsd: positiveFinite(value.vercel.maxDailySpendUsd, 'Daily spend'),
      projects: Object.freeze(projects),
    }),
    neon: Object.freeze({
      maxPreviewBranches: positiveFinite(value.neon.maxPreviewBranches, 'Preview branch'),
    }),
  })
}

function finiteNumber(value: unknown, label: string, allowNegative = false): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || (!allowNegative && number < 0)) {
    throw new Error(`FOCUS ${label} must be a ${allowNegative ? '' : 'non-negative '}finite number`)
  }
  return number
}

export function parseFocusBillingJsonl(text: string): readonly FocusBillingRow[] {
  const lines = text.split(/\r?\n/u).filter(line => line.trim())
  return lines.map((line, index) => {
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error(`FOCUS line ${index + 1} is invalid JSON`) }
    if (!isPlainObject(value)) throw new Error(`FOCUS line ${index + 1} must be an object`)
    if (value.BillingCurrency !== 'USD') throw new Error(`FOCUS line ${index + 1} is not USD`)
    if (typeof value.ChargePeriodStart !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value.ChargePeriodStart)) {
      throw new Error(`FOCUS line ${index + 1} has an invalid charge start`)
    }
    if (typeof value.ServiceName !== 'string' || !isPlainObject(value.Tags) ||
        typeof value.Tags.ProjectName !== 'string' || !value.Tags.ProjectName.trim()) {
      throw new Error(`FOCUS line ${index + 1} has invalid service or project tags`)
    }
    const measuresRequests = value.ServiceName === 'Edge Requests' || value.ServiceName === 'Function Invocations'
    const consumedQuantity = value.ConsumedQuantity === null && !measuresRequests
      ? null
      : finiteNumber(value.ConsumedQuantity, 'quantity')
    return Object.freeze({
      BillingCurrency: 'USD' as const,
      ChargePeriodStart: value.ChargePeriodStart,
      ConsumedQuantity: consumedQuantity,
      EffectiveCost: finiteNumber(value.EffectiveCost, 'effective cost', true),
      ServiceName: value.ServiceName,
      Tags: Object.freeze({ ProjectName: value.Tags.ProjectName }),
    })
  })
}

function roundedCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100_000_000) / 100_000_000
}

export function summarizeFocusBilling(rows: readonly FocusBillingRow[]): BillingSummary {
  const projects = new Map<string, { date: string; project: string; edgeRequests: number; functionInvocations: number; effectiveCostUsd: number }>()
  const spend = new Map<string, number>()

  for (const row of rows) {
    const date = row.ChargePeriodStart.slice(0, 10)
    spend.set(date, (spend.get(date) ?? 0) + row.EffectiveCost)
    const key = `${date}\0${row.Tags.ProjectName}`
    const current = projects.get(key) ?? {
      date, project: row.Tags.ProjectName, edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0,
    }
    projects.set(key, {
      ...current,
      edgeRequests: current.edgeRequests + (row.ServiceName === 'Edge Requests' ? row.ConsumedQuantity ?? 0 : 0),
      functionInvocations: current.functionInvocations + (row.ServiceName === 'Function Invocations' ? row.ConsumedQuantity ?? 0 : 0),
      effectiveCostUsd: current.effectiveCostUsd + row.EffectiveCost,
    })
  }

  return Object.freeze({
    projectDays: Object.freeze([...projects.values()]
      .map(value => Object.freeze({ ...value, effectiveCostUsd: roundedCurrency(value.effectiveCostUsd) }))
      .sort((left, right) => left.date.localeCompare(right.date) || left.project.localeCompare(right.project))),
    teamSpendByDay: Object.freeze([...spend.entries()]
      .map(([date, effectiveCostUsd]) => Object.freeze({ date, effectiveCostUsd: roundedCurrency(effectiveCostUsd) }))
      .sort((left, right) => left.date.localeCompare(right.date))),
  })
}

export function compareCostMetrics(input: Readonly<{
  summary?: BillingSummary
  previewBranchCount?: number
  thresholds: CostThresholds
}>): Readonly<{ violations: readonly Violation[]; unconfiguredProjects: readonly string[] }> {
  const violations: Violation[] = []
  const unconfigured = new Set<string>()
  for (const day of input.summary?.projectDays ?? []) {
    const baseline = input.thresholds.vercel.projects[day.project]
    if (!baseline) { unconfigured.add(day.project); continue }
    const edgeLimit = baseline.edgeRequestsPerDay * ALERT_MULTIPLIER
    if (day.edgeRequests > edgeLimit) violations.push({
      metric: 'edge_requests', label: `${day.project} ${day.date}`, actual: day.edgeRequests, limit: edgeLimit,
    })
    const functionLimit = baseline.functionInvocationsPerDay * ALERT_MULTIPLIER
    if (day.functionInvocations > functionLimit) violations.push({
      metric: 'function_invocations', label: `${day.project} ${day.date}`,
      actual: day.functionInvocations, limit: functionLimit,
    })
  }
  for (const day of input.summary?.teamSpendByDay ?? []) {
    if (day.effectiveCostUsd > input.thresholds.vercel.maxDailySpendUsd) violations.push({
      metric: 'daily_spend_usd', label: day.date, actual: day.effectiveCostUsd,
      limit: input.thresholds.vercel.maxDailySpendUsd,
    })
  }
  if (input.previewBranchCount !== undefined && input.previewBranchCount > input.thresholds.neon.maxPreviewBranches) violations.push({
    metric: 'preview_branches', label: 'Neon preview/* branches', actual: input.previewBranchCount,
    limit: input.thresholds.neon.maxPreviewBranches,
  })
  return Object.freeze({
    violations: Object.freeze(violations.map(value => Object.freeze(value))),
    unconfiguredProjects: Object.freeze([...unconfigured].sort()),
  })
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? error.message : 'unknown error'
  return raw.replace(/[\r\n\x00-\x1f]+/gu, ' ').replace(/https?:\/\/\S+/gu, '[URL redacted]').slice(0, 240)
}

async function readBoundedResponse(response: Response, provider: string): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`${provider} response exceeded size limit`)
  const text = await response.text()
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new Error(`${provider} response exceeded size limit`)
  if (!response.ok) throw new Error(`${provider} API returned HTTP ${response.status}`)
  return text
}

async function fetchBounded(url: URL, init: RequestInit, provider: string, fetcher: typeof fetch): Promise<string> {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  return readBoundedResponse(response, provider)
}

async function listNeonBranches(projectId: string, token: string, fetcher: typeof fetch): Promise<readonly string[]> {
  const names: string[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()
  for (let page = 0; page < 100; page += 1) {
    const url = new URL(`https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}/branches`)
    url.searchParams.set('limit', '100')
    if (cursor) url.searchParams.set('cursor', cursor)
    const text = await fetchBounded(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }, 'Neon', fetcher)
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new Error('Neon API returned invalid JSON') }
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
    if (names.length > 10_000) throw new Error('Neon branch list exceeded safety limit')
  }
  throw new Error('Neon branch pagination exceeded page limit')
}

function sevenCompleteUtcDays(now: Date): Readonly<{ from: string; to: string }> {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
  return Object.freeze({ from: from.toISOString(), to: to.toISOString() })
}

function renderReport(input: Readonly<{
  date: string
  marker: string
  summary?: BillingSummary
  previewBranchCount?: number
  comparison?: ReturnType<typeof compareCostMetrics>
  statuses: readonly CheckStatus[]
}>): string {
  const lines = [input.marker, `## Cost tripwire — ${input.date}`, '', '### Check status', '']
  for (const status of input.statuses) lines.push(`- **${status.provider}:** ${status.status.toUpperCase()} — ${status.detail}`)
  if (input.summary) {
    lines.push('', '### Vercel daily usage', '', '| UTC day | Project | Edge Requests | Function Invocations | Effective cost |', '|---|---|---:|---:|---:|')
    for (const day of input.summary.projectDays) lines.push(
      `| ${day.date} | ${day.project.replaceAll('|', '\\|')} | ${day.edgeRequests} | ${day.functionInvocations} | $${day.effectiveCostUsd.toFixed(2)} |`,
    )
  }
  if (input.previewBranchCount !== undefined) lines.push('', `Neon \`preview/*\` branches: **${input.previewBranchCount}**.`)
  lines.push('', '### Result', '')
  const incomplete = input.statuses.some(status => status.status !== 'ok')
  if (input.comparison?.violations.length) {
    for (const violation of input.comparison.violations) lines.push(`- ${violation.label}: ${violation.actual} (limit ${violation.limit}).`)
  } else lines.push('- No available metric exceeded its configured threshold.')
  if (incomplete) lines.push('- INCOMPLETE — one or more provider checks did not return usable metrics.')
  if (input.comparison?.unconfiguredProjects.length) lines.push(
    `- No baseline is configured for: ${input.comparison.unconfiguredProjects.join(', ')}. Add one before treating this run as complete.`,
  )
  lines.push('', 'See `docs/runbooks/ENVIRONMENT.md` and `docs/runbooks/COSTS.md` before changing infrastructure.')
  return lines.join('\n')
}

export async function publishCostTripwireIssue(
  report: string,
  marker: string,
  environment: NodeJS.ProcessEnv,
  fetcher: typeof fetch,
): Promise<'created' | 'commented' | 'already-published'> {
  const token = environment.GITHUB_TOKEN
  const repository = environment.GITHUB_REPOSITORY
  if (!token || !repository || !/^[^/]+\/[^/]+$/u.test(repository)) throw new Error('GitHub issue publishing is not configured')
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }
  const issues: Array<Record<string, unknown>> = []
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(`https://api.github.com/repos/${repository}/issues`)
    url.searchParams.set('state', 'open'); url.searchParams.set('per_page', '100'); url.searchParams.set('page', String(page))
    const text = await fetchBounded(url, { headers }, 'GitHub', fetcher)
    const values: unknown = JSON.parse(text)
    if (!Array.isArray(values)) throw new Error('GitHub returned an invalid issue list')
    issues.push(...values.filter(isPlainObject))
    if (values.length < 100) break
    if (page === 100) throw new Error('GitHub open issue pagination exceeded safety limit')
  }
  const matches = issues.filter(issue => (
    issue.title === ISSUE_TITLE
    && !('pull_request' in issue)
    && isGitHubActionsBotAuthored(issue)
    && typeof issue.body === 'string'
    && issue.body.includes(ISSUE_OWNERSHIP_MARKER)
  ))
  if (matches.length > 1) throw new Error('Multiple open Cost tripwire issues exist')
  if (matches.length === 0) {
    const url = new URL(`https://api.github.com/repos/${repository}/issues`)
    const body = `${ISSUE_OWNERSHIP_MARKER}\n${report}`
    await fetchBounded(url, { method: 'POST', headers, body: JSON.stringify({ title: ISSUE_TITLE, body }) }, 'GitHub', fetcher)
    return 'created'
  }
  const number = matches[0]?.number
  if (typeof number !== 'number') throw new Error('GitHub returned an invalid Cost tripwire issue')
  if (typeof matches[0]?.body === 'string' && matches[0].body.includes(marker)) {
    return 'already-published'
  }
  const commentsUrl = new URL(`https://api.github.com/repos/${repository}/issues/${number}/comments`)
  for (let page = 1; page <= 100; page += 1) {
    commentsUrl.searchParams.set('per_page', '100')
    commentsUrl.searchParams.set('page', String(page))
    const commentsText = await fetchBounded(commentsUrl, { headers }, 'GitHub', fetcher)
    const comments: unknown = JSON.parse(commentsText)
    if (!Array.isArray(comments)) throw new Error('GitHub returned invalid issue comments')
    if (comments.some(comment => (
      isPlainObject(comment)
      && isGitHubActionsBotAuthored(comment)
      && typeof comment.body === 'string'
      && comment.body.includes(marker)
    ))) {
      return 'already-published'
    }
    if (comments.length < 100) break
    if (page === 100) throw new Error('GitHub issue comment pagination exceeded safety limit')
  }
  commentsUrl.search = ''
  await fetchBounded(commentsUrl, { method: 'POST', headers, body: JSON.stringify({ body: report }) }, 'GitHub', fetcher)
  return 'commented'
}

export async function runCostTripwire(input: Readonly<{
  dryRun: boolean
  environment?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  now?: Date
}>): Promise<void> {
  const environment = input.environment ?? process.env
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? new Date()
  const configText = await readFile(new URL('../config/cost-tripwire.json', import.meta.url), 'utf8')
  const thresholds = validateCostThresholds(JSON.parse(configText))
  const statuses: CheckStatus[] = []
  let summary: BillingSummary | undefined
  let previewBranchCount: number | undefined

  if (!environment.VERCEL_TOKEN || !environment.VERCEL_TEAM_ID) {
    statuses.push({ provider: 'Vercel', status: 'skipped', detail: 'VERCEL_TOKEN or VERCEL_TEAM_ID is absent.' })
  } else try {
    const range = sevenCompleteUtcDays(now)
    const url = new URL('https://api.vercel.com/v1/billing/charges')
    url.searchParams.set('teamId', environment.VERCEL_TEAM_ID)
    url.searchParams.set('from', range.from); url.searchParams.set('to', range.to)
    const text = await fetchBounded(url, { headers: { Authorization: `Bearer ${environment.VERCEL_TOKEN}`, Accept: 'application/x-ndjson' } }, 'Vercel', fetcher)
    summary = summarizeFocusBilling(parseFocusBillingJsonl(text))
    statuses.push({ provider: 'Vercel', status: 'ok', detail: 'Seven complete UTC days read.' })
  } catch (error) {
    statuses.push({ provider: 'Vercel', status: 'failed', detail: safeDetail(error) })
  }

  if (!environment.NEON_API_KEY || !environment.NEON_PROJECT_ID) {
    statuses.push({ provider: 'Neon', status: 'skipped', detail: 'NEON_API_KEY or NEON_PROJECT_ID is absent.' })
  } else try {
    const branches = await listNeonBranches(environment.NEON_PROJECT_ID, environment.NEON_API_KEY, fetcher)
    previewBranchCount = branches.filter(name => name.startsWith('preview/')).length
    statuses.push({ provider: 'Neon', status: 'ok', detail: 'All active branches read.' })
  } catch (error) {
    statuses.push({ provider: 'Neon', status: 'failed', detail: safeDetail(error) })
  }

  const comparison = compareCostMetrics({
    thresholds,
    ...(summary ? { summary } : {}),
    ...(previewBranchCount !== undefined ? { previewBranchCount } : {}),
  })
  const date = now.toISOString().slice(0, 10)
  const runIdentity = environment.GITHUB_RUN_ID ?? `dry-run-${date}`
  const marker = `<!-- cost-tripwire-run:${runIdentity} -->`
  const report = renderReport({
    date,
    marker,
    statuses,
    ...(summary ? { summary } : {}),
    ...(previewBranchCount !== undefined ? { previewBranchCount } : {}),
    comparison,
  })
  const shouldAlert = statuses.some(status => status.status !== 'ok') ||
    Boolean(comparison?.violations.length) || Boolean(comparison?.unconfiguredProjects.length)

  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (input.dryRun) {
    console.log(`${shouldAlert ? 'Would open or update' : 'Would not open'} "${ISSUE_TITLE}".\n\n${report}`)
    return
  }
  if (!shouldAlert) { console.log('Cost tripwire healthy; no issue update needed.'); return }
  const outcome = await publishCostTripwireIssue(report, marker, environment, fetcher)
  console.log(`Cost tripwire issue ${outcome}.`)
}

function parseArguments(arguments_: readonly string[]): Readonly<{ dryRun: boolean }> {
  if (arguments_.length === 0) return Object.freeze({ dryRun: false })
  if (arguments_.length === 1 && arguments_[0] === '--dry-run') return Object.freeze({ dryRun: true })
  throw new Error('Usage: npm run cost-tripwire OR npm run cost-tripwire -- --dry-run')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCostTripwire(parseArguments(process.argv.slice(2))).catch(error => {
    console.error(`Cost tripwire failed: ${safeDetail(error)}`)
    process.exitCode = 1
  })
}
