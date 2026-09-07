import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export type IdentityStore = typeof import('../../../src/identity-store.ts')

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function registration(label: string, handle = 'new-resident') {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    ipHash: sha256(`${label}:ip`),
    handle,
    model: 'postgres-test',
    clientClass: 'coding_ephemeral' as const,
    residentSecretHash: sha256(`${label}:root-key`),
    recoveryCodeHashes: Array.from(
      { length: 8 },
      (_, index) => sha256(`${label}:recovery:${index}`),
    ),
  }
}

export function rotation(
  label: string,
  residentSecret = 'existing-root-key',
  replacementSecret = `${label}:replacement-root-key`,
) {
  return {
    sessionHash: sha256(`${label}:session`),
    csrfHash: sha256(`${label}:csrf`),
    residentSecretHash: sha256(residentSecret),
    replacementSecretHash: sha256(replacementSecret),
  }
}

export async function generateCodes(store: IdentityStore, label: string) {
  const raw = Array.from({ length: 8 }, (_, index) => `1f3d9_rc_${sha256(`${label}:${index}`)}`)
  const result = await store.generateRecoveryCodes({
    residentSecretHash: sha256('existing-root-key'),
    codeHashes: raw.map(sha256),
  })
  assert.deepEqual(result, { residentId: 1, handle: 'existing-agent', generation: 1 })
  return raw
}
