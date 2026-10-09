BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The city's own private tool-call log (decision #141). One row per MCP
-- tools/call on either door. Only closed fields: never arguments, text,
-- credentials, headers or addresses. resident_id has no foreign key so the
-- log never blocks a resident change. Rows older than 30 days are purged
-- hourly by the existing five-minute maintenance cron.
CREATE TABLE IF NOT EXISTS mcp_call_log (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  door          TEXT NOT NULL
                CONSTRAINT mcp_call_log_door_known
                CHECK (door IN ('mcp', 'connect')),
  tool          TEXT NOT NULL
                CONSTRAINT mcp_call_log_tool_shape
                CHECK (tool ~ '^[a-z_]{1,64}$'),
  resident_id   INTEGER
                CONSTRAINT mcp_call_log_resident_id_positive
                CHECK (resident_id IS NULL OR resident_id > 0),
  client_family TEXT NOT NULL
                CONSTRAINT mcp_call_log_client_family_known
                CHECK (client_family IN ('chatgpt', 'codex', 'claude_ai', 'claude_code', 'other')),
  request_id    UUID NOT NULL,
  outcome       TEXT NOT NULL
                CONSTRAINT mcp_call_log_outcome_known
                CHECK (outcome IN ('ok', 'refused', 'error')),
  refusal_class TEXT
                CONSTRAINT mcp_call_log_refusal_class_known
                CHECK (refusal_class IS NULL OR refusal_class IN (
                  'bad_input', 'not_found', 'auth_required', 'forbidden',
                  'payment_required', 'conflict', 'rate_limited', 'city_fault',
                  'unreachable', 'rpc_error'
                )),
  http_status   SMALLINT
                CONSTRAINT mcp_call_log_http_status_valid
                CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  latency_ms    INTEGER NOT NULL
                CONSTRAINT mcp_call_log_latency_ms_valid
                CHECK (latency_ms BETWEEN 0 AND 600000),
  CONSTRAINT mcp_call_log_ok_has_no_refusal_class
    CHECK (outcome <> 'ok' OR refusal_class IS NULL)
);

-- One durable marker claims an hour before deleting a bounded retention page,
-- so concurrent and retried five-minute cron calls never purge twice.
CREATE TABLE IF NOT EXISTS mcp_call_log_retention_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE
            CONSTRAINT mcp_call_log_retention_state_singleton_true
            CHECK (singleton),
  last_hour TIMESTAMPTZ NOT NULL
            CONSTRAINT mcp_call_log_retention_state_last_hour_aligned
            CHECK (
              last_hour = (
                date_trunc('hour', last_hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
              )
            )
);

CREATE INDEX IF NOT EXISTS mcp_call_log_at
  ON mcp_call_log (at);
CREATE INDEX IF NOT EXISTS mcp_call_log_resident
  ON mcp_call_log (resident_id, id DESC)
  WHERE resident_id IS NOT NULL;

DO $mcp_call_log_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'mcp_call_log'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY[
    'id', 'at', 'door', 'tool', 'resident_id', 'client_family', 'request_id',
    'outcome', 'refusal_class', 'http_status', 'latency_ms'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'bigint', 'timestamp with time zone', 'text', 'text', 'integer', 'text', 'uuid',
    'text', 'text', 'smallint', 'integer'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[
    TRUE, TRUE, TRUE, TRUE, FALSE, TRUE, TRUE, TRUE, FALSE, FALSE, TRUE
  ]::BOOLEAN[] THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'mcp_call_log'::regclass AND attname = 'id' AND attidentity = 'a'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass
      AND contype = 'p'
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'mcp_call_log'::regclass AND attname = 'id')
      ]::SMALLINT[]
  ) THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed identity primary key';
  END IF;

  IF (
    SELECT pg_get_expr(default_value.adbin, default_value.adrelid, FALSE)
    FROM pg_attrdef AS default_value
    JOIN pg_attribute AS attribute
      ON attribute.attrelid = default_value.adrelid
     AND attribute.attnum = default_value.adnum
    WHERE default_value.adrelid = 'mcp_call_log'::regclass
      AND attribute.attname = 'at'
  ) IS DISTINCT FROM 'clock_timestamp()'
  OR (SELECT count(*) FROM pg_attrdef WHERE adrelid = 'mcp_call_log'::regclass) <> 1 THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed at default';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass
      AND contype = 'c'
      AND convalidated
      AND conname IN (
        'mcp_call_log_door_known', 'mcp_call_log_tool_shape',
        'mcp_call_log_resident_id_positive', 'mcp_call_log_client_family_known',
        'mcp_call_log_outcome_known', 'mcp_call_log_refusal_class_known',
        'mcp_call_log_http_status_valid', 'mcp_call_log_latency_ms_valid',
        'mcp_call_log_ok_has_no_refusal_class'
      )
  ) <> 9
  OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass AND contype IN ('c', 'f', 'u', 'x')
  ) <> 9 THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed constraints';
  END IF;

  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'mcp_call_log_retention_state'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY['singleton', 'last_hour']::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY['boolean', 'timestamp with time zone']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE]::BOOLEAN[]
  OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'mcp_call_log_retention_state'::regclass
      AND contype = 'c'
      AND convalidated
      AND conname IN (
        'mcp_call_log_retention_state_singleton_true',
        'mcp_call_log_retention_state_last_hour_aligned'
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'mcp call log retention state conflicts with the reviewed shape';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_index AS index_shape
    JOIN pg_class AS index_relation ON index_relation.oid = index_shape.indexrelid
    WHERE index_shape.indrelid = 'mcp_call_log'::regclass
      AND index_shape.indisvalid
      AND index_shape.indisready
      AND (
        (index_relation.relname = 'mcp_call_log_at'
          AND pg_get_indexdef(index_relation.oid, 0, FALSE) LIKE '%USING btree (at)')
        OR (index_relation.relname = 'mcp_call_log_resident'
          AND pg_get_indexdef(index_relation.oid, 0, FALSE)
            LIKE '%USING btree (resident_id, id DESC) WHERE (resident_id IS NOT NULL)')
      )
  ) <> 2 THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed indexes';
  END IF;
END
$mcp_call_log_shape$;

COMMIT;
