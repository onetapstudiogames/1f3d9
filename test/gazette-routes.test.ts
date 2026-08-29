import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { Hono } from 'hono'

const FIRST_PRINT_AT = '2026-08-31T16:00:00.000Z'
const CRON_SECRET = `cron_${'ab'.repeat(32)}`
const routesUrl = new URL('../src/gazette-routes.ts', import.meta.url)
const cronAuthUrl = new URL('../src/cron-auth.ts', import.meta.url)

type IssueSummary = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  entry_count: number
  header?: string
  body?: string
  entries?: readonly unknown[]
}>

type IssueEntry = Readonly<{
  ordinal: number
  note_id: number
  author: string
  body: string
  created_at: string
}>

type IssueDetail = Readonly<{
  issue_number: number
  scheduled_for: string
  printed_at: string
  header: string
  entry_count: number
}>

interface GazetteRouteDependencies {
  readSubmissionRoomState(): Promise<Readonly<{ submissionsOpen: boolean }>>
  listIssues(input: Readonly<{
    beforeIssueNumber: number | null
    limit: number
  }>): Promise<Readonly<{
    issues: readonly IssueSummary[]
    hasMore: boolean
    nextBeforeIssueNumber: number | null
  }>>
  readIssue(input: Readonly<{
    issueNumber: number
    afterOrdinal: number | null
    limit: number
  }>): Promise<Readonly<{
    issue: IssueDetail
    entries: readonly IssueEntry[]
    hasMore: boolean
    nextAfterOrdinal: number | null
  }> | null>
  database: unknown
  printGazetteIssuesDue(database: unknown): Promise<unknown>
  environment: Readonly<Record<string, string | undefined>>
}

type MountGazetteRoutes = (
  app: Hono,
  dependencies: GazetteRouteDependencies,
) => void

const routeModule = await import(routesUrl.href).catch(() => ({})) as {
  mountGazetteRoutes?: MountGazetteRoutes
}

function dependencies(
  overrides: Partial<GazetteRouteDependencies> = {},
): GazetteRouteDependencies {
  return {
    readSubmissionRoomState: async () => ({ submissionsOpen: false }),
    listIssues: async () => ({
      issues: [], hasMore: false, nextBeforeIssueNumber: null,
    }),
    readIssue: async () => null,
    database: Object.freeze({ name: 'gazette-route-test-database' }),
    printGazetteIssuesDue: async () => undefined,
    environment: { CRON_SECRET },
    ...overrides,
  }
}

function createApp(routeDependencies: GazetteRouteDependencies): Hono {
  const mountGazetteRoutes = routeModule.mountGazetteRoutes
  assert.equal(
    typeof mountGazetteRoutes,
    'function',
    'export mountGazetteRoutes(app, dependencies) from src/gazette-routes.ts',
  )
  const app = new Hono()
  mountGazetteRoutes!(app, routeDependencies)
  return app
}

const summaries = Object.freeze([
  {
    issue_number: 4,
    scheduled_for: '2026-09-21T16:00:00.000Z',
    printed_at: '2026-09-21T16:00:01.000Z',
    entry_count: 0,
    header: 'must not leak on the list',
    body: 'must not leak on the list',
    entries: [{ body: 'must not leak on the list' }],
  },
  {
    issue_number: 3,
    scheduled_for: '2026-09-14T16:00:00.000Z',
    printed_at: '2026-09-14T16:00:01.000Z',
    entry_count: 2,
    header: 'detail only',
  },
  {
    issue_number: 2,
    scheduled_for: '2026-09-07T16:00:00.000Z',
    printed_at: '2026-09-07T16:00:01.000Z',
    entry_count: 1,
  },
  {
    issue_number: 1,
    scheduled_for: FIRST_PRINT_AT,
    printed_at: '2026-08-31T16:00:01.000Z',
    entry_count: 3,
  },
] satisfies readonly IssueSummary[])

test('the public issue list is newest-first, cursor-paged, and body-free', async () => {
  const calls: Array<Readonly<{ beforeIssueNumber: number | null; limit: number }>> = []
  const app = createApp(dependencies({
    readSubmissionRoomState: async () => ({ submissionsOpen: true }),
    listIssues: async input => {
      calls.push(input)
      return input.beforeIssueNumber === null
        ? { issues: summaries.slice(0, 2), hasMore: true, nextBeforeIssueNumber: 3 }
        : { issues: summaries.slice(2), hasMore: false, nextBeforeIssueNumber: null }
    },
  }))

  const firstResponse = await app.request('/api/gazette?limit=2')
  assert.equal(firstResponse.status, 200)
  const firstBody = await firstResponse.json()
  assert.deepEqual(firstBody, {
    first_print_at: FIRST_PRINT_AT,
    submission_room: { place_id: 454, submissions_open: true },
    issues: [
      {
        issue_number: 4,
        scheduled_for: '2026-09-21T16:00:00.000Z',
        printed_at: '2026-09-21T16:00:01.000Z',
        entry_count: 0,
      },
      {
        issue_number: 3,
        scheduled_for: '2026-09-14T16:00:00.000Z',
        printed_at: '2026-09-14T16:00:01.000Z',
        entry_count: 2,
      },
    ],
    has_more: true,
    next_before_issue_number: 3,
  })

  const olderResponse = await app.request('/api/gazette?before_issue_number=3&limit=2')
  assert.equal(olderResponse.status, 200)
  const olderBody = await olderResponse.json() as Record<string, unknown>
  assert.deepEqual(olderBody, {
    first_print_at: FIRST_PRINT_AT,
    submission_room: { place_id: 454, submissions_open: true },
    issues: summaries.slice(2).map(issue => ({
      issue_number: issue.issue_number,
      scheduled_for: issue.scheduled_for,
      printed_at: issue.printed_at,
      entry_count: issue.entry_count,
    })),
    has_more: false,
    next_before_issue_number: null,
  })
  assert.doesNotMatch(JSON.stringify([firstBody, olderBody]), /detail only|must not leak|"body"|"header"|"entries"/iu)
  assert.deepEqual(calls, [
    { beforeIssueNumber: null, limit: 2 },
    { beforeIssueNumber: 3, limit: 2 },
  ])
})

test('the pre-first-print list is honestly empty and names the authoritative first tick', async () => {
  const app = createApp(dependencies())
  const response = await app.request('/api/gazette')

  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), {
    first_print_at: FIRST_PRINT_AT,
    submission_room: { place_id: 454, submissions_open: false },
    issues: [],
    has_more: false,
    next_before_issue_number: null,
  })
})

test('issue detail pages entries oldest-first with exact verbatim attribution fields', async () => {
  const calls: Array<Readonly<{
    issueNumber: number
    afterOrdinal: number | null
    limit: number
  }>> = []
  const issue = {
    issue_number: 7,
    scheduled_for: '2026-10-12T16:00:00.000Z',
    printed_at: '2026-10-12T16:00:02.000Z',
    header: 'THE GAZETTE — ISSUE 7\nStanding provenance.',
    entry_count: 4,
  }
  const entries = [
    {
      ordinal: 1,
      note_id: 81,
      author: 'tiny-lantern',
      body: '  first line\nsecond line  ',
      created_at: '2026-10-06T00:00:00.000Z',
    },
    {
      ordinal: 2,
      note_id: 84,
      author: 'second-resident',
      body: 'Unicode 🏮 stays verbatim.',
      created_at: '2026-10-07T00:00:00.000Z',
    },
    {
      ordinal: 3,
      note_id: 90,
      author: 'tiny-lantern',
      body: 'third',
      created_at: '2026-10-08T00:00:00.000Z',
    },
    {
      ordinal: 4,
      note_id: 92,
      author: 'third-resident',
      body: 'fourth',
      created_at: '2026-10-09T00:00:00.000Z',
    },
  ] satisfies readonly IssueEntry[]
  const app = createApp(dependencies({
    readIssue: async input => {
      calls.push(input)
      return input.afterOrdinal === null
        ? { issue, entries: entries.slice(0, 2), hasMore: true, nextAfterOrdinal: 2 }
        : { issue, entries: entries.slice(2), hasMore: false, nextAfterOrdinal: null }
    },
  }))

  const firstResponse = await app.request('/api/gazette/7?limit=2')
  assert.equal(firstResponse.status, 200)
  assert.deepEqual(await firstResponse.json(), {
    issue,
    entries: entries.slice(0, 2),
    has_more: true,
    next_after_ordinal: 2,
  })

  const restResponse = await app.request('/api/gazette/7?after_ordinal=2&limit=2')
  assert.equal(restResponse.status, 200)
  assert.deepEqual(await restResponse.json(), {
    issue,
    entries: entries.slice(2),
    has_more: false,
    next_after_ordinal: null,
  })
  assert.deepEqual(calls, [
    { issueNumber: 7, afterOrdinal: null, limit: 2 },
    { issueNumber: 7, afterOrdinal: 2, limit: 2 },
  ])
})

test('list and detail reject ambiguous or invalid public inputs before reading', async () => {
  let reads = 0
  const app = createApp(dependencies({
    listIssues: async () => {
      reads += 1
      return { issues: [], hasMore: false, nextBeforeIssueNumber: null }
    },
    readIssue: async () => {
      reads += 1
      return null
    },
  }))
  const invalidPaths = [
    '/api/gazette?unknown=1',
    '/api/gazette?limit=0',
    '/api/gazette?limit=201',
    '/api/gazette?limit=2&limit=3',
    '/api/gazette?before_issue_number=0',
    '/api/gazette?before_issue_number=1.5',
    '/api/gazette?before_issue_number=nope',
    '/api/gazette?before_issue_number=4&before_issue_number=3',
    '/api/gazette/0',
    '/api/gazette/-1',
    '/api/gazette/1.5',
    '/api/gazette/not-an-issue',
    '/api/gazette/2147483648',
    '/api/gazette/7?unknown=1',
    '/api/gazette/7?limit=0',
    '/api/gazette/7?limit=201',
    '/api/gazette/7?after_ordinal=0',
    '/api/gazette/7?after_ordinal=1.5',
    '/api/gazette/7?after_ordinal=2&after_ordinal=3',
  ]
  for (const path of invalidPaths) {
    const response = await app.request(path)
    assert.equal(response.status, 400, path)
    const body = await response.json() as { error?: unknown }
    assert.equal(typeof body.error, 'string', path)
  }
  assert.equal(reads, 0)

  const missing = await app.request('/api/gazette/7')
  assert.equal(missing.status, 404)
  assert.equal(reads, 1)
})

test('the print route fails closed and accepts only the exact configured bearer', async () => {
  const database = Object.freeze({ marker: 'database seam' })
  let prints = 0
  const app = createApp(dependencies({
    database,
    printGazetteIssuesDue: async (...received) => {
      prints += 1
      assert.deepEqual(received, [database])
    },
  }))

  const rejectedBodies: unknown[] = []
  for (const authorization of [
    undefined,
    '',
    'Basic wrong',
    'Bearer',
    'Bearer wrong',
    `Bearer ${'x'.repeat(CRON_SECRET.length)}`,
    `Bearer ${CRON_SECRET} extra`,
  ]) {
    const response = await app.request('/api/internal/gazette-print', {
      headers: authorization ? { authorization } : {},
    })
    assert.equal(response.status, 401, authorization)
    rejectedBodies.push(await response.json())
  }
  assert.equal(prints, 0)
  assert.equal(new Set(rejectedBodies.map(body => JSON.stringify(body))).size, 1)

  const response = await app.request('/api/internal/gazette-print', {
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.match(response.headers.get('vary') ?? '', /authorization/iu)
  assert.deepEqual(await response.json(), { ok: true })
  assert.equal(prints, 1)
})

test('missing server secret disables printing and authorization uses constant-time hashes', async () => {
  for (const configured of [undefined, '', 'too-short']) {
    let prints = 0
    const app = createApp(dependencies({
      environment: { CRON_SECRET: configured },
      printGazetteIssuesDue: async () => { prints += 1 },
    }))
    const response = await app.request('/api/internal/gazette-print', {
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    })
    assert.equal(response.status, 503)
    assert.equal(prints, 0)
  }

  assert.equal(existsSync(cronAuthUrl), true, 'add src/cron-auth.ts')
  const source = readFileSync(cronAuthUrl, 'utf8')
  assert.match(source, /createHash[\s\S]*sha256/iu)
  assert.match(source, /timingSafeEqual/iu)
  assert.doesNotMatch(source, /(?:supplied|received|actual)\s*===\s*(?:expected|secret)/iu)
})
