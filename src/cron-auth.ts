import { createHash, timingSafeEqual } from 'node:crypto'

const CRON_SECRET_PATTERN = /^[\x21-\x7e]{32,512}$/u
const MAX_AUTHORIZATION_HEADER_CHARACTERS = 1_024

export type CronAuthorization = 'authorized' | 'unauthorized' | 'unavailable'

function configuredSecret(
  environment: Readonly<Record<string, string | undefined>>,
): string | null {
  const secret = environment.CRON_SECRET
  return secret && CRON_SECRET_PATTERN.test(secret) ? secret : null
}

function bearerValue(authorization: string | undefined): string | null {
  if (!authorization || authorization.length > MAX_AUTHORIZATION_HEADER_CHARACTERS) return null
  return /^Bearer ([^\s]+)$/u.exec(authorization)?.[1] ?? null
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftHash = createHash('sha256').update(left, 'utf8').digest()
  const rightHash = createHash('sha256').update(right, 'utf8').digest()
  return timingSafeEqual(leftHash, rightHash)
}

/** Validate one server-to-server bearer without exposing which credential check failed. */
export function cronBearerAuthorization(
  environment: Readonly<Record<string, string | undefined>>,
  authorization: string | undefined,
): CronAuthorization {
  const expected = configuredSecret(environment)
  if (!expected) return 'unavailable'

  const supplied = bearerValue(authorization)
  const equal = constantTimeEqual(supplied ?? '', expected)
  return supplied !== null && equal ? 'authorized' : 'unauthorized'
}
