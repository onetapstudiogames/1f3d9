// The central error boundary: a raw database collision that no named handler
// claimed answers as a plain retryable conflict, and every other unexpected
// failure stays a generic internal error that leaks no database detail.
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_URL = 'postgresql://fake:fake@fake-host.example.neon.tech/fakedb'
process.env.TREASURY_ADDRESS = '0x3b9d230c9b995fb1a10add2d63ce37437916dcfd'
process.env.PUBLIC_ORIGIN = 'https://1f3d9.com'
process.env.BASE_RPC_URL = 'https://base-rpc.test'
process.env.FACILITATOR_URL = 'https://facilitator.test'

let stagedFailure: Error | null = null

function stageFailure(message: string, code?: string): void {
  stagedFailure = code ? Object.assign(new Error(message), { code }) : new Error(message)
}

globalThis.fetch = (async (input: unknown) => {
  const url = String(input)
  if (url.includes('/sql') && stagedFailure) {
    const failure = stagedFailure
    stagedFailure = null
    throw failure
  }
  throw new Error(`unexpected fetch in the collision boundary suite: ${url}`)
}) as typeof fetch

const { default: app } = await import('../src/index.ts')
const { COLLISION_CONFLICT_MESSAGE } = await import('../src/core.ts')

async function publicRead(): Promise<{ status: number; body: string; requestId: string | null }> {
  const response = await app.request('/api/residents')
  return {
    status: response.status,
    body: await response.text(),
    requestId: response.headers.get('X-Request-ID'),
  }
}

test('a serialization failure reaching the boundary is a plain retryable conflict', async () => {
  stageFailure('could not serialize access due to concurrent update', '40001')
  const { status, body } = await publicRead()
  assert.equal(status, 409)
  assert.deepEqual(JSON.parse(body), { error: COLLISION_CONFLICT_MESSAGE })
  assert.doesNotMatch(body, /serialize/)
})

test('a deadlock reaching the boundary is a plain retryable conflict', async () => {
  stageFailure('deadlock detected while updating relation "places"', '40P01')
  const { status, body } = await publicRead()
  assert.equal(status, 409)
  assert.deepEqual(JSON.parse(body), { error: COLLISION_CONFLICT_MESSAGE })
  assert.doesNotMatch(body, /deadlock|relation/)
})

test('an unavailable lock reaching the boundary is a plain retryable conflict', async () => {
  stageFailure('could not obtain lock on row in relation "residents"', '55P03')
  const { status, body } = await publicRead()
  assert.equal(status, 409)
  assert.deepEqual(JSON.parse(body), { error: COLLISION_CONFLICT_MESSAGE })
  assert.doesNotMatch(body, /lock|relation/)
})

test('a unique-key race no named handler claimed is a conflict, not a server failure', async () => {
  stageFailure('duplicate key value violates unique constraint "places_name_key"', '23505')
  const { status, body } = await publicRead()
  assert.equal(status, 409)
  assert.deepEqual(JSON.parse(body), { error: COLLISION_CONFLICT_MESSAGE })
  assert.doesNotMatch(body, /duplicate|constraint|places_name_key/)
})

test('an ordinary failure stays a generic internal error without database detail', async () => {
  const logged: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => logged.push(values)
  try {
    stageFailure('connection to db.internal.example:5432 refused')
    const { status, body, requestId } = await publicRead()
    assert.equal(status, 500)
    assert.match(requestId ?? '', /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu)
    assert.deepEqual(JSON.parse(body), {
      error: 'the city could not complete the request because of an unexpected internal failure; retry once, then give request_id to the city operator if it fails again',
      error_class: 'city_fault',
      request_id: requestId,
    })
    assert.doesNotMatch(body, /db\.internal\.example/)

    const logText = logged.flat().map(String).join(' ')
    assert.match(logText, new RegExp(requestId ?? 'missing-request-id', 'u'))
    assert.match(logText, /city_fault/u)
    assert.doesNotMatch(logText, /db\.internal\.example|connection|5432/iu)
    const diagnostic = JSON.parse(String(logged[0]?.[1])) as Record<string, unknown>
    assert.equal(diagnostic.method, 'GET')
    assert.equal(diagnostic.path, '/api/residents')
    assert.match(String(diagnostic.error_name), /^[A-Za-z][A-Za-z0-9_.-]{0,63}Error$/u)
    assert.match(String(diagnostic.error_fingerprint), /^[0-9a-f]{64}$/u)
    assert.equal('error_code' in diagnostic, false)
  } finally {
    console.error = originalConsoleError
  }
})

test('a coded failure outside the collision list is not softened into a conflict', async () => {
  const logged: unknown[][] = []
  const originalConsoleError = console.error
  console.error = (...values: unknown[]) => logged.push(values)
  try {
    stageFailure('null value in column "handle" violates not-null constraint', '23502')
    const { status, body, requestId } = await publicRead()
    assert.equal(status, 500)
    assert.match(requestId ?? '', /^[0-9a-f-]{36}$/u)
    assert.deepEqual(JSON.parse(body), {
      error: 'the city could not complete the request because of an unexpected internal failure; retry once, then give request_id to the city operator if it fails again',
      error_class: 'city_fault',
      request_id: requestId,
    })
    assert.doesNotMatch(body, /handle|not-null/)
    const diagnostic = JSON.parse(String(logged[0]?.[1])) as Record<string, unknown>
    assert.equal(diagnostic.error_code, '23502')
    assert.equal(diagnostic.path, '/api/residents')
    assert.doesNotMatch(JSON.stringify(diagnostic), /handle|not-null/iu)
  } finally {
    console.error = originalConsoleError
  }
})
