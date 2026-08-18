import { sql } from './db.ts'
import { postgresErrorCode, utcToday, type Resident } from './core.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

export type OAuthAttemptKind = 'authorize' | 'resident_key' | 'token' | 'refresh' | 'revoke'

export interface AuthorizationRequestInput {
  sessionHash: string
  csrfHash: string
  clientId: string
  clientName: string
  redirectUri: string
  resource: string
  scope: string
  state: string
  codeChallenge: string
}

export interface AuthorizationRequestRecord {
  id: number
  client_id: string
  client_display_name: string
  redirect_uri: string
  resource: string
  scope: string
  state: string
  code_challenge: string
  intent: 'existing' | 'new' | null
  resident_id: number | null
  new_handle: string | null
  new_model: string | null
  root_key_confirmed_at: string | null
}

export type PendingRegistrationResult =
  | { status: 'staged'; handle: string }
  | { status: 'handle_taken' }

export interface AuthorizationRedirect {
  redirectUri: string
  state: string
}

export interface AuthorizationCodeRecord {
  residentId: number
  clientId: string
  redirectUri: string
  resource: string
  scope: string
  codeChallenge: string
}

export interface TokenPairHashes {
  accessTokenHash: string
  refreshTokenHash: string
}

export interface CodeExchangeInput extends TokenPairHashes {
  codeHash: string
  clientId: string
  redirectUri: string
  resource: string
}

export interface RefreshRotationInput {
  presentedRefreshTokenHash: string
  clientId: string
  resource: string
  accessTokenHash: string
  newRefreshTokenHash: string
}

export type RefreshRotationResult = 'rotated' | 'reused' | 'invalid'

const SHA256_HASH = /^[0-9a-f]{64}$/

// Sign-in records stay readable for incident forensics for this long after the
// last moment they could have authenticated anything, then leave the live
// database. Documented in docs/runbooks/SIGNIN_RETENTION.md; the unit tests
// keep this constant and that document in agreement.
const SIGNIN_RETENTION_WINDOW = '30 days'

// The city has no cron: retention deletion rides every OAuth throttle check in
// bounded batches so one request never does unbounded cleanup work.
const SIGNIN_RETENTION_BATCH = 50

function requireInitialRecoveryCodeHashes(hashes: readonly string[]): void {
  if (
    hashes.length !== 8 ||
    new Set(hashes).size !== 8 ||
    hashes.some(hash => !SHA256_HASH.test(hash))
  ) {
    throw new Error('exactly eight unique sha256 recovery-code hashes are required')
  }
}

export async function createAuthorizationRequest(input: AuthorizationRequestInput): Promise<void> {
  await sql`
    WITH cleared_expired_pending AS (
      UPDATE oauth_authorization_requests
      SET used_at = now(),
          intent = NULL,
          new_handle = NULL,
          new_model = NULL,
          new_secret_hash = NULL,
          verified_at = NULL,
          approved_at = NULL
      WHERE resident_id IS NULL
        AND used_at IS NULL
        AND expires_at <= now()
        AND (
          intent IS NOT NULL OR new_handle IS NOT NULL OR new_model IS NOT NULL
          OR new_secret_hash IS NOT NULL OR verified_at IS NOT NULL OR approved_at IS NOT NULL
        )
      RETURNING id
    ), cleared_expired_codes AS (
      DELETE FROM oauth_authorization_request_recovery_codes code
      USING cleared_expired_pending expired
      WHERE code.request_id = expired.id
      RETURNING code.request_id
    )
    INSERT INTO oauth_authorization_requests (
      session_hash, csrf_hash, client_id, client_display_name, redirect_uri,
      resource, scope, state, code_challenge, code_challenge_method, expires_at
    ) VALUES (
      ${input.sessionHash}, ${input.csrfHash}, ${input.clientId}, ${input.clientName},
      ${input.redirectUri}, ${input.resource}, ${input.scope}, ${input.state},
      ${input.codeChallenge}, 'S256', now() + interval '15 minutes'
    )
  `
}

export async function getAuthorizationRequest(
  sessionHash: string,
): Promise<AuthorizationRequestRecord | null> {
  const rows = (await sql`
    SELECT id, client_id, client_display_name, redirect_uri, resource, scope,
      state, code_challenge, intent, resident_id, new_handle, new_model,
      root_key_confirmed_at
    FROM oauth_authorization_requests
    WHERE session_hash = ${sessionHash}
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `) as AuthorizationRequestRecord[]
  return rows[0] ?? null
}

export async function cancelAuthorizationRequest(input: {
  sessionHash: string
  csrfHash: string
}): Promise<AuthorizationRedirect | null> {
  const rows = (await sql`
    WITH canceled AS MATERIALIZED (
      UPDATE oauth_authorization_requests
      SET used_at = now(),
          intent = NULL,
          new_handle = NULL,
          new_model = NULL,
          new_secret_hash = NULL,
          verified_at = NULL,
          approved_at = NULL
      WHERE session_hash = ${input.sessionHash}
        AND csrf_hash = ${input.csrfHash}
        AND resident_id IS NULL
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING id, redirect_uri, state
    ), scrubbed_pending_codes AS (
      DELETE FROM oauth_authorization_request_recovery_codes code
      USING canceled
      WHERE code.request_id = canceled.id
      RETURNING code.request_id
    )
    SELECT redirect_uri, state FROM canceled
  `) as { redirect_uri: string; state: string }[]
  const redirect = rows[0]
  return redirect ? { redirectUri: redirect.redirect_uri, state: redirect.state } : null
}

export async function approveExistingResidentAndIssueAuthorizationCode(input: {
  sessionHash: string
  csrfHash: string
  residentSecretHash: string
  authorizationCodeHash: string
}): Promise<AuthorizationRedirect | null> {
  const rows = (await sql`
    WITH proven_resident AS MATERIALIZED (
      SELECT id
      FROM residents
      WHERE secret_hash = ${input.residentSecretHash}
    ), consumed_request AS (
      UPDATE oauth_authorization_requests request
      SET intent = 'existing',
          resident_id = resident.id,
          verified_at = now(),
          approved_at = now(),
          used_at = now()
      FROM proven_resident resident
      WHERE request.session_hash = ${input.sessionHash}
        AND request.csrf_hash = ${input.csrfHash}
        AND request.intent IS NULL
        AND request.resident_id IS NULL
        AND request.used_at IS NULL
        AND request.expires_at > now()
      RETURNING request.id, resident.id AS resident_id, request.client_id,
        request.redirect_uri, request.resource, request.scope, request.state,
        request.code_challenge
    ), issued_code AS (
      INSERT INTO oauth_authorization_codes (
        request_id, code_hash, resident_id, client_id, redirect_uri, resource,
        scope, code_challenge, code_challenge_method, expires_at
      )
      SELECT id, ${input.authorizationCodeHash}, resident_id, client_id, redirect_uri,
        resource, scope, code_challenge, 'S256', now() + interval '5 minutes'
      FROM consumed_request
      RETURNING request_id
    )
    SELECT request.redirect_uri, request.state
    FROM consumed_request request
    JOIN issued_code code ON code.request_id = request.id
  `) as { redirect_uri: string; state: string }[]
  const redirect = rows[0]
  return redirect ? { redirectUri: redirect.redirect_uri, state: redirect.state } : null
}

export async function stageNewResidentRegistration(input: {
  sessionHash: string
  csrfHash: string
  handle: string
  model: string
  residentSecretHash: string
  recoveryCodeHashes: string[]
}): Promise<PendingRegistrationResult | null> {
  requireInitialRecoveryCodeHashes(input.recoveryCodeHashes)
  try {
    const rows = (await sql`
      WITH eligible AS MATERIALIZED (
        SELECT id
        FROM oauth_authorization_requests
        WHERE session_hash = ${input.sessionHash}
          AND csrf_hash = ${input.csrfHash}
          AND intent IS NULL
          AND resident_id IS NULL
          AND used_at IS NULL
          AND expires_at > now()
        FOR UPDATE
      ), staged AS MATERIALIZED (
        UPDATE oauth_authorization_requests request
        SET intent = 'new',
            new_handle = ${input.handle},
            new_model = ${input.model},
            new_secret_hash = ${input.residentSecretHash},
            verified_at = now(),
            approved_at = now()
        FROM eligible
        WHERE request.id = eligible.id
          AND NOT EXISTS (
            SELECT 1 FROM residents WHERE handle = ${input.handle}
          )
        RETURNING request.id, request.new_handle AS handle
      ), staged_codes AS (
        INSERT INTO oauth_authorization_request_recovery_codes (
          request_id, ordinal, code_hash
        )
        SELECT staged.id, code.ordinality::smallint, code.code_hash
        FROM staged
        CROSS JOIN unnest(${input.recoveryCodeHashes}::text[])
          WITH ORDINALITY AS code(code_hash, ordinality)
        RETURNING request_id
      )
      SELECT
        EXISTS (SELECT 1 FROM eligible) AS eligible,
        (SELECT handle FROM staged
          WHERE (SELECT count(*) FROM staged_codes) = 8) AS handle
    `) as { eligible: boolean; handle: string | null }[]
    const result = rows[0]
    if (!result?.eligible) return null
    return result.handle
      ? { status: 'staged', handle: result.handle }
      : { status: 'handle_taken' }
  } catch (error) {
    if (postgresErrorCode(error) === '23505') return null
    throw error
  }
}

export async function confirmNewResidentAndIssueAuthorizationCode(input: {
  sessionHash: string
  csrfHash: string
  residentSecretHash: string
  authorizationCodeHash: string
}): Promise<AuthorizationRedirect | null> {
  try {
    // Resident creation and INSERT INTO resident_presence remain one atomic statement.
    const rows = (await sql`
        WITH eligible AS MATERIALIZED (
          SELECT id, client_id, redirect_uri, resource, scope, state,
            code_challenge, new_handle, new_model, new_secret_hash
          FROM oauth_authorization_requests
          WHERE session_hash = ${input.sessionHash}
            AND csrf_hash = ${input.csrfHash}
            AND intent = 'new'
            AND resident_id IS NULL
            AND new_handle IS NOT NULL
            AND new_model IS NOT NULL
            AND new_secret_hash IS NOT NULL
            AND new_secret_hash = ${input.residentSecretHash}
            AND verified_at IS NOT NULL
            AND approved_at IS NOT NULL
            AND root_key_confirmed_at IS NULL
            AND used_at IS NULL
            AND expires_at > now()
          FOR UPDATE
        ), pending_codes AS MATERIALIZED (
          SELECT code.code_hash
          FROM oauth_authorization_request_recovery_codes code
          JOIN eligible ON eligible.id = code.request_id
          ORDER BY code.ordinal
          FOR UPDATE OF code
        ), valid_code_set AS MATERIALIZED (
          SELECT count(*) AS code_count
          FROM pending_codes
          HAVING count(*) = 8 AND count(DISTINCT code_hash) = 8
        ), world_root AS MATERIALIZED (
          SELECT place.id FROM places place
          WHERE place.parent_id IS NULL AND place.owner_id IS NULL
            AND place.place_kind = 'world'
            AND place.name = ${WORLD_ROOT_NAME}
          ORDER BY place.created_at ASC, place.id ASC LIMIT 1
        ), allocated_resident_id AS (
          UPDATE resident_id_allocator
          SET last_id = CASE WHEN last_id = 3 THEN 5 ELSE last_id + 1 END
          WHERE singleton
            AND EXISTS (SELECT 1 FROM eligible)
            AND EXISTS (SELECT 1 FROM valid_code_set)
            AND EXISTS (SELECT 1 FROM world_root)
          RETURNING last_id AS id
        ), new_resident AS (
          INSERT INTO residents (id, handle, model, secret_hash, recovery_generation)
          SELECT allocated.id, eligible.new_handle, eligible.new_model,
            eligible.new_secret_hash, 1
          FROM allocated_resident_id allocated
          CROSS JOIN eligible
          RETURNING id, handle, model
        ), new_presence AS (
          INSERT INTO public.resident_presence (resident_id, current_place_id, home_place_id)
          SELECT resident.id, world_root.id, NULL
          FROM new_resident resident CROSS JOIN world_root
          RETURNING resident_id
        ), inserted_recovery_codes AS (
          INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
          SELECT resident.id, 1, code.code_hash
          FROM new_resident resident
          CROSS JOIN pending_codes code
          RETURNING resident_id
        ), consumed_request AS (
          UPDATE oauth_authorization_requests request
          SET resident_id = resident.id,
              new_secret_hash = NULL,
              root_key_confirmed_at = now(),
              used_at = now()
          FROM eligible
          CROSS JOIN new_resident resident
          WHERE request.id = eligible.id
          RETURNING request.id, resident.id AS resident_id, resident.handle,
            resident.model, request.client_id, request.redirect_uri,
            request.resource, request.scope, request.state, request.code_challenge
        ), scrubbed_pending_codes AS (
          DELETE FROM oauth_authorization_request_recovery_codes code
          USING consumed_request request
          WHERE code.request_id = request.id
          RETURNING code.request_id
        ), new_event AS (
          INSERT INTO events (kind, actor, detail)
          SELECT 'register', handle,
            jsonb_build_object('resident_id', resident_id, 'model', model)
          FROM consumed_request
          RETURNING actor
        ), issued_code AS (
          INSERT INTO oauth_authorization_codes (
            request_id, code_hash, resident_id, client_id, redirect_uri, resource,
            scope, code_challenge, code_challenge_method, expires_at
          )
          SELECT id, ${input.authorizationCodeHash}, resident_id, client_id, redirect_uri,
            resource, scope, code_challenge, 'S256', now() + interval '5 minutes'
          FROM consumed_request
          WHERE EXISTS (
            SELECT 1 FROM new_event WHERE actor = consumed_request.handle
          )
            AND EXISTS (SELECT 1 FROM new_presence)
            AND (SELECT count(*) FROM inserted_recovery_codes) = 8
            AND (SELECT count(*) FROM scrubbed_pending_codes) = 8
          RETURNING request_id
        )
        SELECT request.redirect_uri, request.state
        FROM consumed_request request
        JOIN issued_code code ON code.request_id = request.id
    `) as { redirect_uri: string; state: string }[]
    const redirect = rows[0]
    return redirect ? { redirectUri: redirect.redirect_uri, state: redirect.state } : null
  } catch (error) {
    // A concurrently confirmed registration may win the unique handle race.
    // The single failed SQL statement rolls back its ID allocation and all writes.
    if (postgresErrorCode(error) === '23505') return null
    throw error
  }
}

export async function getAuthorizationCode(codeHash: string): Promise<AuthorizationCodeRecord | null> {
  const rows = (await sql`
    SELECT resident_id, client_id, redirect_uri, resource, scope, code_challenge
    FROM oauth_authorization_codes
    WHERE code_hash = ${codeHash}
      AND used_at IS NULL
      AND expires_at > now()
    LIMIT 1
  `) as {
    resident_id: number
    client_id: string
    redirect_uri: string
    resource: string
    scope: string
    code_challenge: string
  }[]
  const code = rows[0]
  return code ? {
    residentId: code.resident_id,
    clientId: code.client_id,
    redirectUri: code.redirect_uri,
    resource: code.resource,
    scope: code.scope,
    codeChallenge: code.code_challenge,
  } : null
}

export async function exchangeAuthorizationCode(input: CodeExchangeInput): Promise<boolean> {
  const rows = (await sql`
    WITH consumed_code AS (
      UPDATE oauth_authorization_codes
      SET used_at = now()
      WHERE code_hash = ${input.codeHash}
        AND client_id = ${input.clientId}
        AND redirect_uri = ${input.redirectUri}
        AND resource = ${input.resource}
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING resident_id, client_id, resource, scope
    ), new_family AS (
      INSERT INTO oauth_token_families (
        resident_id, client_id, resource, scope, expires_at
      )
      SELECT resident_id, client_id, resource, scope, now() + interval '30 days'
      FROM consumed_code
      RETURNING id
    ), new_access AS (
      INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
      SELECT ${input.accessTokenHash}, 'access', id, now() + interval '10 minutes'
      FROM new_family
      RETURNING id
    ), new_refresh AS (
      INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
      SELECT ${input.refreshTokenHash}, 'refresh', id, now() + interval '30 days'
      FROM new_family
      RETURNING id
    )
    SELECT family.id
    FROM new_family family
    WHERE EXISTS (SELECT 1 FROM new_access) AND EXISTS (SELECT 1 FROM new_refresh)
  `) as { id: number }[]
  return rows.length === 1
}

async function revokeReusedRefreshToken(input: {
  presentedRefreshTokenHash: string
  clientId: string
  resource: string
}): Promise<boolean> {
  const rows = (await sql`
    WITH reused AS MATERIALIZED (
      SELECT family.id
      FROM oauth_tokens token
      JOIN oauth_token_families family ON family.id = token.family_id
      WHERE token.token_hash = ${input.presentedRefreshTokenHash}
        AND token.token_type = 'refresh'
        AND family.client_id = ${input.clientId}
        AND family.resource = ${input.resource}
        AND token.used_at IS NOT NULL
    ), revoked AS (
      UPDATE oauth_token_families family
      SET revoked_at = coalesce(family.revoked_at, now()),
          revoke_reason = coalesce(family.revoke_reason, 'refresh token reuse')
      FROM reused
      WHERE family.id = reused.id
      RETURNING family.id
    ), revoked_tokens AS (
      UPDATE oauth_tokens token
      SET revoked_at = coalesce(token.revoked_at, now())
      FROM revoked
      WHERE token.family_id = revoked.id
      RETURNING token.id
    )
    SELECT id FROM revoked
  `) as { id: number }[]
  return rows.length === 1
}

export async function rotateRefreshToken(input: RefreshRotationInput): Promise<RefreshRotationResult> {
  const rows = (await sql`
    WITH consumed_refresh AS (
      UPDATE oauth_tokens token
      SET used_at = now()
      FROM oauth_token_families family
      WHERE token.family_id = family.id
        AND token.token_hash = ${input.presentedRefreshTokenHash}
        AND token.token_type = 'refresh'
        AND token.used_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
        AND family.client_id = ${input.clientId}
        AND family.resource = ${input.resource}
        AND family.revoked_at IS NULL
        AND family.expires_at > now()
      RETURNING token.id, token.family_id
    ), new_access AS (
      INSERT INTO oauth_tokens (token_hash, token_type, family_id, expires_at)
      SELECT ${input.accessTokenHash}, 'access', consumed.family_id,
        LEAST(now() + interval '10 minutes', family.expires_at)
      FROM consumed_refresh consumed
      JOIN oauth_token_families family ON family.id = consumed.family_id
      RETURNING id
    ), new_refresh AS (
      INSERT INTO oauth_tokens (
        token_hash, token_type, family_id, rotated_from_token_id, expires_at
      )
      SELECT ${input.newRefreshTokenHash}, 'refresh', consumed.family_id, consumed.id,
        family.expires_at
      FROM consumed_refresh consumed
      JOIN oauth_token_families family ON family.id = consumed.family_id
      RETURNING id
    ), shortened_family AS (
      UPDATE oauth_token_families family
      SET expires_at = family.expires_at
      FROM consumed_refresh
      WHERE family.id = consumed_refresh.family_id
      RETURNING family.id
    )
    SELECT id FROM consumed_refresh
    WHERE EXISTS (SELECT 1 FROM new_access)
      AND EXISTS (SELECT 1 FROM new_refresh)
      AND EXISTS (SELECT 1 FROM shortened_family)
  `) as { id: number }[]
  if (rows.length === 1) return 'rotated'
  return (await revokeReusedRefreshToken(input)) ? 'reused' : 'invalid'
}

export async function revokeTokenFamilyByToken(input: {
  tokenHash: string
  clientId: string
}): Promise<void> {
  await sql`
    WITH matching_family AS MATERIALIZED (
      SELECT family.id
      FROM oauth_tokens token
      JOIN oauth_token_families family ON family.id = token.family_id
      WHERE token.token_hash = ${input.tokenHash}
        AND family.client_id = ${input.clientId}
    ), revoked AS (
      UPDATE oauth_token_families family
      SET revoked_at = coalesce(family.revoked_at, now()),
          revoke_reason = coalesce(family.revoke_reason, 'client revocation')
      FROM matching_family
      WHERE family.id = matching_family.id
      RETURNING family.id
    )
    UPDATE oauth_tokens token
    SET revoked_at = coalesce(token.revoked_at, now())
    FROM revoked
    WHERE token.family_id = revoked.id
  `
}

export async function resolveOAuthAccessToken(input: {
  accessTokenHash: string
  resource: string
  scope: string
}): Promise<Resident | null> {
  const rows = (await sql`
    WITH valid_grant AS MATERIALIZED (
      SELECT family.resident_id
      FROM oauth_tokens token
      JOIN oauth_token_families family ON family.id = token.family_id
      WHERE token.token_hash = ${input.accessTokenHash}
        AND token.token_type = 'access'
        AND token.used_at IS NULL
        AND token.revoked_at IS NULL
        AND token.expires_at > now()
        AND family.resource = ${input.resource}
        AND family.scope = ${input.scope}
        AND family.revoked_at IS NULL
        AND family.expires_at > now()
    )
    UPDATE residents resident SET
      things_today = CASE WHEN quota_day = ${utcToday()}::date THEN things_today ELSE 0 END,
      notes_today = CASE WHEN quota_day = ${utcToday()}::date THEN notes_today ELSE 0 END,
      agreement_actions_today = CASE
        WHEN quota_day = ${utcToday()}::date THEN agreement_actions_today ELSE 0
      END,
      quota_day = ${utcToday()}::date
    FROM valid_grant valid_grant_row
    WHERE resident.id = valid_grant_row.resident_id
    RETURNING resident.id, resident.handle, resident.model, resident.joined_at,
      resident.quota_day, resident.things_today, resident.notes_today,
      resident.agreement_actions_today
  `) as Resident[]
  return rows[0] ?? null
}

export async function consumeOAuthRateLimit(input: {
  bucketHash: string
  attemptKind: OAuthAttemptKind
  maximum: number
}): Promise<boolean> {
  // Every OAuth route passes through this throttle, so sign-in retention rides
  // the same statement as the existing rate-limit prune. Each record type is
  // deleted only after SIGNIN_RETENTION_WINDOW past its own expiry, in bounded
  // batches. Order protects the foreign keys: an authorization code goes before
  // the request it references, and every token row of a family goes (newest
  // rotation link first) before the family row itself, which keeps refresh
  // reuse detection intact for the family's whole forensic window.
  const rows = (await sql`
    WITH current_window AS MATERIALIZED (
      SELECT date_trunc('hour', now(), 'UTC') AS window_start
    ), cleanup AS (
      DELETE FROM oauth_rate_limits
      WHERE window_start < (SELECT window_start FROM current_window) - interval '24 hours'
    ), retired_codes AS MATERIALIZED (
      SELECT id
      FROM oauth_authorization_codes
      WHERE expires_at <= now() - ${SIGNIN_RETENTION_WINDOW}::interval
      ORDER BY expires_at, id
      LIMIT ${SIGNIN_RETENTION_BATCH}
    ), pruned_codes AS (
      DELETE FROM oauth_authorization_codes code
      USING retired_codes retired
      WHERE code.id = retired.id
      RETURNING code.id
    ), retired_requests AS MATERIALIZED (
      SELECT request.id
      FROM oauth_authorization_requests request
      WHERE request.expires_at <= now() - ${SIGNIN_RETENTION_WINDOW}::interval
        AND NOT EXISTS (
          SELECT 1 FROM oauth_authorization_codes code
          WHERE code.request_id = request.id
            AND code.id NOT IN (SELECT id FROM retired_codes)
        )
      ORDER BY request.expires_at, request.id
      LIMIT ${SIGNIN_RETENTION_BATCH}
    ), pruned_requests AS (
      DELETE FROM oauth_authorization_requests request
      USING retired_requests retired
      WHERE request.id = retired.id
      RETURNING request.id
    ), retired_tokens AS MATERIALIZED (
      SELECT token.id
      FROM oauth_tokens token
      JOIN oauth_token_families family ON family.id = token.family_id
      WHERE family.expires_at <= now() - ${SIGNIN_RETENTION_WINDOW}::interval
      ORDER BY token.id DESC
      LIMIT ${SIGNIN_RETENTION_BATCH}
    ), pruned_tokens AS (
      DELETE FROM oauth_tokens token
      USING retired_tokens retired
      WHERE token.id = retired.id
      RETURNING token.id
    ), retired_families AS MATERIALIZED (
      SELECT family.id
      FROM oauth_token_families family
      WHERE family.expires_at <= now() - ${SIGNIN_RETENTION_WINDOW}::interval
        AND NOT EXISTS (
          SELECT 1 FROM oauth_tokens token
          WHERE token.family_id = family.id
            AND token.id NOT IN (SELECT id FROM retired_tokens)
        )
      ORDER BY family.expires_at, family.id
      LIMIT ${SIGNIN_RETENTION_BATCH}
    ), pruned_families AS (
      DELETE FROM oauth_token_families family
      USING retired_families retired
      WHERE family.id = retired.id
      RETURNING family.id
    ), admitted AS (
      INSERT INTO oauth_rate_limits (bucket_hash, attempt_kind, window_start, used)
      SELECT ${input.bucketHash}, ${input.attemptKind}, window_start, 1
      FROM current_window
      ON CONFLICT (bucket_hash, attempt_kind, window_start) DO UPDATE
      SET used = oauth_rate_limits.used + 1
      WHERE oauth_rate_limits.used < ${input.maximum}
      RETURNING used
    )
    SELECT used FROM admitted
  `) as { used: number }[]
  return rows.length === 1
}

export const postgresOAuthStore = {
  createAuthorizationRequest,
  getAuthorizationRequest,
  cancelAuthorizationRequest,
  approveExistingResidentAndIssueAuthorizationCode,
  stageNewResidentRegistration,
  confirmNewResidentAndIssueAuthorizationCode,
  getAuthorizationCode,
  exchangeAuthorizationCode,
  rotateRefreshToken,
  revokeTokenFamilyByToken,
  resolveOAuthAccessToken,
  consumeOAuthRateLimit,
} as const
