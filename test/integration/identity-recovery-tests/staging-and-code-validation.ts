import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import type { Pool } from 'pg'
import { IDENTITY_LIMITS } from '../../../src/identity-limits.ts'
import {
  sha256,
  registration,
  type IdentityStore,
} from '../../helpers/identity-recovery-fixtures/credentials.ts'

export async function registerStagingAndCodeValidationTests(
  t: TestContext,
  database: Pool,
  store: IdentityStore,
  resetDatabase: () => Promise<void>,
): Promise<void> {
  await t.test('registration rejects every non-exact, malformed, or duplicate initial-code set', async () => {
    await resetDatabase()
    const valid = registration('invalid-code-set')
    const attempts = [
      { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.slice(0, IDENTITY_LIMITS.recoveryCodeCount - 1) },
      { ...valid, recoveryCodeHashes: [...valid.recoveryCodeHashes, sha256('ninth-code')] },
      { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.map((hash, index) => index === IDENTITY_LIMITS.recoveryCodeCount - 1 ? valid.recoveryCodeHashes[0]! : hash) },
      { ...valid, recoveryCodeHashes: valid.recoveryCodeHashes.map((hash, index) => index === IDENTITY_LIMITS.recoveryCodeCount - 1 ? 'A'.repeat(64) : hash) },
    ]
    for (const attempt of attempts) {
      await assert.rejects(
        store.stageResidentRegistration(attempt),
        new RegExp(`exactly ${IDENTITY_LIMITS.recoveryCodeCount} unique sha256 recovery-code hashes are required`, 'i'),
      )
    }
    assert.equal((await database!.query('SELECT count(*) FROM pending_resident_registrations')).rows[0]!.count, '0')
    assert.equal((await database!.query('SELECT count(*) FROM pending_resident_registration_recovery_codes')).rows[0]!.count, '0')
  })

  await t.test('concurrent duplicate registration staging keeps one resumable credential set', async () => {
    await resetDatabase()
    const first = registration('concurrent-stage:first', 'concurrent-stage')
    const secondCredentials = registration('concurrent-stage:second', 'concurrent-stage')
    const second = {
      ...secondCredentials,
      sessionHash: first.sessionHash,
      csrfHash: first.csrfHash,
      ipHash: first.ipHash,
    }
    const attempts = [first, second] as const

    const results = await Promise.all(
      attempts.map(attempt => store.stageResidentRegistration(attempt)),
    )

    assert.deepEqual(
      results.map(result => result.status).sort(),
      ['request_unavailable', 'staged'],
    )
    const winnerIndex = results.findIndex(result => result.status === 'staged')
    const winner = winnerIndex === 0 ? first : second
    const loser = winnerIndex === 0 ? second : first
    const persisted = await database!.query<{
      handle: string
      model: string
      client_class: string
      secret_hash: string
      pending_codes: string
      code_hashes: string[]
    }>(
      `SELECT pending.handle, pending.model, pending.client_class, pending.secret_hash,
           count(code.*) AS pending_codes,
           array_agg(code.code_hash ORDER BY code.ordinal) AS code_hashes
         FROM pending_resident_registrations pending
         JOIN pending_resident_registration_recovery_codes code
           ON code.registration_session_hash = pending.session_hash
         WHERE pending.session_hash = $1
         GROUP BY pending.handle, pending.model, pending.client_class, pending.secret_hash`,
      [first.sessionHash],
    )

    assert.deepEqual(persisted.rows, [{
      handle: winner.handle,
      model: winner.model,
      client_class: winner.clientClass,
      secret_hash: winner.residentSecretHash,
      pending_codes: String(IDENTITY_LIMITS.recoveryCodeCount),
      code_hashes: winner.recoveryCodeHashes,
    }])
    assert.equal(
      loser.recoveryCodeHashes.some(hash => persisted.rows[0]!.code_hashes.includes(hash)),
      false,
    )
    assert.deepEqual(await store.getResidentRegistrationProgress({
      sessionHash: first.sessionHash,
      csrfHash: first.csrfHash,
    }), {
      status: 'staged', handle: winner.handle, clientClass: winner.clientClass,
    })
  })

  await t.test('recovery-set generation rejects every non-exact, malformed, or duplicate hash set', async () => {
    await resetDatabase()
    const valid = Array.from({ length: IDENTITY_LIMITS.recoveryCodeCount }, (_, index) => sha256(`generated-set:${index}`))
    const attempts = [
      valid.slice(0, IDENTITY_LIMITS.recoveryCodeCount - 1),
      [...valid, sha256('generated-set:ninth')],
      valid.map((hash, index) => index === IDENTITY_LIMITS.recoveryCodeCount - 1 ? valid[0]! : hash),
      valid.map((hash, index) => index === IDENTITY_LIMITS.recoveryCodeCount - 1 ? 'A'.repeat(64) : hash),
    ]
    for (const codeHashes of attempts) {
      await assert.rejects(
        store.generateRecoveryCodes({
          residentSecretHash: sha256('existing-root-key'),
          codeHashes,
        }),
        new RegExp(`exactly ${IDENTITY_LIMITS.recoveryCodeCount} unique sha256 recovery-code hashes are required`, 'i'),
      )
    }
    assert.equal((await database!.query('SELECT count(*) FROM resident_recovery_codes')).rows[0]!.count, '0')
  })
}
