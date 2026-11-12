import test from 'node:test'
import assert from 'node:assert/strict'
import { runCostTripwire } from '../scripts/cost-tripwire.ts'

const NOW = new Date('2026-11-12T14:23:00.000Z')
const TODAY = '2026-11-12'
const DAY_MS = 24 * 60 * 60 * 1000
const OWNER_MARKER = '<!-- cost-tripwire-owner:github-actions -->'
const BOT = { login: 'github-actions[bot]' }
const NORMAL_DAY_COST_USD = 1.3
const NORMAL_NEON_CENTS = 1977
const SIX_MEGABYTES = 6 * 1024 * 1024

type World = Readonly<{
  neonTotalCents?: number
  hugeVercelDay?: string
  failingVercelDay?: string
  manualSnapshotsWithoutExpiry?: number
  previewBranches?: readonly string[]
  openPullRequestHeads?: readonly string[]
  openIssues?: readonly Record<string, unknown>[]
}>

type Call = Readonly<{ method: string; url: URL; body?: string }>

function chargeDay(label: string, costUsd: number): string {
  const start = `${label}T08:00:00.000Z`
  const end = new Date(Date.parse(start) + DAY_MS).toISOString()
  const base = { BillingCurrency: 'USD', ChargePeriodStart: start, ChargePeriodEnd: end }
  const seatUsd = 0.645
  const functionUsd = 0.1
  return [
    { ...base, ServiceName: 'Pro', ConsumedQuantity: 1, EffectiveCost: seatUsd, Tags: {} },
    {
      ...base, ServiceName: 'CDN Requests', ConsumedQuantity: 110_000,
      EffectiveCost: costUsd - seatUsd - functionUsd, Tags: { ProjectName: '1f3d9' },
    },
    {
      ...base, ServiceName: 'Function Invocations', ConsumedQuantity: 105_000,
      EffectiveCost: functionUsd, Tags: { ProjectName: '1f3d9' },
    },
  ].map(row => JSON.stringify(row)).join('\n')
}

function neonConfigurations(totalCents: number): unknown {
  const compute = totalCents - 226 - 24 - 1
  return [{
    slug: 'neon',
    billingData: {
      spending: {
        timestamp: '2026-11-12T00:11:47Z',
        periodStart: '2026-11-01T00:00:00Z',
        periodEnd: '2026-12-01T00:00:00Z',
        totalCent: totalCents,
        discountCent: 0,
        items: [
          { name: 'Snapshot storage', quantity: 25.2, units: 'GB-month', price: '0.0896', total: '2.26' },
          { name: 'Storage (child branches)', quantity: 0.04, units: 'GB-month', price: '0.28', total: '0.01' },
          { name: 'Storage (root branches)', quantity: 0.68, units: 'GB-month', price: '0.35', total: '0.24' },
          { name: 'Compute', quantity: 163, units: 'CU-hours', price: '0.106', total: (compute / 100).toFixed(2) },
        ],
      },
    },
  }, { slug: 'upstash' }]
}

function snapshots(withoutExpiry: number): unknown {
  const manual = Array.from({ length: withoutExpiry }, (_, index) => ({
    id: `manual-${index}`, name: `pre-migration-${index}`, manual: true,
  }))
  const scheduled = Array.from({ length: 14 }, (_, index) => ({
    id: `daily-${index}`, name: `daily-${index}`, manual: false, expires_at: '2026-11-20T00:00:00Z',
  }))
  return { snapshots: [...manual, ...scheduled] }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200 })
}

function fakeProviders(world: World, calls: Call[]): typeof fetch {
  return (async (input, init) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    calls.push({ method, url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) })
    if (url.hostname === 'api.vercel.com' && url.pathname === '/v1/billing/charges') {
      const label = new Date(Date.parse(url.searchParams.get('from') ?? '') - DAY_MS).toISOString().slice(0, 10)
      if (label === world.failingVercelDay) return new Response('busy', { status: 503 })
      if (label === world.hugeVercelDay) return new Response('x'.repeat(SIX_MEGABYTES), { status: 200 })
      return new Response(chargeDay(label, NORMAL_DAY_COST_USD), { status: 200 })
    }
    if (url.hostname === 'api.vercel.com' && url.pathname === '/v1/integrations/configurations') {
      return json(neonConfigurations(world.neonTotalCents ?? NORMAL_NEON_CENTS))
    }
    if (url.hostname === 'console.neon.tech' && url.pathname.endsWith('/branches')) {
      const names = ['main', ...(world.previewBranches ?? ['preview/shared-vercel-testing'])]
      return json({ branches: names.map(name => ({ id: `br-${name}`, name })), pagination: {} })
    }
    if (url.hostname === 'console.neon.tech' && url.pathname.endsWith('/snapshots')) {
      return json(snapshots(world.manualSnapshotsWithoutExpiry ?? 11))
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/pulls')) {
      return json((world.openPullRequestHeads ?? []).map(ref => ({ number: 1, head: { ref } })))
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/issues')) {
      return method === 'GET' ? json(world.openIssues ?? []) : new Response('{"number":900}', { status: 201 })
    }
    if (url.hostname === 'api.github.com' && url.pathname.endsWith('/comments')) {
      return method === 'GET' ? json([]) : new Response('{}', { status: 201 })
    }
    throw new Error(`unexpected request ${method} ${url.hostname}${url.pathname}`)
  }) as typeof fetch
}

const ENVIRONMENT = Object.freeze({
  VERCEL_TOKEN: 'vercel-token-canary',
  VERCEL_TEAM_ID: 'team-test',
  NEON_API_KEY: 'neon-key-canary',
  NEON_PROJECT_ID: 'project-test',
  GITHUB_TOKEN: 'github-token-canary',
  GITHUB_REPOSITORY: 'owner/repository',
  GITHUB_RUN_ID: '777',
})

async function run(world: World, dryRun = false) {
  const calls: Call[] = []
  const output: string[] = []
  const originalLog = console.log
  console.log = (...values: unknown[]) => { output.push(values.join(' ')) }
  try {
    const result = await runCostTripwire({
      dryRun, now: NOW, environment: { ...ENVIRONMENT }, fetcher: fakeProviders(world, calls),
    })
    return { result, calls, output: output.join('\n') }
  } finally {
    console.log = originalLog
  }
}

function writes(calls: readonly Call[]): readonly Call[] {
  return calls.filter(call => call.method !== 'GET')
}

test('a quiet normal day stays green and opens nothing', async () => {
  const { result, calls } = await run({})

  assert.equal(result.red, false)
  assert.deepEqual(writes(calls), [])
  assert.equal(calls.filter(call => call.url.pathname === '/v1/billing/charges').length, 31,
    'one Vercel request per charge day of the 2026-10-12 to 2026-11-11 cycle')
})

test('an over-budget Neon spending block turns the run red and says so in plain words', async () => {
  const { result, calls } = await run({ neonTotalCents: 9_000 })

  assert.equal(result.red, true)
  const created = writes(calls).filter(call => call.url.pathname === '/repos/owner/repository/issues')
  assert.equal(created.length, 1)
  const body = JSON.parse(created[0]?.body ?? '{}') as { title?: string; body?: string }
  assert.equal(body.title, `Cost tripwire ${TODAY}`)
  assert.match(body.body ?? '', /on course for \$\d+\.\d\d[^\n]*over the \$120\.00 budget/u)
  assert.match(body.body ?? '', /Neon[^\n]*\$90\.00 so far/u)
  assert.doesNotMatch(body.body ?? '', /canary/u)
})

test('a Vercel day too large to read turns the run red where it used to stay green', async () => {
  const { result, output } = await run({ hugeVercelDay: '2026-11-03' }, true)

  assert.equal(result.red, true)
  assert.match(output, /Vercel charges[^\n]*FAILED[^\n]*size limit/u)
})

test('a failed Vercel read turns the run red', async () => {
  const { result, output } = await run({ failingVercelDay: '2026-11-11' }, true)

  assert.equal(result.red, true)
  assert.match(output, /Vercel charges[^\n]*FAILED[^\n]*HTTP 503/u)
})

test('a crossed limit opens a new dated issue instead of commenting on the old one', async () => {
  const oldIssue = { number: 282, title: 'Cost tripwire', body: `${OWNER_MARKER}\nold`, user: BOT }
  const { result, calls } = await run({ manualSnapshotsWithoutExpiry: 87, openIssues: [oldIssue] })

  assert.equal(result.red, true)
  const posted = writes(calls)
  assert.deepEqual(posted.map(call => call.url.pathname), ['/repos/owner/repository/issues'])
  const body = JSON.parse(posted[0]?.body ?? '{}') as { title?: string; body?: string }
  assert.equal(body.title, `Cost tripwire ${TODAY}`)
  assert.match(body.body ?? '', /87 manual snapshots with no end date[^\n]*limit is 15/u)
})

test('a second red run on the same day adds to that day\'s issue', async () => {
  const todays = { number: 901, title: `Cost tripwire ${TODAY}`, body: `${OWNER_MARKER}\nfirst`, user: BOT }
  const { result, calls } = await run({ manualSnapshotsWithoutExpiry: 87, openIssues: [todays] })

  assert.equal(result.red, true)
  assert.deepEqual(writes(calls).map(call => call.url.pathname), ['/repos/owner/repository/issues/901/comments'])
})

test('a preview database branch with no open pull request turns the run red; the shared branch never does', async () => {
  const quiet = await run({
    previewBranches: ['preview/shared-vercel-testing', 'preview/feature-x'],
    openPullRequestHeads: ['feature-x'],
  })
  assert.equal(quiet.result.red, false)

  const { result, output } = await run({
    previewBranches: ['preview/shared-vercel-testing', 'preview/diag/gemini-register-20261110'],
    openPullRequestHeads: [],
  }, true)
  assert.equal(result.red, true)
  assert.match(output, /preview\/diag\/gemini-register-20261110[^\n]*no open pull request/u)
  assert.doesNotMatch(output, /preview\/shared-vercel-testing[^\n]*no open pull request/u)
})

test('dry run reads every provider, prints the numbers, and writes nothing', async () => {
  const { result, calls, output } = await run({ neonTotalCents: 9_000 }, true)

  assert.equal(result.red, true)
  assert.deepEqual(writes(calls), [])
  assert.match(output, /Would open or add to "Cost tripwire 2026-11-12"/u)
  assert.match(output, /Vercel[^\n]*2026-10-12 to 2026-11-11[^\n]*31 of 31 days/u)
  assert.doesNotMatch(output, /canary/u)
})
