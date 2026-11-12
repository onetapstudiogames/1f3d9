import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  chargeRowsForDay,
  compareCosts,
  latestSettledChargeDay,
  parseFocusBillingJsonl,
  parseNeonSpending,
  publishCostTripwireIssue,
  runCostTripwire,
  summarizeFocusBilling,
  validateCostThresholds,
  vercelCycleThrough,
  type CostThresholds,
} from '../scripts/cost-tripwire.ts'

const fixture = readFileSync(
  new URL('./fixtures/cost-tripwire-charges.jsonl', import.meta.url),
  'utf8',
)

const realShapeFixture = readFileSync(
  new URL('./fixtures/cost-tripwire-focus-real-shapes.ndjson', import.meta.url),
  'utf8',
)

const configuredThresholds = JSON.parse(readFileSync(
  new URL('../config/cost-tripwire.json', import.meta.url),
  'utf8',
)) as unknown

const REAL_FEED_PROJECT_NAMES = [
  '1f3d9',
  '1f3ea',
  'eo-web',
  'snapshot',
  'soti',
  'soti-w3-debug-35d07e2fc1a1',
  'sweetpspeech',
] as const

// The live feed of 2026-10-12 to 2026-11-11 also names 1f3d9-live.
const CONFIGURED_PROJECT_NAMES = [...REAL_FEED_PROJECT_NAMES, '1f3d9-live'] as const

const OWNER_MARKER = '<!-- cost-tripwire-owner:github-actions -->'
const DATED_TITLE = 'Cost tripwire 2026-11-12'
const GITHUB_ENVIRONMENT = Object.freeze({ GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repository' })

function fixtureProjectNames(): string[] {
  return [...new Set(parseFocusBillingJsonl(realShapeFixture).flatMap(row => (
    typeof row.Tags?.ProjectName === 'string' ? [row.Tags.ProjectName] : []
  )))].sort()
}

const thresholds: CostThresholds = Object.freeze({
  schemaVersion: 2,
  cycleBudgetUsd: 1_000,
  vercel: Object.freeze({
    cycleStartDay: 12,
    maxDailySpendUsd: 5,
    projects: Object.freeze({
      '1f3d9': Object.freeze({
        edgeRequestsPerDay: 60_000,
        functionInvocationsPerDay: 60_000,
      }),
    }),
  }),
  neon: Object.freeze({ maxPreviewBranches: 8, maxManualSnapshotsWithoutExpiry: 15 }),
  why: Object.freeze({ cycleBudgetUsd: 'test' }),
})

const AUGUST_CYCLE = vercelCycleThrough('2026-08-26', 12)

function previewBranches(total: number): readonly string[] {
  return Array.from({ length: total }, (_, index) => `preview/feature-${index}`)
}

function openHeads(total: number): readonly string[] {
  return Array.from({ length: total }, (_, index) => `feature-${index}`)
}

test('real-shape FOCUS fixture includes team spend and only tagged project usage', () => {
  const rows = parseFocusBillingJsonl(realShapeFixture)
  const original = structuredClone(rows)

  const summary = summarizeFocusBilling(rows)
  const projectNames = fixtureProjectNames()

  assert.equal(rows.length, 73)
  assert.deepEqual(rows, original)
  assert.deepEqual(projectNames, [...REAL_FEED_PROJECT_NAMES].sort())
  assert.deepEqual(summary.projectDays, [
    {
      date: '2026-08-30', project: '1f3d9',
      edgeRequests: 1, functionInvocations: 1, effectiveCostUsd: 8,
    },
    {
      date: '2026-08-30', project: '1f3ea',
      edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 1,
    },
    { date: '2026-08-30', project: 'eo-web', edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 1 },
    { date: '2026-08-30', project: 'snapshot', edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0 },
    { date: '2026-08-30', project: 'soti', edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0 },
    { date: '2026-08-30', project: 'soti-w3-debug-35d07e2fc1a1', edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0 },
    { date: '2026-08-30', project: 'sweetpspeech', edgeRequests: 0, functionInvocations: 0, effectiveCostUsd: 0 },
  ])
  assert.deepEqual(summary.teamSpendByDay, [
    { date: '2026-08-30', effectiveCostUsd: 14 },
  ])
})

test('CDN Requests, the current Vercel name for Edge Requests, count as edge requests', () => {
  const row = (serviceName: string) => JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: '2026-11-09T08:00:00.000Z', ChargePeriodEnd: '2026-11-10T08:00:00.000Z',
    ConsumedQuantity: 151_177, EffectiveCost: 0.1, ServiceName: serviceName, Tags: { ProjectName: '1f3d9' },
  })
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(row('CDN Requests')))

  assert.equal(summary.projectDays[0]?.edgeRequests, 151_177)
  assert.throws(() => parseFocusBillingJsonl(row('CDN Requests').replace('151177', 'null')), /quantity/iu)
})

test('comparison alerts only above three times baseline and above hard caps', () => {
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(fixture))

  const result = compareCosts({
    vercel: { cycle: AUGUST_CYCLE, summary }, previewBranches: previewBranches(9), openPullRequestHeads: openHeads(9),
  }, thresholds)

  assert.equal(result.findings.length, 4)
  assert.match(result.findings[0] ?? '', /Vercel spent \$5\.62 on 2026-08-26, over the \$5\.00 limit for one day/u)
  assert.match(result.findings[1] ?? '', /180,001 function invocations on 2026-08-26, over the limit of 180,000/u)
  assert.match(result.findings[2] ?? '', /9 preview database branches, over the limit of 8/u)
  assert.match(result.findings[3] ?? '', /names the project other-project, which has no entry/u)
  assert.equal(result.findings.some(finding => /CDN requests/u.test(finding)), false, 'exactly 3x does not exceed 3x')
})

test('day limits look only at the last two settled charge days', () => {
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(fixture))
  const laterCycle = vercelCycleThrough('2026-08-28', 12)

  const result = compareCosts({ vercel: { cycle: laterCycle, summary } }, thresholds)

  assert.equal(result.findings.some(finding => /2026-08-26/u.test(finding)), false)
})

test('a day from the old cycle counts for the one-day limit but not for the new cycle total', () => {
  const cycle = vercelCycleThrough('2026-11-12', 12)
  const summary = {
    projectDays: [],
    teamSpendByDay: [{ date: '2026-11-11', effectiveCostUsd: 9 }, { date: '2026-11-12', effectiveCostUsd: 1.3 }],
  }

  const result = compareCosts({ vercel: { cycle, summary } }, thresholds)

  assert.equal(result.projection.vercelSoFarUsd, 1.3)
  assert.match(result.findings.join(' '), /Vercel spent \$9\.00 on 2026-11-11, over the \$5\.00 limit for one day/u)
})

test('comparison accepts healthy values at the exact caps', () => {
  const result = compareCosts({
    vercel: {
      cycle: AUGUST_CYCLE,
      summary: {
        projectDays: [{
          date: '2026-08-25', project: '1f3d9',
          edgeRequests: 180_000, functionInvocations: 180_000, effectiveCostUsd: 5,
        }],
        teamSpendByDay: [{ date: '2026-08-25', effectiveCostUsd: 5 }],
      },
    },
    previewBranches: previewBranches(8),
    openPullRequestHeads: openHeads(8),
    snapshots: { total: 29, manualWithoutExpiry: 15 },
  }, thresholds)

  assert.deepEqual(result.findings, [])
})

test('the cycle budget counts Vercel and Neon projected to the end of the cycle', () => {
  const spending = parseNeonSpending([{
    slug: 'neon',
    billingData: { spending: {
      timestamp: '2026-11-11T00:00:00Z', periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z',
      totalCent: 4_000, items: [{ name: 'Compute', quantity: 300, units: 'CU-hours', total: '40.00' }],
    } },
  }], new Date('2026-11-11T14:23:00.000Z'))
  const cycle = vercelCycleThrough('2026-11-10', 12)
  const summary = { projectDays: [], teamSpendByDay: cycle.daysToRead.map(date => ({ date, effectiveCostUsd: 2 })) }

  const result = compareCosts({ vercel: { cycle, summary }, neonSpending: spending }, { ...thresholds, cycleBudgetUsd: 150 })

  assert.equal(result.projection.vercelProjectedUsd, 62)
  assert.equal(result.projection.neonProjectedUsd, 120)
  assert.match(result.findings[0] ?? '', /on course for \$182\.00, over the \$150\.00 budget \(Vercel on course for \$62\.00, Neon on course for \$120\.00\)/u)
})

test('explicitly unmonitored feed projects are configured and make the run complete', () => {
  const configured = validateCostThresholds(configuredThresholds)
  assert.deepEqual(Object.keys(configured.vercel.projects).sort(), [...CONFIGURED_PROJECT_NAMES].sort())

  for (const projectNames of [fixtureProjectNames(), [...CONFIGURED_PROJECT_NAMES]]) {
    const result = compareCosts({
      vercel: {
        cycle: vercelCycleThrough('2026-09-01', 12),
        summary: {
          projectDays: projectNames.map(project => ({
            date: '2026-09-01', project,
            edgeRequests: project === '1f3d9' ? 180_000 : 10_000_000,
            functionInvocations: project === '1f3d9' ? 180_000 : 10_000_000,
            effectiveCostUsd: 0,
          })),
          teamSpendByDay: [{ date: '2026-09-01', effectiveCostUsd: 0 }],
        },
      },
    }, configured)

    assert.deepEqual(result.findings, [])
  }
})

test('threshold validation refuses missing, zero, negative, and unknown values', () => {
  assert.deepEqual(validateCostThresholds(structuredClone(thresholds)), thresholds)

  for (const invalid of [
    {},
    { ...thresholds, extra: true },
    { ...thresholds, schemaVersion: 1 },
    { ...thresholds, cycleBudgetUsd: 0 },
    { ...thresholds, why: { cycleBudgetUsd: '' } },
    { ...thresholds, neon: { ...thresholds.neon, maxPreviewBranches: -1 } },
    { ...thresholds, neon: { maxPreviewBranches: 8 } },
    { ...thresholds, vercel: { ...thresholds.vercel, maxDailySpendUsd: 0 } },
    { ...thresholds, vercel: { ...thresholds.vercel, cycleStartDay: 31 } },
    {
      ...thresholds,
      vercel: {
        ...thresholds.vercel,
        projects: { '1f3d9': { edgeRequestsPerDay: 0, functionInvocationsPerDay: 1 } },
      },
    },
    {
      ...thresholds,
      vercel: {
        ...thresholds.vercel,
        projects: { '1f3ea': { unmonitored: true, reason: '' } },
      },
    },
  ]) assert.throws(() => validateCostThresholds(invalid), /threshold|schema|unknown|positive|why/i)
})

test('FOCUS parsing names the physical line and malformed field', () => {
  const row = (overrides: Record<string, unknown>) => JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: '2026-08-25T00:00:00Z', ChargePeriodEnd: '2026-08-26T00:00:00Z',
    ConsumedQuantity: 1, EffectiveCost: 1, ServiceName: 'Edge Requests',
    Tags: { ProjectName: '1f3d9' }, ...overrides,
  })
  const valid = row({})

  for (const [invalid, message] of [
    [`${valid}\n\nnot-json`, /FOCUS line 3 is invalid JSON/u],
    ['[]', /FOCUS line 1 must be an object/u],
    [row({ BillingCurrency: 'EUR' }), /FOCUS line 1 is not USD/u],
    [row({ ChargePeriodStart: 'not-a-date' }), /FOCUS line 1.*charge start/iu],
    [row({ ChargePeriodEnd: undefined }), /FOCUS line 1.*charge end/iu],
    [row({ ServiceName: undefined }), /FOCUS line 1.*service name/iu],
    [row({ Tags: null }), /FOCUS line 1.*tags must be an object/iu],
    [row({ Tags: { ProjectName: '' } }), /FOCUS line 1.*project name/iu],
    [row({ ConsumedQuantity: '1' }), /FOCUS line 1.*quantity.*number/iu],
    [row({ EffectiveCost: '1' }), /FOCUS line 1.*effective cost.*number/iu],
  ] as const) assert.throws(() => parseFocusBillingJsonl(invalid), message)
})

test('FOCUS parsing accepts signed adjustments without measurable quantity', () => {
  const adjustment = (serviceName: string, cost: number) => JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: '2026-08-25T00:00:00.000Z', ChargePeriodEnd: '2026-08-26T00:00:00.000Z',
    ConsumedQuantity: null, EffectiveCost: cost, ServiceName: serviceName,
    Tags: { ProjectName: '1f3d9' },
  })

  assert.deepEqual(summarizeFocusBilling(parseFocusBillingJsonl(adjustment('Credit', -2.5))), {
    projectDays: [{
      date: '2026-08-25', project: '1f3d9', edgeRequests: 0,
      functionInvocations: 0, effectiveCostUsd: -2.5,
    }],
    teamSpendByDay: [{ date: '2026-08-25', effectiveCostUsd: -2.5 }],
  })
  assert.throws(() => parseFocusBillingJsonl(adjustment('Edge Requests', 1)), /quantity/i)
})

test('a charge day answer must be the day asked for and already over', () => {
  const day = (start: string, end: string) => JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: start, ChargePeriodEnd: end,
    ConsumedQuantity: 1, EffectiveCost: 0.645, ServiceName: 'Pro', Tags: {},
  })
  const now = new Date('2026-11-12T14:23:00.000Z')

  assert.equal(chargeRowsForDay('2026-11-11', day('2026-11-11T08:00:00.000Z', '2026-11-12T08:00:00.000Z'), now).length, 1)
  assert.throws(() => chargeRowsForDay('2026-11-11', '', now), /no charges for 2026-11-11/u)
  assert.throws(
    () => chargeRowsForDay('2026-11-11', day('2026-11-10T08:00:00.000Z', '2026-11-11T08:00:00.000Z'), now),
    /charges for 2026-11-10 when asked for 2026-11-11/u,
  )
  assert.throws(
    () => chargeRowsForDay('2026-11-12', day('2026-11-12T08:00:00.000Z', '2026-11-13T08:00:00.000Z'), now),
    /not complete yet/u,
  )
})

test('the Vercel cycle runs from the 12th to the 11th and reads only settled days', () => {
  assert.equal(latestSettledChargeDay(new Date('2026-11-12T14:23:00.000Z')), '2026-11-11')
  assert.equal(latestSettledChargeDay(new Date('2026-11-12T01:10:00.000Z')), '2026-11-10')

  const full = vercelCycleThrough('2026-11-11', 12)
  assert.deepEqual([full.firstDay, full.lastDay, full.length, full.daysToRead.length], ['2026-10-12', '2026-11-11', 31, 31])
  const first = vercelCycleThrough('2026-11-12', 12)
  assert.deepEqual([first.firstDay, first.lastDay, first.length, first.daysToRead], ['2026-11-12', '2026-12-11', 30, ['2026-11-12']])
  assert.deepEqual(first.dayLimitDays, ['2026-11-11', '2026-11-12'], 'the one-day limits reach back into the old cycle')
  assert.deepEqual(full.dayLimitDays, ['2026-11-10', '2026-11-11'])
  const wrap = vercelCycleThrough('2027-01-05', 12)
  assert.deepEqual([wrap.firstDay, wrap.lastDay, wrap.length, wrap.daysToRead.length], ['2026-12-12', '2027-01-11', 31, 25])
})

test('Neon spending must be present, fresh, and add up', () => {
  const now = new Date('2026-11-12T14:23:00.000Z')
  const configurations = (spending: Record<string, unknown>) => [{ slug: 'neon', billingData: { spending: {
    timestamp: '2026-11-12T00:11:47Z', periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z',
    totalCent: 1_977, items: [{ name: 'Compute', quantity: 163, units: 'CU-hours', total: '19.77' }], ...spending,
  } } }]

  assert.equal(parseNeonSpending(configurations({}), now).totalUsd, 19.77)
  assert.throws(() => parseNeonSpending([{ slug: 'upstash' }], now), /0 Neon integrations/u)
  assert.throws(() => parseNeonSpending([{ slug: 'neon' }], now), /no spending block/u)
  assert.throws(() => parseNeonSpending(configurations({ timestamp: '2026-11-09T00:00:00Z' }), now), /last measured \d+ hours ago/u)
  assert.throws(() => parseNeonSpending(configurations({ totalCent: 5_000 }), now), /add up to \$19\.77, not the total \$50\.00/u)
  assert.throws(() => parseNeonSpending(configurations({ totalCent: 19.77 }), now), /whole number of cents/u)
  assert.throws(() => parseNeonSpending(configurations({ items: [] }), now), /no line items/u)
})

test('available provider metrics still alert when another provider failed', () => {
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(fixture))
  assert.equal(compareCosts({ vercel: { cycle: AUGUST_CYCLE, summary } }, thresholds).findings.length, 3)
  assert.match(
    compareCosts({ previewBranches: previewBranches(9) }, thresholds).findings.join('\n'),
    /9 preview database branches/u,
  )
})

test('missing provider secrets skip every check, make no request, and turn the run red', async () => {
  let requests = 0
  const originalLog = console.log
  console.log = () => {}
  try {
    const result = await runCostTripwire({
      dryRun: true,
      now: new Date('2026-09-01T12:00:00.000Z'),
      environment: {},
      fetcher: (async () => {
        requests += 1
        throw new Error('must not fetch')
      }) as typeof fetch,
    })
    assert.equal(result.red, true)
    assert.match(result.report, /Vercel charges: SKIPPED\. VERCEL_TOKEN and VERCEL_TEAM_ID are absent/u)
  } finally {
    console.log = originalLog
  }
  assert.equal(requests, 0)
})

test('repeated Neon pagination cursor becomes a reportable failure', async () => {
  let branchRequests = 0
  const output: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => { output.push(values.join(' ')) }
  try {
    await runCostTripwire({
      dryRun: true,
      now: new Date('2026-09-01T12:00:00.000Z'),
      environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project' },
      fetcher: (async input => {
        if (new URL(String(input)).pathname.endsWith('/branches')) branchRequests += 1
        return new Response(JSON.stringify({ branches: [], snapshots: [], pagination: { next: 'same' } }), { status: 200 })
      }) as typeof fetch,
    })
  } finally {
    console.log = originalLog
  }
  assert.equal(branchRequests, 2)
  assert.match(output.join('\n'), /Neon branches: FAILED.*pagination cursor repeated/isu)
})

test('issue idempotency finds a run marker after the first comment page', async () => {
  const methods: string[] = []
  const marker = '<!-- cost-tripwire-run:123 -->'
  const outcome = await publishCostTripwireIssue({
    report: 'report', marker, title: DATED_TITLE, environment: { ...GITHUB_ENVIRONMENT },
    fetcher: (async (input, init) => {
      methods.push(init?.method ?? 'GET')
      const url = new URL(String(input))
      if (url.pathname.endsWith('/issues')) return new Response(JSON.stringify([
        { number: 7, title: DATED_TITLE, body: OWNER_MARKER, user: { login: 'github-actions[bot]' } },
      ]), { status: 200 })
      if (url.searchParams.get('page') === '1') return new Response(JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({ body: `older ${index}`, user: { login: 'github-actions[bot]' } })),
      ), { status: 200 })
      return new Response(JSON.stringify([{ body: marker, user: { login: 'github-actions[bot]' } }]), { status: 200 })
    }) as typeof fetch,
  })

  assert.equal(outcome, 'already-published')
  assert.deepEqual(methods, ['GET', 'GET', 'GET'])
})

test('issue idempotency recognizes the run marker in the issue body', async () => {
  let requests = 0
  const marker = '<!-- cost-tripwire-run:created-before-timeout -->'
  const outcome = await publishCostTripwireIssue({
    report: 'report', marker, title: DATED_TITLE, environment: { ...GITHUB_ENVIRONMENT },
    fetcher: (async () => {
      requests += 1
      return new Response(JSON.stringify([{
        number: 7, title: DATED_TITLE, body: `${OWNER_MARKER}\n${marker}\nexisting report`, user: { login: 'github-actions[bot]' },
      }]), { status: 200 })
    }) as typeof fetch,
  })
  assert.equal(outcome, 'already-published')
  assert.equal(requests, 1)
})

test('issue publishing ignores a public user squatting on the dated title', async () => {
  const methods: string[] = []
  const outcome = await publishCostTripwireIssue({
    report: 'report', marker: '<!-- cost-tripwire-run:456 -->', title: DATED_TITLE, environment: { ...GITHUB_ENVIRONMENT },
    fetcher: (async (_input, init) => {
      methods.push(init?.method ?? 'GET')
      if (!init?.method) return new Response(JSON.stringify([{
        number: 8, title: DATED_TITLE, body: OWNER_MARKER, user: { login: 'public-user' },
      }]), { status: 200 })
      return new Response('{}', { status: 201 })
    }) as typeof fetch,
  })

  assert.equal(outcome, 'created')
  assert.deepEqual(methods, ['GET', 'POST'])
})

test('issue idempotency ignores a forged run marker from a public user', async () => {
  const marker = '<!-- cost-tripwire-run:789 -->'
  const postedBodies: string[] = []
  const outcome = await publishCostTripwireIssue({
    report: 'report', marker, title: DATED_TITLE, environment: { ...GITHUB_ENVIRONMENT },
    fetcher: (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/issues')) return new Response(JSON.stringify([{
        number: 7, title: DATED_TITLE, body: OWNER_MARKER, user: { login: 'github-actions[bot]' },
      }]), { status: 200 })
      if (!init?.method) return new Response(JSON.stringify([{ body: marker, user: { login: 'public-user' } }]), { status: 200 })
      postedBodies.push(String(init.body))
      return new Response('{}', { status: 201 })
    }) as typeof fetch,
  })

  assert.equal(outcome, 'commented')
  assert.deepEqual(postedBodies, [JSON.stringify({ body: 'report' })])
})
