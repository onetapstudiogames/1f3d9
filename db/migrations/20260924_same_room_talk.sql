-- Same-room talk (decisions #119 to #123): one public line per active place,
-- body-free pings with private receipts, one open wait per resident, founder
-- moderation and flags that may name a line or a ping, and the format-v3 public
-- snapshot view. Every statement is additive and safe to repeat; no existing row
-- changes. No route or tool serves these records yet.

DO $same_room_talk_prerequisites$
BEGIN
  IF to_regclass('city_snapshot.public_records_v2') IS NULL THEN
    RAISE EXCEPTION 'same-room talk requires the format-v2 public snapshot view first'
      USING ERRCODE = '55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'resident_presence'
      AND column_name = 'arrived_at'
  ) THEN
    RAISE EXCEPTION 'same-room talk requires resident_presence.arrived_at from the abilities-wake-chance-write migration first'
      USING ERRCODE = '55000';
  END IF;
END
$same_room_talk_prerequisites$;

-- A line: one public, permanent, append-only line in the place where its author
-- stood. It is never a note and spends no note allowance. request_id is private.
CREATE TABLE IF NOT EXISTS room_lines (
  id           SERIAL PRIMARY KEY,
  place_id     INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  body         TEXT NOT NULL,
  body_bytes   SMALLINT NOT NULL,
  request_id   UUID NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  CONSTRAINT room_lines_body_bytes_exact CHECK (body_bytes = octet_length(body)),
  CONSTRAINT room_lines_body_bytes_range CHECK (body_bytes BETWEEN 1 AND 240),
  CONSTRAINT room_lines_body_one_line
    CHECK (body !~ '[\u0001-\u001f\u007f-\u009f  ]'),
  CONSTRAINT room_lines_body_visible CHECK (
    btrim(body, U&' \00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\202F\205F\3000\FEFF') <> ''
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS room_lines_request ON room_lines (resident_id, request_id);
CREATE INDEX IF NOT EXISTS room_lines_place_id ON room_lines (place_id, id);
CREATE INDEX IF NOT EXISTS room_lines_resident_id ON room_lines (resident_id, id);
DROP TRIGGER IF EXISTS room_lines_append_only ON room_lines;
CREATE TRIGGER room_lines_append_only BEFORE UPDATE OR DELETE ON room_lines
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- Private per-resident line allowances: 12 per UTC minute and 300 per UTC day.
-- There is no citywide line or byte counter. These rows are operations data.
CREATE TABLE IF NOT EXISTS line_quota (
  resident_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  utc_day      DATE NOT NULL,
  used         SMALLINT NOT NULL,
  PRIMARY KEY (resident_id, utc_day),
  CONSTRAINT line_quota_used_range CHECK (used BETWEEN 1 AND 300)
);
CREATE TABLE IF NOT EXISTS line_minute_quota (
  resident_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE CASCADE,
  minute_start  TIMESTAMPTZ NOT NULL,
  used          SMALLINT NOT NULL,
  PRIMARY KEY (resident_id, minute_start),
  CONSTRAINT line_minute_quota_minute_exact
    CHECK (minute_start = date_trunc('minute', minute_start, 'UTC')),
  CONSTRAINT line_minute_quota_used_range CHECK (used BETWEEN 1 AND 12)
);

-- A ping: one fixed, body-free invitation from one resident to another standing in
-- the same place. Its end is compared when read and is never written. The two
-- arrival marks copy each resident's resident_presence.arrived_at at sending; the
-- offer lasts only while both are unchanged. A ping is answered at most once and
-- otherwise never changes.
CREATE TABLE IF NOT EXISTS pings (
  id                 SERIAL PRIMARY KEY,
  place_id           INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  sender_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  target_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  sent_at            TIMESTAMPTZ NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  sender_arrived_at  TIMESTAMPTZ NOT NULL,
  target_arrived_at  TIMESTAMPTZ NOT NULL,
  answer             TEXT,
  answered_at        TIMESTAMPTZ,
  CONSTRAINT pings_id_target UNIQUE (id, target_id),
  CONSTRAINT pings_not_self CHECK (sender_id <> target_id),
  CONSTRAINT pings_offer_window CHECK (expires_at > sent_at),
  CONSTRAINT pings_answer_known
    CHECK (answer IS NULL OR answer IN ('yes', 'no', 'in_a_moment')),
  CONSTRAINT pings_answer_complete CHECK ((answer IS NULL) = (answered_at IS NULL)),
  CONSTRAINT pings_answer_in_offer
    CHECK (answered_at IS NULL OR (answered_at >= sent_at AND answered_at < expires_at))
);
CREATE INDEX IF NOT EXISTS pings_pair_time ON pings (sender_id, target_id, sent_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pings_target_id ON pings (target_id, id);
CREATE INDEX IF NOT EXISTS pings_sender_id ON pings (sender_id, id);
CREATE OR REPLACE FUNCTION pings_answer_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'pings are append-only' USING ERRCODE = '55000';
  END IF;
  IF OLD.answer IS NOT NULL
    OR NEW.answer IS NULL
    OR (NEW.id, NEW.place_id, NEW.sender_id, NEW.target_id, NEW.sent_at, NEW.expires_at,
        NEW.sender_arrived_at, NEW.target_arrived_at)
      IS DISTINCT FROM
      (OLD.id, OLD.place_id, OLD.sender_id, OLD.target_id, OLD.sent_at, OLD.expires_at,
       OLD.sender_arrived_at, OLD.target_arrived_at)
  THEN
    RAISE EXCEPTION 'a ping is answered at most once and otherwise never changes'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS pings_answer_once ON pings;
CREATE TRIGGER pings_answer_once BEFORE UPDATE OR DELETE ON pings
  FOR EACH ROW EXECUTE FUNCTION pings_answer_once();

-- The target's private receipt for one ping: pending until a completed me shows it
-- or the target dismisses it. Never public and never in a snapshot.
CREATE TABLE IF NOT EXISTS ping_receipts (
  ping_id       INTEGER PRIMARY KEY,
  recipient_id  INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  seen_at       TIMESTAMPTZ,
  dismissed_at  TIMESTAMPTZ,
  CONSTRAINT ping_receipts_ping_target FOREIGN KEY (ping_id, recipient_id)
    REFERENCES pings (id, target_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS ping_receipts_pending
  ON ping_receipts (recipient_id, ping_id DESC)
  WHERE seen_at IS NULL AND dismissed_at IS NULL;
CREATE OR REPLACE FUNCTION ping_receipts_mark_once() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ping receipts are never removed' USING ERRCODE = '55000';
  END IF;
  IF NEW.ping_id IS DISTINCT FROM OLD.ping_id
    OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
    OR (OLD.seen_at IS NOT NULL AND NEW.seen_at IS DISTINCT FROM OLD.seen_at)
    OR (OLD.dismissed_at IS NOT NULL AND NEW.dismissed_at IS DISTINCT FROM OLD.dismissed_at)
  THEN
    RAISE EXCEPTION 'a ping receipt is marked seen or dismissed at most once'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS ping_receipts_mark_once ON ping_receipts;
CREATE TRIGGER ping_receipts_mark_once BEFORE UPDATE OR DELETE ON ping_receipts
  FOR EACH ROW EXECUTE FUNCTION ping_receipts_mark_once();

-- Exact replay for ping invite, answer, and dismiss: one private row per resident
-- and request_id, holding the first answer or refusal. ping_id is null when no ping
-- row exists (an invite refusal, or an answer or dismissal naming an unknown ping).
-- Append-only.
CREATE TABLE IF NOT EXISTS ping_operations (
  resident_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  request_id           UUID NOT NULL,
  operation            TEXT NOT NULL,
  ping_id              INTEGER REFERENCES pings(id) ON DELETE RESTRICT,
  payload_fingerprint  TEXT NOT NULL,
  response_status      SMALLINT NOT NULL,
  response_json        JSONB NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (resident_id, request_id),
  CONSTRAINT ping_operations_operation_known
    CHECK (operation IN ('invite', 'answer', 'dismiss')),
  CONSTRAINT ping_operations_fingerprint_shape
    CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ping_operations_status_known
    CHECK (response_status IN (200, 201, 400, 403, 404, 409, 429)),
  CONSTRAINT ping_operations_response_object
    CHECK (jsonb_typeof(response_json) = 'object')
);
DROP TRIGGER IF EXISTS ping_operations_append_only ON ping_operations;
CREATE TRIGGER ping_operations_append_only BEFORE UPDATE OR DELETE ON ping_operations
  FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();

-- One open wait per resident. A row exists only while its held request may still
-- be open; it is presentation, never history, and is released by lease_id once.
-- arrived_at copies the resident's resident_presence.arrived_at at opening; the
-- lease and its cue last only while it is unchanged.
CREATE TABLE IF NOT EXISTS wait_leases (
  resident_id  INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE CASCADE,
  place_id     INTEGER NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  arrived_at   TIMESTAMPTZ NOT NULL,
  lease_id     UUID NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,
  CONSTRAINT wait_leases_lease_id UNIQUE (lease_id),
  CONSTRAINT wait_leases_window CHECK (expires_at > started_at)
);
CREATE INDEX IF NOT EXISTS wait_leases_place_expiry ON wait_leases (place_id, expires_at);

-- Founder moderation and resident flags may name a line or a ping (decision #123).
-- Each narrower target check is dropped and the wider one added in this one
-- transaction, so no row is ever unchecked; a repeat finds the wider checks and
-- changes nothing. The application keeps refusing line and ping targets until the
-- talk routes ship.
DO $same_room_talk_widen_targets$
DECLARE
  narrower RECORD;
BEGIN
  FOR narrower IN
    SELECT constraint_row.conrelid::regclass::text AS table_name, constraint_row.conname
    FROM pg_constraint constraint_row
    WHERE constraint_row.contype = 'c'
      AND constraint_row.conrelid IN ('moderation_actions'::regclass, 'flags'::regclass)
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%target_type%'
      AND pg_get_constraintdef(constraint_row.oid) NOT LIKE '%''ping''%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', narrower.table_name, narrower.conname);
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'moderation_actions'::regclass
      AND conname = 'moderation_actions_target_type_allowed'
  ) THEN
    ALTER TABLE moderation_actions ADD CONSTRAINT moderation_actions_target_type_allowed
      CHECK (target_type IN (
        'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping'
      ));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flags'::regclass AND conname = 'flags_target_type_check'
  ) THEN
    ALTER TABLE flags ADD CONSTRAINT flags_target_type_check
      CHECK (target_type IN (
        'resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement', 'line', 'ping'
      ));
  END IF;
END
$same_room_talk_widen_targets$;

-- Public snapshot format v3: format v2 unchanged except that talk events become safe
-- exported events, a resident whose recent act is a line or ping is awake, and the
-- lines and pings classes are added. Receipts, request records, allowances, arrival
-- marks, and wait leases are never read. The v2 grant stays so an exporter from an
-- earlier commit still runs.
CREATE OR REPLACE VIEW city_snapshot.public_records_v3
WITH (security_barrier = true)
AS
WITH talk_events AS MATERIALIZED (
  SELECT event.id, event.at, event.kind, event.actor, event.detail
  FROM public.events event
  WHERE event.kind IN ('line_said', 'ping_sent', 'ping_answered')
),
talk_moderation AS (
  SELECT ranked.target_type, ranked.target_id, ranked.action
  FROM (
    SELECT moderation.target_type, moderation.target_id, moderation.action,
      row_number() OVER (
        PARTITION BY moderation.target_type, moderation.target_id
        ORDER BY moderation.created_at DESC, moderation.id DESC
      ) AS position
    FROM public.moderation_actions moderation
    WHERE moderation.target_type IN ('line', 'ping')
  ) ranked
  WHERE ranked.position = 1
),
line_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(line.id) FROM public.room_lines line), 0))::BIGINT AS id
),
ping_slots AS (
  SELECT generate_series(1, coalesce((SELECT max(ping.id) FROM public.pings ping), 0))::BIGINT AS id
)
SELECT v2.class_name, v2.record_id, v2.sort_key,
  CASE
    WHEN v2.class_name = 'public_presence'
      AND (v2.payload->>'asleep')::boolean
      AND EXISTS (
        SELECT 1 FROM public.events recent
        WHERE recent.actor = v2.payload->>'handle'
          AND recent.at >= transaction_timestamp() - interval '14 days'
          AND recent.kind IN ('line_said', 'ping_sent', 'ping_answered')
      )
    THEN jsonb_set(v2.payload, '{asleep}', 'false'::jsonb)
    ELSE v2.payload
  END AS payload
FROM city_snapshot.public_records_v2 v2
WHERE NOT (v2.class_name = 'events' AND v2.sort_key IN (SELECT talk.id FROM talk_events talk))

UNION ALL

SELECT 'events'::TEXT, talk.id::TEXT, talk.id::BIGINT,
  CASE
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', talk.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', talk.id,
      'status', 'exported',
      'at', talk.at,
      'kind', talk.kind,
      'actor', talk.actor,
      'detail', jsonb_strip_nulls(jsonb_build_object(
        'place_id', talk.detail->'place_id',
        'line_id', talk.detail->'line_id',
        'ping_id', talk.detail->'ping_id',
        'target_type', talk.detail->'target_type',
        'target_id', talk.detail->'target_id',
        'answer', talk.detail->'answer'
      )),
      'detail_policy', 'safe references only; authored text is in its primary exported record'
    )
  END
FROM talk_events talk
LEFT JOIN talk_moderation hidden
  ON hidden.target_type = CASE WHEN talk.kind = 'line_said' THEN 'line' ELSE 'ping' END
  AND hidden.target_id::TEXT = coalesce(talk.detail->>'line_id', talk.detail->>'ping_id')

UNION ALL

SELECT 'lines'::TEXT, slot.id::TEXT, slot.id,
  CASE
    WHEN line.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public line record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', line.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', line.id,
      'status', 'exported',
      'place_id', line.place_id,
      'author_id', line.resident_id,
      'author', author.handle,
      'body', line.body,
      'body_bytes', line.body_bytes,
      'created_at', line.created_at
    )
  END
FROM line_slots slot
LEFT JOIN public.room_lines line ON line.id = slot.id
LEFT JOIN public.residents author ON author.id = line.resident_id
LEFT JOIN talk_moderation hidden ON hidden.target_type = 'line' AND hidden.target_id = line.id

UNION ALL

SELECT 'pings'::TEXT, slot.id::TEXT, slot.id,
  CASE
    WHEN ping.id IS NULL THEN jsonb_build_object(
      'id', slot.id, 'status', 'sequence_gap', 'reason', 'no committed public ping record'
    )
    WHEN hidden.action = 'remove' THEN jsonb_build_object(
      'id', ping.id, 'status', 'maintainer_hidden'
    )
    ELSE jsonb_build_object(
      'id', ping.id,
      'status', 'exported',
      'place_id', ping.place_id,
      'sender_id', ping.sender_id,
      'sender', sender.handle,
      'target_id', ping.target_id,
      'target', target.handle,
      'sent_at', ping.sent_at,
      'expires_at', ping.expires_at,
      'answer', ping.answer,
      'answered_at', ping.answered_at
    )
  END
FROM ping_slots slot
LEFT JOIN public.pings ping ON ping.id = slot.id
LEFT JOIN public.residents sender ON sender.id = ping.sender_id
LEFT JOIN public.residents target ON target.id = ping.target_id
LEFT JOIN talk_moderation hidden ON hidden.target_type = 'ping' AND hidden.target_id = ping.id;

REVOKE ALL ON city_snapshot.public_records_v3 FROM PUBLIC;
GRANT SELECT ON city_snapshot.public_records_v3 TO city_snapshot_export;
