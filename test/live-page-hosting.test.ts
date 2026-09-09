import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

test('Vercel redirects the bare Live page before proxying its relative assets', () => {
  const configuration = JSON.parse(
    readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'),
  ) as {
    redirects?: unknown[]
    rewrites?: unknown[]
    headers?: unknown[]
  }

  assert.deepEqual(configuration.redirects, [{
    source: '/live',
    destination: '/live/',
    permanent: true,
  }])
  assert.deepEqual(configuration.rewrites?.slice(0, 2), [{
    source: '/live/',
    destination: 'https://1f3d9-live.vercel.app/',
  }, {
    source: '/live/:path*',
    destination: 'https://1f3d9-live.vercel.app/:path*',
  }])
  assert.deepEqual(configuration.rewrites?.at(2), {
    source: '/(.*)',
    destination: '/api/index',
  })
  assert.equal(configuration.rewrites?.length, 3)
})
