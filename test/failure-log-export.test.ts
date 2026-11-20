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

const noSleep = async (): Promise<void> => {}

test('failure export fails closed when more than one API page shares one millisecond', async () => {
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => response(Array.from({ length: 50 }, (_, index) => ({
      requestId: `same-${index}`, timestamp: 90, statusCode: 500,
    })), true),
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 90, endMs: 90,
  }), /more than 50 failure rows share timestamp 90/iu)
})

test('failure export returns an empty list for a complete empty window', async () => {
  const rows = await fetchVercelFailureRows({
    fetcher: async () => response([]),
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '4xx',
    startMs: 70, endMs: 100,
  })

  assert.deepEqual(rows, [])
})

test('failure export normalizes live Vercel ISO timestamps to epoch milliseconds', async () => {
  const rows = await fetchVercelFailureRows({
    fetcher: async () => response([{
      requestId: 'iso-time', timestamp: '2026-09-10T12:00:00.123Z', statusCode: 500,
    }]),
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
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
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '4xx',
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
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
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
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 0, endMs: 100_000,
  })

  assert.deepEqual(rows.map(row => row.requestId), ['edge', 'later'])
  assert.ok(providerNow > 200)
})

test('failure export reports HTTP failures without including provider response text or credentials', async () => {
  const credential = `1f3d9_sk_${'ab'.repeat(24)}`
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => new Response(`private provider detail ${credential}`, { status: 400 }),
    sleep: noSleep, token: credential, teamId: 'team', project: '1f3d9', statusClass: '5xx',
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
      sleep: noSleep,
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
  // A paced read of a busy day took about 26 minutes live on 2026-11-20.
  const timeoutMinutes = Number(/timeout-minutes:\s*(\d+)/u.exec(workflow)?.[1])
  assert.ok(timeoutMinutes >= 60, `the export job needs room for a paced, retried day, got ${timeoutMinutes}`)
})

const MINUTE_MS = 60_000
const DOCUMENTED_REQUEST_LOG_LIMIT_PER_MINUTE = 240

function status(code: number, headers: Record<string, string> = {}): Response {
  return new Response('provider detail', { status: code, headers })
}

function windowKey(url: URL): string {
  return `${url.searchParams.get('startDate')}-${url.searchParams.get('endDate')}`
}

function recordingSleep(): { readonly sleep: (ms: number) => Promise<void>; readonly waits: number[] } {
  const waits: number[] = []
  return { waits, sleep: async ms => { waits.push(ms) } }
}

test('failure export waits and retries the same window after HTTP 429 instead of failing', async () => {
  const urls: string[] = []
  const replies = [status(429), response([{ requestId: 'after-wait', timestamp: 80, statusCode: 500 }])]
  const { sleep, waits } = recordingSleep()
  const rows = await fetchVercelFailureRows({
    fetcher: async input => {
      urls.push(String(input))
      return replies.shift()!
    },
    sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 70, endMs: 100,
  })

  assert.deepEqual(rows.map(row => row.requestId), ['after-wait'])
  assert.equal(urls.length, 2)
  assert.equal(urls[0], urls[1])
  assert.ok(waits.some(ms => ms >= 1_000), 'a 429 without Retry-After still waits a real backoff')
})

test('failure export honours Retry-After seconds and HTTP dates on a 429', async () => {
  const { sleep, waits } = recordingSleep()
  const replies = [
    status(429, { 'retry-after': '7' }),
    status(429, { 'retry-after': new Date(Date.now() + 30_000).toUTCString() }),
    response([]),
  ]
  await fetchVercelFailureRows({
    fetcher: async () => replies.shift()!,
    sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '4xx',
    startMs: 70, endMs: 100,
  })

  assert.ok(waits.includes(7_000), `expected a 7000 ms wait in ${JSON.stringify(waits)}`)
  assert.ok(waits.some(ms => ms > 27_000 && ms <= 30_000), `expected about 30000 ms in ${JSON.stringify(waits)}`)
})

test('failure export grows its 429 backoff, caps each wait, and gives up naming the status and tries', async () => {
  const { sleep, waits } = recordingSleep()
  let calls = 0
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => {
      calls += 1
      return status(429, calls === 1 ? { 'retry-after': '86400' } : {})
    },
    sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 70, endMs: 100,
  }), error => {
    assert.match(String(error), /HTTP 429 after \d+ tries/u)
    assert.match(String(error), new RegExp(`after ${calls} tries`, 'u'))
    assert.doesNotMatch(String(error), /provider detail/u)
    return true
  })

  assert.ok(calls >= 3 && calls <= 10, `bounded tries, got ${calls}`)
  const backoffs = waits.filter(ms => ms >= 1_000)
  assert.equal(backoffs.length, calls - 1)
  assert.ok(backoffs.every(ms => ms <= MINUTE_MS), `each wait is capped: ${JSON.stringify(backoffs)}`)
  const growing = backoffs.slice(1)
  assert.ok(growing.every((ms, index) => index === 0 || ms >= growing[index - 1]!), 'backoff never shrinks')
  assert.ok(growing.at(-1)! > growing[0]!, 'backoff grows')
})

test('a retried window adds no duplicate rows and loses none, even inside a split', async () => {
  const seen = new Map<string, number>()
  const rows = await fetchVercelFailureRows({
    fetcher: async input => {
      const key = windowKey(new URL(String(input)))
      const attempt = (seen.get(key) ?? 0) + 1
      seen.set(key, attempt)
      if (key === '0-29999') {
        return attempt === 1
          ? status(429)
          : response([{ requestId: 'a', timestamp: 100, statusCode: 500 }, { requestId: 'c', timestamp: 20_000, statusCode: 500 }], true)
      }
      if (key === '0-14999') {
        return attempt === 1
          ? status(503)
          : response([{ requestId: 'a', timestamp: 100, statusCode: 500 }, { requestId: 'b', timestamp: 200, statusCode: 500 }])
      }
      if (key === '15000-29999') {
        return attempt === 1
          ? status(429, { 'retry-after': '1' })
          : response([{ requestId: 'c', timestamp: 20_000, statusCode: 500 }, { requestId: 'd', timestamp: 29_999, statusCode: 500 }])
      }
      throw new Error(`unexpected window ${key}`)
    },
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 0, endMs: 29_999,
  })

  assert.deepEqual(rows.map(row => row.requestId), ['a', 'b', 'c', 'd'])
  assert.deepEqual(Object.fromEntries(seen), { '0-29999': 2, '0-14999': 2, '15000-29999': 2 })
})

test('failure export still fails at once on a non-retryable HTTP status', async () => {
  for (const code of [400, 401, 403, 404]) {
    let calls = 0
    await assert.rejects(fetchVercelFailureRows({
      fetcher: async () => {
        calls += 1
        return status(code)
      },
      sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
      startMs: 70, endMs: 100,
    }), new RegExp(`Vercel request-log read failed with HTTP ${code}$`, 'u'))
    assert.equal(calls, 1, `HTTP ${code} is not retried`)
  }
})

test('one export spaces every request through one shared pause that stays under the documented limit', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'failure-log-export-'))
  const pauses: number[] = []
  let activePauses = 0
  let maxActivePauses = 0
  let fetches = 0
  try {
    await runFailureLogExport({
      environment: { VERCEL_TOKEN: 'test-token', VERCEL_TEAM_ID: 'test-team' },
      fetcher: async () => {
        fetches += 1
        return response([])
      },
      sleep: async ms => {
        pauses.push(ms)
        activePauses += 1
        maxActivePauses = Math.max(maxActivePauses, activePauses)
        await new Promise(resolveTick => setImmediate(resolveTick))
        activePauses -= 1
      },
      now: new Date('2026-09-10T12:00:00.000Z'),
      outDir,
    })
  } finally {
    await rm(outDir, { recursive: true, force: true })
  }

  assert.ok(fetches > 4)
  assert.equal(pauses.length, fetches, 'every request waits its turn')
  assert.equal(new Set(pauses).size, 1, 'one fixed pause')
  assert.ok(pauses[0]! >= MINUTE_MS / DOCUMENTED_REQUEST_LOG_LIMIT_PER_MINUTE)
  assert.equal(maxActivePauses, 1, 'the four parallel scans share one pace')
})

function timeoutAbort(): DOMException {
  return new DOMException('The operation was aborted due to timeout', 'TimeoutError')
}

function networkFailure(): TypeError {
  return new TypeError('fetch failed')
}

function bodyThatTimesOut(): Response {
  return new Response(new ReadableStream({ start(controller) { controller.error(timeoutAbort()) } }))
}

test('failure export retries the same window after a read timeout or a network error', async () => {
  for (const [label, fail] of [
    ['timeout before headers', async (): Promise<Response> => { throw timeoutAbort() }],
    ['network error', async (): Promise<Response> => { throw networkFailure() }],
    ['timeout while reading the body', async (): Promise<Response> => bodyThatTimesOut()],
  ] as const) {
    const urls: string[] = []
    let calls = 0
    const { sleep, waits } = recordingSleep()
    const rows = await fetchVercelFailureRows({
      fetcher: async input => {
        urls.push(String(input))
        calls += 1
        return calls === 1 ? fail() : response([{ requestId: 'after-retry', timestamp: 80, statusCode: 500 }])
      },
      sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
      startMs: 70, endMs: 100,
    })

    assert.deepEqual(rows.map(row => row.requestId), ['after-retry'], label)
    assert.equal(urls.length, 2, label)
    assert.equal(urls[0], urls[1], `${label} retries the same window`)
    assert.ok(waits.includes(5_000), `${label} waits the first backoff step: ${JSON.stringify(waits)}`)
  }
})

test('failure export gives up on repeated timeouts or network errors on the 429 ladder, naming the cause and tries', async () => {
  for (const [cause, thrown] of [['a timeout', timeoutAbort], ['a network error', networkFailure]] as const) {
    const { sleep, waits } = recordingSleep()
    let calls = 0
    await assert.rejects(fetchVercelFailureRows({
      fetcher: async () => {
        calls += 1
        throw thrown()
      },
      sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
      startMs: 70, endMs: 100,
    }), error => {
      assert.equal(String(error), `Error: Vercel request-log read failed with ${cause} after 6 tries`)
      return true
    })

    assert.equal(calls, 6, `${cause}: six tries`)
    assert.deepEqual(waits.filter(ms => ms >= 1_000), [5_000, 10_000, 20_000, 40_000, 60_000], cause)
  }
})

test('timeouts, network errors and HTTP retries share one six-try limit for a window', async () => {
  const failures = [
    async (): Promise<Response> => { throw timeoutAbort() },
    async (): Promise<Response> => status(429),
    async (): Promise<Response> => { throw networkFailure() },
    async (): Promise<Response> => status(503),
    async (): Promise<Response> => bodyThatTimesOut(),
    async (): Promise<Response> => { throw networkFailure() },
  ]
  let calls = 0
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => failures[calls++]!(),
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 70, endMs: 100,
  }), /^Error: Vercel request-log read failed with a network error after 6 tries$/u)
  assert.equal(calls, 6)
})

test('a window retried after timeouts and network errors adds no duplicate rows and loses none', async () => {
  const seen = new Map<string, number>()
  const rows = await fetchVercelFailureRows({
    fetcher: async input => {
      const key = windowKey(new URL(String(input)))
      const attempt = (seen.get(key) ?? 0) + 1
      seen.set(key, attempt)
      if (key === '0-29999') {
        if (attempt === 1) throw timeoutAbort()
        return response([{ requestId: 'a', timestamp: 100, statusCode: 500 }, { requestId: 'c', timestamp: 20_000, statusCode: 500 }], true)
      }
      if (key === '0-14999') {
        if (attempt === 1) throw networkFailure()
        return response([{ requestId: 'a', timestamp: 100, statusCode: 500 }, { requestId: 'b', timestamp: 200, statusCode: 500 }])
      }
      if (key === '15000-29999') {
        if (attempt === 1) return bodyThatTimesOut()
        return response([{ requestId: 'c', timestamp: 20_000, statusCode: 500 }, { requestId: 'd', timestamp: 29_999, statusCode: 500 }])
      }
      throw new Error(`unexpected window ${key}`)
    },
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 0, endMs: 29_999,
  })

  assert.deepEqual(rows.map(row => row.requestId), ['a', 'b', 'c', 'd'])
  assert.deepEqual(Object.fromEntries(seen), { '0-29999': 2, '0-14999': 2, '15000-29999': 2 })
})

test('failure export still fails at once on every failure that is not transient', async () => {
  const cases: readonly (readonly [string, () => Promise<Response>, RegExp])[] = [
    ['HTTP 422', async () => status(422), /^Error: Vercel request-log read failed with HTTP 422$/u],
    ['an abort that is not our timeout', async () => { throw new DOMException('aborted', 'AbortError') }, /aborted/u],
    ['an unexpected fetcher error', async () => { throw new Error('fake programming fault') }, /fake programming fault/u],
    ['a body that is not JSON', async () => new Response('not json'), /was not JSON/u],
    ['a body with an invalid shape', async () => Response.json([]), /invalid shape/u],
    ['a body with an invalid rows page', async () => Response.json({ rows: [] }), /invalid rows page/u],
    ['a row without an id', async () => response([{ timestamp: 80 }]), /lacked an id or timestamp/u],
    ['a declared oversize response', async () => new Response('{}', { headers: { 'content-length': String(6 * 1024 * 1024) } }), /exceeded the export size limit/u],
    ['an actual oversize response', async () => new Response('x'.repeat(5 * 1024 * 1024 + 1)), /exceeded the export size limit/u],
    ['a row outside its window', async () => response([{ requestId: 'late', timestamp: 101, statusCode: 500 }]), /outside the requested time window/u],
  ]
  for (const [label, reply, expected] of cases) {
    let calls = 0
    const { sleep, waits } = recordingSleep()
    await assert.rejects(fetchVercelFailureRows({
      fetcher: async () => {
        calls += 1
        return reply()
      },
      sleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
      startMs: 70, endMs: 100,
    }), expected, label)
    assert.equal(calls, 1, `${label} is not retried`)
    assert.deepEqual(waits.filter(ms => ms >= 1_000), [], `${label} does not wait a backoff`)
  }

  let sameStampCalls = 0
  await assert.rejects(fetchVercelFailureRows({
    fetcher: async () => {
      sameStampCalls += 1
      return response(Array.from({ length: 50 }, (_, index) => ({ requestId: `same-${index}`, timestamp: 90 })), true)
    },
    sleep: noSleep, token: 'test-token', teamId: 'team', project: '1f3d9', statusClass: '5xx',
    startMs: 90, endMs: 90,
  }), /more than 50 failure rows share timestamp 90/u)
  assert.equal(sameStampCalls, 1, 'more than 50 rows on one timestamp is not retried')
})
