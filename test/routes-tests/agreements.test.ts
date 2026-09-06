import assert from 'node:assert/strict'
import { getRoutesTestContext } from '../helpers/routes-fixtures/context.ts'


export function registerAgreementsTests(): void {
  const {
    OTHER_SECRET,
    app,
    authHeaders,
    inserted,
    reset,
    setActor,
    sqlCalls,
    test,
  } = getRoutesTestContext()


  test('note and agreement quotas fail atomically without a partial public record', async () => {
    reset({
      scenario: 'quotas', openToNotes: true,
      quota: { things: true, notes: false, agreements: false },
    })
    const note = await app.request('/api/note', {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ place_id: 2, body: 'too many' }),
    })
    assert.equal(note.status, 429)
    assert.deepEqual(await note.json(), {
      error: '50 notes per UTC day; retry after the next UTC day begins',
    })
    assert.equal(inserted('notes'), 0)

    const agreement = await app.request('/api/agreement', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ parties: ['tiny-lantern', 'neighbor'], body: 'we keep the square open' }),
    })
    assert.equal(agreement.status, 429)
    assert.deepEqual(await agreement.json(), {
      error: '5 agreement actions per UTC day; retry after the next UTC day begins',
    })
    assert.equal(inserted('agreements'), 0)
  })

  test('a timer-moved note author receives the engine proximity status instead of a 500', async () => {
    reset({ scenario: 'timer moved note author', currentPlaceId: 3, openToNotes: true })
    const response = await app.request('/api/note', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ place_id: 2, body: 'already gone' }),
    })
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), {
      error: 'you must be standing in place_id 2 to leave a note there; you are standing in place_id 3',
    })
    assert.equal(inserted('notes'), 0)
  })

  test('agreements remain unenforced public text and each party signs for itself', async () => {
    reset({ scenario: 'agreements' })
    const created = await app.request('/api/agreement', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ parties: ['tiny-lantern', 'neighbor'], body: 'we keep the square open' }),
    })
    assert.equal(created.status, 201)
    const createdBody = await created.json() as { agreement: { accession_open: boolean } }
    assert.equal(createdBody.agreement.accession_open, false)

    const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
    assert.equal(signed.status, 200)

    const publicRecord = await app.request('/api/agreements?party=tiny-lantern&open=true')
    assert.equal(publicRecord.status, 200)
    const body = await publicRecord.json() as { agreements: { body: string; signatures: string[]; open: boolean }[] }
    assert.equal(body.agreements[0]?.body, 'we keep the square open')
    assert.deepEqual(body.agreements[0]?.signatures, ['tiny-lantern'])
    assert.equal(body.agreements[0]?.open, true)
  })

  test('a new agreement may explicitly open itself to later accession', async () => {
    reset({ scenario: 'agreements' })

    const created = await app.request('/api/agreement', {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({
        parties: ['tiny-lantern', 'neighbor'],
        body: 'we keep the square open',
        accession_open: true,
      }),
    })

    assert.equal(created.status, 201, await created.clone().text())
    const body = await created.json() as { agreement: { accession_open: boolean } }
    assert.equal(body.agreement.accession_open, true)
    assert.equal(inserted('agreement_accession_openings'), 1)
  })

  test('a later arrival cannot accede until the author explicitly opens the agreement', async () => {
    reset({ scenario: 'agreements', agreementParties: ['neighbor'], agreementAccessionOpen: false })
    setActor(9, 'latecomer')

    const blocked = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
    assert.equal(blocked.status, 403)
    assert.deepEqual(await blocked.json(), {
      error: 'this agreement is closed to later signers; its original author can POST /api/agreement/61/open-accession before this signer retries',
    })
    assert.equal(inserted('agreement_parties'), 0)
    assert.equal(inserted('agreement_signatures'), 0)
  })

  test('a later arrival accedes and signs atomically after author opt-in', async () => {
    reset({
      scenario: 'agreements',
      agreementParties: ['neighbor'],
      agreementAccessionOpen: true,
    })
    setActor(9, 'latecomer')

    const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
    assert.equal(signed.status, 200, await signed.clone().text())
    const body = await signed.json() as { signature: { handle: string; acceded: boolean } }
    assert.equal(body.signature.handle, 'latecomer')
    assert.equal(body.signature.acceded, true)
    // One statement carries both inserts, so this asserts the accession path was
    // taken at all -- whether its WHERE clause suppresses the party row for a
    // named signer is Postgres semantics no fake can decide.
    assert.equal(inserted('agreement_parties'), 1)
    assert.equal(inserted('agreement_signatures'), 1)
  })

  test('a named party signs without acceding', async () => {
    reset({ scenario: 'agreements' })

    const signed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })
    assert.equal(signed.status, 200, await signed.clone().text())
    const body = await signed.json() as { signature: { acceded: boolean } }
    assert.equal(body.signature.acceded, false)
    assert.equal(inserted('agreement_signatures'), 1)
  })

  test('a repeated agreement sign replays the original signature without spending quota', async () => {
    reset({
      scenario: 'agreement replay',
      quota: { things: true, notes: true, agreements: false },
      agreementAcceded: ['tiny-lantern'],
    })

    const replayed = await app.request('/api/agreement/61/sign', { method: 'POST', headers: authHeaders() })

    assert.equal(replayed.status, 200, await replayed.clone().text())
    assert.deepEqual(await replayed.json(), {
      signature: {
        agreement_id: 61,
        handle: 'tiny-lantern',
        acceded: true,
        signed_at: '2026-08-10T23:59:00.000Z',
      },
    })
    assert.equal(inserted('agreement_parties'), 0)
    assert.equal(inserted('agreement_signatures'), 0)
    assert.equal(inserted('events'), 0)
    assert.equal(sqlCalls().some(call => /UPDATE residents SET agreement_actions_today/i.test(call.query ?? '')), false)
  })

  test('only the original author may permanently open an existing agreement to accession', async () => {
    reset({ scenario: 'agreements', agreementCreatorId: 7, agreementAccessionOpen: false })

    setActor(8, 'neighbor')
    const denied = await app.request('/api/agreement/61/open-accession', {
      method: 'POST', headers: authHeaders(OTHER_SECRET),
    })
    assert.equal(denied.status, 403)
    assert.deepEqual(await denied.json(), {
      error: 'only the original author may open this agreement to later signers',
    })
    assert.equal(inserted('agreement_accession_openings'), 0)

    setActor(7, 'tiny-lantern')
    const opened = await app.request('/api/agreement/61/open-accession', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(opened.status, 201, await opened.clone().text())
    const body = await opened.json() as { agreement: { id: number; accession_open: boolean } }
    assert.deepEqual(body.agreement, {
      id: 61,
      accession_open: true,
      opened_at: '2026-08-11T00:00:00.000Z',
    })
    assert.equal(inserted('agreement_accession_openings'), 1)

    const retried = await app.request('/api/agreement/61/open-accession', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(retried.status, 200, await retried.clone().text())
    assert.equal(inserted('agreement_accession_openings'), 1)
  })

  test('opening accession distinguishes missing agreements and exhausted quota', async () => {
    reset({ scenario: 'agreements', agreementExists: false })
    const missing = await app.request('/api/agreement/61/open-accession', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), {
      error: 'agreement_id 61 was not found; re-read GET /api/agreements and use a current agreement_id',
    })

    reset({ scenario: 'agreements', quota: { things: true, notes: true, agreements: false } })
    const capped = await app.request('/api/agreement/61/open-accession', {
      method: 'POST', headers: authHeaders(),
    })
    assert.equal(capped.status, 429)
    assert.deepEqual(await capped.json(), {
      error: '5 agreement actions per UTC day; retry after the next UTC day begins',
    })
    assert.equal(inserted('agreement_accession_openings'), 0)
  })

  test('the public record separates the parties an author named from those who acceded', async () => {
    reset({
      scenario: 'agreements',
      agreementParties: ['neighbor', 'tiny-lantern'],
      agreementAcceded: ['tiny-lantern'],
    })

    const record = await app.request('/api/agreements?party=tiny-lantern')
    assert.equal(record.status, 200)
    const body = await record.json() as {
      agreements: { parties: string[]; acceded: string[]; accession_open: boolean }[]
    }
    assert.deepEqual(body.agreements[0]?.parties, ['neighbor', 'tiny-lantern'])
    assert.deepEqual(body.agreements[0]?.acceded, ['tiny-lantern'])
    assert.equal(body.agreements[0]?.accession_open, false)
  })
}
