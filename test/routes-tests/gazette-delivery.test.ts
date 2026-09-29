import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'

const GAZETTE_WINDOW = Object.freeze({
  after_change_id: null,
  through_change_id: '12',
  gazette: {
    issue_number: 6,
    scheduled_for: '2026-10-05T16:00:00.000Z',
    printed_at: '2026-10-05T16:02:00.000Z',
    entry_count: 12,
    change_id: '12',
    also_printed: [],
  },
})

export function registerGazetteDeliveryTests(): void {
  const { app, authHeaders, fixtureState, reset, test } = getRoutesTestContext()

  test('/api/me omits the Gazette field when the pinned window has no issue', async () => {
    reset()
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as Record<string, unknown>
    assert.equal(Object.hasOwn(body, 'gazette'), false)
  })

  test('/api/me marks an issue new on a resident first visit', async () => {
    reset({ gazetteWindow: GAZETTE_WINDOW })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as { gazette: { new_issue: boolean } }
    assert.equal(body.gazette.new_issue, true)
  })

  test('/api/me gives a later visit the one-line Gazette summary', async () => {
    reset({
      gazetteWindow: {
        ...GAZETTE_WINDOW,
        after_change_id: '12',
      },
    })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as { gazette: { new_issue: boolean; summary: string } }
    assert.equal(body.gazette.new_issue, false)
    assert.match(body.gazette.summary, /^This week's Gazette is issue 6, printed 2026-10-05 with 12 entries\./u)
    assert.match(body.gazette.summary, /Your first me after each Monday print lists up to 20 of its entries\./u)
  })

  test('/api/me places gazette after since_last_visit without changing its keys', async () => {
    reset({
      attentionLastVisitAt: '2026-09-20T12:00:00.000Z',
      gazetteWindow: GAZETTE_WINDOW,
    })
    const response = await app.request('/api/me', { headers: authHeaders() })
    assert.equal(response.status, 200, await response.clone().text())
    const body = await response.json() as {
      since_last_visit: Record<string, unknown>
    }
    assert.deepEqual(Object.keys(body.since_last_visit), [
      'city_updates', 'tools_changed', 'fee_credit_received', 'around_you', 'last_visit_at',
    ])
    const keys = Object.keys(body as unknown as Record<string, unknown>)
    assert.equal(keys.indexOf('gazette'), keys.indexOf('since_last_visit') + 1)
  })
}
