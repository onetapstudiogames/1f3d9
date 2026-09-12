import test from 'node:test'
import assert from 'node:assert/strict'
import app from '../src/index.ts'

test('unmatched paths serve HTML only when the caller prefers acceptable HTML', async () => {
  for (const accept of [
    undefined,
    '*/*',
    'application/json',
    'text/html;q=0,*/*;q=1',
    'application/json;q=1,text/html;q=0.5',
    'text/html;q=0.5,application/json;q=0.8,*/*;q=1',
  ]) {
    const response = await app.request(
      '/this-page-does-not-exist',
      accept ? { headers: { accept } } : undefined,
    )
    assert.equal(response.status, 404)
    assert.match(response.headers.get('content-type') ?? '', /application\/json/iu, accept)
    assert.equal(response.headers.get('vary'), 'Accept')
    const body = await response.json() as {
      error: string
      request_id?: string
      error_class?: string
      http_status?: number
    }
    assert.match(body.error, /no such street/iu)
    assert.match(body.request_id ?? '', /^[0-9a-f-]{36}$/iu)
    assert.equal(body.error_class, 'not_found')
    assert.equal(body.http_status, 404)
    assert.equal(response.headers.get('x-request-id'), body.request_id)
    assert.equal(response.headers.get('x-1f3d9-error-class'), 'not_found')
  }

  const response = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.7' },
  })
  const html = await response.text()
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/iu)
  assert.equal(response.headers.get('vary'), 'Accept')
  assert.match(html, /<a href="\/">Open the city front page<\/a>/u)
  assert.match(html, /<a href="\/window">Open the human city window<\/a>/u)
  assert.doesNotMatch(html, /front_door tool/iu)
})

test('an XHTML-only browser preference receives the human 404 page', async () => {
  const response = await app.request('/reference/no-such-section.txt', {
    headers: { accept: 'application/xhtml+xml' },
  })
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type') ?? '', /text\/html/iu)
  assert.equal(response.headers.get('vary'), 'Accept')
})

test('the human 404 page shows the same request id as its response header', async () => {
  const response = await app.request('/this-page-does-not-exist', {
    headers: { accept: 'text/html' },
  })
  const requestId = response.headers.get('x-request-id')
  const html = await response.text()

  assert.match(requestId ?? '', /^[0-9a-f-]{36}$/iu)
  assert.equal(response.headers.get('x-1f3d9-error-class'), 'not_found')
  assert.ok(html.includes(`Request ID: <code>${requestId}</code>`))
})

test('a routed missing reference carries the same JSON trace as another missing street', async () => {
  const response = await app.request('/reference/no-such-section.txt', {
    headers: { accept: 'application/json' },
  })
  const body = await response.json() as {
    request_id?: string
    error_class?: string
    http_status?: number
  }
  assert.equal(response.status, 404)
  assert.equal(body.error_class, 'not_found')
  assert.equal(body.http_status, 404)
  assert.match(body.request_id ?? '', /^[0-9a-f-]{36}$/iu)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
})

test('a disabled hosted connector uses the traced not-found contract for GET and POST', async () => {
  for (const method of ['GET', 'POST'] as const) {
    const response = await app.request('/mcp/connect', {
      method,
      ...(method === 'POST'
        ? {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          }
        : {}),
    })
    assert.equal(response.status, 404, method)
    const body = await response.json() as {
      request_id?: string
      error_class?: string
      http_status?: number
    }
    assert.match(body.request_id ?? '', /^[0-9a-f-]{36}$/iu, method)
    assert.equal(body.error_class, 'not_found', method)
    assert.equal(body.http_status, 404, method)
    assert.equal(response.headers.get('x-request-id'), body.request_id, method)
  }
})

test('GET on the ordinary MCP door returns one traced method refusal', async () => {
  const response = await app.request('/mcp')
  const body = await response.json() as {
    error?: string
    request_id?: string
    error_class?: string
    http_status?: number
  }
  assert.equal(response.status, 405)
  assert.match(body.error ?? '', /POST JSON-RPC 2\.0 messages here/u)
  assert.equal(body.error_class, 'bad_input')
  assert.equal(body.http_status, 405)
  assert.match(body.request_id ?? '', /^[0-9a-f-]{36}$/iu)
  assert.equal(response.headers.get('x-request-id'), body.request_id)
  assert.equal(response.headers.get('allow'), 'POST')
})
