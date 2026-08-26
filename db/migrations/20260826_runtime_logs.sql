BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- The receiver remains dormant until the operator configures Vercel's drain.
-- Retried deliveries keep one row because Vercel's log id is the primary key.
CREATE TABLE IF NOT EXISTS runtime_logs (
  id             TEXT PRIMARY KEY
                 CONSTRAINT runtime_logs_id_bounded
                 CHECK (octet_length(id) BETWEEN 1 AND 128),
  received_at    TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  project        TEXT NOT NULL
                 CONSTRAINT runtime_logs_project_bounded
                 CHECK (octet_length(project) BETWEEN 1 AND 128),
  timestamp      TIMESTAMPTZ NOT NULL,
  source         TEXT NOT NULL
                 CONSTRAINT runtime_logs_source_bounded
                 CHECK (octet_length(source) BETWEEN 1 AND 64),
  level          TEXT NOT NULL
                 CONSTRAINT runtime_logs_level_bounded
                 CHECK (octet_length(level) BETWEEN 1 AND 32),
  request_path   TEXT
                 CONSTRAINT runtime_logs_request_path_bounded
                 CHECK (request_path IS NULL OR octet_length(request_path) <= 2048),
  request_method TEXT
                 CONSTRAINT runtime_logs_request_method_bounded
                 CHECK (request_method IS NULL OR octet_length(request_method) <= 16),
  status_code    INTEGER
                 CONSTRAINT runtime_logs_status_code_valid
                 CHECK (status_code IS NULL OR status_code BETWEEN -1 AND 599),
  duration_ms    BIGINT
                 CONSTRAINT runtime_logs_duration_ms_valid
                 CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 86400000),
  user_agent     TEXT
                 CONSTRAINT runtime_logs_user_agent_bounded
                 CHECK (user_agent IS NULL OR octet_length(user_agent) <= 1024),
  message        TEXT
                 CONSTRAINT runtime_logs_message_bounded
                 CHECK (message IS NULL OR octet_length(message) <= 4096),
  deployment_id  TEXT NOT NULL
                 CONSTRAINT runtime_logs_deployment_id_bounded
                 CHECK (octet_length(deployment_id) BETWEEN 1 AND 128)
);

DO $runtime_logs_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  received_at_default TEXT;
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'runtime_logs'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY[
    'id', 'received_at', 'project', 'timestamp', 'source', 'level',
    'request_path', 'request_method', 'status_code', 'duration_ms',
    'user_agent', 'message', 'deployment_id'
  ]::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY[
    'text', 'timestamp with time zone', 'text', 'timestamp with time zone',
    'text', 'text', 'text', 'text', 'integer', 'bigint', 'text', 'text', 'text'
  ]::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[
    TRUE, TRUE, TRUE, TRUE, TRUE, TRUE,
    FALSE, FALSE, FALSE, FALSE, FALSE, FALSE, TRUE
  ]::BOOLEAN[] THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'runtime_logs'::regclass
      AND contype = 'p'
      AND convalidated
      AND NOT condeferrable
      AND NOT condeferred
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'runtime_logs'::regclass AND attname = 'id')
      ]::SMALLINT[]
  ) THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed primary key';
  END IF;

  SELECT pg_get_expr(default_value.adbin, default_value.adrelid, FALSE)
  INTO received_at_default
  FROM pg_attrdef AS default_value
  JOIN pg_attribute AS attribute
    ON attribute.attrelid = default_value.adrelid
   AND attribute.attnum = default_value.adnum
  WHERE default_value.adrelid = 'runtime_logs'::regclass
    AND attribute.attname = 'received_at';

  IF received_at_default IS DISTINCT FROM 'clock_timestamp()'
  OR (
    SELECT count(*)
    FROM pg_attrdef
    WHERE adrelid = 'runtime_logs'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed received_at default';
  END IF;

  IF (
    WITH reviewed_constraints(name, definition) AS (
      VALUES
        ('runtime_logs_id_bounded',
          'CHECK (((octet_length(id) >= 1) AND (octet_length(id) <= 128)))'),
        ('runtime_logs_project_bounded',
          'CHECK (((octet_length(project) >= 1) AND (octet_length(project) <= 128)))'),
        ('runtime_logs_source_bounded',
          'CHECK (((octet_length(source) >= 1) AND (octet_length(source) <= 64)))'),
        ('runtime_logs_level_bounded',
          'CHECK (((octet_length(level) >= 1) AND (octet_length(level) <= 32)))'),
        ('runtime_logs_request_path_bounded',
          'CHECK (((request_path IS NULL) OR (octet_length(request_path) <= 2048)))'),
        ('runtime_logs_request_method_bounded',
          'CHECK (((request_method IS NULL) OR (octet_length(request_method) <= 16)))'),
        ('runtime_logs_status_code_valid',
          'CHECK (((status_code IS NULL) OR ((status_code >= ''-1''::integer) AND (status_code <= 599))))'),
        ('runtime_logs_duration_ms_valid',
          'CHECK (((duration_ms IS NULL) OR ((duration_ms >= 0) AND (duration_ms <= 86400000))))'),
        ('runtime_logs_user_agent_bounded',
          'CHECK (((user_agent IS NULL) OR (octet_length(user_agent) <= 1024)))'),
        ('runtime_logs_message_bounded',
          'CHECK (((message IS NULL) OR (octet_length(message) <= 4096)))'),
        ('runtime_logs_deployment_id_bounded',
          'CHECK (((octet_length(deployment_id) >= 1) AND (octet_length(deployment_id) <= 128)))')
    )
    SELECT count(*)
    FROM reviewed_constraints AS reviewed
    JOIN pg_constraint AS actual
     ON actual.conrelid = 'runtime_logs'::regclass
     AND actual.contype = 'c'
     AND actual.convalidated
     AND NOT actual.connoinherit
     AND actual.conname = reviewed.name
     AND pg_get_constraintdef(actual.oid, FALSE) = reviewed.definition
  ) <> 11 THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed constraints';
  END IF;

  IF (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'runtime_logs'::regclass
      AND contype = 'c'
  ) <> 11 THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed constraints';
  END IF;
END
$runtime_logs_shape$;

-- One durable marker claims an hour before deleting a bounded retention page.
-- This prevents concurrent and retried five-minute cron calls from purging twice.
CREATE TABLE IF NOT EXISTS runtime_log_retention_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE
            CONSTRAINT runtime_log_retention_state_singleton_true
            CHECK (singleton),
  last_hour TIMESTAMPTZ NOT NULL
            CONSTRAINT runtime_log_retention_state_last_hour_aligned
            CHECK (
              last_hour = (
                date_trunc('hour', last_hour AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
              )
            )
);

DO $runtime_log_retention_state_shape$
DECLARE
  actual_columns TEXT[];
  actual_types TEXT[];
  actual_required BOOLEAN[];
  singleton_default TEXT;
BEGIN
  SELECT
    array_agg(attribute.attname ORDER BY attribute.attnum),
    array_agg(format_type(attribute.atttypid, attribute.atttypmod) ORDER BY attribute.attnum),
    array_agg(attribute.attnotnull ORDER BY attribute.attnum)
  INTO actual_columns, actual_types, actual_required
  FROM pg_attribute AS attribute
  WHERE attribute.attrelid = 'runtime_log_retention_state'::regclass
    AND attribute.attnum > 0
    AND NOT attribute.attisdropped;

  IF actual_columns IS DISTINCT FROM ARRAY['singleton', 'last_hour']::TEXT[]
  OR actual_types IS DISTINCT FROM ARRAY['boolean', 'timestamp with time zone']::TEXT[]
  OR actual_required IS DISTINCT FROM ARRAY[TRUE, TRUE]::BOOLEAN[] THEN
    RAISE EXCEPTION 'runtime log retention state conflicts with the reviewed columns';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'runtime_log_retention_state'::regclass
      AND contype = 'p'
      AND convalidated
      AND NOT condeferrable
      AND NOT condeferred
      AND conkey = ARRAY[
        (SELECT attnum FROM pg_attribute
         WHERE attrelid = 'runtime_log_retention_state'::regclass
           AND attname = 'singleton')
      ]::SMALLINT[]
  ) THEN
    RAISE EXCEPTION 'runtime log retention state conflicts with the reviewed primary key';
  END IF;

  SELECT pg_get_expr(default_value.adbin, default_value.adrelid, FALSE)
  INTO singleton_default
  FROM pg_attrdef AS default_value
  JOIN pg_attribute AS attribute
    ON attribute.attrelid = default_value.adrelid
   AND attribute.attnum = default_value.adnum
  WHERE default_value.adrelid = 'runtime_log_retention_state'::regclass
    AND attribute.attname = 'singleton';

  IF singleton_default IS DISTINCT FROM 'true'
  OR (
    SELECT count(*)
    FROM pg_attrdef
    WHERE adrelid = 'runtime_log_retention_state'::regclass
  ) <> 1 THEN
    RAISE EXCEPTION 'runtime log retention state conflicts with the reviewed singleton default';
  END IF;

  IF (
    WITH reviewed_constraints(name, definition) AS (
      VALUES
        ('runtime_log_retention_state_singleton_true', 'CHECK (singleton)'),
        ('runtime_log_retention_state_last_hour_aligned',
          'CHECK ((last_hour = (date_trunc(''hour''::text, (last_hour AT TIME ZONE ''UTC''::text)) AT TIME ZONE ''UTC''::text)))')
    )
    SELECT count(*)
    FROM reviewed_constraints AS reviewed
    JOIN pg_constraint AS actual
     ON actual.conrelid = 'runtime_log_retention_state'::regclass
     AND actual.contype = 'c'
     AND actual.convalidated
     AND NOT actual.connoinherit
     AND actual.conname = reviewed.name
     AND pg_get_constraintdef(actual.oid, FALSE) = reviewed.definition
  ) <> 2
  OR (
    SELECT count(*)
    FROM pg_constraint
    WHERE conrelid = 'runtime_log_retention_state'::regclass
      AND contype = 'c'
  ) <> 2 THEN
    RAISE EXCEPTION 'runtime log retention state conflicts with the reviewed constraints';
  END IF;
END
$runtime_log_retention_state_shape$;

CREATE INDEX IF NOT EXISTS runtime_logs_project_timestamp
  ON runtime_logs (project, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS runtime_logs_retention
  ON runtime_logs (received_at, id);

DO $runtime_log_indexes_shape$
DECLARE
  runtime_schema TEXT;
  runtime_table TEXT;
  project_timestamp_definition TEXT;
  retention_definition TEXT;
BEGIN
  SELECT namespace.nspname, relation.relname
  INTO runtime_schema, runtime_table
  FROM pg_class AS relation
  JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
  WHERE relation.oid = 'runtime_logs'::regclass;

  SELECT pg_get_indexdef(index_relation.oid, 0, FALSE)
  INTO project_timestamp_definition
  FROM pg_class AS index_relation
  JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
  JOIN pg_index AS index_shape
    ON index_shape.indexrelid = index_relation.oid
   AND index_shape.indrelid = 'runtime_logs'::regclass
   AND index_shape.indisvalid
   AND index_shape.indisready
  WHERE namespace.nspname = runtime_schema
    AND index_relation.relname = 'runtime_logs_project_timestamp'
    AND index_relation.relkind = 'i';

  IF project_timestamp_definition IS DISTINCT FROM format(
    'CREATE INDEX runtime_logs_project_timestamp ON %I.%I USING btree (project, "timestamp" DESC, id DESC)',
    runtime_schema,
    runtime_table
  ) THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed project timestamp index';
  END IF;

  SELECT pg_get_indexdef(index_relation.oid, 0, FALSE)
  INTO retention_definition
  FROM pg_class AS index_relation
  JOIN pg_namespace AS namespace ON namespace.oid = index_relation.relnamespace
  JOIN pg_index AS index_shape
    ON index_shape.indexrelid = index_relation.oid
   AND index_shape.indrelid = 'runtime_logs'::regclass
   AND index_shape.indisvalid
   AND index_shape.indisready
  WHERE namespace.nspname = runtime_schema
    AND index_relation.relname = 'runtime_logs_retention'
    AND index_relation.relkind = 'i';

  IF retention_definition IS DISTINCT FROM format(
    'CREATE INDEX runtime_logs_retention ON %I.%I USING btree (received_at, id)',
    runtime_schema,
    runtime_table
  ) THEN
    RAISE EXCEPTION 'runtime log table conflicts with the reviewed retention index';
  END IF;
END
$runtime_log_indexes_shape$;

COMMIT;
