import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseNeonPreviewCleanupArguments,
  runNeonPreviewCleanup,
  selectPreviewBranchForClosedPullRequest,
} from '../scripts/neon-preview-cleanup.ts'
import { safeErrorDetail } from '../scripts/safe-error-detail.ts'

const cleanupSource = readFileSync(
  new URL('../scripts/neon-preview-cleanup.ts', import.meta.url),
  'utf8',
)

const branches = Object.freeze([
  Object.freeze({ id: 'br-main', name: 'main', primary: true }),
  Object.freeze({ id: 'br-shared', name: 'preview/shared-vercel-testing', primary: false }),
  Object.freeze({ id: 'br-feature', name: 'preview/feature/cost-safe', primary: false }),
])

test('cleanup selects only the exact non-primary branch for the closed PR', () => {
  assert.deepEqual(
    selectPreviewBranchForClosedPullRequest('feature/cost-safe', branches),
    { id: 'br-feature', name: 'preview/feature/cost-safe' },
  )
})

test('cleanup relies on reachable primary and shared-preview guards only', () => {
  assert.doesNotMatch(cleanupSource, /match\.name\s*===\s*['"]main['"]/u)
  assert.match(cleanupSource, /match\.primary/u)
  assert.match(cleanupSource, /match\.name\s*===\s*SHARED_BRANCH/u)
})

test('cleanup refuses protected, near-match, duplicate, and malformed targets', () => {
  assert.throws(
    () => selectPreviewBranchForClosedPullRequest('shared-vercel-testing', branches),
    /protected/i,
  )
  assert.equal(selectPreviewBranchForClosedPullRequest('feature/cost', branches), null)
  assert.equal(selectPreviewBranchForClosedPullRequest('', branches), null)
  assert.throws(
    () => selectPreviewBranchForClosedPullRequest('feature/cost-safe', [...branches, branches[2]!]),
    /multiple/i,
  )
  assert.throws(
    () => selectPreviewBranchForClosedPullRequest('main', [
      { id: 'br-danger', name: 'preview/main', primary: true },
    ]),
    /primary/i,
  )
})

test('cleanup proves the exact branch again before deleting by ID', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const logs: string[] = []
  await runNeonPreviewCleanup({
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project', GITHUB_REPOSITORY: 'owner/repo' },
    event: { pull_request: { head: { ref: 'feature/cost-safe', repo: { full_name: 'owner/repo' } } } },
    log: line => { logs.push(line) },
    fetcher: (async (input, init) => {
      const method = init?.method ?? 'GET'
      const url = String(input)
      requests.push({ url, method })
      if (url.endsWith('/branches?limit=100')) return new Response(JSON.stringify({
        branches: [{ id: 'br-feature', name: 'preview/feature/cost-safe', primary: false }],
        pagination: {},
      }), { status: 200 })
      if (method === 'GET') return new Response(JSON.stringify({
        branch: { id: 'br-feature', name: 'preview/feature/cost-safe', primary: false },
      }), { status: 200 })
      return new Response('{}', { status: 200 })
    }) as typeof fetch,
  })

  assert.deepEqual(requests.map(value => value.method), ['GET', 'GET', 'DELETE'])
  assert.match(requests[2]!.url, /\/branches\/br-feature$/u)
  assert.deepEqual(logs, ['Neon preview cleanup: requested deletion of preview/feature/cost-safe.'])
})

test('rehearsal proves the exact branch but makes no DELETE request', async () => {
  const requests: Array<{ url: string; method: string }> = []
  const logs: string[] = []
  await runNeonPreviewCleanup({
    dryRun: true,
    headReference: 'feature/cost-safe',
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project' },
    log: line => { logs.push(line) },
    fetcher: (async (input, init) => {
      const method = init?.method ?? 'GET'
      const url = String(input)
      requests.push({ url, method })
      if (url.endsWith('/branches?limit=100')) return new Response(JSON.stringify({
        branches: [{ id: 'br-feature', name: 'preview/feature/cost-safe', primary: false }],
        pagination: {},
      }), { status: 200 })
      return new Response(JSON.stringify({
        branch: { id: 'br-feature', name: 'preview/feature/cost-safe', primary: false },
      }), { status: 200 })
    }) as typeof fetch,
  })

  assert.deepEqual(requests.map(value => value.method), ['GET', 'GET'])
  assert.deepEqual(logs, [
    'Neon preview cleanup: would have deleted preview/feature/cost-safe; nothing was deleted.',
  ])
})

test('terminal arguments require rehearsal mode and one head ref', () => {
  assert.deepEqual(
    parseNeonPreviewCleanupArguments(['--dry-run', '--head-ref', 'feature/cost-safe']),
    { dryRun: true, headReference: 'feature/cost-safe' },
  )
  for (const arguments_ of [
    [],
    ['--head-ref', 'feature/cost-safe'],
    ['--dry-run'],
    ['--dry-run', '--head-ref', 'feature/cost-safe', 'extra'],
  ]) assert.throws(() => parseNeonPreviewCleanupArguments(arguments_), /usage/i)
})

test('a direct head ref can never select live deletion', async () => {
  let requests = 0
  await assert.rejects(runNeonPreviewCleanup({
    headReference: 'feature/cost-safe',
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project' },
    log: () => {},
    fetcher: (async () => {
      requests += 1
      throw new Error('must not fetch')
    }) as typeof fetch,
  }), /only in rehearsal mode/i)
  assert.equal(requests, 0)
})

test('shared error detail removes URLs and control characters', () => {
  assert.equal(
    safeErrorDetail(new Error('failed at https://example.test/path?token=secret\nnext line')),
    'failed at [URL redacted] next line',
  )
})

test('cleanup reports a DELETE race as already absent', async () => {
  const logs: string[] = []
  let request = 0
  await runNeonPreviewCleanup({
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project', GITHUB_REPOSITORY: 'owner/repo' },
    event: { pull_request: { head: { ref: 'feature/cost-safe', repo: { full_name: 'owner/repo' } } } },
    log: line => { logs.push(line) },
    fetcher: (async () => {
      request += 1
      if (request === 1) return new Response(JSON.stringify({
        branches: [{ id: 'br-feature', name: 'preview/feature/cost-safe', primary: false }],
      }), { status: 200 })
      if (request === 2) return new Response(JSON.stringify({
        branch: { id: 'br-feature', name: 'preview/feature/cost-safe', primary: false },
      }), { status: 200 })
      return new Response('', { status: 404 })
    }) as typeof fetch,
  })
  assert.deepEqual(logs, ['Neon preview cleanup: preview/feature/cost-safe was already absent during deletion.'])
})

test('cleanup refuses a fork with a colliding head branch name', async () => {
  let requests = 0
  const logs: string[] = []
  await runNeonPreviewCleanup({
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project', GITHUB_REPOSITORY: 'owner/repo' },
    event: { pull_request: { head: { ref: 'feature/cost-safe', repo: { full_name: 'attacker/fork' } } } },
    log: line => { logs.push(line) },
    fetcher: (async () => { requests += 1; throw new Error('must not fetch') }) as typeof fetch,
  })
  assert.equal(requests, 0)
  assert.deepEqual(logs, ['Neon preview cleanup: SKIPPED — the closed PR came from a fork.'])
})

test('cleanup fails closed when Neon omits primary branch identity', async () => {
  await assert.rejects(runNeonPreviewCleanup({
    environment: { NEON_API_KEY: 'key', NEON_PROJECT_ID: 'project', GITHUB_REPOSITORY: 'owner/repo' },
    event: { pull_request: { head: { ref: 'feature/cost-safe', repo: { full_name: 'owner/repo' } } } },
    log: () => {},
    fetcher: (async () => new Response(JSON.stringify({
      branches: [{ id: 'br-feature', name: 'preview/feature/cost-safe' }],
    }), { status: 200 })) as typeof fetch,
  }), /invalid branch/i)
})
