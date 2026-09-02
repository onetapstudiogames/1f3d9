import { CITY_FEE_CREDIT_UNITS } from './city-credit.ts'

export interface PlaceLifecycleOperationDatabase {
  query(
    text: string,
    params?: readonly unknown[] | unknown[],
  ): Promise<readonly Record<string, unknown>[]>
  transaction?<T>(work: (database: PlaceLifecycleOperationDatabase) => Promise<T>): Promise<T>
}

export type PlaceLifecycleOperationResult =
  | Readonly<{
      state: 'completed'
      attemptId: string
      responseStatus: number
      responseBody: string
    }>
  | Readonly<{
      state: 'target_changed'
      attemptId: string
      reason: string
    }>

const COMPLETE_PLACE_LIFECYCLE_SQL = `
  /* place-lifecycle:complete */
  WITH owned_attempt AS MATERIALIZED (
    SELECT attempt.*, resident.handle AS actor_handle,
      spend.request_id AS credit_request_id
    FROM payment_attempts attempt
    JOIN residents resident ON resident.id = attempt.actor_id
    JOIN city_credit_entries spend
      ON spend.payment_attempt_id = attempt.public_id
      AND spend.entry_kind = 'spend'
    WHERE attempt.public_id = $1::text
      AND attempt.lease_owner = $2::text
      AND attempt.status = 'payment_pending'
      AND attempt.method = 'credit'
      AND attempt.operation IN ('place_rename', 'place_retire', 'place_restore')
      AND attempt.asset_type = 'place'
      AND attempt.asset_id IS NOT NULL
      AND attempt.amount_units = $3::bigint
    FOR UPDATE OF attempt
  ), shaped AS MATERIALIZED (
    SELECT attempt.*,
      CASE attempt.operation
        WHEN 'place_rename' THEN 'rename'
        WHEN 'place_retire' THEN 'retire'
        ELSE 'restore'
      END AS requested_action,
      attempt.request_json->>'name' AS requested_name
    FROM owned_attempt attempt
    WHERE jsonb_typeof(attempt.request_json) = 'object'
      AND attempt.target_key = 'place:' || attempt.asset_id::text || ':' ||
        CASE attempt.operation
          WHEN 'place_rename' THEN 'rename:' || attempt.credit_request_id
          WHEN 'place_retire' THEN 'retire:' || attempt.credit_request_id
          ELSE 'restore:' || attempt.credit_request_id
        END
      AND (
        (
          attempt.operation = 'place_rename'
          AND attempt.request_json ?& ARRAY['place_id', 'name']
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_object_keys(attempt.request_json) key
            WHERE key <> ALL(ARRAY['place_id', 'name']::text[])
          )
          AND jsonb_typeof(attempt.request_json->'place_id') = 'number'
          AND (attempt.request_json->>'place_id') ~ '^[1-9][0-9]*$'
          AND (attempt.request_json->>'place_id')::numeric <= 2147483647
          AND (attempt.request_json->>'place_id')::integer = attempt.asset_id
          AND jsonb_typeof(attempt.request_json->'name') = 'string'
          AND char_length(attempt.request_json->>'name') BETWEEN 1 AND 120
          AND btrim(attempt.request_json->>'name') = attempt.request_json->>'name'
          AND (attempt.request_json->>'name') !~ '[\r\n]'
        )
        OR (
          attempt.operation IN ('place_retire', 'place_restore')
          AND attempt.request_json ? 'place_id'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_object_keys(attempt.request_json) key
            WHERE key <> 'place_id'
          )
          AND jsonb_typeof(attempt.request_json->'place_id') = 'number'
          AND (attempt.request_json->>'place_id') ~ '^[1-9][0-9]*$'
          AND (attempt.request_json->>'place_id')::numeric <= 2147483647
          AND (attempt.request_json->>'place_id')::integer = attempt.asset_id
        )
      )
  ), place_state AS MATERIALIZED (
    SELECT shaped.*, place.parent_id, place.name AS current_name,
      place.owner_id, place.retired_at,
      (SELECT parent.retired_at FROM places parent
        WHERE parent.id = place.parent_id FOR SHARE) AS parent_retired_at,
      (SELECT count(*)::integer FROM places child
        WHERE child.parent_id = place.id AND child.retired_at IS NULL) AS subplace_count,
      (SELECT count(*)::integer FROM things thing
        WHERE thing.place_id = place.id AND thing.withdrawn_at IS NULL) AS thing_count,
      (SELECT count(*)::integer FROM resident_presence presence
        WHERE presence.current_place_id = place.id) AS resident_count,
      EXISTS (
        SELECT 1 FROM places sibling
        WHERE sibling.parent_id = place.parent_id
          AND sibling.id <> place.id
          AND sibling.retired_at IS NULL
          AND lower(sibling.name) = lower(coalesce(shaped.requested_name, place.name))
      ) AS name_taken
    FROM shaped
    JOIN places place ON place.id = shaped.asset_id
    FOR UPDATE OF place
  ), decision AS MATERIALIZED (
    SELECT state.*,
      CASE
        WHEN state.owner_id IS NULL THEN 'place not found'
        WHEN state.owner_id <> state.actor_id THEN 'only the place owner may rename, retire, or restore it'
        WHEN state.requested_action = 'rename' AND state.retired_at IS NOT NULL
          THEN 'place is retired; restore it before renaming'
        WHEN state.requested_action = 'rename' AND state.current_name = state.requested_name
          THEN 'place already has that name'
        WHEN state.requested_action = 'rename' AND state.name_taken
          THEN 'that place name is already taken inside its parent'
        WHEN state.requested_action = 'retire' AND state.retired_at IS NOT NULL
          THEN 'place is already retired'
        WHEN state.requested_action = 'retire' AND state.subplace_count > 0
          THEN 'place is not empty: move or retire its ' || state.subplace_count::text ||
            CASE WHEN state.subplace_count = 1 THEN ' subplace first' ELSE ' subplaces first' END
        WHEN state.requested_action = 'retire' AND state.thing_count > 0
          THEN 'place is not empty: move or withdraw its ' || state.thing_count::text ||
            CASE WHEN state.thing_count = 1 THEN ' thing first' ELSE ' things first' END
        WHEN state.requested_action = 'retire' AND state.resident_count > 0
          THEN 'place is not empty: ' || state.resident_count::text ||
            CASE WHEN state.resident_count = 1
              THEN ' resident is standing there' ELSE ' residents are standing there' END
        WHEN state.requested_action = 'restore' AND state.retired_at IS NULL
          THEN 'place is already active'
        WHEN state.requested_action = 'restore' AND state.parent_retired_at IS NOT NULL
          THEN 'parent place is retired; restore it before restoring this place'
        WHEN state.requested_action = 'restore' AND state.name_taken
          THEN 'that place name is already taken inside its parent'
        ELSE NULL
      END AS refusal
    FROM place_state state
  ), changed AS MATERIALIZED (
    UPDATE places place SET
      name = CASE WHEN decision.requested_action = 'rename'
        THEN decision.requested_name ELSE place.name END,
      retired_at = CASE
        WHEN decision.requested_action = 'retire' THEN clock_timestamp()
        WHEN decision.requested_action = 'restore' THEN NULL
        ELSE place.retired_at
      END
    FROM decision
    WHERE place.id = decision.asset_id AND decision.refusal IS NULL
    RETURNING place.*, decision.public_id AS attempt_id,
      decision.actor_id, decision.actor_handle, decision.requested_action,
      decision.current_name AS prior_name
  ), cleared_homes AS (
    UPDATE resident_presence presence SET home_place_id = NULL, updated_at = clock_timestamp()
    FROM changed
    WHERE changed.requested_action = 'retire'
      AND presence.home_place_id = changed.id
    RETURNING presence.resident_id
  ), new_event AS MATERIALIZED (
    INSERT INTO events (kind, actor, detail, at)
    SELECT CASE changed.requested_action
        WHEN 'rename' THEN 'place_renamed'
        WHEN 'retire' THEN 'place_retired'
        ELSE 'place_restored'
      END,
      changed.actor_handle,
      jsonb_build_object(
        'place_id', changed.id,
        'name', changed.name,
        'former_name', CASE WHEN changed.requested_action = 'rename'
          THEN changed.prior_name ELSE NULL END
      ),
      clock_timestamp()
    FROM changed
    RETURNING id, kind, at
  ), new_name_history AS (
    INSERT INTO place_name_history (place_id, name, started_at, event_id)
    SELECT changed.id, changed.name, event.at, event.id
    FROM changed
    JOIN new_event event ON event.kind = 'place_renamed'
    RETURNING id
  ), response AS MATERIALIZED (
    SELECT changed.attempt_id, changed.actor_id,
      jsonb_build_object(
        'place', (to_jsonb(changed) - ARRAY[
          'attempt_id', 'actor_id', 'actor_handle', 'requested_action', 'prior_name',
          'front_matter_thing_ids'
        ]::text[]) || jsonb_build_object('owner', changed.actor_handle),
        'city_fee_credit', jsonb_build_object(
          'spent_usdc', '1.000000',
          'balance_usdc', (
            SELECT (balance_units / 1000000)::text || '.' ||
              lpad((balance_units % 1000000)::text, 6, '0')
            FROM city_credit_accounts WHERE resident_id = changed.actor_id
          )
        )
      ) AS response_json
    FROM changed
    WHERE EXISTS (SELECT 1 FROM new_event)
      AND (
        changed.requested_action <> 'rename'
        OR EXISTS (SELECT 1 FROM new_name_history)
      )
  ), completed AS MATERIALIZED (
    SELECT completed.*
    FROM response
    CROSS JOIN LATERAL complete_city_credit_attempt(
      response.attempt_id,
      $2::text,
      jsonb_build_object('kind', 'place', 'id', (response.response_json #>> '{place,id}')::integer),
      200::smallint,
      response.response_json,
      convert_to(response.response_json::text, 'UTF8')
    ) completed
  )
  SELECT 'completed'::text AS state,
    completed.response_status,
    convert_from(completed.response_body_bytes, 'UTF8') AS response_body,
    NULL::text AS reason
  FROM completed
  UNION ALL
  SELECT 'target_changed'::text AS state,
    NULL::smallint AS response_status,
    NULL::text AS response_body,
    decision.refusal AS reason
  FROM decision
  WHERE decision.refusal IS NOT NULL
`

export async function completePlaceLifecycleOperation(
  database: PlaceLifecycleOperationDatabase,
  input: Readonly<{ attemptId: string; leaseOwner: string }>,
): Promise<PlaceLifecycleOperationResult> {
  const complete = async (transaction: PlaceLifecycleOperationDatabase) => {
    await transaction.query(`
      /* place-lifecycle:lock-before-recheck */
      SELECT place.id
      FROM payment_attempts attempt
      JOIN places place ON place.id = attempt.asset_id
      WHERE attempt.public_id = $1::text
        AND attempt.lease_owner = $2::text
        AND attempt.status = 'payment_pending'
        AND attempt.operation IN ('place_rename', 'place_retire', 'place_restore')
      FOR UPDATE OF attempt, place
    `, [input.attemptId, input.leaseOwner])
    return transaction.query(COMPLETE_PLACE_LIFECYCLE_SQL, [
      input.attemptId,
      input.leaseOwner,
      CITY_FEE_CREDIT_UNITS.toString(),
    ])
  }
  const rows = database.transaction
    ? await database.transaction(complete)
    : await complete(database)
  const row = rows[0]
  if (!row) return {
    state: 'target_changed',
    attemptId: input.attemptId,
    reason: 'place or paid request changed before completion',
  }
  if (row.state === 'target_changed') {
    return { state: 'target_changed', attemptId: input.attemptId, reason: String(row.reason) }
  }
  if (row.state !== 'completed') throw new Error('place lifecycle completion returned an invalid state')
  const responseStatus = Number(row.response_status)
  if (!Number.isSafeInteger(responseStatus) || responseStatus !== 200) {
    throw new Error('place lifecycle completion returned an invalid status')
  }
  if (typeof row.response_body !== 'string') {
    throw new Error('place lifecycle completion returned no response body')
  }
  return {
    state: 'completed',
    attemptId: input.attemptId,
    responseStatus,
    responseBody: row.response_body,
  }
}
