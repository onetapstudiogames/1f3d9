import { appendFile, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { safeErrorDetail } from './safe-error-detail.ts'
import { SHARED_BRANCH } from './neon-preview-cleanup.ts'
import {
  fetchBounded,
  githubHeaders,
  isPlainObject,
  listNeonBranches,
  listOpenPullRequestHeads,
  readGitHubPages,
  readNeonSnapshots,
  readVercelChargeDays,
  readVercelIntegrations,
  type SnapshotCounts,
} from './cost-tripwire-reads.ts'

const ALERT_MULTIPLIER = 3
const DAY_MS = 24 * 60 * 60 * 1000
// A Pacific charge day ends at 07:00 or 08:00 UTC. From 12:00 UTC the day before is
// treated as settled; earlier in the UTC day the run stops one day further back.
const CHARGE_DAY_SETTLED_HOUR_UTC = 12
// Day limits look at the last two settled days, so one skipped scheduled run cannot hide a day.
// On the first day of a cycle the earlier of the two is the old cycle's last day: it is read
// and checked for the day limits, but kept out of the new cycle's total.
const DAILY_LIMIT_LOOKBACK_DAYS = 2
const NEON_SPENDING_MAX_AGE_HOURS = 48
const MIN_PROJECTION_BASIS_MS = DAY_MS
const ISSUE_TITLE_PREFIX = 'Cost tripwire'
const ISSUE_OWNERSHIP_MARKER = '<!-- cost-tripwire-owner:github-actions -->'
const GITHUB_ACTIONS_BOT_LOGIN = 'github-actions[bot]'
const CONFIG_PATH = 'config/cost-tripwire.json'
const WATCHED_PROJECT = '1f3d9'
const PREVIEW_PREFIX = 'preview/'
const EDGE_REQUEST_SERVICES: ReadonlySet<string> = new Set(['Edge Requests', 'CDN Requests'])
const FUNCTION_INVOCATION_SERVICE = 'Function Invocations'

type FocusBillingRow = Readonly<{
  BillingCurrency: 'USD'
  ChargePeriodStart: string
  ChargePeriodEnd: string
  ConsumedQuantity: number | null
  EffectiveCost: number
  ServiceName: string
  Tags: Readonly<{ ProjectName?: string }>
}>

type ProjectThreshold = Readonly<{
  edgeRequestsPerDay: number
  functionInvocationsPerDay: number
}> | Readonly<{ unmonitored: true; reason: string }>

export type CostThresholds = Readonly<{
  schemaVersion: 2
  cycleBudgetUsd: number
  vercel: Readonly<{
    cycleStartDay: number
    maxDailySpendUsd: number
    projects: Readonly<Record<string, ProjectThreshold>>
  }>
  neon: Readonly<{ maxPreviewBranches: number; maxManualSnapshotsWithoutExpiry: number }>
  why: Readonly<Record<string, string>>
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

export type VercelCycle = Readonly<{
  firstDay: string
  lastDay: string
  length: number
  daysToRead: readonly string[]
  dayLimitDays: readonly string[]
}>

type NeonSpendingItem = Readonly<{ name: string; quantity: number; units: string; totalUsd: number }>

export type NeonSpending = Readonly<{
  periodStart: string
  periodEnd: string
  measuredAt: string
  totalUsd: number
  items: readonly NeonSpendingItem[]
}>

export type CostReadings = Readonly<{
  vercel?: Readonly<{ cycle: VercelCycle; summary: BillingSummary }>
  neonSpending?: NeonSpending
  previewBranches?: readonly string[]
  openPullRequestHeads?: readonly string[]
  snapshots?: SnapshotCounts
}>

type Projection = Readonly<{
  vercelSoFarUsd?: number
  vercelProjectedUsd?: number
  neonSoFarUsd?: number
  neonProjectedUsd?: number
  totalProjectedUsd?: number
}>

type Comparison = Readonly<{
  findings: readonly string[]
  orphanPreviewBranches: readonly string[]
  projection: Projection
}>

type Provider = 'Vercel charges' | 'Neon spending' | 'Neon branches' | 'Neon snapshots' | 'GitHub pull requests'
type CheckStatus = Readonly<{ provider: Provider; status: 'ok' | 'skipped' | 'failed'; detail: string }>

export type CostTripwireResult = Readonly<{
  red: boolean
  report: string
  issue?: 'created' | 'commented' | 'already-published'
}>

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

function validateProject(name: string, limits: unknown): ProjectThreshold {
  if (!name.trim() || !isPlainObject(limits)) throw new Error('Each Vercel project needs thresholds')
  if (limits.unmonitored === true) {
    exactKeys(limits, ['unmonitored', 'reason'], `Thresholds for ${name}`)
    if (typeof limits.reason !== 'string' || !limits.reason.trim()) {
      throw new Error(`${name} unmonitored threshold reason must be a non-empty string`)
    }
    return Object.freeze({ unmonitored: true as const, reason: limits.reason })
  }
  exactKeys(limits, ['edgeRequestsPerDay', 'functionInvocationsPerDay'], `Thresholds for ${name}`)
  return Object.freeze({
    edgeRequestsPerDay: positiveFinite(limits.edgeRequestsPerDay, `${name} Edge Requests`),
    functionInvocationsPerDay: positiveFinite(limits.functionInvocationsPerDay, `${name} Function Invocations`),
  })
}

function validateWhy(value: unknown): Readonly<Record<string, string>> {
  if (!isPlainObject(value) || Object.values(value).some(reason => typeof reason !== 'string' || !reason.trim())) {
    throw new Error('Cost threshold why entries must be non-empty strings')
  }
  return Object.freeze({ ...value } as Record<string, string>)
}

function cycleStartDay(value: unknown): number {
  const MAX_SAFE_CYCLE_DAY = 28
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_SAFE_CYCLE_DAY) {
    throw new Error('Vercel cycleStartDay threshold must be a whole day from 1 to 28')
  }
  return value
}

export function validateCostThresholds(value: unknown): CostThresholds {
  if (!isPlainObject(value)) throw new Error('Cost threshold configuration must be an object')
  exactKeys(value, ['schemaVersion', 'cycleBudgetUsd', 'vercel', 'neon', 'why'], 'Cost threshold configuration')
  if (value.schemaVersion !== 2) throw new Error('Cost threshold schemaVersion must be 2')
  if (!isPlainObject(value.vercel) || !isPlainObject(value.neon)) {
    throw new Error('Vercel and Neon threshold sections are required')
  }
  exactKeys(value.vercel, ['cycleStartDay', 'maxDailySpendUsd', 'projects'], 'Vercel thresholds')
  exactKeys(value.neon, ['maxPreviewBranches', 'maxManualSnapshotsWithoutExpiry'], 'Neon thresholds')
  if (!isPlainObject(value.vercel.projects) || Object.keys(value.vercel.projects).length === 0) {
    throw new Error('At least one Vercel project threshold is required')
  }
  const projects = Object.fromEntries(Object.entries(value.vercel.projects)
    .map(([name, limits]) => [name, validateProject(name, limits)]))
  return Object.freeze({
    schemaVersion: 2,
    cycleBudgetUsd: positiveFinite(value.cycleBudgetUsd, 'Cycle budget'),
    vercel: Object.freeze({
      cycleStartDay: cycleStartDay(value.vercel.cycleStartDay),
      maxDailySpendUsd: positiveFinite(value.vercel.maxDailySpendUsd, 'Daily spend'),
      projects: Object.freeze(projects),
    }),
    neon: Object.freeze({
      maxPreviewBranches: positiveFinite(value.neon.maxPreviewBranches, 'Preview branch'),
      maxManualSnapshotsWithoutExpiry: positiveFinite(value.neon.maxManualSnapshotsWithoutExpiry, 'Manual snapshot'),
    }),
    why: validateWhy(value.why),
  })
}

function finiteNumber(value: unknown, lineNumber: number, label: string, allowNegative = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (!allowNegative && value < 0)) {
    throw new Error(`FOCUS line ${lineNumber} ${label} must be a ${allowNegative ? '' : 'non-negative '}finite number`)
  }
  return value
}

function chargeTime(value: unknown, lineNumber: number, label: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`FOCUS line ${lineNumber} has an invalid charge ${label}`)
  }
  return value
}

function measuresRequests(serviceName: string): boolean {
  return EDGE_REQUEST_SERVICES.has(serviceName) || serviceName === FUNCTION_INVOCATION_SERVICE
}

function parseFocusLine(line: string, lineNumber: number): FocusBillingRow {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw new Error(`FOCUS line ${lineNumber} is invalid JSON`) }
  if (!isPlainObject(value)) throw new Error(`FOCUS line ${lineNumber} must be an object`)
  if (value.BillingCurrency !== 'USD') throw new Error(`FOCUS line ${lineNumber} is not USD`)
  const start = chargeTime(value.ChargePeriodStart, lineNumber, 'start')
  const end = chargeTime(value.ChargePeriodEnd, lineNumber, 'end')
  if (typeof value.ServiceName !== 'string' || !value.ServiceName.trim()) {
    throw new Error(`FOCUS line ${lineNumber} has an invalid service name`)
  }
  if (!isPlainObject(value.Tags)) throw new Error(`FOCUS line ${lineNumber} tags must be an object`)
  const projectName = value.Tags.ProjectName
  if (projectName !== undefined && (typeof projectName !== 'string' || !projectName.trim())) {
    throw new Error(`FOCUS line ${lineNumber} has an invalid project name tag`)
  }
  const consumedQuantity = value.ConsumedQuantity === null && !measuresRequests(value.ServiceName)
    ? null
    : finiteNumber(value.ConsumedQuantity, lineNumber, 'quantity')
  return Object.freeze({
    BillingCurrency: 'USD' as const,
    ChargePeriodStart: start,
    ChargePeriodEnd: end,
    ConsumedQuantity: consumedQuantity,
    EffectiveCost: finiteNumber(value.EffectiveCost, lineNumber, 'effective cost', true),
    ServiceName: value.ServiceName,
    Tags: Object.freeze(projectName === undefined ? {} : { ProjectName: projectName }),
  })
}

export function parseFocusBillingJsonl(text: string): readonly FocusBillingRow[] {
  return Object.freeze(text.split(/\r?\n/u)
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter(({ line }) => line.trim())
    .map(({ line, lineNumber }) => parseFocusLine(line, lineNumber)))
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
    const project = row.Tags.ProjectName
    if (!project) continue
    const key = `${date}\0${project}`
    const current = projects.get(key) ?? {
      date, project, edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0,
    }
    projects.set(key, {
      ...current,
      edgeRequests: current.edgeRequests + (EDGE_REQUEST_SERVICES.has(row.ServiceName) ? row.ConsumedQuantity ?? 0 : 0),
      functionInvocations: current.functionInvocations + (row.ServiceName === FUNCTION_INVOCATION_SERVICE ? row.ConsumedQuantity ?? 0 : 0),
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

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10)
}

function dayStart(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`)
}

export function latestSettledChargeDay(now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const daysBack = now.getUTCHours() < CHARGE_DAY_SETTLED_HOUR_UTC ? 2 : 1
  return utcDay(today - daysBack * DAY_MS)
}

export function vercelCycleThrough(latestDay: string, startDay: number): VercelCycle {
  const latest = new Date(dayStart(latestDay))
  const startMonth = latest.getUTCDate() >= startDay ? latest.getUTCMonth() : latest.getUTCMonth() - 1
  const first = Date.UTC(latest.getUTCFullYear(), startMonth, startDay)
  const next = Date.UTC(latest.getUTCFullYear(), startMonth + 1, startDay)
  const readCount = Math.round((latest.getTime() - first) / DAY_MS) + 1
  return Object.freeze({
    firstDay: utcDay(first),
    lastDay: utcDay(next - DAY_MS),
    length: Math.round((next - first) / DAY_MS),
    daysToRead: Object.freeze(Array.from({ length: readCount }, (_, index) => utcDay(first + index * DAY_MS))),
    dayLimitDays: Object.freeze(Array.from({ length: DAILY_LIMIT_LOOKBACK_DAYS }, (_, index) => (
      utcDay(latest.getTime() - (DAILY_LIMIT_LOOKBACK_DAYS - 1 - index) * DAY_MS)
    ))),
  })
}

function vercelDaysToFetch(cycle: VercelCycle): readonly string[] {
  return Object.freeze([...new Set([...cycle.dayLimitDays, ...cycle.daysToRead])].sort())
}

function inCycle(cycle: VercelCycle, date: string): boolean {
  return date >= cycle.firstDay && date <= cycle.lastDay
}

export function chargeRowsForDay(day: string, text: string, now: Date): readonly FocusBillingRow[] {
  const rows = parseFocusBillingJsonl(text)
  if (rows.length === 0) throw new Error(`Vercel returned no charges for ${day}`)
  const otherDay = rows.find(row => row.ChargePeriodStart.slice(0, 10) !== day)
  if (otherDay) throw new Error(`Vercel returned charges for ${otherDay.ChargePeriodStart.slice(0, 10)} when asked for ${day}`)
  if (rows.some(row => Date.parse(row.ChargePeriodEnd) > now.getTime())) {
    throw new Error(`Vercel charges for ${day} are not complete yet`)
  }
  return rows
}

function parseCents(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Neon spending ${label} must be a whole number of cents`)
  }
  return value
}

function spendingTime(value: unknown, label: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new Error(`Neon spending has an invalid ${label}`)
  return value
}

function parseSpendingItem(item: unknown): NeonSpendingItem {
  const total = isPlainObject(item) && typeof item.total === 'string' ? Number(item.total) : Number.NaN
  if (!isPlainObject(item) || typeof item.name !== 'string' || !item.name.trim() || typeof item.units !== 'string'
    || typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || !Number.isFinite(total) || total < 0) {
    throw new Error('Neon spending has an invalid line item')
  }
  return Object.freeze({ name: item.name, quantity: item.quantity, units: item.units, totalUsd: total })
}

function neonSpendingBlock(configurations: unknown): Record<string, unknown> {
  if (!Array.isArray(configurations)) throw new Error('Vercel returned an invalid integration list')
  const neon = configurations.filter(entry => isPlainObject(entry) && entry.slug === 'neon')
  if (neon.length !== 1) throw new Error(`Vercel lists ${neon.length} Neon integrations; expected exactly one`)
  const billing = isPlainObject(neon[0]) ? neon[0].billingData : undefined
  if (!isPlainObject(billing) || !isPlainObject(billing.spending)) throw new Error('The Neon integration has no spending block')
  return billing.spending
}

export function parseNeonSpending(configurations: unknown, now: Date): NeonSpending {
  const spending = neonSpendingBlock(configurations)
  const periodStart = spendingTime(spending.periodStart, 'period start')
  const periodEnd = spendingTime(spending.periodEnd, 'period end')
  const measuredAt = spendingTime(spending.timestamp, 'timestamp')
  if (Date.parse(periodEnd) <= Date.parse(periodStart) || Date.parse(measuredAt) < Date.parse(periodStart)) {
    throw new Error('Neon spending period does not contain its own timestamp')
  }
  const ageHours = (now.getTime() - Date.parse(measuredAt)) / (60 * 60 * 1000)
  if (ageHours > NEON_SPENDING_MAX_AGE_HOURS) throw new Error(`Neon spending was last measured ${Math.round(ageHours)} hours ago`)
  const totalCents = parseCents(spending.totalCent, 'total')
  if (!Array.isArray(spending.items) || spending.items.length === 0) throw new Error('Neon spending has no line items')
  const items = Object.freeze(spending.items.map(parseSpendingItem))
  const itemCents = Math.round(items.reduce((sum, item) => sum + item.totalUsd, 0) * 100)
  if (Math.abs(itemCents - totalCents) > items.length) {
    throw new Error(`Neon line items add up to ${money(itemCents / 100)}, not the total ${money(totalCents / 100)}`)
  }
  return Object.freeze({ periodStart, periodEnd, measuredAt, totalUsd: totalCents / 100, items })
}

function money(value: number): string {
  return `$${value.toFixed(2)}`
}

function count(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function vercelSoFar(cycle: VercelCycle, summary: BillingSummary): number {
  const cycleDays = summary.teamSpendByDay.filter(day => inCycle(cycle, day.date))
  return roundedCurrency(cycleDays.reduce((sum, day) => sum + day.effectiveCostUsd, 0))
}

function project(readings: CostReadings): Projection {
  const vercel = readings.vercel
  const neon = readings.neonSpending
  const vercelSoFarUsd = vercel ? vercelSoFar(vercel.cycle, vercel.summary) : undefined
  const vercelProjectedUsd = vercel && vercelSoFarUsd !== undefined
    ? vercelSoFarUsd * vercel.cycle.length / vercel.cycle.daysToRead.length
    : undefined
  const neonProjectedUsd = neon ? projectNeon(neon) : undefined
  const parts = [vercelProjectedUsd, neonProjectedUsd].filter((part): part is number => part !== undefined)
  return Object.freeze({
    ...(vercelSoFarUsd !== undefined ? { vercelSoFarUsd } : {}),
    ...(vercelProjectedUsd !== undefined ? { vercelProjectedUsd } : {}),
    ...(neon ? { neonSoFarUsd: neon.totalUsd } : {}),
    ...(neonProjectedUsd !== undefined ? { neonProjectedUsd } : {}),
    ...(parts.length ? { totalProjectedUsd: parts.reduce((sum, part) => sum + part, 0) } : {}),
  })
}

function projectNeon(spending: NeonSpending): number {
  const length = Date.parse(spending.periodEnd) - Date.parse(spending.periodStart)
  const elapsed = Date.parse(spending.measuredAt) - Date.parse(spending.periodStart)
  const basis = Math.min(Math.max(elapsed, MIN_PROJECTION_BASIS_MS), length)
  return spending.totalUsd * length / basis
}

function budgetFindings(projection: Projection, thresholds: CostThresholds): readonly string[] {
  const total = projection.totalProjectedUsd
  if (total === undefined || total <= thresholds.cycleBudgetUsd) return []
  const parts = [
    projection.vercelProjectedUsd !== undefined ? `Vercel on course for ${money(projection.vercelProjectedUsd)}` : 'Vercel not read',
    projection.neonProjectedUsd !== undefined ? `Neon on course for ${money(projection.neonProjectedUsd)}` : 'Neon not read',
  ]
  return [`The bill for this cycle is on course for ${money(total)}, over the ${money(thresholds.cycleBudgetUsd)} budget (${parts.join(', ')}).`]
}

function dailyFindings(readings: CostReadings, thresholds: CostThresholds): readonly string[] {
  const vercel = readings.vercel
  if (!vercel) return []
  const checkedDays = new Set(vercel.cycle.dayLimitDays)
  const spend = vercel.summary.teamSpendByDay
    .filter(day => checkedDays.has(day.date) && day.effectiveCostUsd > thresholds.vercel.maxDailySpendUsd)
    .map(day => `Vercel spent ${money(day.effectiveCostUsd)} on ${day.date}, over the ${money(thresholds.vercel.maxDailySpendUsd)} limit for one day.`)
  const requests = vercel.summary.projectDays.filter(day => checkedDays.has(day.date)).flatMap(day => {
    const baseline = thresholds.vercel.projects[day.project]
    if (!baseline || 'unmonitored' in baseline) return []
    return [
      requestFinding(day.project, day.date, 'CDN requests', day.edgeRequests, baseline.edgeRequestsPerDay),
      requestFinding(day.project, day.date, 'function invocations', day.functionInvocations, baseline.functionInvocationsPerDay),
    ].filter((finding): finding is string => finding !== undefined)
  })
  return [...spend, ...requests]
}

function requestFinding(projectName: string, date: string, label: string, actual: number, baseline: number): string | undefined {
  const limit = baseline * ALERT_MULTIPLIER
  if (actual <= limit) return undefined
  return `The ${projectName} project had ${count(actual)} ${label} on ${date}, over the limit of ${count(limit)} (${ALERT_MULTIPLIER} times a normal day of ${count(baseline)}).`
}

function unconfiguredFindings(readings: CostReadings, thresholds: CostThresholds): readonly string[] {
  const names = new Set((readings.vercel?.summary.projectDays ?? [])
    .map(day => day.project)
    .filter(name => !thresholds.vercel.projects[name]))
  return [...names].sort().map(name => `The Vercel bill names the project ${name}, which has no entry in ${CONFIG_PATH}.`)
}

function orphanPreviewBranches(readings: CostReadings): readonly string[] {
  if (!readings.previewBranches || !readings.openPullRequestHeads) return []
  const open = new Set(readings.openPullRequestHeads.map(head => `${PREVIEW_PREFIX}${head}`))
  return readings.previewBranches.filter(name => name !== SHARED_BRANCH && !open.has(name))
}

function slowGrowerFindings(readings: CostReadings, thresholds: CostThresholds, orphans: readonly string[]): readonly string[] {
  const findings: string[] = []
  const snapshotLimit = thresholds.neon.maxManualSnapshotsWithoutExpiry
  if (readings.snapshots && readings.snapshots.manualWithoutExpiry > snapshotLimit) findings.push(
    `The city database has ${readings.snapshots.manualWithoutExpiry} manual snapshots with no end date; the limit is ${snapshotLimit}. Each one is billed at about its full size every month. Nothing was deleted.`,
  )
  const branchLimit = thresholds.neon.maxPreviewBranches
  if (readings.previewBranches && readings.previewBranches.length > branchLimit) findings.push(
    `Neon has ${readings.previewBranches.length} preview database branches, over the limit of ${branchLimit}.`,
  )
  for (const name of orphans) findings.push(
    `The Neon branch ${name} has no open pull request. Nothing was deleted; remove it by hand once you know what made it.`,
  )
  return findings
}

export function compareCosts(readings: CostReadings, thresholds: CostThresholds): Comparison {
  const projection = project(readings)
  const orphans = orphanPreviewBranches(readings)
  return Object.freeze({
    findings: Object.freeze([
      ...budgetFindings(projection, thresholds),
      ...dailyFindings(readings, thresholds),
      ...slowGrowerFindings(readings, thresholds, orphans),
      ...unconfiguredFindings(readings, thresholds),
    ]),
    orphanPreviewBranches: Object.freeze([...orphans]),
    projection,
  })
}

function statusFindings(statuses: readonly CheckStatus[]): readonly string[] {
  return statuses.filter(status => status.status !== 'ok').map(status => (
    `The ${status.provider} read ${status.status === 'skipped' ? 'was skipped' : 'failed'}: ${status.detail} Until it works, the alarm cannot see this part of the bill.`
  ))
}

function billLines(readings: CostReadings, projection: Projection, thresholds: CostThresholds): readonly string[] {
  const lines = ['', '### The bill', '']
  const vercel = readings.vercel
  if (vercel && projection.vercelSoFarUsd !== undefined && projection.vercelProjectedUsd !== undefined) lines.push(
    `- Vercel (cycle ${vercel.cycle.firstDay} to ${vercel.cycle.lastDay}, ${vercel.cycle.daysToRead.length} of ${vercel.cycle.length} days read): ${money(projection.vercelSoFarUsd)} so far, on course for ${money(projection.vercelProjectedUsd)}. This is Vercel's effective cost, which includes the Pro seat.`,
  )
  else lines.push('- Vercel: not read.')
  const neon = readings.neonSpending
  if (neon && projection.neonProjectedUsd !== undefined) {
    const lastDay = utcDay(Date.parse(neon.periodEnd) - DAY_MS)
    lines.push(`- Neon (${neon.periodStart.slice(0, 10)} to ${lastDay}, measured ${neon.measuredAt}): ${money(neon.totalUsd)} so far, on course for ${money(projection.neonProjectedUsd)}.`)
    for (const item of neon.items) lines.push(`  - ${item.name}: ${item.quantity} ${item.units}, ${money(item.totalUsd)}`)
  } else lines.push('- Neon: not read.')
  if (projection.totalProjectedUsd !== undefined) lines.push(
    `- Together: on course for ${money(projection.totalProjectedUsd)} against the ${money(thresholds.cycleBudgetUsd)} budget.`,
  )
  return lines
}

function dayTableLines(readings: CostReadings): readonly string[] {
  const vercel = readings.vercel
  if (!vercel) return []
  const summary = vercel.summary
  const lines = ['', '### Vercel by charge day', '', `| Day | Team cost | ${WATCHED_PROJECT} CDN requests | ${WATCHED_PROJECT} function invocations |`, '|---|---:|---:|---:|']
  for (const day of summary.teamSpendByDay) {
    const watched = summary.projectDays.find(row => row.date === day.date && row.project === WATCHED_PROJECT)
    const label = inCycle(vercel.cycle, day.date) ? day.date : `${day.date} (old cycle, day limits only)`
    lines.push(`| ${label} | ${money(day.effectiveCostUsd)} | ${count(watched?.edgeRequests ?? 0)} | ${count(watched?.functionInvocations ?? 0)} |`)
  }
  return lines
}

function slowGrowerLines(readings: CostReadings, orphans: readonly string[]): readonly string[] {
  const lines = ['', '### Slow growers', '']
  lines.push(readings.snapshots
    ? `- City database snapshots: ${readings.snapshots.total} in all, ${readings.snapshots.manualWithoutExpiry} manual with no end date.`
    : '- City database snapshots: not read.')
  if (readings.previewBranches) {
    const orphanSet = new Set(orphans)
    lines.push(`- Neon preview branches: ${readings.previewBranches.length}.`)
    for (const name of readings.previewBranches) lines.push(`  - ${name}: ${name === SHARED_BRANCH
      ? 'the shared test branch, kept on purpose'
      : orphanSet.has(name) ? 'no open pull request' : readings.openPullRequestHeads ? 'has an open pull request' : 'pull requests not read'}`)
  } else lines.push('- Neon preview branches: not read.')
  return lines
}

function renderReport(input: Readonly<{
  date: string
  marker: string
  readings: CostReadings
  comparison: Comparison
  statuses: readonly CheckStatus[]
  thresholds: CostThresholds
  red: readonly string[]
}>): string {
  const lines = [input.marker, `## Cost tripwire ${input.date}`, '']
  if (input.red.length) {
    lines.push('### What went red', '')
    for (const finding of input.red) lines.push(`- ${finding}`)
  } else lines.push('Nothing crossed a limit and every read worked.')
  lines.push(...billLines(input.readings, input.comparison.projection, input.thresholds))
  lines.push(...slowGrowerLines(input.readings, input.comparison.orphanPreviewBranches))
  lines.push('', '### Reads', '')
  for (const status of input.statuses) lines.push(`- ${status.provider}: ${status.status.toUpperCase()}. ${status.detail}`)
  lines.push(...dayTableLines(input.readings))
  lines.push('', `Limits live in \`${CONFIG_PATH}\`. See \`docs/runbooks/COSTS.md\` before changing infrastructure or a limit.`)
  return lines.join('\n')
}

function issueTitle(date: string): string {
  return `${ISSUE_TITLE_PREFIX} ${date}`
}

function isGitHubActionsBotAuthored(value: Record<string, unknown>): boolean {
  return isPlainObject(value.user) && value.user.login === GITHUB_ACTIONS_BOT_LOGIN
}

function hasBotMarker(value: Record<string, unknown>, marker: string): boolean {
  return isGitHubActionsBotAuthored(value) && typeof value.body === 'string' && value.body.includes(marker)
}

// A red run opens a new issue titled with today's UTC date. A second red run on the same
// day adds a comment to that day's issue. Older open issues are never written to.
export async function publishCostTripwireIssue(input: Readonly<{
  report: string
  marker: string
  title: string
  environment: NodeJS.ProcessEnv
  fetcher: typeof fetch
}>): Promise<'created' | 'commented' | 'already-published'> {
  const token = input.environment.GITHUB_TOKEN
  const repository = input.environment.GITHUB_REPOSITORY
  if (!token || !repository || !/^[^/]+\/[^/]+$/u.test(repository)) throw new Error('GitHub issue publishing is not configured')
  const headers = githubHeaders(token)
  const issues = await readGitHubPages(`/repos/${repository}/issues`, { state: 'open' }, token, input.fetcher)
  const matches = issues.filter(issue => (
    issue.title === input.title && !('pull_request' in issue) && hasBotMarker(issue, ISSUE_OWNERSHIP_MARKER)
  ))
  if (matches.length > 1) throw new Error(`Multiple open "${input.title}" issues exist`)
  const existing = matches[0]
  if (!existing) {
    const url = new URL(`https://api.github.com/repos/${repository}/issues`)
    const body = JSON.stringify({ title: input.title, body: `${ISSUE_OWNERSHIP_MARKER}\n${input.report}` })
    await fetchBounded(url, { method: 'POST', headers, body }, 'GitHub', input.fetcher)
    return 'created'
  }
  if (typeof existing.number !== 'number') throw new Error('GitHub returned an invalid Cost tripwire issue')
  if (typeof existing.body === 'string' && existing.body.includes(input.marker)) return 'already-published'
  const commentsPath = `/repos/${repository}/issues/${existing.number}/comments`
  const comments = await readGitHubPages(commentsPath, {}, token, input.fetcher)
  if (comments.some(comment => hasBotMarker(comment, input.marker))) return 'already-published'
  const body = JSON.stringify({ body: input.report })
  await fetchBounded(new URL(`https://api.github.com${commentsPath}`), { method: 'POST', headers, body }, 'GitHub', input.fetcher)
  return 'commented'
}

type Read<T> = Readonly<{ status: CheckStatus; value?: T }>

async function readProvider<T>(
  provider: Provider, missing: string | undefined, describe: (value: T) => string, read: () => Promise<T>,
): Promise<Read<T>> {
  if (missing) return Object.freeze({ status: Object.freeze({ provider, status: 'skipped' as const, detail: missing }) })
  try {
    const value = await read()
    return Object.freeze({ status: Object.freeze({ provider, status: 'ok' as const, detail: describe(value) }), value })
  } catch (error) {
    return Object.freeze({ status: Object.freeze({ provider, status: 'failed' as const, detail: safeErrorDetail(error) }) })
  }
}

function absent(environment: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  const missing = names.filter(name => !environment[name])
  if (missing.length === 0) return undefined
  return `${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} absent.`
}

async function readVercelCycle(environment: NodeJS.ProcessEnv, fetcher: typeof fetch, now: Date, thresholds: CostThresholds) {
  const cycle = vercelCycleThrough(latestSettledChargeDay(now), thresholds.vercel.cycleStartDay)
  const days = await readVercelChargeDays(vercelDaysToFetch(cycle), environment.VERCEL_TEAM_ID ?? '', environment.VERCEL_TOKEN ?? '', fetcher)
  const rows = days.flatMap(({ day, text }) => chargeRowsForDay(day, text, now))
  return Object.freeze({ cycle, summary: summarizeFocusBilling(rows) })
}

async function readAll(environment: NodeJS.ProcessEnv, fetcher: typeof fetch, now: Date, thresholds: CostThresholds) {
  const vercelMissing = absent(environment, ['VERCEL_TOKEN', 'VERCEL_TEAM_ID'])
  const neonMissing = absent(environment, ['NEON_API_KEY', 'NEON_PROJECT_ID'])
  const githubMissing = absent(environment, ['GITHUB_TOKEN', 'GITHUB_REPOSITORY'])
  const neonKey = environment.NEON_API_KEY ?? ''
  const neonProject = environment.NEON_PROJECT_ID ?? ''
  return Promise.all([
    readProvider('Vercel charges', vercelMissing,
      value => `Read ${vercelDaysToFetch(value.cycle).length} charge days, one request each.`,
      () => readVercelCycle(environment, fetcher, now, thresholds)),
    readProvider('Neon spending', vercelMissing, () => 'Read from the Vercel Neon integration.',
      async () => parseNeonSpending(await readVercelIntegrations(environment.VERCEL_TEAM_ID ?? '', environment.VERCEL_TOKEN ?? '', fetcher), now)),
    readProvider('Neon branches', neonMissing, value => `Read ${value.length} preview/* branches.`,
      async () => (await listNeonBranches(neonProject, neonKey, fetcher)).filter(name => name.startsWith(PREVIEW_PREFIX))),
    readProvider('Neon snapshots', neonMissing, value => `Read ${value.total} snapshots.`,
      () => readNeonSnapshots(neonProject, neonKey, fetcher)),
    readProvider('GitHub pull requests', githubMissing, value => `Read ${value.length} open pull ${value.length === 1 ? 'request' : 'requests'}.`,
      () => listOpenPullRequestHeads(environment.GITHUB_REPOSITORY ?? '', environment.GITHUB_TOKEN ?? '', fetcher)),
  ] as const)
}

export async function runCostTripwire(input: Readonly<{
  dryRun: boolean
  environment?: NodeJS.ProcessEnv
  fetcher?: typeof fetch
  now?: Date
}>): Promise<CostTripwireResult> {
  const environment = input.environment ?? process.env
  const fetcher = input.fetcher ?? fetch
  const now = input.now ?? new Date()
  const configText = await readFile(new URL(`../${CONFIG_PATH}`, import.meta.url), 'utf8')
  const thresholds = validateCostThresholds(JSON.parse(configText))
  const [vercel, neonSpending, previewBranches, snapshots, pulls] = await readAll(environment, fetcher, now, thresholds)
  const statuses = [vercel.status, neonSpending.status, previewBranches.status, snapshots.status, pulls.status]
  const readings: CostReadings = Object.freeze({
    ...(vercel.value ? { vercel: vercel.value } : {}),
    ...(neonSpending.value ? { neonSpending: neonSpending.value } : {}),
    ...(previewBranches.value ? { previewBranches: previewBranches.value } : {}),
    ...(snapshots.value ? { snapshots: snapshots.value } : {}),
    ...(pulls.value ? { openPullRequestHeads: pulls.value } : {}),
  })
  const comparison = compareCosts(readings, thresholds)
  const red = [...comparison.findings, ...statusFindings(statuses)]
  const date = now.toISOString().slice(0, 10)
  const marker = `<!-- cost-tripwire-run:${environment.GITHUB_RUN_ID ?? `dry-run-${date}`} -->`
  const report = renderReport({ date, marker, readings, comparison, statuses, thresholds, red })
  const title = issueTitle(date)

  if (environment.GITHUB_STEP_SUMMARY) await appendFile(environment.GITHUB_STEP_SUMMARY, `${report}\n`)
  if (input.dryRun || red.length === 0) {
    const plan = red.length ? `Would open or add to "${title}".` : 'Would not open an issue.'
    console.log(input.dryRun ? `${plan}\n\n${report}` : 'Cost tripwire healthy; no issue needed.')
    return Object.freeze({ red: red.length > 0, report })
  }
  const issue = await publishCostTripwireIssue({ report, marker, title, environment, fetcher })
  console.log(`Cost tripwire issue ${issue}.`)
  return Object.freeze({ red: true, report, issue })
}

function parseArguments(arguments_: readonly string[]): Readonly<{ dryRun: boolean }> {
  if (arguments_.length === 0) return Object.freeze({ dryRun: false })
  if (arguments_.length === 1 && arguments_[0] === '--dry-run') return Object.freeze({ dryRun: true })
  throw new Error('Usage: npm run cost-tripwire OR npm run cost-tripwire -- --dry-run')
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runCostTripwire(parseArguments(process.argv.slice(2)))).then(result => {
    if (!result.red) return
    console.error('Cost tripwire is red: a limit was crossed or a provider read did not work. Read the report above.')
    process.exitCode = 1
  }).catch(error => {
    console.error(`Cost tripwire failed: ${safeErrorDetail(error)}`)
    process.exitCode = 1
  })
}
