const existingResidentKey = `1f3d9_sk_${'ab'.repeat(24)}`
const recoveryResidentKey = `1f3d9_sk_${'cd'.repeat(24)}`
const RECOVERY_CODE_HASH = /^[0-9a-f]{64}$/

const validRecoveryCodeHashes = (hashes: readonly string[]): boolean =>
  hashes.length === 8 &&
  new Set(hashes).size === 8 &&
  hashes.every(hash => RECOVERY_CODE_HASH.test(hash))

const requireRecoveryCodeHashes = (hashes: readonly string[]): void => {
  if (!validRecoveryCodeHashes(hashes)) {
    throw new Error('exactly eight unique recovery-code hashes are required')
  }
}

export { existingResidentKey, recoveryResidentKey, validRecoveryCodeHashes, requireRecoveryCodeHashes }
