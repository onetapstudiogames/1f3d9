import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  compareCostMetrics,
  parseFocusBillingJsonl,
  publishCostTripwireIssue,
  runCostTripwire,
  summarizeFocusBilling,
  validateCostThresholds,
  type CostThresholds,
} from '../scripts/cost-tripwire.ts'

const fixture = readFileSync(
  new URL('./fixtures/cost-tripwire-charges.jsonl', import.meta.url),
  'utf8',
)

const thresholds: CostThresholds = Object.freeze({
  schemaVersion: 1,
  vercel: Object.freeze({
    maxDailySpendUsd: 5,
    projects: Object.freeze({
      '1f3d9': Object.freeze({
        edgeRequestsPerDay: 60_000,
        functionInvocationsPerDay: 60_000,
      }),
    }),
  }),
  neon: Object.freeze({ maxPreviewBranches: 8 }),
})

test('FOCUS fixture aggregates daily project usage without mutating rows', () => {
  const rows = parseFocusBillingJsonl(fixture)
  const original = structuredClone(rows)

  const summary = summarizeFocusBilling(rows)

  assert.deepEqual(rows, original)
  assert.deepEqual(summary.projectDays, [
    {
      date: '2026-08-25', project: '1f3d9',
      edgeRequests: 60_000, functionInvocations: 60_000, effectiveCostUsd: 0.16,
    },
    {
      date: '2026-08-26', project: '1f3d9',
      edgeRequests: 180_000, functionInvocations: 180_001, effectiveCostUsd: 5.37,
    },
    {
      date: '2026-08-26', project: 'other-project',
      edgeRequests: 125_000, functionInvocations: 0, effectiveCostUsd: 0.25,
    },
  ])
  assert.deepEqual(summary.teamSpendByDay, [
    { date: '2026-08-25', effectiveCostUsd: 0.16 },
    { date: '2026-08-26', effectiveCostUsd: 5.62 },
  ])
})

test('comparison alerts only above three times baseline and above hard caps', () => {
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(fixture))

  const result = compareCostMetrics({ summary, previewBranchCount: 9, thresholds })

  assert.deepEqual(result.violations.map(value => value.metric), [
    'function_invocations',
    'daily_spend_usd',
    'preview_branches',
  ])
  assert.equal(
    result.violations.some(value => value.metric === 'edge_requests'),
    false,
    'exactly 3x does not exceed 3x',
  )
  assert.deepEqual(result.unconfiguredProjects, ['other-project'])
})

test('comparison accepts healthy values at the exact caps', () => {
  const result = compareCostMetrics({
    summary: {
      projectDays: [{
        date: '2026-08-25', project: '1f3d9',
        edgeRequests: 180_000, functionInvocations: 180_000, effectiveCostUsd: 5,
      }],
      teamSpendByDay: [{ date: '2026-08-25', effectiveCostUsd: 5 }],
    },
    previewBranchCount: 8,
    thresholds,
  })

  assert.deepEqual(result.violations, [])
})

test('threshold validation refuses missing, zero, negative, and unknown values', () => {
  assert.deepEqual(validateCostThresholds(structuredClone(thresholds)), thresholds)

  for (const invalid of [
    {},
    { ...thresholds, extra: true },
    { ...thresholds, neon: { maxPreviewBranches: -1 } },
    { ...thresholds, vercel: { ...thresholds.vercel, maxDailySpendUsd: 0 } },
    {
      ...thresholds,
      vercel: {
        ...thresholds.vercel,
        projects: { '1f3d9': { edgeRequestsPerDay: 0, functionInvocationsPerDay: 1 } },
      },
    },
  ]) assert.throws(() => validateCostThresholds(invalid), /threshold|schema|unknown|positive/i)
})

test('FOCUS parsing refuses malformed, non-USD, and non-finite charge rows', () => {
  for (const invalid of [
    'not-json',
    '{"BillingCurrency":"EUR"}',
    JSON.stringify({
      BillingCurrency: 'USD', ChargePeriodStart: '2026-08-25T00:00:00Z',
      ConsumedQuantity: 'NaN', EffectiveCost: 1, ServiceName: 'Edge Requests',
      Tags: { ProjectName: '1f3d9' },
    }),
  ]) assert.throws(() => parseFocusBillingJsonl(invalid), /FOCUS|JSON|USD|quantity/i)
})

test('FOCUS parsing accepts signed adjustments without measurable quantity', () => {
  const rows = parseFocusBillingJsonl(JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: '2026-08-25T00:00:00.000Z',
    ConsumedQuantity: null, EffectiveCost: -2.5, ServiceName: 'Credit',
    Tags: { ProjectName: '1f3d9' },
  }))

  assert.deepEqual(summarizeFocusBilling(rows), {
    projectDays: [{
      date: '2026-08-25', project: '1f3d9', edgeRequests: 0,
      functionInvocations: 0, effectiveCostUsd: -2.5,
    }],
    teamSpendByDay: [{ date: '2026-08-25', effectiveCostUsd: -2.5 }],
  })
  assert.throws(() => parseFocusBillingJsonl(JSON.stringify({
    BillingCurrency: 'USD', ChargePeriodStart: '2026-08-25T00:00:00.000Z',
    ConsumedQuantity: null, EffectiveCost: 1, ServiceName: 'Edge Requests',
    Tags: { ProjectName: '1f3d9' },
  })), /quantity/i)
})

test('available provider metrics still alert when the other provider failed', () => {
  const summary = summarizeFocusBilling(parseFocusBillingJsonl(fixture))
  assert.deepEqual(
    compareCostMetrics({ summary, thresholds }).violations.map(value => value.metric),
    ['function_invocations', 'daily_spend_usd'],
  )
  assert.deepEqual(
    compareCostMetrics({ previewBranchCount: 9, thresholds }).violations.map(value => value.metric),
    ['preview_branches'],
  )
})

test('dry-run reads providers but performs no write and prints no secret', async () => {
  const methods: string[] = []
  const tokenCanary = 'do-not-print-vercel-token'
  const neonCanary = 'do-not-print-neon-key'
  const output: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => { output.push(values.join(' ')) }
  try {
    await runCostTripwire({
      dryRun: true,
      now: new Date('2026-09-01T12:00:00.000Z'),
      environment: {
        VERCEL_TOKEN: tokenCanary,
        VERCEL_TEAM_ID: 'team-test',
        NEON_API_KEY: neonCanary,
        NEON_PROJECT_ID: 'project-test',
      },
      fetcher: (async (input, init) => {
        methods.push(init?.method ?? 'GET')
        const url = String(input)
        if (url.includes('api.vercel.com')) return new Response(fixture, { status: 200 })
        if (url.includes('console.neon.tech')) return new Response(JSON.stringify({
          branches: [{ id: 'br-main', name: 'main', primary: true }],
          pagination: {},
        }), { status: 200 })
        throw new Error(`unexpected URL ${url}`)
      }) as typeof fetch,
    })
  } finally {
    console.log = originalLog
  }

  assert.deepEqual(methods, ['GET', 'GET'])
  assert.match(output.join('\n'), /Would open or update "Cost tripwire"/u)
  assert.doesNotMatch(output.join('\n'), new RegExp(`${tokenCanary}|${neonCanary}`, 'u'))
})

test('missing provider secrets skip both checks without making a request', async () => {
  let requests = 0
  const originalLog = console.log
  console.log = () => {}
  try {
    await runCostTripwire({
      dryRun: true,
      now: new Date('2026-09-01T12:00:00.000Z'),
      environment: {},
      fetcher: (async () => {
        requests += 1
        throw new Error('must not fetch')
      }) as typeof fetch,
    })
  } finally {
    console.log = originalLog
  }
  assert.equal(requests, 0)
})

test('repeated Neon pagination cursor becomes a reportable failure', async () => {
  let requests = 0
  const output: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => { output.push(values.join(' ')) }
  try {
    await runCostTripwire({
      dryRun: true,
      now: new Date('2026-09-01T12:00:00.000Z'),
      environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project' },
      fetcher: (async () => {
        requests += 1
        return new Response(JSON.stringify({ branches: [], pagination: { next: 'same' } }), { status: 200 })
      }) as typeof fetch,
    })
  } finally {
    console.log = originalLog
  }
  assert.equal(requests, 2)
  assert.match(output.join('\n'), /FAILED.*pagination cursor repeated/isu)
})

test('issue idempotency finds a run marker after the first comment page', async () => {
  const methods: string[] = []
  const marker = '<!-- cost-tripwire-run:123 -->'
  const outcome = await publishCostTripwireIssue(
    'report', marker,
    { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repository' },
    (async (input, init) => {
      methods.push(init?.method ?? 'GET')
      const url = new URL(String(input))
      if (url.pathname.endsWith('/issues')) return new Response(JSON.stringify([
        {
          number: 7,
          title: 'Cost tripwire',
          body: '<!-- cost-tripwire-owner:github-actions -->',
          user: { login: 'github-actions[bot]' },
        },
      ]), { status: 200 })
      if (url.searchParams.get('page') === '1') return new Response(JSON.stringify(
        Array.from({ length: 100 }, (_, index) => ({
          body: `older ${index}`,
          user: { login: 'github-actions[bot]' },
        })),
      ), { status: 200 })
      return new Response(JSON.stringify([{
        body: marker,
        user: { login: 'github-actions[bot]' },
      }]), { status: 200 })
    }) as typeof fetch,
  )

  assert.equal(outcome, 'already-published')
  assert.deepEqual(methods, ['GET', 'GET', 'GET'])
})

test('issue idempotency recognizes the run marker in the issue body', async () => {
  let requests = 0
  const marker = '<!-- cost-tripwire-run:created-before-timeout -->'
  const outcome = await publishCostTripwireIssue(
    'report', marker,
    { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repository' },
    (async () => {
      requests += 1
      return new Response(JSON.stringify([
        {
          number: 7,
          title: 'Cost tripwire',
          body: `<!-- cost-tripwire-owner:github-actions -->\n${marker}\nexisting report`,
          user: { login: 'github-actions[bot]' },
        },
      ]), { status: 200 })
    }) as typeof fetch,
  )
  assert.equal(outcome, 'already-published')
  assert.equal(requests, 1)
})

test('issue publishing ignores a public user squatting on the tripwire title', async () => {
  const methods: string[] = []
  const outcome = await publishCostTripwireIssue(
    'report', '<!-- cost-tripwire-run:456 -->',
    { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repository' },
    (async (_input, init) => {
      methods.push(init?.method ?? 'GET')
      if (!init?.method) return new Response(JSON.stringify([{
        number: 8,
        title: 'Cost tripwire',
        body: '<!-- cost-tripwire-owner:github-actions -->',
        user: { login: 'public-user' },
      }]), { status: 200 })
      return new Response('{}', { status: 201 })
    }) as typeof fetch,
  )

  assert.equal(outcome, 'created')
  assert.deepEqual(methods, ['GET', 'POST'])
})

test('issue idempotency ignores a forged run marker from a public user', async () => {
  const marker = '<!-- cost-tripwire-run:789 -->'
  const postedBodies: string[] = []
  const outcome = await publishCostTripwireIssue(
    'report', marker,
    { GITHUB_TOKEN: 'token', GITHUB_REPOSITORY: 'owner/repository' },
    (async (input, init) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/issues')) return new Response(JSON.stringify([{
        number: 7,
        title: 'Cost tripwire',
        body: '<!-- cost-tripwire-owner:github-actions -->',
        user: { login: 'github-actions[bot]' },
      }]), { status: 200 })
      if (!init?.method) return new Response(JSON.stringify([{
        body: marker,
        user: { login: 'public-user' },
      }]), { status: 200 })
      postedBodies.push(String(init.body))
      return new Response('{}', { status: 201 })
    }) as typeof fetch,
  )

  assert.equal(outcome, 'commented')
  assert.deepEqual(postedBodies, [JSON.stringify({ body: 'report' })])
})
