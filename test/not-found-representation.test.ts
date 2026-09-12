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
