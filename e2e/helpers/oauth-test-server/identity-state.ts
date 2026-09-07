import { sha256 } from '../../../src/core.ts'
import { existingResidentKey, recoveryResidentKey } from './identity-fixtures.ts'

type TestIdentityResident = Readonly<{
  id: number
  handle: string
  secretHash: string
  generation: number
}>

const identityState = {
  residents: new Map<number, TestIdentityResident>([
    [49, { id: 49, handle: 'browser-resident', secretHash: sha256(existingResidentKey), generation: 0 }],
    [50, { id: 50, handle: 'recovery-browser', secretHash: sha256(recoveryResidentKey), generation: 0 }],
  ]),
  recoveryCodes: new Map<string, Readonly<{
    residentId: number
    generation: number
    used: boolean
  }>>(),
}

export { identityState, type TestIdentityResident }
