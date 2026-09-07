import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { WorldTestContext } from '../../helpers/world-postgres-fixtures/harness.ts'

export async function registerAgreementTests(
  t: TestContext,
  {
    app, bearer, database, neighborSecret, postgresCode, resetDatabase, seedAgreement,
    founderSecret,
  }: Pick<WorldTestContext,
    | 'app' | 'bearer' | 'database' | 'neighborSecret' | 'postgresCode' | 'resetDatabase'
    | 'seedAgreement' | 'founderSecret'
  > ,
  runConcurrentAccessionTest: () => Promise<void>,
): Promise<void> {
  await t.test('an existing agreement stays closed until its creator opts in', async () => {
    await resetDatabase()
    const agreementId = await seedAgreement()

    const closedSign = await app.request(`/api/agreement/${agreementId}/sign`, {
      method: 'POST',
      headers: bearer(neighborSecret),
    })
    assert.equal(closedSign.status, 403)

    const state = await database!.query(`
        SELECT
          EXISTS(SELECT 1 FROM agreement_accession_openings WHERE agreement_id = $1) AS opened,
          EXISTS(SELECT 1 FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 2) AS joined,
          EXISTS(SELECT 1 FROM agreement_signatures WHERE agreement_id = $1 AND resident_id = 2) AS signed,
          (SELECT agreement_actions_today FROM residents WHERE id = 2) AS quota
      `, [agreementId])
    assert.deepEqual(state.rows, [{ opened: false, joined: false, signed: false, quota: 0 }])

    await assert.rejects(
      database!.query(`
          INSERT INTO agreement_accession_openings (agreement_id, opened_by_id)
          VALUES ($1, 2)
        `, [agreementId]),
      error => postgresCode(error) === '23503',
    )

    const unauthorizedOpen = await app.request(`/api/agreement/${agreementId}/open-accession`, {
      method: 'POST',
      headers: bearer(neighborSecret),
    })
    assert.equal(unauthorizedOpen.status, 403)

    const opened = await app.request(`/api/agreement/${agreementId}/open-accession`, {
      method: 'POST',
      headers: bearer(founderSecret),
    })
    assert.equal(opened.status, 201)
    assert.equal((await opened.json() as { agreement: { accession_open: boolean } }).agreement.accession_open, true)
  })

  await t.test('an accession opening and named-party provenance are append-only', async () => {
    await resetDatabase()
    const agreementId = await seedAgreement({ accessionOpen: true })

    const named = await database!.query(`
        SELECT named FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 1
      `, [agreementId])
    assert.deepEqual(named.rows, [{ named: true }])

    await assert.rejects(
      database!.query(`
          UPDATE agreement_parties SET named = false
          WHERE agreement_id = $1 AND resident_id = 1
        `, [agreementId]),
      error => postgresCode(error) === '55000',
    )

    await assert.rejects(
      database!.query(`
          UPDATE agreement_accession_openings SET opened_at = opened_at + interval '1 second'
          WHERE agreement_id = $1
        `, [agreementId]),
      error => postgresCode(error) === '55000',
    )
    await assert.rejects(
      database!.query('DELETE FROM agreement_accession_openings WHERE agreement_id = $1', [agreementId]),
      error => postgresCode(error) === '55000',
    )

    const opening = await database!.query(`
        SELECT agreement_id, opened_by_id FROM agreement_accession_openings WHERE agreement_id = $1
      `, [agreementId])
    assert.deepEqual(opening.rows, [{ agreement_id: agreementId, opened_by_id: 1 }])
  })


  await runConcurrentAccessionTest()
  await t.test('a rejected accession leaves no partial party or signature', async () => {
    await resetDatabase()
    const agreementId = await seedAgreement({ accessionOpen: true })
    await database!.query('UPDATE residents SET agreement_actions_today = 5 WHERE id = 2')

    const response = await app.request(`/api/agreement/${agreementId}/sign`, {
      method: 'POST',
      headers: bearer(neighborSecret),
    })
    assert.equal(response.status, 429)

    const state = await database!.query(`
        SELECT
          EXISTS(SELECT 1 FROM agreement_parties WHERE agreement_id = $1 AND resident_id = 2) AS joined,
          EXISTS(SELECT 1 FROM agreement_signatures WHERE agreement_id = $1 AND resident_id = 2) AS signed,
          (SELECT agreement_actions_today FROM residents WHERE id = 2) AS quota
      `, [agreementId])
    assert.deepEqual(state.rows, [{ joined: false, signed: false, quota: 5 }])
  })
}
