// Decision row 74 security fix: a pairing code (oauth-store.ts) binds to the
// credential generation that existed at mint -- its resident's secret_hash
// at that moment -- and every unused code is invalidated in the same
// transaction as a rotation or recovery (identity-store.ts). This proves
// both defenses against the real store, not an injected fake: a code minted
// under a since-replaced key must never redeem, whether or not the
// invalidation transaction is the thing that stopped it.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import test, { mock } from 'node:test'
import { Client, Pool } from 'pg'

const POSTGRES_IMAGE = 'postgres@sha256:7958605b474b3d264a969cb3a123d6aa00ad1e1fe9da8a69984dabb704d93317'
const POSTGRES_DATABASE = 'pairing_integration'
const schemaDdl = await readFile(new URL('../../db/schema.sql', import.meta.url), 'utf8')

let database: Pool | null = null

const sql = async (
  strings: TemplateStringsArray,
  ...values: readonly unknown[]
): Promise<Record<string, unknown>[]> => {
  assert.ok(database, 'the PostgreSQL test client must be connected before either store runs')
  const text = strings.reduce(
    (statement, part, index) => statement + part + (index < values.length ? `$${index + 1}` : ''),
    '',
  )
  const result = await database.query(text, [...values])
  return result.rows as Record<string, unknown>[]
}

mock.module(new URL('../../src/db.ts', import.meta.url).href, { namedExports: { sql } })

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runDocker(args: readonly string[]): string {
  const result = spawnSync('docker', [...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? 'unknown'}`
    throw new Error(`docker ${args[0] ?? ''} failed: ${detail}`)
  }
  return result.stdout.trim()
}

async function startPostgres(): Promise<{ client: Pool; containerName: string }> {
  const containerName = `1f3d9-pairing-test-${process.pid}-${randomBytes(4).toString('hex')}`
  const password = randomBytes(24).toString('hex')

  runDocker([
    'run', '--detach', '--rm', '--name', containerName,
    '--publish', '127.0.0.1::5432',
    '--env', `POSTGRES_PASSWORD=${password}`,
    '--env', `POSTGRES_DB=${POSTGRES_DATABASE}`,
    POSTGRES_IMAGE,
  ])

  try {
    const portOutput = runDocker(['port', containerName, '5432/tcp'])
    const port = Number(portOutput.match(/:(\d+)\s*$/)?.[1])
    assert.ok(Number.isInteger(port) && port > 0, `could not read PostgreSQL port from ${portOutput}`)

    const deadline = Date.now() + 30_000
    let lastError: unknown = null
    const connection = {
      host: '127.0.0.1', port, user: 'postgres', password,
      database: POSTGRES_DATABASE, ssl: false,
    } as const
    while (Date.now() < deadline) {
      const client = new Client(connection)
      try {
        await client.connect()
        await client.end()
        return { client: new Pool(connection), containerName }
      } catch (error) {
        lastError = error
        await client.end().catch(() => undefined)
        await delay(200)
      }
    }
    throw lastError instanceof Error ? lastError : new Error('PostgreSQL did not become ready')
  } catch (error) {
    spawnSync('docker', ['stop', '--time', '0', containerName], { encoding: 'utf8' })
    throw error
  }
}

async function resetDatabase(): Promise<void> {
  assert.ok(database)
  await database.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public')
  await database.query(schemaDdl)
  await database.query(
    `INSERT INTO residents (id, handle, model, secret_hash)
     VALUES (1, 'existing-agent', 'integration-test', $1)`,
    [sha256('resident-key-v1')],
  )
  await database.query('UPDATE resident_id_allocator SET last_id = 1 WHERE singleton')
}

function authorizationRequestInput(label: string) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    clientId: 'postgres-pairing-client',
    clientName: 'PostgreSQL pairing integration test',
    redirectUri: 'https://client.example.test/oauth/callback',
    resource: 'https://city.example.test/mcp/connect',
    scope: 'city:resident',
    state: `${label}-state`,
    codeChallenge: 'A'.repeat(43),
  }
}

async function pairingCodeRow(codeHash: string) {
  assert.ok(database)
  const result = await database.query<{
    secret_hash_at_mint: string
    invalidated_at: string | null
    used_at: string | null
  }>(
    'SELECT secret_hash_at_mint, invalidated_at, used_at FROM pairing_codes WHERE code_hash = $1',
    [codeHash],
  )
  return result.rows[0] ?? null
}

test('pairing codes bind to the credential generation at mint in real PostgreSQL', async t => {
  const postgres = await startPostgres()
  database = postgres.client

  try {
    const identityStore = await import('../../src/identity-store.ts')
    const oauthStore = await import('../../src/oauth-store.ts')

    await t.test('mint records the resident\'s CURRENT secret_hash, not a caller-supplied one', async () => {
      await resetDatabase()
      const codeHash = sha256('mint-records-current-hash')
      const minted = await oauthStore.mintPairingCode({ residentId: 1, codeHash })
      assert.ok(!Number.isNaN(Date.parse(minted.expiresAt)))
      assert.deepEqual(await pairingCodeRow(codeHash), {
        secret_hash_at_mint: sha256('resident-key-v1'),
        invalidated_at: null,
        used_at: null,
      })
    })

    await t.test('peekPairingCodeResident reports the resident without consuming the code', async () => {
      await resetDatabase()
      const codeHash = sha256('peek-does-not-consume')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash })

      assert.deepEqual(await oauthStore.peekPairingCodeResident(codeHash), {
        status: 'valid', handle: 'existing-agent',
      })
      // Peeking twice must be safe -- it never marks the code used.
      assert.deepEqual(await oauthStore.peekPairingCodeResident(codeHash), {
        status: 'valid', handle: 'existing-agent',
      })
      assert.equal((await pairingCodeRow(codeHash))?.used_at, null)

      const request = authorizationRequestInput('peek-then-confirm')
      await oauthStore.createAuthorizationRequest(request)
      assert.deepEqual(
        await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: codeHash,
          authorizationCodeHash: sha256('peek-then-confirm:authorization-code'),
        }),
        { status: 'approved', redirectUri: request.redirectUri, state: request.state },
      )
    })

    await t.test('peekPairingCodeResident rejects unknown, used, and rotation-invalidated codes', async () => {
      await resetDatabase()
      assert.deepEqual(
        await oauthStore.peekPairingCodeResident(sha256('never-minted')),
        { status: 'pairing_code_rejected' },
      )

      const usedCodeHash = sha256('peek-after-use')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash: usedCodeHash })
      const request = authorizationRequestInput('peek-after-use')
      await oauthStore.createAuthorizationRequest(request)
      assert.equal(
        (await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: usedCodeHash,
          authorizationCodeHash: sha256('peek-after-use:authorization-code'),
        })).status,
        'approved',
      )
      assert.deepEqual(
        await oauthStore.peekPairingCodeResident(usedCodeHash),
        { status: 'pairing_code_rejected' },
      )

      const rotatedCodeHash = sha256('peek-after-rotation')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash: rotatedCodeHash })
      const rotationStage = {
        sessionHash: sha256('peek-rot:session'),
        csrfHash: sha256('peek-rot:csrf'),
        residentSecretHash: sha256('resident-key-v1'),
        replacementSecretHash: sha256('resident-key-v2'),
      }
      assert.equal((await identityStore.stageRootRotation(rotationStage)).status, 'staged')
      assert.equal(
        (await identityStore.confirmRootRotation({
          sessionHash: rotationStage.sessionHash,
          csrfHash: rotationStage.csrfHash,
          replacementSecretHash: rotationStage.replacementSecretHash,
          invalidatePairingCodes: true,
        })).status,
        'rotated',
      )
      assert.deepEqual(
        await oauthStore.peekPairingCodeResident(rotatedCodeHash),
        { status: 'pairing_code_rejected' },
      )
    })

    await t.test('a valid, unexpired, unused code redeems and issues an authorization code', async () => {
      await resetDatabase()
      const request = authorizationRequestInput('redeem-valid')
      await oauthStore.createAuthorizationRequest(request)
      const codeHash = sha256('valid-pairing-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash })

      assert.deepEqual(
        await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: codeHash,
          authorizationCodeHash: sha256('redeem-valid:authorization-code'),
        }),
        { status: 'approved', redirectUri: request.redirectUri, state: request.state },
      )
      assert.ok((await pairingCodeRow(codeHash))?.used_at)
    })

    await t.test('rotating the resident key invalidates every unused pairing code for that resident', async () => {
      await resetDatabase()
      const codeHash = sha256('rotation-invalidated-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash })

      const rotationStage = {
        sessionHash: sha256('rot:session'),
        csrfHash: sha256('rot:csrf'),
        residentSecretHash: sha256('resident-key-v1'),
        replacementSecretHash: sha256('resident-key-v2'),
      }
      assert.equal((await identityStore.stageRootRotation(rotationStage)).status, 'staged')
      assert.equal(
        (await identityStore.confirmRootRotation({
          sessionHash: rotationStage.sessionHash,
          csrfHash: rotationStage.csrfHash,
          replacementSecretHash: rotationStage.replacementSecretHash,
          invalidatePairingCodes: true,
        })).status,
        'rotated',
      )

      assert.ok((await pairingCodeRow(codeHash))?.invalidated_at, 'rotation must invalidate the unused code')

      const request = authorizationRequestInput('rotation-redeem-after')
      await oauthStore.createAuthorizationRequest(request)
      assert.deepEqual(
        await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: codeHash,
          authorizationCodeHash: sha256('rotation-redeem-after:should-not-issue'),
        }),
        { status: 'pairing_code_rejected' },
        'a code minted under the pre-rotation key must stop resolving the moment the key rotates',
      )
    })

    await t.test('recovering the resident key invalidates every unused pairing code for that resident', async () => {
      await resetDatabase()
      const rawCodes = Array.from(
        { length: 8 },
        (_, index) => `1f3d9_rc_${sha256(`recovery-seed:${index}`)}`,
      )
      const generated = await identityStore.generateRecoveryCodes({
        residentSecretHash: sha256('resident-key-v1'),
        codeHashes: rawCodes.map(sha256),
      })
      assert.deepEqual(generated && { residentId: generated.residentId, handle: generated.handle }, {
        residentId: 1, handle: 'existing-agent',
      })

      const codeHash = sha256('recovery-invalidated-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash })

      const recoveryStage = {
        sessionHash: sha256('rec:session'),
        csrfHash: sha256('rec:csrf'),
        recoveryCodeHash: sha256(rawCodes[0]!),
        replacementSecretHash: sha256('resident-key-v2'),
      }
      assert.deepEqual(await identityStore.stageRootRecovery(recoveryStage), {
        status: 'staged', handle: 'existing-agent',
      })
      assert.deepEqual(await identityStore.confirmRootRecovery({
        sessionHash: recoveryStage.sessionHash,
        csrfHash: recoveryStage.csrfHash,
        replacementSecretHash: recoveryStage.replacementSecretHash,
        invalidatePairingCodes: true,
      }), { status: 'recovered', residentId: 1, handle: 'existing-agent' })

      assert.ok((await pairingCodeRow(codeHash))?.invalidated_at, 'recovery must invalidate the unused code')

      const request = authorizationRequestInput('recovery-redeem-after')
      await oauthStore.createAuthorizationRequest(request)
      assert.deepEqual(
        await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: codeHash,
          authorizationCodeHash: sha256('recovery-redeem-after:should-not-issue'),
        }),
        { status: 'pairing_code_rejected' },
        'a code minted under the pre-recovery key must stop resolving the moment the key changes',
      )
    })

    await t.test(
      'redemption independently fails closed on a stale secret_hash_at_mint, even if invalidated_at were never set',
      async () => {
        // Belt-and-suspenders proof: simulate a hypothetical future code path
        // that changes a resident's secret_hash without going through
        // confirmRootRotation/confirmRootRecovery (so invalidated_at stays
        // NULL), and prove redemption still fails closed on the generation
        // check alone.
        await resetDatabase()
        const codeHash = sha256('stale-generation-code')
        await oauthStore.mintPairingCode({ residentId: 1, codeHash })
        await database!.query('UPDATE residents SET secret_hash = $1 WHERE id = 1', [sha256('resident-key-v2')])
        assert.equal((await pairingCodeRow(codeHash))?.invalidated_at, null)

        const request = authorizationRequestInput('stale-generation-redeem')
        await oauthStore.createAuthorizationRequest(request)
        assert.deepEqual(
          await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
            sessionHash: request.sessionHash,
            csrfHash: request.csrfHash,
            pairingCodeHash: codeHash,
            authorizationCodeHash: sha256('stale-generation-redeem:should-not-issue'),
          }),
          { status: 'pairing_code_rejected' },
        )
      },
    )

    await t.test('rotation invalidates only the rotated resident\'s own pairing codes', async () => {
      await resetDatabase()
      await database!.query(
        `INSERT INTO residents (id, handle, model, secret_hash)
         VALUES (2, 'other-agent', 'integration-test', $1)`,
        [sha256('other-resident-key')],
      )
      await database!.query('UPDATE resident_id_allocator SET last_id = 2 WHERE singleton')

      const ownCodeHash = sha256('own-code')
      const otherCodeHash = sha256('other-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash: ownCodeHash })
      await oauthStore.mintPairingCode({ residentId: 2, codeHash: otherCodeHash })

      const rotationStage = {
        sessionHash: sha256('multi-rot:session'),
        csrfHash: sha256('multi-rot:csrf'),
        residentSecretHash: sha256('resident-key-v1'),
        replacementSecretHash: sha256('resident-key-v2'),
      }
      assert.equal((await identityStore.stageRootRotation(rotationStage)).status, 'staged')
      assert.equal(
        (await identityStore.confirmRootRotation({
          sessionHash: rotationStage.sessionHash,
          csrfHash: rotationStage.csrfHash,
          replacementSecretHash: rotationStage.replacementSecretHash,
          invalidatePairingCodes: true,
        })).status,
        'rotated',
      )

      assert.ok((await pairingCodeRow(ownCodeHash))?.invalidated_at)
      assert.equal((await pairingCodeRow(otherCodeHash))?.invalidated_at, null)
    })

    await t.test('a used code is never re-invalidated and an expired code is left for its own cleanup', async () => {
      await resetDatabase()
      const expiredCodeHash = sha256('recently-expired-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash: expiredCodeHash })
      await database!.query(
        "UPDATE pairing_codes SET expires_at = now() - interval '1 minute' WHERE code_hash = $1",
        [expiredCodeHash],
      )
      assert.deepEqual(
        await oauthStore.peekPairingCodeResident(expiredCodeHash),
        { status: 'pairing_code_rejected' },
        'the real PostgreSQL expiry predicate must reject a row whose expiry is in the past',
      )

      const request = authorizationRequestInput('already-used')
      await oauthStore.createAuthorizationRequest(request)
      const usedCodeHash = sha256('already-used-code')
      await oauthStore.mintPairingCode({ residentId: 1, codeHash: usedCodeHash })
      assert.deepEqual(
        (await oauthStore.approveExistingResidentByPairingCodeAndIssueAuthorizationCode({
          sessionHash: request.sessionHash,
          csrfHash: request.csrfHash,
          pairingCodeHash: usedCodeHash,
          authorizationCodeHash: sha256('already-used:authorization-code'),
        })).status,
        'approved',
      )
      const usedBefore = await pairingCodeRow(usedCodeHash)
      assert.ok(usedBefore?.used_at)
      assert.equal(usedBefore?.invalidated_at, null)

      const rotationStage = {
        sessionHash: sha256('post-use-rot:session'),
        csrfHash: sha256('post-use-rot:csrf'),
        residentSecretHash: sha256('resident-key-v1'),
        replacementSecretHash: sha256('resident-key-v2'),
      }
      assert.equal((await identityStore.stageRootRotation(rotationStage)).status, 'staged')
      assert.equal(
        (await identityStore.confirmRootRotation({
          sessionHash: rotationStage.sessionHash,
          csrfHash: rotationStage.csrfHash,
          replacementSecretHash: rotationStage.replacementSecretHash,
          invalidatePairingCodes: true,
        })).status,
        'rotated',
      )

      const usedAfter = await pairingCodeRow(usedCodeHash)
      assert.deepEqual(usedAfter, usedBefore, 'an already-used code is never touched by rotation invalidation')
      assert.deepEqual(await pairingCodeRow(expiredCodeHash), {
        secret_hash_at_mint: sha256('resident-key-v1'),
        invalidated_at: null,
        used_at: null,
      }, 'a recently expired code is left for its own cleanup')
    })
  } finally {
    database = null
    await postgres.client.end().catch(() => undefined)
    spawnSync('docker', ['stop', '--time', '0', postgres.containerName], { encoding: 'utf8' })
  }
})
