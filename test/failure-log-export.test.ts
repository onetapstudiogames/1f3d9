import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  fetchVercelFailureRows,
  runFailureLogExport,
  sanitizeFailureRow,
} from '../scripts/export-vercel-failure-logs.ts'

function response(rows: readonly Record<string, unknown>[], hasMoreRows = false): Response {
  return Response.json({ rows, hasMoreRows })
}

test('failure export fails closed when more than one API page shares one millisecond', async () => {
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => response(Array.from({ length: 50 }, (_, index) => ({
      requestId: `same-${index}`, timestamp: 90, statusCode: 500,
    })), true),
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 90, endMs: 90,
  }), /more than 50 failure rows share timestamp 90/iu)
})

test('failure export returns an empty list for a complete empty window', async () => {
  const rows = await fetchVercelFailureRows({
    fetcher: async () => response([]),
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '4xx',
    startMs: 70, endMs: 100,
  })

  assert.deepEqual(rows, [])
})

test('failure export normalizes live Vercel ISO timestamps to epoch milliseconds', async () => {
  const rows = await fetchVercelFailureRows({
    fetcher: async () => response([{
      requestId: 'iso-time', timestamp: '2026-09-10T12:00:00.123Z', statusCode: 500,
    }]),
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 1_789_041_600_000, endMs: 1_789_041_600_999,
  })

  assert.equal(rows[0]?.timestamp, 1_789_041_600_123)
})

test('daily export protects the rolling retention edge with gapless oldest-first windows', async () => {
  const urls: URL[] = []
  await fetchVercelFailureRows({
    fetcher: async input => {
      urls.push(new URL(String(input)))
      return response([])
    },
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '4xx',
    startMs: 70, endMs: 100_070,
  })

  assert.deepEqual(urls.map(url => [
    url.searchParams.get('startDate'), url.searchParams.get('endDate'),
  ]), [['70', '30069'], ['30070', '90069'], ['90070', '100070']])
})

test('oldest-first export splits a truncated window and reads the older half first', async () => {
  const urls: URL[] = []
  const replies = [
    response([{ requestId: 'parent-only', timestamp: 25_000, statusCode: 500 }], true),
    response([{ requestId: 'old', timestamp: 100, statusCode: 500 }]),
    response([]),
  ]
  const rows = await fetchVercelFailureRows({
    fetcher: async input => {
      urls.push(new URL(String(input)))
      return replies.shift()!
    },
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 0, endMs: 29_999,
  })

  assert.deepEqual(urls.map(url => [
    url.searchParams.get('startDate'), url.searchParams.get('endDate'),
  ]), [['0', '29999'], ['0', '14999'], ['15000', '29999']])
  assert.deepEqual(rows.map(row => row.requestId), ['old', 'parent-only'])
})

test('oldest-first export retains an edge row that a later rolling-retention read would prune', async () => {
  let providerNow = 100
  const sourceRows = [
    { requestId: 'edge', timestamp: 0, statusCode: 500 },
    { requestId: 'later', timestamp: 90_000, statusCode: 500 },
  ]
  const rows = await fetchVercelFailureRows({
    fetcher: async input => {
      const url = new URL(String(input))
      const start = Number(url.searchParams.get('startDate'))
      const end = Number(url.searchParams.get('endDate'))
      const retained = sourceRows.filter(row => (
        row.timestamp >= providerNow - 100
        && row.timestamp >= start
        && row.timestamp <= end
      ))
      providerNow += 50
      return response(retained)
    },
    token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 0, endMs: 100_000,
  })

  assert.deepEqual(rows.map(row => row.requestId), ['edge', 'later'])
  assert.ok(providerNow > 200)
})

test('failure export reports HTTP failures without including provider response text or credentials', async () => {
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => new Response(`private provider detail ${credential}`, { status: 400 }),
    token: credential, teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 70, endMs: 100,
  }), error => {
    assert.match(String(error), /HTTP 400/u)
    assert.doesNotMatch(String(error), /private provider detail|1f3d9_sk_/u)
    return true
  })
})

test('failure export keeps diagnostic fields while dropping query strings, raw app logs, and credential-shaped text', () => {
  const safe = sanitizeFailureRow('1f3d9', {
    requestId: 'request-1', timestamp: 100, requestMethod: 'GET',
    requestPath: `/api/place/2/1f3ea_sk_${'ab'.repeat(24)}`,
    requestSearchParams: `token=1f3d9_sk_${'cd'.repeat(24)}`,
    statusCode: 500, errorCode: 'FUNCTION_INVOCATION_FAILED',
    clientUserAgent: 'safe-test-agent/1.0',
    requestReferer: `https://1f3d9.com/window?token=1f3d9_sk_${'12'.repeat(24)}`,
    requestDurationMs: 21,
    logs: [
      {
        message: 'request_failure ' + JSON.stringify({
          event: 'request_failure', request_id: 'public-request', error_class: 'city_fault',
          status: 500, method: 'GET', path: '/api/place/:id', error_name: 'NeonDbError',
          error_code: 'XX000', error_fingerprint: 'a'.repeat(64), secret: 'drop me',
        }),
      },
      { message: `raw body 1f3d9_sk_${'ef'.repeat(24)}` },
    ],
    functionEvents: [{ durationMs: 12, region: 'iad1', concurrency: 2, private: 'drop me' }],
  })

  const encoded = JSON.stringify(safe)
  assert.doesNotMatch(encoded, /requestSearchParams|token=|raw body|drop me|1f3(?:d9|ea)_sk_/iu)
  assert.match(encoded, /\[redacted city credential\]/iu)
  assert.deepEqual(safe.diagnostics, [{
    event: 'request_failure', request_id: 'public-request', error_class: 'city_fault',
    status: 500, method: 'GET', path: '/api/place/:id', error_name: 'NeonDbError',
    error_code: 'XX000', error_fingerprint: 'a'.repeat(64),
  }])
  assert.deepEqual(safe.functionEvents, [{ durationMs: 12, region: 'iad1', concurrency: 2 }])
  assert.equal(safe.clientUserAgent, 'safe-test-agent/1.0')
  assert.equal(safe.requestReferer, 'https://1f3d9.com/window')
  assert.equal(safe.requestDurationMs, 21)
})

test('failure export redacts a credential before applying field length limits', () => {
  const safe = sanitizeFailureRow('1f3d9', {
    requestId: 'request-1',
    timestamp: 100,
    clientUserAgent: `${'x'.repeat(2_040)}1f3d9_sk_${'ab'.repeat(24)}`,
  })

  assert.doesNotMatch(String(safe.clientUserAgent), /1f3d9_/u)
  assert.equal(safe.clientUserAgent, '[redacted]')
  assert.ok(String(safe.clientUserAgent).length <= 2_048)
})

test('failure export redacts percent-encoded credentials in paths without decoding query data', () => {
  const safe = sanitizeFailureRow('1f3d9', {
    requestId: 'request-1',
    timestamp: 100,
    requestPath: `/api/place/1f3d9%5Fsk%5F${'ab'.repeat(24)}?private%5Fquery=value`,
  })

  assert.equal(safe.requestPath, '/api/place/[redacted city credential]')
  assert.doesNotMatch(String(safe.requestPath), /private|query|1f3d9|%5F/iu)
})

test('failure export applies shared credential redaction to every retained string field', () => {
  const cityToken = `1f3d9_at_${'ab'.repeat(32)}`
  const giftToken = `gift_claim_${'cd'.repeat(32)}`
  const commonTokens = {
    openai: `sk-${'a'.repeat(20)}`,
    githubPat: `github_pat_${'b'.repeat(20)}`,
    github: `ghp_${'c'.repeat(20)}`,
    slack: `xoxb-${'d'.repeat(20)}`,
    aws: `AKIA${'E'.repeat(16)}`,
  }
  const safe = sanitizeFailureRow(giftToken, {
    requestId: `Bearer ${'request-token'.repeat(2)}`,
    timestamp: 100,
    requestMethod: commonTokens.openai,
    requestPath: `/api/${giftToken}`,
    errorCode: commonTokens.githubPat,
    clientUserAgent: `Bearer ${'agent-token'.repeat(2)}`,
    requestReferer: 'https://fixture-user:fixture-password@example.test/window',
    logs: [{
      message: 'request_failure ' + JSON.stringify({
        event: 'request_failure',
        request_id: giftToken,
        error_class: commonTokens.github,
        method: commonTokens.slack,
        path: 'postgresql://fixture-user:fixture-password@db.example.test/city',
        error_name: commonTokens.aws,
        error_code: cityToken,
        error_fingerprint: 'https://other-user:other-password@example.test/path',
      }),
    }],
    functionEvents: [{
      functionStartType: `Bearer ${'function-token'.repeat(2)}`,
      region: commonTokens.openai,
    }],
  })

  const encoded = JSON.stringify(safe)
  assert.doesNotMatch(encoded, /gift_claim_|1f3d9_at_|fixture-(?:user|password)|other-(?:user|password)/iu)
  assert.doesNotMatch(encoded, /Bearer\s+(?!\[redacted\])|postgres(?:ql)?:\/\/|github_pat_|ghp_|xoxb-|AKIAE|sk-a/iu)
  assert.match(encoded, /redacted/iu)
})

test('failure export fails closed on sensitive assignments in retained strings', () => {
  const safe = sanitizeFailureRow('1f3d9', {
    requestId: 'request-1',
    timestamp: 100,
    clientUserAgent: `apiToken=${'z'.repeat(32)}`,
  })

  assert.equal(safe.clientUserAgent, '[redacted: log text contained credential material]')
})

test('one run reads both configured projects and classes into dated sanitized JSON', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'failure-log-export-'))
  const urls: URL[] = []
  try {
    const result = await runFailureLogExport({
      environment: { VERCEL_TOKEN: 'test-token', VERCEL_TEAM_ID: 'test-team' },
      fetcher: async input => {
        urls.push(new URL(String(input)))
        return response([])
      },
      now: new Date('2026-09-10T12:00:00.000Z'),
      outDir,
    })

    assert.equal(result.rowCount, 0)
    assert.equal(result.path, join(outDir, 'failure-logs-2026-09-10.json'))
    assert.deepEqual(new Set(urls.map(url => url.searchParams.get('projectId'))), new Set(['1f3d9', '1f3ea']))
    assert.deepEqual(new Set(urls.map(url => url.searchParams.get('statusCode'))), new Set(['4xx', '5xx']))
    for (const project of ['1f3d9', '1f3ea']) for (const statusClass of ['4xx', '5xx']) {
      const windows = urls.filter(url => (
        url.searchParams.get('projectId') === project
        && url.searchParams.get('statusCode') === statusClass
      )).map(url => ({
        start: Number(url.searchParams.get('startDate')),
        end: Number(url.searchParams.get('endDate')),
      })).toSorted((left, right) => left.start - right.start)
      assert.equal(windows[0]?.start, 1_788_955_200_000)
      assert.equal(windows.at(-1)?.end, 1_789_041_600_000)
      assert.ok(windows.every((window, index) => index === 0 || window.start === windows[index - 1]!.end + 1))
    }
    assert.ok(urls.every(url => url.searchParams.get('page') === null))
    const saved = await readFile(result.path, 'utf8')
    assert.deepEqual(JSON.parse(saved), {
      exported_at: '2026-09-10T12:00:00.000Z',
      start_ms: 1788955200000,
      end_ms: 1789041600000,
      rows: [],
    })
    assert.doesNotMatch(saved, /test-token|test-team/u)
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }
})

test('daily workflow exports both projects and both failure classes to a retained artifact', async () => {
  const workflow = await readFile(new URL('../.github/workflows/failure-log-export.yml', import.meta.url), 'utf8')
  assert.match(workflow, /schedule:[\s\S]*cron:/u)
  assert.match(workflow, /workflow_dispatch:/u)
  assert.match(workflow, /VERCEL_TOKEN:\s*\$\{\{ secrets\.VERCEL_TOKEN \}\}/u)
  assert.match(workflow, /VERCEL_TEAM_ID:\s*\$\{\{ vars\.VERCEL_TEAM_ID \}\}/u)
  assert.match(workflow, /export-vercel-failure-logs/u)
  assert.match(workflow, /logs\/failures/u)
  assert.match(workflow, /upload-artifact@[0-9a-f]{40}/u)
  assert.match(workflow, /retention-days:\s*(?:[3-9][0-9]|[1-9][0-9]{2,})/u)
})
