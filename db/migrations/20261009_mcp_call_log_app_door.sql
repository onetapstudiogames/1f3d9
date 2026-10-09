BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The app door's calls join the city's own private tool-call log (decisions
-- #141 and #142). Calls to /mcp/app are logged with door 'app', so the door
-- check widens from two doors to three. Nothing else about the table changes:
-- the same closed fields, no resident identity. It needs
-- 20261009_mcp_call_log.sql first, and it is safe to run again.
DO $mcp_call_log_app_door_needs_table$
BEGIN
  IF to_regclass('public.mcp_call_log') IS NULL THEN
    RAISE EXCEPTION 'mcp call log app door migration needs 20261009_mcp_call_log.sql applied first';
  END IF;
END
$mcp_call_log_app_door_needs_table$;

ALTER TABLE mcp_call_log
  DROP CONSTRAINT IF EXISTS mcp_call_log_door_known,
  ADD CONSTRAINT mcp_call_log_door_known
    CHECK (door IN ('mcp', 'connect', 'app'));

DO $mcp_call_log_app_door_shape$
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
    'id', 'at', 'door', 'tool', 'client_family', 'request_id',
    'outcome', 'refusal_class', 'http_status', 'latency_ms'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'bigint', 'timestamp with time zone', 'text', 'text', 'text', 'uuid',
    'text', 'text', 'smallint', 'integer'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, TRUE, FALSE, FALSE, TRUE
  ]::BOOLEAN[] THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed columns';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass
      AND contype = 'c'
      AND convalidated
      AND conname IN (
        'mcp_call_log_door_known', 'mcp_call_log_tool_shape',
        'mcp_call_log_client_family_known', 'mcp_call_log_outcome_known', 'mcp_call_log_refusal_class_known',
        'mcp_call_log_http_status_valid', 'mcp_call_log_latency_ms_valid',
        'mcp_call_log_ok_has_no_refusal_class'
      )
  ) <> 8
  OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass AND contype IN ('c', 'f', 'u', 'x')
  ) <> 8 THEN
    RAISE EXCEPTION 'mcp call log table conflicts with the reviewed constraints';
  END IF;

  IF (
    SELECT pg_get_constraintdef(oid)
    FROM pg_constraint
    WHERE conrelid = 'mcp_call_log'::regclass
      AND conname = 'mcp_call_log_door_known'
  ) IS DISTINCT FROM
    'CHECK ((door = ANY (ARRAY[''mcp''::text, ''connect''::text, ''app''::text])))' THEN
    RAISE EXCEPTION 'mcp call log door check does not name exactly the three doors mcp, connect and app';
  END IF;
END
$mcp_call_log_app_door_shape$;

COMMIT;
