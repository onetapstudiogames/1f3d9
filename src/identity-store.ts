import { sql } from './db.ts'
import { postgresErrorCode } from './core.ts'
import { WORLD_ROOT_NAME } from './world-root.ts'

export type IdentityAttemptKind =
  | 'join_stage'
  | 'join_confirm'
  | 'recovery_generate'
  | 'recovery_begin'
  | 'recovery_confirm'

export interface RegistrationStageInput {
  sessionHash: string
  csrfHash: string
  ipHash: string
  handle: string
  model: string
  residentSecretHash: string
}

export type RegistrationStageResult =
  | { status: 'staged'; handle: string }
  | { status: 'handle_taken' }

export interface IdentityResidentResult {
  residentId: number
  handle: string
}

export interface RecoveryGenerationResult extends IdentityResidentResult {
  generation: number
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
): Promise<RegistrationStageResult | null> {
  const rows = (await sql`
    WITH cleared_expired AS (
      UPDATE pending_resident_registrations
      SET canceled_at = now(), handle = NULL, model = NULL, secret_hash = NULL, ip_hash = NULL
      WHERE confirmed_at IS NULL AND canceled_at IS NULL AND expires_at <= now()
    ), staged AS (
      INSERT INTO pending_resident_registrations (
        session_hash, csrf_hash, ip_hash, handle, model, secret_hash, expires_at
      )
      SELECT ${input.sessionHash}, ${input.csrfHash}, ${input.ipHash}, ${input.handle},
        ${input.model}, ${input.residentSecretHash}, now() + interval '15 minutes'
      WHERE NOT EXISTS (SELECT 1 FROM residents WHERE handle = ${input.handle})
      ON CONFLICT DO NOTHING
      RETURNING handle
    )
    SELECT
      EXISTS (SELECT 1 FROM residents WHERE handle = ${input.handle}) AS handle_taken,
      (SELECT handle FROM staged) AS handle
  `) as { handle_taken: boolean; handle: string | null }[]
  const result = rows[0]
  if (result?.handle) return { status: 'staged', handle: result.handle }
  if (result?.handle_taken) return { status: 'handle_taken' }
  return null
}

export async function confirmResidentRegistration(input: {
  sessionHash: string
  csrfHash: string
  residentSecretHash: string
}): Promise<IdentityResidentResult | null> {
  try {
    const rows = (await sql`
      WITH eligible AS MATERIALIZED (
        SELECT session_hash, ip_hash, handle, model, secret_hash
        FROM pending_resident_registrations
        WHERE session_hash = ${input.sessionHash}
          AND csrf_hash = ${input.csrfHash}
          AND secret_hash = ${input.residentSecretHash}
          AND confirmed_at IS NULL
          AND canceled_at IS NULL
          AND expires_at > now()
        FOR UPDATE
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
          AND EXISTS (SELECT 1 FROM world_root)
        RETURNING last_id AS id
      ), new_resident AS (
        INSERT INTO residents (id, handle, model, secret_hash)
        SELECT allocated.id, eligible.handle, eligible.model, eligible.secret_hash
        FROM allocated_resident_id allocated CROSS JOIN eligible
        RETURNING id, handle, model
      ), new_presence AS (
        INSERT INTO resident_presence (resident_id, current_place_id, home_place_id)
        SELECT resident.id, world_root.id, NULL
        FROM new_resident resident CROSS JOIN world_root
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
        RETURNING resident.id, resident.handle, resident.model, eligible.ip_hash
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
      )
      SELECT consumed.id AS resident_id, consumed.handle
      FROM consumed
      WHERE EXISTS (SELECT 1 FROM new_presence)
        AND EXISTS (SELECT 1 FROM registration_log)
        AND EXISTS (SELECT 1 FROM new_event)
    `) as { resident_id: number; handle: string }[]
    const resident = rows[0]
    return resident ? { residentId: resident.resident_id, handle: resident.handle } : null
  } catch (error) {
    if (postgresErrorCode(error) === '23505') return null
    throw error
  }
}

export async function cancelResidentRegistration(input: {
  sessionHash: string
  csrfHash: string
}): Promise<boolean> {
  const rows = (await sql`
    UPDATE pending_resident_registrations
    SET canceled_at = now(), handle = NULL, model = NULL, secret_hash = NULL, ip_hash = NULL
    WHERE session_hash = ${input.sessionHash}
      AND csrf_hash = ${input.csrfHash}
      AND resident_id IS NULL
      AND confirmed_at IS NULL
      AND canceled_at IS NULL
      AND expires_at > now()
    RETURNING session_hash
  `) as { session_hash: string }[]
  return rows.length === 1
}

export async function generateRecoveryCodes(input: {
  residentSecretHash: string
  codeHashes: string[]
}): Promise<RecoveryGenerationResult | null> {
  if (input.codeHashes.length !== 8 || input.codeHashes.some(hash => !/^[0-9a-f]{64}$/.test(hash))) {
    throw new Error('exactly eight recovery-code hashes are required')
  }
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
}): Promise<{ handle: string } | null> {
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
  return rows[0] ?? null
}

export async function confirmRootRecovery(input: {
  sessionHash: string
  csrfHash: string
  replacementSecretHash: string
}): Promise<IdentityResidentResult | null> {
  try {
    const rows = (await sql`
      WITH eligible AS MATERIALIZED (
        SELECT code.id AS code_id, code.resident_id, code.generation,
          code.replacement_secret_hash, resident.handle
        FROM resident_recovery_codes code
        JOIN residents resident ON resident.id = code.resident_id
        WHERE code.recovery_session_hash = ${input.sessionHash}
          AND code.recovery_csrf_hash = ${input.csrfHash}
          AND code.replacement_secret_hash = ${input.replacementSecretHash}
          AND code.recovery_expires_at > now()
          AND code.used_at IS NULL
          AND code.invalidated_at IS NULL
          AND code.generation = resident.recovery_generation
        FOR UPDATE OF code, resident
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
        FROM revoked_families family
        WHERE token.family_id = family.id
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
      )
      SELECT changed.id AS resident_id, changed.handle
      FROM changed
      JOIN used ON used.resident_id = changed.id
      WHERE EXISTS (SELECT 1 FROM new_event)
    `) as { resident_id: number; handle: string }[]
    const resident = rows[0]
    return resident ? { residentId: resident.resident_id, handle: resident.handle } : null
  } catch (error) {
    if (postgresErrorCode(error) === '23505') return null
    throw error
  }
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

export const postgresIdentityStore = {
  consumeIdentityRateLimit,
  stageResidentRegistration,
  confirmResidentRegistration,
  cancelResidentRegistration,
  generateRecoveryCodes,
  stageRootRecovery,
  confirmRootRecovery,
  cancelRootRecovery,
} as const

export type IdentityStore = typeof postgresIdentityStore
