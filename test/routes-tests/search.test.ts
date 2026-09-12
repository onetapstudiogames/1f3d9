import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerSearchTests(): void {
  const {
    PUBLIC_SEARCH_RATE_CAPACITY,
    app,
    authHeaders,
    encodePublicSearchCursor,
    reset,
    sqlCalls,
    test,
    withVercelForwarding,
  } = getRoutesTestContext()


  test('search and changes succeed through their real Hono routes without returning authored bodies', async () => {
    await withVercelForwarding(async () => {
      reset({ scenario: 'public pagination' })
      const headers = { 'X-Vercel-Forwarded-For': '203.0.113.180' }
      const searched = await app.request(
        '/api/search?q=archive+lantern&mode=phrase&type=thing&maker=archive-smith',
        { headers },
      )
      assert.equal(searched.status, 200)
      assert.equal(searched.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await searched.json(), {
        query: 'archive lantern', mode: 'phrase', type: 'thing', maker: 'archive-smith',
        results: [{
          type: 'thing', id: 41, place_id: 2, name: 'archive_lantern',
          maker_id: 5, made_by: 'archive-smith',
          current_owner_id: 7, current_owner: 'tiny-lantern',
          owner_id: 7, owner: 'tiny-lantern', open_to_use: true,
          has_drawing: false,
          body_text_bytes: 19, created_at: '2026-08-11T00:00:00.000000Z',
          href: '/api/thing/41',
        }],
        total_items: 1, total_text_bytes: 19, returned_items: 1,
        returned_text_bytes: 0, has_more: false, next_before: null, change_marker: '9',
      })
      const searchRead = sqlCalls().find(call => /\/\* public:search \*\//iu.test(call.query ?? ''))
      assert.match(searchRead?.query ?? '', /thing\.maker_id/iu)
      assert.match(searchRead?.query ?? '', /maker\.handle\s+AS\s+made_by/iu)
      assert.match(searchRead?.query ?? '', /thing\.owner_id\s+AS\s+current_owner_id/iu)
      assert.match(searchRead?.query ?? '', /owner\.handle\s+AS\s+current_owner/iu)
      assert.ok(searchRead?.params?.includes('archive-smith'))

      const checkpoint = await app.request('/api/changes')
      assert.equal(checkpoint.status, 200)
      assert.deepEqual(await checkpoint.json(), {
        change_marker: '9',
        next_step: 'Send change_marker back as since to read changes after that point.',
      })
      for (const query of ['kind=note', 'limit=1']) {
        const refused = await app.request(`/api/changes?${query}`)
        assert.equal(refused.status, 400, query)
        const refusal = await refused.json() as { next_step?: string }
        assert.match(refusal.next_step ?? '', /omit kind, limit, and since to obtain a marker/iu, query)
      }
      const malformed = await app.request('/api/changes?since=not-a-marker')
      assert.equal(malformed.status, 400)
      assert.equal(Object.hasOwn(await malformed.json(), 'next_step'), false)
      const changes = await app.request('/api/changes?since=8&kind=action&limit=1')
      assert.equal(changes.status, 200)
      assert.deepEqual(await changes.json(), {
        change_marker: '9',
        changes: [{
          change_id: '9', kind: 'action', actor: 'tiny-lantern',
          detail: { channel: 'public' }, created_at: '2026-08-11T00:00:09.000Z',
        }],
        returned_items: 1, unchanged: false, has_more: false, next_since: '9',
      })
      const changeRead = sqlCalls().find(call => /\/\* public:changes \*\//iu.test(call.query ?? ''))
      assert.deepEqual(changeRead?.params, ['8', '2', 'action'])
    })
  })

  test('anonymous search parses before applying its per-caller fairness limit and exact database work', async () => {
    await withVercelForwarding(async () => {
      reset({ scenario: 'public pagination' })
      const headers = { 'X-Vercel-Forwarded-For': '203.0.113.181' }
      for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
        const invalid = await app.request('/api/search?q=', { headers })
        assert.equal(invalid.status, 400, `invalid search ${index + 1}`)
      }
      for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
        const response = await app.request('/api/search?q=archive', { headers })
        assert.equal(response.status, 200, `admitted search ${index + 1}`)
      }
      const limited = await app.request('/api/search?q=archive', { headers })
      assert.equal(limited.status, 429)
      assert.ok(Number(limited.headers.get('retry-after')) >= 1)
      assert.deepEqual(await limited.json(), { error: 'public search rate limit reached; retry' })
      assert.equal(
        sqlCalls().filter(call => /\/\* public:search \*\//iu.test(call.query ?? '')).length,
        PUBLIC_SEARCH_RATE_CAPACITY,
      )
    })
  })

  test('anonymous search trusts only the final Vercel forwarding hop for caller fairness', async () => {
    await withVercelForwarding(async () => {
      reset({ scenario: 'public pagination' })
      const finalHop = '203.0.113.182'
      for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
        const response = await app.request('/api/search?q=archive', {
          headers: { 'X-Vercel-Forwarded-For': `198.51.100.${index + 1}, ${finalHop}` },
        })
        assert.equal(response.status, 200, `admitted search ${index + 1}`)
      }
      const spoofed = await app.request('/api/search?q=archive', {
        headers: { 'X-Vercel-Forwarded-For': `192.0.2.200, ${finalHop}` },
      })
      assert.equal(spoofed.status, 429)
      const otherCaller = await app.request('/api/search?q=archive', {
        headers: { 'X-Vercel-Forwarded-For': '192.0.2.200, 203.0.113.183' },
      })
      assert.equal(otherCaller.status, 200)
    })
  })

  test('outside Vercel, spoofed forwarding headers share the anonymous fallback bucket', async () => {
    const previous = process.env.VERCEL
    process.env.VERCEL = '0'
    try {
      reset({ scenario: 'public pagination' })
      for (let index = 0; index < PUBLIC_SEARCH_RATE_CAPACITY; index += 1) {
        const response = await app.request('/api/search?q=archive', {
          headers: {
            'X-Vercel-Forwarded-For': `203.0.113.${index + 20}`,
            'X-Forwarded-For': `198.51.100.${index + 20}`,
          },
        })
        assert.equal(response.status, 200, `fallback search ${index + 1}`)
      }
      const limited = await app.request('/api/search?q=archive', {
        headers: {
          'X-Vercel-Forwarded-For': '203.0.113.250',
          'X-Forwarded-For': '198.51.100.250',
        },
      })
      assert.equal(limited.status, 429)
    } finally {
      process.env.VERCEL = previous
    }
  })

  test('a search continuation rejects a forged future reconciliation marker', async () => {
    await withVercelForwarding(async () => {
      reset({ scenario: 'public pagination', publicChangeMarker: '12' })
      const before = encodePublicSearchCursor({
        q: 'archive', mode: 'words', type: 'all',
        createdAt: '2026-08-11T00:00:00.000000Z', itemType: 'thing', id: 41,
        changeMarker: '999',
      })
      const response = await app.request(
        `/api/search?q=archive&before=${encodeURIComponent(before)}`,
        { headers: { 'X-Vercel-Forwarded-For': '203.0.113.184' } },
      )
      assert.equal(response.status, 409)
      assert.deepEqual(await response.json(), {
        error: 'search marker 999 is ahead of checkpoint 12',
      })
    })
  })

  test('public direct resource ids reject PostgreSQL integer overflow before database work', async () => {
    for (const path of [
      '/api/place/2147483648',
      '/api/thing/2147483648',
      '/api/note/2147483648',
    ]) {
      reset({ scenario: 'public pagination' })
      const response = await app.request(path)
      assert.equal(response.status, 400, path)
      assert.equal(sqlCalls().length, 0, path)
    }
  })

  test('/api/me rejects unknown read options after authentication', async () => {
    reset({ scenario: 'remaining pagination' })
    const response = await app.request('/api/me?q=pretend-search', { headers: authHeaders() })
    assert.equal(response.status, 400)
    const body = await response.json() as { error: string }
    assert.match(body.error, /unsupported query option: q/i)
    assert.equal(
      sqlCalls().some(call => /\/\* public:me_/i.test(call.query ?? '')),
      false,
      'unknown options fail before reading private collections',
    )
  })
}
