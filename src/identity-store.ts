import { sql } from './db.ts'
import { postgresErrorCode, postgresErrorConstraint } from './core.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

export type IdentityAttemptKind =
  | 'join_stage'
  | 'join_confirm'
  | 'recovery_generate'
  | 'recovery_begin'
  | 'recovery_confirm'
  | 'rotation_begin'
  | 'rotation_confirm'

export interface RegistrationStageInput {
  sessionHash: string
  csrfHash: string
  ipHash: string
  handle: string
  model: string
  residentSecretHash: string
  recoveryCodeHashes: string[]
}

export type RegistrationStageResult =
  | { status: 'staged'; handle: string }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export interface IdentityResidentResult {
  residentId: number
  handle: string
}

export interface RecoveryGenerationResult extends IdentityResidentResult {
  generation: number
}

export type RegistrationConfirmationResult =
  | ({ status: 'confirmed' } & IdentityResidentResult)
  | { status: 'credential_rejected' }
  | { status: 'handle_taken' }
  | { status: 'request_unavailable' }

export type RecoveryStageResult =
  | { status: 'staged'; handle: string }
  | { status: 'credential_rejected' }

export type RecoveryConfirmationResult =
  | ({ status: 'recovered' } & IdentityResidentResult)
  | { status: 'credential_rejected' }
  | { status: 'request_unavailable' }

export type RotationStageResult =
  | ({ status: 'staged' } & IdentityResidentResult)
  | { status: 'credential_rejected' }
  | { status: 'request_unavailable' }

const SHA256_HASH = /^[0-9a-f]{64}$/

/**
 * PostgreSQL aborts one whole transaction when it breaks a deadlock. Identity
 * confirmation statements are atomic, so the aborted statement is safe to try
 * once more after the competing confirmation has been allowed to finish.
 */
export async function retryIdentityDeadlockOnce<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (postgresErrorCode(error) !== '40P01') throw error
    return operation()
  }
}

function requireRecoveryCodeHashes(hashes: readonly string[]): void {
  if (
    hashes.length !== 8 ||
    new Set(hashes).size !== 8 ||
    hashes.some(hash => !SHA256_HASH.test(hash))
  ) {
    throw new Error('exactly eight unique sha256 recovery-code hashes are required')
  }
}

export async function consumeIdentityRateLimit(input: {
  bucketHash: string
  attemptKind: IdentityAttemptKind
  maximum: number
}): Promise<boolean> {
  const rows = (await sql`
    WITH current_window AS MATERIALIZED (
      SELECT date_trunc('hour', now(), 'UTC') AS window_start
    ), cleanup AS (
      DELETE FROM identity_rate_limits
      WHERE window_start < (SELECT window_start FROM current_window) - interval '24 hours'
    ), admitted AS (
      INSERT INTO identity_rate_limits (bucket_hash, attempt_kind, window_start, used)
      SELECT ${input.bucketHash}, ${input.attemptKind}, window_start, 1
      FROM current_window
      ON CONFLICT (bucket_hash, attempt_kind, window_start) DO UPDATE
      SET used = identity_rate_limits.used + 1
      WHERE identity_rate_limits.used < ${input.maximum}
      RETURNING used
    )
    SELECT used FROM admitted
  `) as { used: number }[]
  return rows.length === 1
}

export async function stageResidentRegistration(
  input: RegistrationStageInput,
): Promise<RegistrationStageResult> {
  requireRecoveryCodeHashes(input.recoveryCodeHashes)
  const rows = (await sql`
      WITH cleared_expired AS MATERIALIZED (
        UPDATE pending_resident_registrations
        SET canceled_at = now(), handle = NULL, model = NULL, secret_hash = NULL,
            ip_hash = NULL
        WHERE confirmed_at IS NULL AND canceled_at IS NULL AND expires_at <= now()
        RETURNING session_hash
      ), cleared_expired_codes AS (
        DELETE FROM pending_resident_registration_recovery_codes code
        USING cleared_expired expired
        WHERE code.registration_session_hash = expired.session_hash
        RETURNING code.registration_session_hash
      ), staged AS MATERIALIZED (
        INSERT INTO pending_resident_registrations (
          session_hash, csrf_hash, ip_hash, handle, model, secret_hash, expires_at
        )
        SELECT ${input.sessionHash}, ${input.csrfHash}, ${input.ipHash}, ${input.handle},
          ${input.model}, ${input.residentSecretHash}, now() + interval '15 minutes'
        WHERE NOT EXISTS (SELECT 1 FROM residents WHERE handle = ${input.handle})
        ON CONFLICT DO NOTHING
        RETURNING session_hash, handle
      ), staged_codes AS (
        INSERT INTO pending_resident_registration_recovery_codes (
          registration_session_hash, ordinal, code_hash
        )
        SELECT staged.session_hash, code.ordinality::smallint, code.code_hash
        FROM staged
        CROSS JOIN unnest(${input.recoveryCodeHashes}::text[])
          WITH ORDINALITY AS code(code_hash, ordinality)
        RETURNING registration_session_hash
      )
      SELECT
        EXISTS (SELECT 1 FROM residents WHERE handle = ${input.handle}) AS handle_taken,
        (SELECT handle FROM staged
          WHERE (SELECT count(*) FROM staged_codes) = 8) AS handle
  `) as { handle_taken: boolean; handle: string | null }[]
  const result = rows[0]
  if (result?.handle) return { status: 'staged', handle: result.handle }
  if (result?.handle_taken) return { status: 'handle_taken' }
  return { status: 'request_unavailable' }
}

export async function confirmResidentRegistration(input: {
  sessionHash: string
  csrfHash: string
  residentSecretHash: string
}): Promise<RegistrationConfirmationResult> {
  try {
    const rows = (await sql`
      WITH active_request AS MATERIALIZED (
        SELECT session_hash, ip_hash, handle, model, secret_hash
        FROM pending_resident_registrations
        WHERE session_hash = ${input.sessionHash}
          AND csrf_hash = ${input.csrfHash}
          AND confirmed_at IS NULL
          AND canceled_at IS NULL
          AND expires_at > now()
        FOR UPDATE
      ), eligible AS MATERIALIZED (
        SELECT session_hash, ip_hash, handle, model, secret_hash
        FROM active_request
        WHERE secret_hash = ${input.residentSecretHash}
      ), handle_conflict AS MATERIALIZED (
        SELECT resident.handle
        FROM residents resident
        JOIN eligible ON eligible.handle = resident.handle
      ), pending_codes AS MATERIALIZED (
        SELECT code.code_hash
        FROM pending_resident_registration_recovery_codes code
        JOIN eligible ON eligible.session_hash = code.registration_session_hash
        ORDER BY code.ordinal
        FOR UPDATE OF code
      ), valid_code_set AS MATERIALIZED (
        SELECT count(*) AS code_count
        FROM pending_codes
        HAVING count(*) = 8 AND count(DISTINCT code_hash) = 8
      ), world_root AS MATERIALIZED (
        SELECT place.id FROM places place
        WHERE place.parent_id IS NULL AND place.owner_id IS NULL
          AND place.place_kind = 'world' AND place.name = ${WORLD_ROOT_NAME}
        ORDER BY place.created_at ASC, place.id ASC LIMIT 1
      ), allocated_resident_id AS (
        UPDATE resident_id_allocator
        SET last_id = CASE WHEN last_id = 3 THEN 5 ELSE last_id + 1 END
        WHERE singleton
          AND EXISTS (SELECT 1 FROM eligible)
          AND EXISTS (SELECT 1 FROM valid_code_set)
          AND EXISTS (SELECT 1 FROM world_root)
          AND NOT EXISTS (SELECT 1 FROM handle_conflict)
        RETURNING last_id AS id
      ), new_resident AS (
        INSERT INTO residents (id, handle, model, secret_hash, recovery_generation)
        SELECT allocated.id, eligible.handle, eligible.model, eligible.secret_hash, 1
        FROM allocated_resident_id allocated CROSS JOIN eligible
        RETURNING id, handle, model
      ), new_presence AS (
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        SELECT resident.id, world_root.id, NULL
        FROM new_resident resident CROSS JOIN world_root
        RETURNING resident_id
      ), inserted_recovery_codes AS (
        INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
        SELECT resident.id, 1, code.code_hash
        FROM new_resident resident
        CROSS JOIN pending_codes code
        RETURNING resident_id
      ), consumed AS (
        UPDATE pending_resident_registrations pending
        SET resident_id = resident.id,
            confirmed_at = now(),
            handle = NULL,
            model = NULL,
            secret_hash = NULL,
            ip_hash = NULL
        FROM eligible CROSS JOIN new_resident resident
        WHERE pending.session_hash = eligible.session_hash
        RETURNING resident.id, resident.handle, resident.model, eligible.ip_hash,
          eligible.session_hash
      ), scrubbed_pending_codes AS (
        DELETE FROM pending_resident_registration_recovery_codes code
        USING consumed
        WHERE code.registration_session_hash = consumed.session_hash
        RETURNING code.registration_session_hash
      ), registration_log AS (
        INSERT INTO reg_log (ip_hash)
        SELECT ip_hash FROM consumed
        RETURNING ip_hash
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'register', handle,
          jsonb_build_object('resident_id', id, 'model', model)
        FROM consumed
        RETURNING actor
      ), completed AS MATERIALIZED (
        SELECT consumed.id AS resident_id, consumed.handle
        FROM consumed
        WHERE EXISTS (SELECT 1 FROM new_presence)
          AND (SELECT count(*) FROM inserted_recovery_codes) = 8
          AND (SELECT count(*) FROM scrubbed_pending_codes) = 8
          AND EXISTS (SELECT 1 FROM registration_log)
          AND EXISTS (SELECT 1 FROM new_event)
      )
      SELECT 'confirmed'::text AS status, completed.resident_id, completed.handle
      FROM completed
      UNION ALL
      SELECT 'request_unavailable'::text, NULL::integer, NULL::text
      WHERE NOT EXISTS (SELECT 1 FROM active_request)
      UNION ALL
      SELECT 'credential_rejected'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM active_request)
        AND NOT EXISTS (SELECT 1 FROM eligible)
      UNION ALL
      SELECT 'handle_taken'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM eligible)
        AND EXISTS (SELECT 1 FROM handle_conflict)
    `) as {
      status: 'confirmed' | 'credential_rejected' | 'handle_taken' | 'request_unavailable'
      resident_id: number | null
      handle: string | null
    }[]
    const result = rows[0]
    if (!result) throw new Error('resident registration confirmation produced no outcome')
    if (result.status !== 'confirmed') return { status: result.status }
    if (result.resident_id === null || result.handle === null) {
      throw new Error('resident registration confirmation returned an incomplete resident')
    }
    return {
      status: 'confirmed', residentId: result.resident_id, handle: result.handle,
    }
  } catch (error) {
    if (
      postgresErrorCode(error) === '23505' &&
      postgresErrorConstraint(error) === 'residents_handle_key'
    ) return { status: 'handle_taken' }
    throw error
  }
}

export async function cancelResidentRegistration(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  const rows = (await sql`
    WITH canceled AS MATERIALIZED (
      UPDATE pending_resident_registrations
      SET canceled_at = now(), handle = NULL, model = NULL, secret_hash = NULL,
          ip_hash = NULL
      WHERE session_hash = ${input.sessionHash}
        AND csrf_hash = ${input.csrfHash}
        AND resident_id IS NULL
        AND confirmed_at IS NULL
        AND canceled_at IS NULL
        AND expires_at > now()
      RETURNING session_hash
    ), scrubbed_pending_codes AS (
      DELETE FROM pending_resident_registration_recovery_codes code
      USING canceled
      WHERE code.registration_session_hash = canceled.session_hash
      RETURNING code.registration_session_hash
    )
    SELECT session_hash FROM canceled
  `) as { session_hash: string }[]
  return rows.length === 1
}

export async function generateRecoveryCodes(input: {
  residentSecretHash: string
  codeHashes: string[]
}): Promise<RecoveryGenerationResult | null> {
  requireRecoveryCodeHashes(input.codeHashes)
  const rows = (await sql`
    WITH proven AS MATERIALIZED (
      SELECT id, handle, recovery_generation
      FROM residents
      WHERE secret_hash = ${input.residentSecretHash}
      FOR UPDATE
    ), advanced AS (
      UPDATE residents resident
      SET recovery_generation = resident.recovery_generation + 1
      FROM proven
      WHERE resident.id = proven.id
      RETURNING resident.id, resident.handle, resident.recovery_generation
    ), invalidated AS (
      UPDATE resident_recovery_codes code
      SET invalidated_at = coalesce(code.invalidated_at, now()),
          recovery_session_hash = NULL,
          recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL,
          recovery_expires_at = NULL,
          staged_at = NULL
      FROM advanced
      WHERE code.resident_id = advanced.id
        AND code.used_at IS NULL
        AND code.invalidated_at IS NULL
      RETURNING code.id
    ), invalidated_rotations AS (
      UPDATE resident_key_rotations rotation
      SET invalidated_at = now(),
          session_hash = NULL,
          csrf_hash = NULL,
          resident_secret_hash = NULL,
          replacement_secret_hash = NULL
      FROM advanced
      WHERE rotation.resident_id = advanced.id
        AND rotation.confirmed_at IS NULL
        AND rotation.canceled_at IS NULL
        AND rotation.invalidated_at IS NULL
      RETURNING rotation.id
    ), inserted AS (
      INSERT INTO resident_recovery_codes (resident_id, generation, code_hash)
      SELECT advanced.id, advanced.recovery_generation, hash
      FROM advanced CROSS JOIN unnest(${input.codeHashes}::text[]) AS hash
      RETURNING resident_id
    )
    SELECT advanced.id AS resident_id, advanced.handle, advanced.recovery_generation AS generation
    FROM advanced
    WHERE (SELECT count(*) FROM inserted) = 8
  `) as { resident_id: number; handle: string; generation: number }[]
  const resident = rows[0]
  return resident ? {
    residentId: resident.resident_id,
    handle: resident.handle,
    generation: Number(resident.generation),
  } : null
}

export async function stageRootRecovery(input: {
  sessionHash: string
  csrfHash: string
  recoveryCodeHash: string
  replacementSecretHash: string
}): Promise<RecoveryStageResult> {
  const rows = (await sql`
    WITH cleared_expired AS (
      UPDATE resident_recovery_codes
      SET recovery_session_hash = NULL,
          recovery_csrf_hash = NULL,
          replacement_secret_hash = NULL,
          recovery_expires_at = NULL,
          staged_at = NULL
      WHERE used_at IS NULL
        AND invalidated_at IS NULL
        AND recovery_expires_at <= now()
    ), eligible AS MATERIALIZED (
      SELECT code.id, resident.handle
      FROM resident_recovery_codes code
      JOIN residents resident ON resident.id = code.resident_id
      WHERE code.code_hash = ${input.recoveryCodeHash}
        AND code.generation = resident.recovery_generation
        AND code.used_at IS NULL
        AND code.invalidated_at IS NULL
        AND code.recovery_session_hash IS NULL
      FOR UPDATE OF code
    ), staged AS (
      UPDATE resident_recovery_codes code
      SET recovery_session_hash = ${input.sessionHash},
          recovery_csrf_hash = ${input.csrfHash},
          replacement_secret_hash = ${input.replacementSecretHash},
          recovery_expires_at = now() + interval '15 minutes',
          staged_at = now()
      FROM eligible
      WHERE code.id = eligible.id
      RETURNING eligible.handle
    )
    SELECT handle FROM staged
  `) as { handle: string }[]
  const staged = rows[0]
  return staged ? { status: 'staged', handle: staged.handle } : { status: 'credential_rejected' }
}

async function confirmRootRecoveryOnce(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<RecoveryConfirmationResult> {
  const rows = (await sql`
      WITH active_request AS MATERIALIZED (
        SELECT code.id AS code_id, code.resident_id, code.generation,
          code.replacement_secret_hash, resident.handle,
          resident.recovery_generation AS current_generation
        FROM resident_recovery_codes code
        JOIN residents resident ON resident.id = code.resident_id
        WHERE code.recovery_session_hash = ${input.sessionHash}
          AND code.recovery_csrf_hash = ${input.csrfHash}
          AND code.recovery_expires_at > now()
          AND code.used_at IS NULL
          AND code.invalidated_at IS NULL
        FOR UPDATE OF code, resident
      ), available_request AS MATERIALIZED (
        SELECT *
        FROM active_request
        WHERE generation = current_generation
      ), eligible AS MATERIALIZED (
        SELECT *
        FROM available_request
        WHERE replacement_secret_hash = ${input.replacementSecretHash}
      ), changed AS (
        UPDATE residents resident
        SET secret_hash = eligible.replacement_secret_hash,
            recovery_generation = resident.recovery_generation + 1
        FROM eligible
        WHERE resident.id = eligible.resident_id
          AND resident.recovery_generation = eligible.generation
        RETURNING resident.id, resident.handle
      ), used AS (
        UPDATE resident_recovery_codes code
        SET used_at = now(),
            recovery_session_hash = NULL,
            recovery_csrf_hash = NULL,
            replacement_secret_hash = NULL,
            recovery_expires_at = NULL,
            staged_at = NULL
        FROM eligible JOIN changed ON changed.id = eligible.resident_id
        WHERE code.id = eligible.code_id
        RETURNING code.id, code.resident_id
      ), invalidated_siblings AS (
        UPDATE resident_recovery_codes code
        SET invalidated_at = coalesce(code.invalidated_at, now()),
            recovery_session_hash = NULL,
            recovery_csrf_hash = NULL,
            replacement_secret_hash = NULL,
            recovery_expires_at = NULL,
            staged_at = NULL
        FROM used
        WHERE code.resident_id = used.resident_id
          AND code.id <> used.id
          AND code.used_at IS NULL
          AND code.invalidated_at IS NULL
        RETURNING code.id
      ), invalidated_rotations AS (
        UPDATE resident_key_rotations rotation
        SET invalidated_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        FROM used
        WHERE rotation.resident_id = used.resident_id
          AND rotation.confirmed_at IS NULL
          AND rotation.canceled_at IS NULL
          AND rotation.invalidated_at IS NULL
        RETURNING rotation.id
      ), revoked_families AS (
        UPDATE oauth_token_families family
        SET revoked_at = coalesce(family.revoked_at, now()),
            revoke_reason = coalesce(family.revoke_reason, 'root key recovery')
        FROM used
        WHERE family.resident_id = used.resident_id
          AND family.revoked_at IS NULL
        RETURNING family.id
      ), revoked_tokens AS (
        UPDATE oauth_tokens token
        SET revoked_at = coalesce(token.revoked_at, now())
        FROM oauth_token_families family, used
        WHERE token.family_id = family.id
          AND family.resident_id = used.resident_id
        RETURNING token.id
      ), invalidated_codes AS (
        UPDATE oauth_authorization_codes code
        SET used_at = coalesce(code.used_at, now())
        FROM used
        WHERE code.resident_id = used.resident_id
          AND code.used_at IS NULL
        RETURNING code.id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'rotate', handle, '{}'::jsonb FROM changed
        RETURNING actor
      ), completed AS MATERIALIZED (
        SELECT changed.id AS resident_id, changed.handle
        FROM changed
        JOIN used ON used.resident_id = changed.id
        WHERE EXISTS (SELECT 1 FROM new_event)
      )
      SELECT 'recovered'::text AS status, completed.resident_id, completed.handle
      FROM completed
      UNION ALL
      SELECT 'request_unavailable'::text, NULL::integer, NULL::text
      WHERE NOT EXISTS (SELECT 1 FROM active_request)
         OR NOT EXISTS (SELECT 1 FROM available_request)
      UNION ALL
      SELECT 'credential_rejected'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM available_request)
        AND NOT EXISTS (SELECT 1 FROM eligible)
    `) as {
      status: 'recovered' | 'credential_rejected' | 'request_unavailable'
      resident_id: number | null
      handle: string | null
    }[]
  const result = rows[0]
  if (!result) throw new Error('root recovery confirmation produced no outcome')
  if (result.status !== 'recovered') return { status: result.status }
  if (result.resident_id === null || result.handle === null) {
    throw new Error('root recovery confirmation returned an incomplete resident')
  }
  return { status: 'recovered', residentId: result.resident_id, handle: result.handle }
}

export async function confirmRootRecovery(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<RecoveryConfirmationResult> {
  return retryIdentityDeadlockOnce(() => confirmRootRecoveryOnce(input))
}

export async function cancelRootRecovery(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  const rows = (await sql`
    UPDATE resident_recovery_codes
    SET recovery_session_hash = NULL,
        recovery_csrf_hash = NULL,
        replacement_secret_hash = NULL,
        recovery_expires_at = NULL,
        staged_at = NULL
    WHERE recovery_session_hash = ${input.sessionHash}
      AND recovery_csrf_hash = ${input.csrfHash}
      AND recovery_expires_at > now()
      AND used_at IS NULL
      AND invalidated_at IS NULL
    RETURNING id
  `) as { id: number }[]
  return rows.length === 1
}

export async function stageRootRotation(input: {
  sessionHash: string
  csrfHash: string
  residentSecretHash: string
  replacementSecretHash: string
}): Promise<RotationStageResult> {
  const rows = (await sql`
      WITH cleared_expired AS (
        UPDATE resident_key_rotations
        SET canceled_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        WHERE expires_at <= now()
          AND confirmed_at IS NULL
          AND canceled_at IS NULL
          AND invalidated_at IS NULL
      ), proven AS MATERIALIZED (
        SELECT resident.id, resident.handle, resident.secret_hash,
          resident.recovery_generation
        FROM residents resident
        WHERE resident.secret_hash = ${input.residentSecretHash}
        FOR UPDATE
      ), staged AS (
        INSERT INTO resident_key_rotations (
          resident_id, recovery_generation, session_hash, csrf_hash,
          resident_secret_hash, replacement_secret_hash, expires_at
        )
        SELECT proven.id, proven.recovery_generation, ${input.sessionHash},
          ${input.csrfHash}, proven.secret_hash, ${input.replacementSecretHash},
          now() + interval '15 minutes'
        FROM proven
        WHERE proven.secret_hash <> ${input.replacementSecretHash}
        ON CONFLICT DO NOTHING
        RETURNING resident_id
      )
      SELECT 'staged'::text AS status, proven.id AS resident_id, proven.handle
      FROM proven
      JOIN staged ON staged.resident_id = proven.id
      UNION ALL
      SELECT 'credential_rejected'::text, NULL::integer, NULL::text
      WHERE NOT EXISTS (SELECT 1 FROM proven)
      UNION ALL
      SELECT 'request_unavailable'::text, NULL::integer, NULL::text
      WHERE EXISTS (SELECT 1 FROM proven)
        AND NOT EXISTS (SELECT 1 FROM staged)
    `) as {
      status: 'staged' | 'credential_rejected' | 'request_unavailable'
      resident_id: number | null
      handle: string | null
    }[]
  const result = rows[0]
  if (!result) throw new Error('root rotation staging produced no outcome')
  if (result.status !== 'staged') return { status: result.status }
  if (result.resident_id === null || result.handle === null) {
    throw new Error('root rotation staging returned an incomplete resident')
  }
  return { status: 'staged', residentId: result.resident_id, handle: result.handle }
}

export type RootRotationResult =
  | ({ status: 'rotated' } & IdentityResidentResult)
  | { status: 'credential_rejected' }
  | { status: 'rate_limited' }
  | { status: 'request_unavailable' }

async function confirmRootRotationOnce(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<RootRotationResult> {
  const rows = (await sql`
      WITH cleared_expired AS (
        UPDATE resident_key_rotations
        SET canceled_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        WHERE expires_at <= now()
          AND confirmed_at IS NULL
          AND canceled_at IS NULL
          AND invalidated_at IS NULL
      ), active_rotation AS MATERIALIZED (
        SELECT rotation.id AS rotation_id, rotation.resident_id,
          rotation.recovery_generation, rotation.resident_secret_hash,
          rotation.replacement_secret_hash, resident.handle,
          resident.secret_hash AS current_secret_hash,
          resident.recovery_generation AS current_generation
        FROM resident_key_rotations rotation
        JOIN residents resident ON resident.id = rotation.resident_id
        WHERE rotation.session_hash = ${input.sessionHash}
          AND rotation.csrf_hash = ${input.csrfHash}
          AND rotation.expires_at > now()
          AND rotation.confirmed_at IS NULL
          AND rotation.canceled_at IS NULL
          AND rotation.invalidated_at IS NULL
        FOR UPDATE OF rotation, resident
      ), available_rotation AS MATERIALIZED (
        SELECT *
        FROM active_rotation
        WHERE resident_secret_hash = current_secret_hash
          AND recovery_generation = current_generation
      ), eligible AS MATERIALIZED (
        SELECT *
        FROM available_rotation
        WHERE replacement_secret_hash = ${input.replacementSecretHash}
      ), admission AS MATERIALIZED (
        SELECT eligible.*,
          (
            SELECT count(*)::integer
            FROM resident_key_rotations prior
            WHERE prior.resident_id = eligible.resident_id
              AND prior.confirmed_at >= date_trunc('day', now(), 'UTC')
          ) AS daily_successes
        FROM eligible
      ), rate_limited AS (
        UPDATE resident_key_rotations rotation
        SET canceled_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        FROM admission
        WHERE rotation.id = admission.rotation_id
          AND admission.daily_successes >= 5
        RETURNING rotation.id, rotation.resident_id
      ), changed AS (
        UPDATE residents resident
        SET secret_hash = admission.replacement_secret_hash,
            recovery_generation = resident.recovery_generation + 1
        FROM admission
        WHERE resident.id = admission.resident_id
          AND admission.daily_successes < 5
          AND resident.secret_hash = admission.resident_secret_hash
          AND resident.recovery_generation = admission.recovery_generation
        RETURNING resident.id, resident.handle
      ), confirmed AS (
        UPDATE resident_key_rotations rotation
        SET confirmed_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        FROM admission
        JOIN changed ON changed.id = admission.resident_id
        WHERE rotation.id = admission.rotation_id
        RETURNING rotation.id, changed.id AS resident_id, changed.handle
      ), invalidated_rotation_siblings AS (
        UPDATE resident_key_rotations rotation
        SET invalidated_at = now(),
            session_hash = NULL,
            csrf_hash = NULL,
            resident_secret_hash = NULL,
            replacement_secret_hash = NULL
        FROM confirmed
        WHERE rotation.resident_id = confirmed.resident_id
          AND rotation.id <> confirmed.id
          AND rotation.confirmed_at IS NULL
          AND rotation.canceled_at IS NULL
          AND rotation.invalidated_at IS NULL
        RETURNING rotation.id
      ), invalidated_recovery AS (
        UPDATE resident_recovery_codes code
        SET invalidated_at = coalesce(code.invalidated_at, now()),
            recovery_session_hash = NULL,
            recovery_csrf_hash = NULL,
            replacement_secret_hash = NULL,
            recovery_expires_at = NULL,
            staged_at = NULL
        FROM confirmed
        WHERE code.resident_id = confirmed.resident_id
          AND code.used_at IS NULL
          AND code.invalidated_at IS NULL
        RETURNING code.id
      ), revoked_families AS (
        UPDATE oauth_token_families family
        SET revoked_at = coalesce(family.revoked_at, now()),
            revoke_reason = coalesce(family.revoke_reason, 'root key rotation')
        FROM confirmed
        WHERE family.resident_id = confirmed.resident_id
        RETURNING family.id
      ), revoked_tokens AS (
        UPDATE oauth_tokens token
        SET revoked_at = coalesce(token.revoked_at, now())
        FROM oauth_token_families family, confirmed
        WHERE token.family_id = family.id
          AND family.resident_id = confirmed.resident_id
        RETURNING token.id
      ), invalidated_codes AS (
        UPDATE oauth_authorization_codes code
        SET used_at = coalesce(code.used_at, now())
        FROM confirmed
        WHERE code.resident_id = confirmed.resident_id
          AND code.used_at IS NULL
        RETURNING code.id
      ), new_event AS (
        INSERT INTO events (kind, actor, detail)
        SELECT 'rotate', confirmed.handle, '{}'::jsonb FROM confirmed
        RETURNING actor
      )
      SELECT 'rotated'::text AS status, confirmed.resident_id, confirmed.handle
      FROM confirmed
      WHERE EXISTS (SELECT 1 FROM new_event)
      UNION ALL
      SELECT 'rate_limited'::text AS status, NULL::integer AS resident_id, NULL::text AS handle
      FROM rate_limited
      UNION ALL
      SELECT 'request_unavailable'::text AS status, NULL::integer AS resident_id, NULL::text AS handle
      WHERE NOT EXISTS (SELECT 1 FROM active_rotation)
         OR NOT EXISTS (SELECT 1 FROM available_rotation)
      UNION ALL
      SELECT 'credential_rejected'::text AS status, NULL::integer AS resident_id, NULL::text AS handle
      WHERE EXISTS (SELECT 1 FROM available_rotation)
        AND NOT EXISTS (SELECT 1 FROM eligible)
    `) as {
      status: 'rotated' | 'rate_limited' | 'credential_rejected' | 'request_unavailable'
      resident_id: number | null
      handle: string | null
    }[]
  const result = rows[0]
  if (!result) throw new Error('root rotation confirmation produced no outcome')
  if (result.status === 'rate_limited') return { status: 'rate_limited' }
  if (result.status === 'credential_rejected') return { status: 'credential_rejected' }
  if (result.status === 'request_unavailable') return { status: 'request_unavailable' }
  if (result.resident_id === null || result.handle === null) {
    throw new Error('root rotation confirmation returned an incomplete resident')
  }
  return {
    status: 'rotated',
    residentId: result.resident_id,
    handle: result.handle,
  }
}

export async function confirmRootRotation(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<RootRotationResult> {
  return retryIdentityDeadlockOnce(() => confirmRootRotationOnce(input))
}

export async function cancelRootRotation(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  const rows = (await sql`
    UPDATE resident_key_rotations
    SET canceled_at = now(),
        session_hash = NULL,
        csrf_hash = NULL,
        resident_secret_hash = NULL,
        replacement_secret_hash = NULL
    WHERE session_hash = ${input.sessionHash}
      AND csrf_hash = ${input.csrfHash}
      AND expires_at > now()
      AND confirmed_at IS NULL
      AND canceled_at IS NULL
      AND invalidated_at IS NULL
    RETURNING id
  `) as { id: number }[]
  return rows.length === 1
}

export const postgresIdentityStore = {
  consumeIdentityRateLimit,
  stageResidentRegistration,
  confirmResidentRegistration,
  cancelResidentRegistration,
  generateRecoveryCodes,
  stageRootRecovery,
  confirmRootRecovery,
  cancelRootRecovery,
  stageRootRotation,
  confirmRootRotation,
  cancelRootRotation,
} as const

export type IdentityStore = typeof postgresIdentityStore
