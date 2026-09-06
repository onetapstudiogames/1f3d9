import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'

import {
  CITY_CREDIT_ROUTE_CASES,
  assertCityCreditNoStore,
  cityCreditDomainWriteCount,
} from '../helpers/routes-fixtures/city-credit.ts'

export function registerCityCreditSpendTests(): void {
  const {
    X_PAYMENT,
    app,
    authHeaders,
    fixtureState,
    networkCalled,
    reset,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('each eligible paid action deliberately spends one own city fee credit and replays exactly', async () => {

    for (const creditCase of CITY_CREDIT_ROUTE_CASES) {
      reset({
        scenario: 'paid claims',
        cityCreditBalances: new Map([[7, 1_000_000n]]),
      })
      const requestBody = JSON.stringify(creditCase.body)
      const headers = {
        ...authHeaders(),
        'X-1F3D9-FEE-CREDIT': creditCase.requestId,
      }
      const first = await app.request(creditCase.path, {
        method: 'POST', headers, body: requestBody,
      })
      assert.equal(first.status, creditCase.status, `${creditCase.label}: ${await first.clone().text()}`)
      assertCityCreditNoStore(first, `${creditCase.label} success`)
      const firstText = await first.text()
      const firstBody = JSON.parse(firstText) as Record<string, unknown>
      assert.ok(firstBody[creditCase.resultKey], creditCase.label)
      assert.deepEqual(firstBody.city_fee_credit, {
        spent_usdc: '1.000000',
        balance_usdc: '0.000000',
      }, creditCase.label)
      assert.equal(Object.hasOwn(firstBody, 'fee_tx'), false, creditCase.label)
      assert.equal(first.headers.get('x-payment-response'), null, creditCase.label)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 0n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
      assert.equal(fixtureState.current.paymentHashes.size, 0, creditCase.label)
      assert.equal(networkCalled('/verify'), false, creditCase.label)
      assert.equal(networkCalled('/settle'), false, creditCase.label)
      const paidWrite = sqlCalls().find(call => /complete_city_credit_attempt/iu.test(call.query ?? ''))
      assert.ok(paidWrite?.query, `${creditCase.label}: missing atomic paid write`)
      const eventStart = paidWrite.query.indexOf('INSERT INTO events')
      const responseStart = paidWrite.query.indexOf('completed_x402_attempt AS', eventStart)
      assert.ok(eventStart >= 0 && responseStart > eventStart, `${creditCase.label}: missing public event boundary`)
      assert.doesNotMatch(
        paidWrite.query.slice(eventStart, responseStart),
        /city_fee_credit|balance_usdc|request_id|source_key/iu,
        `${creditCase.label}: private credit accounting leaked into its public event`,
      )
      const domainWrites = sqlCalls().filter(call =>
        /insert\s+into\s+(?:places|kinds|kind_revisions)|update\s+kinds/iu.test(call.query ?? '')).length

      const replay = await app.request(creditCase.path, {
        method: 'POST', headers, body: requestBody,
      })
      assert.equal(replay.status, creditCase.status, `${creditCase.label}: ${await replay.clone().text()}`)
      assertCityCreditNoStore(replay, `${creditCase.label} replay`)
      assert.equal(await replay.text(), firstText, creditCase.label)
      assert.equal(fixtureState.current.cityCreditBalances.get(7), 0n, creditCase.label)
      assert.equal(fixtureState.current.cityCreditEntries.filter(entry => entry.entry_kind === 'spend').length, 1, creditCase.label)
      assert.equal(sqlCalls().filter(call =>
        /insert\s+into\s+(?:places|kinds|kind_revisions)|update\s+kinds/iu.test(call.query ?? '')).length,
      domainWrites, `${creditCase.label}: replay must not repeat the domain write`)
    }
  })

  test('city fee credit selection rejects insufficient balance, mixed rails, and free interior use before debit', async () => {
    reset({ scenario: 'paid claims' })
    const insufficient = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-1F3D9-FEE-CREDIT': 'wave4-empty-00001' },
      body: JSON.stringify({ parent_id: null, name: 'No Credit Continent', description: '' }),
    })
    assert.equal(insufficient.status, 409, await insufficient.clone().text())
    assertCityCreditNoStore(insufficient, 'insufficient credit')
    assert.match(await insufficient.text(), /insufficient city fee credit/i)
    assert.equal(fixtureState.current.cityCreditEntries.length, 0)
    assert.equal(networkCalled('/verify'), false)
    assert.equal(networkCalled('/settle'), false)

    reset({ scenario: 'paid claims', cityCreditBalances: new Map([[7, 1_000_000n]]) })
    const mixed = await app.request('/api/place', {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'X-PAYMENT': X_PAYMENT,
        'X-1F3D9-FEE-CREDIT': 'wave4-mixed-00001',
      },
      body: JSON.stringify({ parent_id: null, name: 'Mixed Rail Continent', description: '' }),
    })
    assert.equal(mixed.status, 400, await mixed.clone().text())
    assertCityCreditNoStore(mixed, 'mixed payment rails')
    assert.match(await mixed.text(), /choose one payment method/i)
    assert.equal(fixtureState.current.cityCreditEntries.length, 0)
    assert.equal(fixtureState.current.paymentAttempts.size, 0)
    assert.equal(networkCalled('/verify'), false)
    assert.equal(networkCalled('/settle'), false)
    const mixedRefusalWrites = sqlCalls().filter(call =>
      /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? ''))
    assert.equal(mixedRefusalWrites.length, 0, 'payment-rail refusals stay outside anti-loop state')
    const mixedStorageWrites = sqlCalls().filter(call =>
      /\b(?:insert|update|delete)\b/iu.test(call.query ?? '')
        && !/update\s+residents\s+set\s+things_today/iu.test(call.query ?? '')
        && !/insert\s+into\s+resident_refusal_state/iu.test(call.query ?? ''))
    assert.equal(
      mixedStorageWrites.length,
      0,
      `mixed payment rails reached storage: ${mixedStorageWrites[0]?.query?.replace(/\s+/gu, ' ').trim() ?? 'unknown write'}`,
    )

    reset({ cityCreditBalances: new Map([[7, 1_000_000n]]) })
    const freeInterior = await app.request('/api/place', {
      method: 'POST',
      headers: { ...authHeaders(), 'X-1F3D9-FEE-CREDIT': 'wave4-free-000001' },
      body: JSON.stringify({ parent_id: 2, name: 'Free Interior', description: '' }),
    })
    assert.equal(freeInterior.status, 400, await freeInterior.clone().text())
    assertCityCreditNoStore(freeInterior, 'free interior selector')
    assert.match(await freeInterior.text(), /only supported for the paid/i)
    assert.equal(fixtureState.current.cityCreditBalances.get(7), 1_000_000n)
    assert.equal(fixtureState.current.cityCreditEntries.length, 0)
    assert.equal(fixtureState.current.paymentAttempts.size, 0)
  })

  test('verified passive root identity alone selects the private refusal counter', async () => {
    reset()
    const refusal = await app.request('/api/me?unexpected=1', { headers: authHeaders() })
    assert.equal(refusal.status, 400, await refusal.clone().text())
    const write = sqlCalls().find(call =>
      /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? ''))
    assert.deepEqual(write?.params?.slice(0, 2).map(Number), [7, 400])
    assert.match(String(write?.params?.[2] ?? ''), /^[0-9a-f]{64}$/u)

    reset({ authValid: false })
    const unauthorized = await app.request('/api/me?unexpected=1', { headers: authHeaders() })
    assert.equal(unauthorized.status, 401)
    assert.equal(
      sqlCalls().some(call => /insert\s+into\s+resident_refusal_state/iu.test(call.query ?? '')),
      false,
    )
  })
}
