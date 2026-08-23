import { randomBytes } from 'node:crypto'

const RECOVERY_CODE_COUNT = 8
const RECOVERY_CODE_PREFIX = '1f3d9_rc_'

export type RecoveryCodeSet = readonly [
  string, string, string, string, string, string, string, string,
]

function newRecoveryCode(): string {
  return RECOVERY_CODE_PREFIX + randomBytes(32).toString('hex')
}

export function collectRecoveryCodeSet(makeCode: () => string): RecoveryCodeSet {
  const codes = new Set<string>()
  for (let attempt = 0; codes.size < RECOVERY_CODE_COUNT; attempt += 1) {
    if (attempt >= 64) throw new Error('secure recovery-code generation failed')
    codes.add(makeCode())
  }
  const values = [...codes]
  return [
    values[0]!, values[1]!, values[2]!, values[3]!,
    values[4]!, values[5]!, values[6]!, values[7]!,
  ]
}

export function newRecoveryCodeSet(): RecoveryCodeSet {
  return collectRecoveryCodeSet(newRecoveryCode)
}
