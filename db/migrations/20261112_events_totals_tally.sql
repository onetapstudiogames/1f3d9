BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Additive only: two new tables and one row. No existing table is altered,
-- referenced or locked, so event writers never wait on this migration.
-- The events list's kept tally (decision #196). A count of settled public events,
-- grouped by what decides whether a feed room keeps them out: every event in its
-- (kind, all) row, and a note, line, thing, ping or applied activity also in a row
-- for the room, thing or set of rooms it names. Public counts only: nothing about
-- any reader, caller or request. The five-minute maintenance cron adds newly
-- settled events and checks the tally against a full recount each hour. Nothing
-- reads it to answer a caller until a later reviewed change turns that on.
CREATE TABLE IF NOT EXISTS events_totals_tally (
  kind       TEXT NOT NULL,
  key_type   TEXT NOT NULL
             CONSTRAINT events_totals_tally_key_type_known
             CHECK (key_type IN ('all', 'place', 'thing', 'rooms')),
  key_id     INTEGER NOT NULL
             CONSTRAINT events_totals_tally_key_id_shape
             CHECK ((key_type = 'all') = (key_id = 0) AND key_id >= 0),
  room_set   INTEGER[] NOT NULL DEFAULT '{}'
             CONSTRAINT events_totals_tally_room_set_shape
             CHECK ((key_type = 'rooms') = (cardinality(room_set) > 0)
               AND (key_type <> 'rooms' OR room_set[1] = key_id)),
  items      BIGINT NOT NULL
             CONSTRAINT events_totals_tally_items_positive CHECK (items > 0),
  text_bytes BIGINT NOT NULL
             CONSTRAINT events_totals_tally_text_bytes_nonnegative CHECK (text_bytes >= 0),
  CONSTRAINT events_totals_tally_pkey PRIMARY KEY (kind, key_type, key_id, room_set)
);
CREATE INDEX IF NOT EXISTS events_totals_tally_key
  ON events_totals_tally (key_type, key_id);

-- One state row: the change marker the tally covers, the rule version it was built
-- with, and the hourly check's result. Only the maintenance cron writes it, except
-- that the operator may set paused (stops the cron's tally work) or clear held_off.
CREATE TABLE IF NOT EXISTS events_totals_state (
  singleton                BOOLEAN PRIMARY KEY DEFAULT TRUE
                           CONSTRAINT events_totals_state_singleton_true CHECK (singleton),
  rule_version             INTEGER NOT NULL DEFAULT 0
                           CONSTRAINT events_totals_state_rule_version_nonnegative
                           CHECK (rule_version >= 0),
  generation               BIGINT NOT NULL DEFAULT 0
                           CONSTRAINT events_totals_state_generation_nonnegative
                           CHECK (generation >= 0),
  kept_change_id           BIGINT NOT NULL DEFAULT 0
                           CONSTRAINT events_totals_state_kept_change_id_nonnegative
                           CHECK (kept_change_id >= 0),
  caught_up_at             TIMESTAMPTZ,
  trusted                  BOOLEAN NOT NULL DEFAULT FALSE,
  paused                   BOOLEAN NOT NULL DEFAULT FALSE,
  held_off                 BOOLEAN NOT NULL DEFAULT FALSE,
  last_check_hour          TIMESTAMPTZ,
  last_check_at            TIMESTAMPTZ,
  last_check_ok            BOOLEAN,
  last_check_change_id     BIGINT,
  last_check_feed_room_ids INTEGER[],
  last_mismatch_at         TIMESTAMPTZ,
  CONSTRAINT events_totals_state_trust_needs_fill
    CHECK (NOT trusted OR (caught_up_at IS NOT NULL AND NOT held_off))
);
INSERT INTO events_totals_state (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

DO $events_totals_shape$
BEGIN
  IF (
    SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'events_totals_tally'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY['kind', 'key_type', 'key_id', 'room_set', 'items', 'text_bytes']
  OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'events_totals_tally'::regclass AND contype IN ('c', 'p') AND convalidated
  ) <> 6
  OR (
    SELECT count(*) FROM pg_constraint
    WHERE conrelid = 'events_totals_tally'::regclass AND contype IN ('f', 'u', 'x')
  ) <> 0 THEN
    RAISE EXCEPTION 'events totals tally conflicts with the reviewed shape';
  END IF;
  IF (
    SELECT array_agg(attribute.attname::text ORDER BY attribute.attnum)
    FROM pg_attribute attribute
    WHERE attribute.attrelid = 'events_totals_state'::regclass
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
  ) IS DISTINCT FROM ARRAY[
    'singleton', 'rule_version', 'generation', 'kept_change_id', 'caught_up_at',
    'trusted', 'paused', 'held_off', 'last_check_hour', 'last_check_at', 'last_check_ok',
    'last_check_change_id', 'last_check_feed_room_ids', 'last_mismatch_at'
  ]
  OR (SELECT count(*) FROM events_totals_state) <> 1 THEN
    RAISE EXCEPTION 'events totals state conflicts with the reviewed shape';
  END IF;
END
$events_totals_shape$;

COMMIT;
