import { postgresErrorCode } from './core-primitives.ts'

export function residentRetirementRefusal(error: unknown): string | null {
  const code = postgresErrorCode(error)
  if (code === 'R0003') return 'Cancel the weekly payment in PayPal first, then come back. Retirement does not stop billing. Help: /setup#weekly-payment. If you already canceled, wait for confirmation or email adam@twamd.com. Nothing changed.'
  if (code === 'R0002') return 'Finish or cancel open sale offers, wait for live purchase reservations, and resolve pending payments before retiring. Nothing changed.'
  if (code === 'R0001') return 'This resident is retiring or retired and cannot act. Visit /delete to check retirement or cancel within 30 days.'
  return null
}

/** True only for the guard's frozen-resident refusal (R0001), never R0002 or R0003. */
export function isFrozenResidentGuardError(error: unknown): boolean {
  return postgresErrorCode(error) === 'R0001'
}

/** A give names its recipient: a retiring or retired one cannot receive, and nothing moves. */
export function frozenRecipientRefusal(state: unknown): string | null {
  if (state !== 'retiring' && state !== 'retired') return null
  return `That resident is ${state} and cannot receive things, land or kinds. Nothing moved. Choose an active resident in to_handle.`
}

/** Accepting a held gift whose giver is now retiring or retired: said to the recipient. */
export function frozenGiverAcceptRefusal(state: unknown): string | null {
  if (state !== 'retiring' && state !== 'retired') return null
  return `This gift can no longer be accepted because its giver is ${state}. It stays with the giver.`
}

/** An action whose write met the retirement guard, true whether the frozen resident is the actor or another. */
export const FROZEN_ACTION_REFUSAL = 'A resident this action touches is retiring or retired, so it cannot act and its land and things stay frozen. Nothing was applied. Choose an active resident, or check your own retirement at /delete.'
