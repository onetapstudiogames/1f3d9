import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerOfficialAndFlagsTests(): void {
  const {
    Hono,
    TREASURY,
    app,
    authHeaders,
    createHash,
    fixtureState,
    inserted,
    mcp,
    reset,
    setOAuthResidentResolver,
    sqlCalls,
    test,
    withVercelForwarding,
  } = getRoutesTestContext()


  test('official facts, events, residents, and treasury are public and anti-token', async () => {
    reset({ scenario: 'public books' })
    const official = await app.request('/api/official')
    assert.equal(official.status, 200)
    const facts = await official.json() as {
      domain: string
      treasury: string
      network: string
      token: null
      statement: string
      deployment_commit: string
      public_snapshots: {
        format_version: number
        releases: string
        format: string
        verifier: string
        cadence: string
        scope: string
        corrections: string
        recovery: string
      }
    }
    assert.equal(facts.domain, 'https://1f3d9.com')
    assert.equal(facts.treasury.toLowerCase(), TREASURY)
    assert.equal(facts.network, 'base')
    assert.equal(facts.token, null)
    assert.equal(facts.deployment_commit, 'e'.repeat(40))
    assert.match(official.headers.get('cache-control') ?? '', /no-store/iu)
    assert.equal(facts.statement,
      'There is no 1F3D9 token, coin, or tradeable points program, and there never will be. ' +
      'Prepaid city fee credit is private, resident-bound, nontransferable, and cannot be sold or redeemed. ' +
      'Anyone selling it is lying. The city never holds sale money; sales move wallet to wallet. ' +
      'The city never asks anyone to send money anywhere; any "municipal", "city", "registry", "archive" or "treasury" fund, fee, or wallet named by a resident is not the city\'s, and the only city fees are the flat fee credits listed on this page, paid to the published treasury.',
    )
    assert.deepEqual(facts.public_snapshots, {
      format_version: 2,
      releases: 'https://github.com/onetapstudiogames/1f3d9/releases?q=city-snapshot-',
      format: 'https://github.com/onetapstudiogames/1f3d9/blob/main/docs/PUBLIC_SNAPSHOTS.md',
      verifier: 'https://github.com/onetapstudiogames/1f3d9/blob/main/scripts/verify-public-snapshot.ts',
      cadence: 'daily at 08:17 UTC via the enabled workflow (cron 17 8 * * *)',
      scope: 'the full approved anonymous public record, not only the names directory',
      corrections: 'original snapshot assets are immutable; errata are separate append-only releases',
      recovery: 'public snapshots exclude private recovery data and are not recovery backups',
    })
    assert.deepEqual(
      (facts as unknown as { skill_version_recommended: { city: string; market: string } })
        .skill_version_recommended,
      { city: '1.9.6', market: '2.4.3' },
    )

    const [events, residents, treasury] = await Promise.all([
      app.request('/api/events'), app.request('/api/residents'), app.request('/treasury'),
    ])
    assert.equal(events.status, 200)
    assert.equal(residents.status, 200)
    assert.equal(treasury.status, 200)
    assert.equal(JSON.stringify(await residents.json()).includes('secret'), false)
    const books = await treasury.json() as {
      address: string
      fees_collected_usdc: number
      note: string
      recent_fees: Array<{ id?: number; purpose: string }>
      recent_fees_page: {
        total_items: number
        total_text_bytes: number
        returned_items: number
        returned_text_bytes: number
        has_more: boolean
        next_before_id: number | null
      }
    }
    assert.equal(books.address.toLowerCase(), TREASURY)
    assert.equal(books.fees_collected_usdc, 1)
    assert.match(books.note, /sales.*never|peer.to.peer|wallet/i)
    assert.deepEqual(books.recent_fees_page, {
      total_items: 1,
      total_text_bytes: 4,
      returned_items: 1,
      returned_text_bytes: 4,
      has_more: false,
      next_before_id: null,
    })

    reset({ scenario: 'public books' })
    const humanBooks = await app.request('/treasury', { headers: { accept: 'text/html' } })
    const booksHtml = await humanBooks.text()
    assert.equal(humanBooks.status, 200)
    assert.match(humanBooks.headers.get('content-type') ?? '', /^text\/html\b/iu)
    assert.equal(humanBooks.headers.get('vary'), 'Accept')
    assert.match(humanBooks.headers.get('content-security-policy') ?? '', /default-src 'none'/u)
    assert.match(humanBooks.headers.get('cache-control') ?? '', /no-store/iu)
    assert.doesNotMatch(humanBooks.headers.get('cache-control') ?? '', /s-maxage/iu)
    assert.match(booksHtml, /<title>Public books · 1F3D9<\/title>/u)
    assert.match(booksHtml, /<h1[^>]*>The city&rsquo;s public books<\/h1>/u)
    assert.match(booksHtml, /<dt>Treasury address<\/dt>/u)
    assert.match(booksHtml, /<th scope="col">Amount \(USDC\)<\/th>/u)
    assert.match(booksHtml, /<td>kind<\/td>/u)
    assert.match(booksHtml, /<a href="\/">Agent front door<\/a>/u)

    reset({ scenario: 'public books' })
    const apiBooks = await app.request('/api/treasury', { headers: { accept: 'text/html' } })
    assert.match(apiBooks.headers.get('content-type') ?? '', /^application\/json\b/iu)
    assert.equal(apiBooks.headers.get('vary'), null)
    assert.equal((await apiBooks.json() as { address: string }).address.toLowerCase(), TREASURY)

    for (const accept of [
      '*/*',
      'text/html;q=0,*/*;q=1',
      'text/html;q=0.5,application/json;q=1',
      'text/html;q=0.5,application/json;q=0.8,*/*;q=1',
      'text/html,application/json',
      'application/json;q=0.5,text/html;q=0,*/*;q=1',
    ]) {
      reset({ scenario: 'public books' })
      const rawBooks = await app.request('/treasury', { headers: { accept } })
      assert.match(rawBooks.headers.get('content-type') ?? '', /^application\/json\b/iu, accept)
      assert.equal(rawBooks.headers.get('vary'), 'Accept', accept)
    }
  })

  test('anonymous flags are rate-limited without publishing the report text', async () => {
    await withVercelForwarding(async () => {
      reset({ scenario: 'flag quota' })
      const body = JSON.stringify({
        target_type: 'thing', target_id: 41, reason: 'private report detail',
      })
      for (let index = 0; index < 5; index += 1) {
        const accepted = await app.request('/api/flag', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Vercel-Forwarded-For': `198.51.100.${index + 1}, 203.0.113.30`,
          },
          body,
        })
        assert.equal(accepted.status, 201)
      }
      // The anonymous bucket key is domain-separated from resident keys, so a
      // crafted address like "resident:7" can never land in a resident's bucket.
      const anonymousSlot = sqlCalls().find(call => /anonymous_flag_limits/i.test(call.query ?? ''))
      assert.equal(
        String(anonymousSlot?.params?.[0]),
        createHash('sha256').update('flag:ip:203.0.113.30', 'utf8').digest('hex'),
      )
      const limited = await app.request('/api/flag', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Vercel-Forwarded-For': '192.0.2.200, 203.0.113.30',
        },
        body,
      })
      assert.equal(limited.status, 429)
      assert.deepEqual(await limited.json(), {
        error: '5 anonymous flag limit reached per IP per UTC hour; retry after the next UTC hour begins',
      })
      assert.equal(inserted('flags'), 5)
      const flagWrite = sqlCalls().find(call => /insert\s+into\s+flags\b/i.test(call.query ?? ''))
      assert.ok(flagWrite)
      assert.doesNotMatch(flagWrite.query ?? '', /jsonb_build_object\([\s\S]*?'reason'/i)

      fixtureState.current = { ...fixtureState.current, calls: [] }
      const authenticated = await app.request('/api/flag', {
        method: 'POST', headers: authHeaders(), body,
      })
      assert.equal(authenticated.status, 201)
      // A resident takes a slot in its own bucket, so an exhausted anonymous IP
      // bucket never blocks a signed-in report.
      const residentSlot = sqlCalls().find(call => /anonymous_flag_limits/i.test(call.query ?? ''))
      assert.ok(residentSlot, 'resident flags take their own limited slot')
      assert.equal(Number(residentSlot.params?.[1]), 20)
      assert.equal(
        String(residentSlot.params?.[0]),
        createHash('sha256').update('flag:resident:7', 'utf8').digest('hex'),
      )
    })
  })

  test('a flag reason over 500 characters is rejected without losing text silently', async () => {
    reset({ scenario: 'flag quota' })
    const response = await app.request('/api/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target_type: 'thing', target_id: 41, reason: 'x'.repeat(501) }),
    })

    assert.equal(response.status, 400)
    assert.match(JSON.stringify(await response.json()), /reason[^.]*at most 500 characters/iu)
    assert.equal(inserted('flags'), 0)
  })

  test('a flag refuses a target that does not exist before spending quota or writing records', async () => {
    reset({ scenario: 'flag quota' })
    const response = await app.request('/api/flag', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        target_type: 'thing', target_id: 2_147_483_647, reason: 'missing target',
      }),
    })

    assert.equal(response.status, 404)
    assert.deepEqual(await response.json(), {
      error: 'thing target_id 2147483647 was not found; re-read the public record and send a current target_id',
    })
    assert.equal(inserted('flags'), 0)
    assert.equal(
      sqlCalls().some(call => /anonymous_flag_limits/iu.test(call.query ?? '')),
      false,
    )
  })

  test('invalid MCP credentials cannot fall through to the anonymous flag lane', async () => {
    reset({ scenario: 'flag quota' })
    const argumentsBody = {
      target_type: 'thing', target_id: 41, reason: 'private report detail',
    }
    const callBody = (name: string) => JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name, arguments: argumentsBody },
    })

    const legacy = await app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer invalid' },
      body: callBody('flag'),
    })
    const legacyPayload = await legacy.json() as {
      result: { isError: boolean; content: Array<{ text: string }> }
    }
    assert.equal(legacyPayload.result.isError, true)
    assert.match(legacyPayload.result.content[0]?.text ?? '', /auth_required|bad or missing bearer/iu)
    assert.equal(inserted('flags'), 0)

    const previousHostedFlag = process.env.HOSTED_CHAT_SIGNIN_ENABLED
    process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
    setOAuthResidentResolver(async () => null)
    try {
      const gateway = new Hono()
      gateway.post('/mcp/connect', c => mcp(c, app, { hostedChat: true }))
      for (const authorization of [undefined, `Bearer 1f3d9_at_${'ef'.repeat(32)}`]) {
        const hosted = await gateway.request('/mcp/connect', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(authorization ? { authorization } : {}),
          },
          body: callBody('mcp_for_1f3d9_flag'),
        })
        const hostedPayload = await hosted.json() as {
          result: { isError: boolean; content: Array<{ text: string }> }
        }
        assert.equal(hostedPayload.result.isError, true)
        assert.match(hostedPayload.result.content[0]?.text ?? '', /auth_required|bad or missing bearer/iu)
        assert.equal(inserted('flags'), 0)
      }
    } finally {
      setOAuthResidentResolver(null)
      if (previousHostedFlag === undefined) delete process.env.HOSTED_CHAT_SIGNIN_ENABLED
      else process.env.HOSTED_CHAT_SIGNIN_ENABLED = previousHostedFlag
    }
  })

  test('resident flags are bounded in their own hourly bucket', async () => {
    reset({ scenario: 'flag quota' })
    const body = JSON.stringify({ target_type: 'thing', target_id: 41, reason: 'private report detail' })
    for (let index = 0; index < 20; index += 1) {
      const accepted = await app.request('/api/flag', {
        method: 'POST', headers: authHeaders(), body,
      })
      assert.equal(accepted.status, 201, `resident flag ${index + 1}`)
    }
    const limited = await app.request('/api/flag', {
      method: 'POST', headers: authHeaders(), body,
    })
    assert.equal(limited.status, 429)
    assert.deepEqual(await limited.json(), {
      error: '20 resident flag limit reached per UTC hour; retry after the next UTC hour begins',
    })
    assert.equal(inserted('flags'), 20)

    // The resident's exhausted bucket leaves anonymous reporting untouched.
    const anonymous = await app.request('/api/flag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.77' },
      body,
    })
    assert.equal(anonymous.status, 201)
  })
}
