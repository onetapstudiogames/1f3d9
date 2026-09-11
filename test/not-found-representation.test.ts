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
    assert.match((await response.json() as { error: string }).error, /no such street/iu)
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
