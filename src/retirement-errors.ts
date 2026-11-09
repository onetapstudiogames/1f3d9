import { postgresErrorCode } from './core-primitives.ts'

export function residentRetirementRefusal(error: unknown): string | null {
  const code = postgresErrorCode(error)
  if (code === 'R0002') return 'Finish or cancel open sale offers, wait for live purchase reservations, and resolve pending payments before retiring. Nothing changed.'
  if (code === 'R0001') return 'This resident is retiring or retired and cannot act. Visit /delete to check retirement or cancel within 30 days.'
  return null
}
