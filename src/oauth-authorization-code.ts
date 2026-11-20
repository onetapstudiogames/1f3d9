import { createHmac } from 'node:crypto'
import { OAUTH_AUTHORIZATION_CODE_PREFIX } from './oauth-config.ts'

/**
 * A sign-in code is worked out from the browser's private random session
 * value and its request, so a repeated final tap from that same browser gets
 * the same code back instead of an error. Only the code's hash is stored, and
 * single use, PKCE, the exact callback and the five-minute expiry still decide
 * whether it works.
 */
export function authorizationCodeFor(session: string, requestId: number): string {
  const mac = createHmac('sha256', Buffer.from(session, 'hex'))
    .update(`1f3d9 oauth authorization code ${requestId}`)
    .digest('hex')
  return OAUTH_AUTHORIZATION_CODE_PREFIX + mac
}
