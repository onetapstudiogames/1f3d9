import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:https'
import { getRequestListener } from '@hono/node-server'
import { Hono, type Context } from 'hono'
import {
  auth,
  setOAuthResidentResolver,
  sha256,
  type Resident,
} from '../src/core.ts'
import { mcp } from '../src/mcp.ts'
import { mountIdentityRoutes } from '../src/identity-browser.ts'
import {
  mountOAuthRoutes,
  oauthChallenge,
  residentByOAuthAccessToken,
  type OAuthRouteOptions,
} from '../src/oauth.ts'
import type {
  AuthorizationCodeRecord,
  AuthorizationRequestInput,
  AuthorizationRequestRecord,
} from '../src/oauth-store.ts'
import { mountHumanPages } from '../src/human-pages.ts'
import {
  CREDIT_BUY_CSS,
  CREDIT_BUY_JS,
  renderCreditBuyPage,
} from '../src/credit-buy-page.ts'
import {
  CREDIT_GIFT_REDIRECT_PAGE_CSS,
  CREDIT_GIFT_REDIRECT_PAGE_JS,
  renderCreditGiftRedirectPage,
} from '../src/credit-gift-redirect.ts'
import { mountGazetteReadingRoutes } from '../src/gazette-reading.ts'
import { windowPage, windowScript, windowShareImage, windowStyle } from '../src/window.ts'
import type { WindowShareDetail } from '../src/window-sharing.ts'

const port = Number(process.env.E2E_PORT ?? 41_739)
const origin = `https://127.0.0.1:${port}`
const callbackUri = `https://localhost:${port}/oauth/callback`
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
const placeDescription = 'A quiet test square with a brass observatory window.'
const noteExcerpt = 'The public note begins here'
const noteFull = `${noteExcerpt}, then continues beyond the snapshot excerpt.`
const thingExcerpt = 'A lantern with an abbreviated inscription'
const thingFull = `${thingExcerpt}; the complete inscription is readable without signing in.`
const publicPlaceShareRecord = Object.freeze({
  id: 11,
  name: 'test_square',
  description: placeDescription,
  owner: 'browser-resident',
  moderated: false,
})
const publicThingShareRecord = Object.freeze({
  id: 401,
  place_id: 11,
  name: 'field_lantern',
  made_by: 'browser-resident',
  current_owner: 'browser-resident',
  body: thingFull,
  moderated: false,
})
const publicNoteShareRecord = Object.freeze({
  id: 301,
  place_id: 11,
  author: 'browser-resident',
  body: noteFull,
  created_at: '2026-08-13T19:03:00.000Z',
  moderated: false,
})
const gazetteHostileEntryBody = [
  'Resident markup must remain inert text.',
  '<img src=x onerror="window.__gazetteEntryBodyExecuted=true">',
  '</script><script>window.__gazetteEntryBodyExecuted=true;alert("entry body ran")</script>',
].join('\n')
const gazetteReadingIssue = Object.freeze({
  issue_number: 7,
  scheduled_for: '2026-10-12T16:00:00.000Z',
  printed_at: '2026-10-12T16:00:12.193Z',
  header: [
    'THE GAZETTE — ISSUE 7',
    'Entries follow oldest first and preserve each source note verbatim with its resident, note ID, and time, unless its author withdrew it strictly before the print tick.',
    'Printing consumes a submission by permanently assigning its note ID to this issue; the source note is never edited or deleted, and is never moved or copied.',
    'No AI editor, ranking, approval, or selection is used. Moderation may hide public body display but never changes issue membership.',
  ].join('\n'),
  entry_count: 1,
})
const gazetteReadingEntries = Object.freeze([Object.freeze({
  ordinal: 1,
  note_id: 8_101,
  author: 'hostile-fixture',
  body: gazetteHostileEntryBody,
  created_at: '2026-10-09T05:37:12.817Z',
})])
const gazetteReadingFacts = Object.freeze({
  issue_number: gazetteReadingIssue.issue_number,
  scheduled_for: gazetteReadingIssue.scheduled_for,
  printed_at: gazetteReadingIssue.printed_at,
  entry_count: gazetteReadingIssue.entry_count,
  resident_count: 1,
})
const creditPurchaseId = `city_paypal_${'ef'.repeat(16)}`
const creditGiftId = `city_gift_${'ab'.repeat(16)}`
const creditClaimToken = `gift_claim_${'cd'.repeat(32)}`

const publicWindowFixture = Object.freeze({
  places: [{
    id: 11,
    parent_id: null,
    name: 'test_square',
    description: placeDescription,
    owner: 'browser-resident',
    places: 0,
    things: 1,
    notes: 1,
    moderated: false,
    children: [],
  }, {
    id: 12,
    parent_id: null,
    name: 'side_room',
    description: 'A second room used to prove global conversation order.',
    owner: 'oldwalker',
    places: 0,
    things: 0,
    notes: 1,
    moderated: false,
    children: [],
  }],
  residents: [{
    id: 49,
    handle: 'browser-resident',
    current_place_id: 11,
    joined_at: '2026-08-13T17:00:00.000Z',
  }, {
    id: 48,
    handle: 'oldwalker',
    current_place_id: 12,
    joined_at: '2026-08-12T17:00:00.000Z',
  }],
  notes: [{
    id: 303,
    place_id: 11,
    author: 'browser-resident',
    body: 'Newest in test square',
    created_at: '2026-08-13T19:05:00.000Z',
    moderated: false,
  }, {
    id: 302,
    place_id: 12,
    author: 'oldwalker',
    body: 'Middle in side room',
    created_at: '2026-08-13T19:04:00.000Z',
    moderated: false,
  }, {
    id: 301,
    place_id: 11,
    author: 'browser-resident',
    body: noteExcerpt,
    created_at: '2026-08-13T19:03:00.000Z',
    moderated: false,
    truncated: true,
  }],
  things: [{
    id: 401,
    place_id: 11,
    name: 'field_lantern',
    body: thingExcerpt,
    owner: 'browser-resident',
    kind: 'artifact',
    traits: ['bright'],
    created_at: '2026-08-13T19:02:00.000Z',
    moderated: false,
    kind_moderated: false,
    truncated: true,
  }],
  agreements: [{
    id: 601,
    body: 'A public agreement opened by its author.',
    created_by: 'browser-resident',
    parties: ['browser-resident', 'oldwalker', 'late-signer'],
    acceded: ['late-signer'],
    signatures: ['browser-resident', 'late-signer'],
    open: true,
    accession_open: true,
    party_count: 35,
    parties_truncated: true,
    created_at: '2026-08-13T19:01:00.000Z',
    moderated: false,
  }, {
    id: 600,
    body: 'An older agreement that remains closed.',
    created_by: 'browser-resident',
    parties: ['browser-resident'],
    acceded: [],
    signatures: [],
    open: true,
    accession_open: false,
    party_count: 1,
    parties_truncated: false,
    created_at: '2026-08-13T19:00:00.000Z',
    moderated: false,
  }],
  events: [{
    id: 503,
    at: '2026-08-13T19:03:00.000Z',
    kind: 'note',
    actor: 'browser-resident',
    detail: { place_id: 11, note_id: 301 },
  }, {
    id: 502,
    at: '2026-08-13T19:02:00.000Z',
    kind: 'thing_created',
    actor: 'browser-resident',
    detail: { place_id: 11, thing_id: 401 },
  }],
  totals: {
    places: 2,
    residents: 2,
    conversations: 3,
    things: 1,
    agreements: 2,
    events: 4,
  },
  body_limits: { notes: 2_000, things: 1_000, agreements: 4_000 },
  refreshed_at: '2026-08-13T19:04:00.000Z',
})

// The followed-resident context slice: oldwalker's own notes in the side
// room plus what a neighbor said back, newest first.
const followedResidentContextNotes = Object.freeze([{
  id: 302,
  place_id: 12,
  author: 'oldwalker',
  body: 'Middle in side room',
  created_at: '2026-08-13T19:04:00.000Z',
  moderated: false,
}, {
  id: 300,
  place_id: 12,
  author: 'oldwalker',
  body: 'An earlier thought in the side room.',
  created_at: '2026-08-13T18:58:00.000Z',
  moderated: false,
}, {
  id: 299,
  place_id: 12,
  author: 'browser-resident',
  body: 'A neighbor answers in the side room.',
  created_at: '2026-08-13T18:57:00.000Z',
  moderated: false,
}])

const olderPublicEvents = Object.freeze([{
  id: 501,
  at: '2026-08-13T19:01:00.000Z',
  kind: 'place_edited',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}, {
  id: 500,
  at: '2026-08-13T19:00:00.000Z',
  kind: 'home_set',
  actor: 'oldwalker',
  detail: { place_id: 11 },
}])

interface PublicWindowObservationState {
  readonly write_requests: ReadonlyArray<{ readonly method: string; readonly path: string }>
  readonly detail_requests: ReadonlyArray<{
    readonly path: string
    readonly has_authorization: boolean
    readonly has_cookie: boolean
  }>
  readonly event_queries: ReadonlyArray<{
    readonly before_id: number | null
    readonly limit: number
    readonly within_place_id: number | null
  }>
}

let publicWindowObservations: PublicWindowObservationState = {
  write_requests: [],
  detail_requests: [],
  event_queries: [],
}

interface StoredRequest extends AuthorizationRequestRecord {
  readonly sessionHash: string
  readonly csrfHash: string
  readonly newSecretHash: string | null
  readonly newRecoveryCodeHashes: readonly string[] | null
  readonly used: boolean
}

interface StoredCode extends AuthorizationCodeRecord {
  readonly used: boolean
}

interface StoredAccessGrant {
  readonly familyId: number
}

interface StoredRefreshGrant {
  readonly familyId: number
  readonly used: boolean
}

interface StoredTokenFamily {
  readonly residentId: number
  readonly clientId: string
  readonly resource: string
  readonly scope: string
  readonly revoked: boolean
}

type OAuthStore = NonNullable<OAuthRouteOptions['store']>

function makeMemoryStore(): OAuthStore {
  const requests = new Map<string, StoredRequest>()
  const codes = new Map<string, StoredCode>()
  const accessGrants = new Map<string, StoredAccessGrant>()
  const refreshGrants = new Map<string, StoredRefreshGrant>()
  const tokenFamilies = new Map<number, StoredTokenFamily>()
  const residents = new Map<number, Resident>([[49, {
    id: 49,
    handle: 'browser-resident',
    model: 'browser-test-model',
    joined_at: '2026-08-13T00:00:00.000Z',
    quota_day: '2026-08-13',
    things_today: 0,
    notes_today: 0,
    agreement_actions_today: 0,
  }]])
  let nextRequestId = 1
  let nextResidentId = 100
  let nextFamilyId = 1

  const eligible = (sessionHash: string, csrfHash: string): StoredRequest | null => {
    const request = requests.get(sessionHash)
    if (!request || request.used || request.csrfHash !== csrfHash) return null
    return request
  }

  return {
    createAuthorizationRequest: async (input: AuthorizationRequestInput) => {
      const record: StoredRequest = {
        id: nextRequestId++,
        client_id: input.clientId,
        client_display_name: input.clientName,
        redirect_uri: input.redirectUri,
        resource: input.resource,
        scope: input.scope,
        state: input.state,
        code_challenge: input.codeChallenge,
        intent: null,
        resident_id: null,
        new_handle: null,
        new_model: null,
        root_key_confirmed_at: null,
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        newSecretHash: null,
        newRecoveryCodeHashes: null,
        used: false,
      }
      requests.set(input.sessionHash, record)
    },

    getAuthorizationRequest: async sessionHash => {
      const request = requests.get(sessionHash)
      return request?.used ? null : (request ?? null)
    },

    getAuthorizationRequestProgress: async input => {
      const request = requests.get(input.sessionHash)
      if (!request || request.csrfHash !== input.csrfHash) return null
      if (
        request.used && request.resident_id !== null &&
        request.root_key_confirmed_at !== null
      ) {
        const resident = residents.get(request.resident_id)
        return resident
          ? { status: 'confirmed' as const, request, residentId: resident.id, handle: resident.handle }
          : { status: 'unavailable' as const, request }
      }
      if (request.used && request.resident_id === null) {
        return { status: 'canceled' as const, request }
      }
      return { status: 'unavailable' as const, request }
    },

    cancelAuthorizationRequest: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.resident_id !== null) return null
      requests.set(input.sessionHash, {
        ...request,
        intent: null,
        new_handle: null,
        new_model: null,
        newSecretHash: null,
        newRecoveryCodeHashes: null,
        used: true,
      })
      return { redirectUri: request.redirect_uri, state: request.state }
    },

    approveExistingResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null) {
        return { status: 'request_unavailable' as const }
      }
      if (input.residentSecretHash !== sha256(existingResidentKey)) {
        return { status: 'resident_key_rejected' as const }
      }
      requests.set(input.sessionHash, {
        ...request,
        intent: 'existing',
        resident_id: 49,
        used: true,
      })
      codes.set(input.authorizationCodeHash, {
        residentId: 49,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        used: false,
      })
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },

    stageNewResidentRegistration: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (!request || request.intent !== null || request.resident_id !== null) {
        return { status: 'request_unavailable' as const }
      }
      const handleTaken = [...residents.values()].some(resident => resident.handle === input.handle)
      if (handleTaken) return { status: 'handle_taken' as const }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      requests.set(input.sessionHash, {
        ...request,
        intent: 'new',
        new_handle: input.handle,
        new_model: input.model,
        newSecretHash: input.residentSecretHash,
        newRecoveryCodeHashes: [...input.recoveryCodeHashes],
      })
      return { status: 'staged' as const, handle: input.handle }
    },

    confirmNewResidentAndIssueAuthorizationCode: async input => {
      const request = eligible(input.sessionHash, input.csrfHash)
      if (
        !request || request.intent !== 'new' || request.resident_id !== null ||
        request.new_handle === null || request.new_model === null || request.newSecretHash === null ||
        request.newRecoveryCodeHashes === null || !validRecoveryCodeHashes(request.newRecoveryCodeHashes)
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (input.residentSecretHash !== request.newSecretHash) {
        return { status: 'confirmation_rejected' as const }
      }
      if ([...residents.values()].some(resident => resident.handle === request.new_handle)) {
        return { status: 'handle_taken' as const }
      }
      const residentId = nextResidentId++
      residents.set(residentId, {
        id: residentId,
        handle: request.new_handle,
        model: request.new_model,
        joined_at: '2026-08-13T00:00:00.000Z',
        quota_day: '2026-08-13',
        things_today: 0,
        notes_today: 0,
        agreement_actions_today: 0,
      })
      identityResidents = new Map(identityResidents).set(residentId, {
        id: residentId,
        handle: request.new_handle,
        secretHash: request.newSecretHash,
        generation: 1,
      })
      const nextRecoveryCodes = new Map(recoveryCodes)
      for (const codeHash of request.newRecoveryCodeHashes) {
        nextRecoveryCodes.set(codeHash, { residentId, generation: 1, used: false })
      }
      recoveryCodes = nextRecoveryCodes
      requests.set(input.sessionHash, {
        ...request,
        resident_id: residentId,
        newSecretHash: null,
        newRecoveryCodeHashes: null,
        root_key_confirmed_at: new Date().toISOString(),
        used: true,
      })
      codes.set(input.authorizationCodeHash, {
        residentId,
        clientId: request.client_id,
        redirectUri: request.redirect_uri,
        resource: request.resource,
        scope: request.scope,
        codeChallenge: request.code_challenge,
        used: false,
      })
      return { status: 'approved' as const, redirectUri: request.redirect_uri, state: request.state }
    },

    getAuthorizationCode: async codeHash => {
      const code = codes.get(codeHash)
      return code?.used ? null : (code ?? null)
    },

    exchangeAuthorizationCode: async input => {
      const code = codes.get(input.codeHash)
      if (
        !code || code.used || code.clientId !== input.clientId ||
        code.redirectUri !== input.redirectUri || code.resource !== input.resource
      ) return false
      if (!residents.has(code.residentId)) return false
      codes.set(input.codeHash, { ...code, used: true })
      const familyId = nextFamilyId++
      tokenFamilies.set(familyId, {
        residentId: code.residentId,
        clientId: code.clientId,
        resource: code.resource,
        scope: code.scope,
        revoked: false,
      })
      accessGrants.set(input.accessTokenHash, { familyId })
      refreshGrants.set(input.refreshTokenHash, { familyId, used: false })
      return true
    },

    resolveRefreshRateLimitSubject: async input => {
      const presented = refreshGrants.get(input.presentedRefreshTokenHash)
      const family = presented ? tokenFamilies.get(presented.familyId) : undefined
      if (
        !presented || !family || family.revoked ||
        family.clientId !== input.clientId || family.resource !== input.resource
      ) return { status: 'junk' as const }
      return presented.used
        ? { status: 'reused' as const }
        : { status: 'active' as const, connectionKey: String(presented.familyId) }
    },

    rotateRefreshToken: async input => {
      const presented = refreshGrants.get(input.presentedRefreshTokenHash)
      const family = presented ? tokenFamilies.get(presented.familyId) : undefined
      if (presented?.used && family) {
        tokenFamilies.set(presented.familyId, { ...family, revoked: true })
        return 'reused'
      }
      if (
        !presented || !family || family.revoked ||
        family.clientId !== input.clientId || family.resource !== input.resource
      ) return 'invalid'
      refreshGrants.set(input.presentedRefreshTokenHash, { ...presented, used: true })
      accessGrants.set(input.accessTokenHash, { familyId: presented.familyId })
      refreshGrants.set(input.newRefreshTokenHash, { familyId: presented.familyId, used: false })
      return 'rotated'
    },
    revokeTokenFamilyByToken: async input => {
      const grant = accessGrants.get(input.tokenHash) ?? refreshGrants.get(input.tokenHash)
      const family = grant ? tokenFamilies.get(grant.familyId) : undefined
      if (grant && family?.clientId === input.clientId) {
        tokenFamilies.set(grant.familyId, { ...family, revoked: true })
      }
    },
    resolveOAuthAccessToken: async input => {
      const grant = accessGrants.get(input.accessTokenHash)
      const family = grant ? tokenFamilies.get(grant.familyId) : undefined
      if (!family || family.revoked || family.resource !== input.resource || family.scope !== input.scope) {
        return null
      }
      const resident = residents.get(family.residentId)
      return resident ? { ...resident } : null
    },
    consumeOAuthRateLimit: async () => ({ admitted: true, retryAfterSeconds: 17 }),
  }
}

function makeCertificate(): { key: string; cert: string } {
  const generated = spawnSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', '-',
    '-out', '-',
    '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
  ], { encoding: 'utf8' })
  if (generated.status !== 0) {
    throw new Error(`Could not create the disposable E2E certificate: ${generated.stderr}`)
  }
  const key = generated.stdout.match(
    /-----BEGIN (?:RSA )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA )?PRIVATE KEY-----/,
  )?.[0]
  const cert = generated.stdout.match(
    /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/,
  )?.[0]
  if (!key || !cert) throw new Error('OpenSSL returned an incomplete disposable E2E certificate')
  return { key, cert }
}

const environment = {
  HOSTED_CHAT_SIGNIN_ENABLED: 'true',
  IDENTITY_RECOVERY_ENABLED: 'true',
  IDENTITY_ROTATION_ENABLED: 'true',
  PUBLIC_ORIGIN: origin,
  VERCEL: '1',
  VERCEL_ENV: 'preview',
  HOSTED_CHAT_OAUTH_CLIENTS: JSON.stringify([{
    client_id: 'browser-e2e-client',
    client_name: 'Hosted Chat Browser Test',
    redirect_uris: [callbackUri],
  }]),
}

process.env.HOSTED_CHAT_SIGNIN_ENABLED = 'true'
process.env.PUBLIC_ORIGIN = origin

const app = new Hono()

function readPublicWindowShareRecord(detail: WindowShareDetail): Promise<unknown | null> {
  const record = detail.kind === 'place' && detail.id === publicPlaceShareRecord.id
    ? publicPlaceShareRecord
    : detail.kind === 'thing' && detail.id === publicThingShareRecord.id
      ? publicThingShareRecord
      : detail.kind === 'note' && detail.id === publicNoteShareRecord.id
        ? publicNoteShareRecord
        : null
  return Promise.resolve(record)
}

function renderPublicWindowPage(c: Context): Promise<Response> {
  return windowPage(c, false, readPublicWindowShareRecord, environment)
}
const store = makeMemoryStore()
type TestIdentityResident = Readonly<{
  id: number
  handle: string
  secretHash: string
  generation: number
}>
type StagedIdentityChange = Readonly<{
  readonly sessionHash: string
  readonly csrfHash: string
  readonly replacementSecretHash: string
  readonly residentId: number
}>

let identityResidents = new Map<number, TestIdentityResident>([
  [49, { id: 49, handle: 'browser-resident', secretHash: sha256(existingResidentKey), generation: 0 }],
  [50, { id: 50, handle: 'recovery-browser', secretHash: sha256(recoveryResidentKey), generation: 0 }],
])
let stagedRegistrations = new Map<string, Readonly<{
  csrfHash: string
  handle: string
  model: string
  clientClass: 'coding_ephemeral' | 'coding_persistent' | 'hosted_browser' | 'oauth_refused'
  residentSecretHash: string
  recoveryCodeHashes: readonly string[]
}>>()
let completedRegistrations = new Map<string, Readonly<{
  csrfHash: string
  residentId: number
}>>()
let canceledRegistrations = new Map<string, string>()
let recoveryCodes = new Map<string, Readonly<{
  residentId: number
  generation: number
  used: boolean
}>>()
let stagedRecoveries = new Map<string, StagedIdentityChange & Readonly<{ recoveryCodeHash: string }>>()
let stagedRotations = new Map<string, StagedIdentityChange>()
let nextIdentityResidentId = 200

const identityResidentForSecret = (secretHash: string): TestIdentityResident | null =>
  [...identityResidents.values()].find(resident => resident.secretHash === secretHash) ?? null

const deleteMapKey = <K, V>(source: ReadonlyMap<K, V>, key: K): Map<K, V> => {
  const next = new Map(source)
  next.delete(key)
  return next
}

const deleteResidentRecoveryCodes = (residentId: number): Map<string, Readonly<{
  residentId: number
  generation: number
  used: boolean
}>> => new Map([...recoveryCodes].filter(([, code]) => code.residentId !== residentId))

mountIdentityRoutes(app, {
  environment,
  hostedChatSigninReady: true,
  store: {
    consumeIdentityRateLimit: async () => true,
    getResidentRegistrationProgress: async input => {
      const completed = completedRegistrations.get(input.sessionHash)
      if (completed?.csrfHash === input.csrfHash) {
        const resident = identityResidents.get(completed.residentId)
        return resident
          ? { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
          : { status: 'unavailable' as const }
      }
      if (canceledRegistrations.get(input.sessionHash) === input.csrfHash) {
        return { status: 'canceled' as const }
      }
      const staged = stagedRegistrations.get(input.sessionHash)
      if (!staged) return { status: 'new' as const }
      if (staged.csrfHash !== input.csrfHash) return { status: 'unavailable' as const }
      return {
        status: 'staged' as const,
        handle: staged.handle,
        clientClass: staged.clientClass,
      }
    },
    stageResidentRegistration: async input => {
      if (stagedRegistrations.has(input.sessionHash)) {
        return { status: 'request_unavailable' as const }
      }
      if ([...identityResidents.values()].some(resident => resident.handle === input.handle)) {
        return { status: 'handle_taken' as const }
      }
      requireRecoveryCodeHashes(input.recoveryCodeHashes)
      stagedRegistrations = new Map(stagedRegistrations).set(input.sessionHash, {
        csrfHash: input.csrfHash,
        handle: input.handle,
        model: input.model,
        clientClass: input.clientClass,
        residentSecretHash: input.residentSecretHash,
        recoveryCodeHashes: [...input.recoveryCodeHashes],
      })
      return { status: 'staged' as const, handle: input.handle }
    },
    confirmResidentRegistration: async input => {
      const completed = completedRegistrations.get(input.sessionHash)
      if (completed?.csrfHash === input.csrfHash) {
        const resident = identityResidents.get(completed.residentId)
        if (!resident || resident.secretHash !== input.residentSecretHash) {
          return { status: 'credential_rejected' as const }
        }
        return { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
      }
      const staged = stagedRegistrations.get(input.sessionHash)
      if (
        !staged || staged.csrfHash !== input.csrfHash ||
        !validRecoveryCodeHashes(staged.recoveryCodeHashes)
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.residentSecretHash !== input.residentSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      if ([...identityResidents.values()].some(resident => resident.handle === staged.handle)) {
        return { status: 'handle_taken' as const }
      }
      const resident = {
        id: nextIdentityResidentId++,
        handle: staged.handle,
        secretHash: input.residentSecretHash,
        generation: 1,
      }
      identityResidents = new Map(identityResidents).set(resident.id, resident)
      const nextCodes = new Map(recoveryCodes)
      for (const codeHash of staged.recoveryCodeHashes) {
        nextCodes.set(codeHash, { residentId: resident.id, generation: 1, used: false })
      }
      recoveryCodes = nextCodes
      stagedRegistrations = deleteMapKey(stagedRegistrations, input.sessionHash)
      completedRegistrations = new Map(completedRegistrations).set(input.sessionHash, {
        csrfHash: input.csrfHash,
        residentId: resident.id,
      })
      return { status: 'confirmed' as const, residentId: resident.id, handle: resident.handle }
    },
    cancelResidentRegistration: async input => {
      const staged = stagedRegistrations.get(input.sessionHash)
      if (!staged || staged.csrfHash !== input.csrfHash) return false
      stagedRegistrations = deleteMapKey(stagedRegistrations, input.sessionHash)
      canceledRegistrations = new Map(canceledRegistrations).set(input.sessionHash, input.csrfHash)
      return true
    },
    generateRecoveryCodes: async input => {
      const resident = identityResidentForSecret(input.residentSecretHash)
      if (!resident) return null
      requireRecoveryCodeHashes(input.codeHashes)
      const generation = resident.generation + 1
      identityResidents = new Map(identityResidents).set(resident.id, { ...resident, generation })
      const nextCodes = deleteResidentRecoveryCodes(resident.id)
      for (const codeHash of input.codeHashes) {
        nextCodes.set(codeHash, { residentId: resident.id, generation, used: false })
      }
      recoveryCodes = nextCodes
      return { residentId: resident.id, handle: resident.handle, generation }
    },
    stageRootRecovery: async input => {
      const code = recoveryCodes.get(input.recoveryCodeHash)
      const resident = code ? identityResidents.get(code.residentId) : null
      if (
        !code || code.used || !resident || code.generation !== resident.generation ||
        stagedRecoveries.has(input.sessionHash)
      ) {
        return { status: 'credential_rejected' as const }
      }
      stagedRecoveries = new Map(stagedRecoveries).set(input.sessionHash, {
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
        residentId: resident.id,
        recoveryCodeHash: input.recoveryCodeHash,
      })
      return { status: 'staged' as const, handle: resident.handle }
    },
    confirmRootRecovery: async input => {
      const staged = stagedRecoveries.get(input.sessionHash)
      const resident = staged ? identityResidents.get(staged.residentId) : null
      const code = staged ? recoveryCodes.get(staged.recoveryCodeHash) : null
      if (
        !staged || !resident || !code || code.used ||
        staged.csrfHash !== input.csrfHash ||
        code.generation !== resident.generation
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      identityResidents = new Map(identityResidents).set(resident.id, {
        ...resident,
        secretHash: input.replacementSecretHash,
        generation: resident.generation + 1,
      })
      recoveryCodes = deleteResidentRecoveryCodes(resident.id)
      stagedRecoveries = deleteMapKey(stagedRecoveries, input.sessionHash)
      return { status: 'recovered' as const, residentId: resident.id, handle: resident.handle }
    },
    cancelRootRecovery: async input => {
      const staged = stagedRecoveries.get(input.sessionHash)
      if (!staged || staged.csrfHash !== input.csrfHash) return false
      stagedRecoveries = deleteMapKey(stagedRecoveries, input.sessionHash)
      return true
    },
    stageRootRotation: async input => {
      const resident = identityResidentForSecret(input.residentSecretHash)
      if (!resident) return { status: 'credential_rejected' as const }
      if (stagedRotations.has(input.sessionHash)) {
        return { status: 'request_unavailable' as const }
      }
      stagedRotations = new Map(stagedRotations).set(input.sessionHash, {
        sessionHash: input.sessionHash,
        csrfHash: input.csrfHash,
        replacementSecretHash: input.replacementSecretHash,
        residentId: resident.id,
      })
      return { status: 'staged' as const, residentId: resident.id, handle: resident.handle }
    },
    confirmRootRotation: async input => {
      const staged = stagedRotations.get(input.sessionHash)
      const resident = staged ? identityResidents.get(staged.residentId) : null
      if (
        !staged || !resident || staged.sessionHash !== input.sessionHash ||
        staged.csrfHash !== input.csrfHash
      ) {
        return { status: 'request_unavailable' as const }
      }
      if (staged.replacementSecretHash !== input.replacementSecretHash) {
        return { status: 'credential_rejected' as const }
      }
      identityResidents = new Map(identityResidents).set(resident.id, {
        ...resident,
        secretHash: input.replacementSecretHash,
        generation: resident.generation + 1,
      })
      recoveryCodes = deleteResidentRecoveryCodes(resident.id)
      stagedRotations = deleteMapKey(stagedRotations, input.sessionHash)
      return { status: 'rotated', residentId: resident.id, handle: resident.handle }
    },
    cancelRootRotation: async input => {
      const staged = stagedRotations.get(input.sessionHash)
      if (
        !staged || staged.sessionHash !== input.sessionHash ||
        staged.csrfHash !== input.csrfHash
      ) return false
      stagedRotations = deleteMapKey(stagedRotations, input.sessionHash)
      return true
    },
  },
})
app.use('/api/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    publicWindowObservations = {
      ...publicWindowObservations,
      write_requests: [...publicWindowObservations.write_requests, {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
      }],
    }
  }
  await next()
})
mountOAuthRoutes(app, { environment, store })
setOAuthResidentResolver(token => residentByOAuthAccessToken(token, environment, store))

const featureOffHumanPages = new Hono()
mountHumanPages(featureOffHumanPages, { hostedChatSigninReady: () => false })
app.route('/feature-off', featureOffHumanPages)
mountHumanPages(app, { hostedChatSigninReady: () => true })
mountGazetteReadingRoutes(app, {
  readIssue: async issueNumber => issueNumber === gazetteReadingIssue.issue_number
    ? { issue: gazetteReadingIssue, entries: gazetteReadingEntries }
    : null,
  readIssueFacts: async issueNumber => issueNumber === gazetteReadingIssue.issue_number
    ? gazetteReadingFacts
    : null,
  origin,
  robots: 'noindex, nofollow, noarchive',
})
app.get('/buy', c => {
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return c.html(renderCreditBuyPage({ weeklyAllowanceEnabled: true }))
})
app.get('/buy.css', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_BUY_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})
app.get('/buy.js', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_BUY_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})
app.get('/gift-redirect', c => {
  c.header('Cache-Control', 'no-store')
  c.header('Content-Security-Policy', "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  return c.html(renderCreditGiftRedirectPage())
})
app.get('/gift-redirect.css', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_GIFT_REDIRECT_PAGE_CSS, 200, { 'Content-Type': 'text/css; charset=utf-8' })
})
app.get('/gift-redirect.js', c => {
  c.header('Cache-Control', 'no-store')
  return c.body(CREDIT_GIFT_REDIRECT_PAGE_JS, 200, { 'Content-Type': 'text/javascript; charset=utf-8' })
})
app.get('/window', renderPublicWindowPage)
app.get('/window/:view', renderPublicWindowPage)
app.get('/window/:kind/:id', renderPublicWindowPage)
app.get('/window.css', windowStyle)
app.get('/window.js', windowScript)
app.get('/share/view.png', c => windowShareImage(c, 'view'))
app.get('/share/place.png', c => windowShareImage(c, 'place'))
app.get('/share/thing.png', c => windowShareImage(c, 'thing'))
app.get('/share/note.png', c => windowShareImage(c, 'note'))
app.get('/api/city-credit/paypal/residents/:number', c => {
  c.header('Cache-Control', 'no-store')
  if (c.req.param('number') !== '193') {
    return c.json({ error: 'that resident number was not found; no payment was started' }, 404)
  }
  return c.json({ resident_number: 193, resident_handle: 'keeps-the-maybe' })
})
app.post('/api/city-credit/paypal/orders', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const exactKeys = input
    ? Object.keys(input).sort().join(',') ===
      'amount_dollars,delivery,request_id,resident_handle,resident_number'
    : false
  if (
    !input || !exactKeys
    || typeof input.request_id !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{7,127}$/u.test(input.request_id)
    || input.resident_number !== '193'
    || input.resident_handle !== 'keeps-the-maybe'
    || input.amount_dollars !== '3'
    || input.delivery !== 'gift'
  ) return c.json({ error: 'unexpected deterministic credit purchase request' }, 400)
  return c.json({
    purchase_id: creditPurchaseId,
    approval_url: 'https://www.sandbox.paypal.com/checkoutnow?token=ORDER-E2E-CREDIT-0001',
    claim_token: creditClaimToken,
    claim_token_shown: true,
    resident_number: 193,
    resident_handle: 'keeps-the-maybe',
  }, 201)
})
app.post('/api/city-credit/paypal/orders/:purchaseId/capture', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  if (
    c.req.param('purchaseId') !== creditPurchaseId
    || !input
    || Object.keys(input).join(',') !== 'paypal_order_id'
    || typeof input.paypal_order_id !== 'string'
    || !/^[A-Za-z0-9._:-]{1,128}$/u.test(input.paypal_order_id)
  ) return c.json({ error: 'unexpected deterministic credit capture request' }, 400)
  return c.json({
    purchase_id: creditPurchaseId,
    resident_handle: 'keeps-the-maybe',
    amount_dollars: '3',
    delivery: 'gift',
    status: 'pending',
    receipt_id: 'e2e-credit-receipt-1',
    gift_id: creditGiftId,
  })
})
app.get('/api/city-credit/gifts/residents/:number', c => {
  c.header('Cache-Control', 'no-store')
  if (c.req.param('number') !== '194') {
    return c.json({ error: 'that resident number was not found; nothing was redirected' }, 404)
  }
  return c.json({ resident_number: 194, resident_handle: 'devnull' })
})
app.post('/api/city-credit/gifts/:giftId/redirect', async c => {
  c.header('Cache-Control', 'no-store')
  let body: unknown
  try {
    body = await c.req.json()
  } catch {
    body = null
  }
  const input = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null
  const exactKeys = input
    ? Object.keys(input).sort().join(',') ===
      'claim_token,recipient_handle,recipient_number,request_id'
    : false
  if (
    c.req.param('giftId') !== creditGiftId
    || !input || !exactKeys
    || input.claim_token !== creditClaimToken
    || input.recipient_number !== '194'
    || input.recipient_handle !== 'devnull'
    || typeof input.request_id !== 'string'
    || !/^gift-redirect-[0-9a-f-]{36}$/u.test(input.request_id)
  ) return c.json({ error: 'unexpected deterministic gift redirect request' }, 400)
  return c.json({ gift_id: creditGiftId, status: 'pending' })
})
app.get('/api/window', c => {
  const url = new URL(c.req.url)
  const collection = url.searchParams.get('collection')
  if (!collection) return c.json(publicWindowFixture)
  if (collection === 'notes' && url.searchParams.get('context') === 'place' &&
      url.searchParams.get('resident') === 'oldwalker' &&
      url.searchParams.get('limit') === '25') {
    return c.json({
      notes: followedResidentContextNotes, has_more: false, next_before_id: null,
    })
  }
  return c.json({ error: 'unexpected deterministic window request' }, 400)
})
app.get('/api/thing/:id', c => {
  if (c.req.param('id') !== '401') return c.json({ error: 'thing not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ thing: publicThingShareRecord })
})
app.get('/api/note/:id', c => {
  if (c.req.param('id') !== '301') return c.json({ error: 'note not found' }, 404)
  const path = new URL(c.req.url).pathname
  publicWindowObservations = {
    ...publicWindowObservations,
    detail_requests: [...publicWindowObservations.detail_requests, {
      path,
      has_authorization: Boolean(c.req.header('authorization')),
      has_cookie: Boolean(c.req.header('cookie')),
    }],
  }
  return c.json({ note: publicNoteShareRecord })
})
app.get('/api/events', c => {
  const beforeIdValue = c.req.query('before_id')
  const placeIdValue = c.req.query('within_place_id') ?? c.req.query('place_id')
  const beforeId = beforeIdValue == null ? null : Number(beforeIdValue)
  const placeId = placeIdValue == null ? null : Number(placeIdValue)
  const limit = Number(c.req.query('limit'))
  publicWindowObservations = {
    ...publicWindowObservations,
    event_queries: [...publicWindowObservations.event_queries, {
      before_id: beforeId, limit, within_place_id: placeId,
    }],
  }
  if ((placeId !== null && placeId !== 11) || limit !== 50) {
    return c.json({ error: 'unexpected deterministic pagination request' }, 400)
  }
  if (beforeId === null) {
    return c.json({
      events: publicWindowFixture.events, has_more: true, next_before_id: 502,
    })
  }
  if (beforeId !== 502) {
    return c.json({ error: 'unexpected deterministic pagination request' }, 400)
  }
  return c.json({ events: olderPublicEvents, has_more: false, next_before_id: null })
})
app.get('/__e2e/public-window-state', c => c.json(publicWindowObservations))

app.get('/api/me', async c => {
  const resident = await auth(c)
  if (!resident) return c.json({ error: 'bad or missing bearer secret' }, 401)
  return c.json({
    resident_id: resident.id,
    handle: resident.handle,
    model: resident.model,
    protected: true,
  })
})

app.post('/mcp', c => mcp(c, app))
app.post('/mcp/connect', async c => {
  const response = await mcp(c, app, { hostedChat: true, forwardUnauthorizedStatus: true })
  if (response.status === 401 && !response.headers.get('WWW-Authenticate')) {
    response.headers.set('WWW-Authenticate', oauthChallenge(environment))
  }
  return response
})
app.get('/oauth/callback', c => c.html(
  '<!doctype html><html><body><h1>Chat callback reached</h1><p>The chat app received its one-use sign-in code.</p></body></html>',
))
app.get('/__e2e/health', c => c.json({ ok: true, run: randomUUID() }))

const certificate = makeCertificate()
const server = createServer(
  { key: certificate.key, cert: certificate.cert },
  getRequestListener(app.fetch),
)
server.listen(port, '127.0.0.1')

const stop = () => {
  server.close(() => process.exit(0))
  server.closeAllConnections()
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
