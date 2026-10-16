BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Feed rooms (decision #153). A place owner may mark an owned quiet room as a
-- feed room; its notes, lines, things and pings then stay out of residents'
-- city-wide lists. places gains one boolean, feed, with a constant default, so
-- adding it rewrites no row, and one check, places_feed_needs_quiet, so a feed
-- room is always quiet. places is read by almost every query, so the column and
-- the check are added in one ALTER TABLE statement (one brief exclusive lock),
-- the check NOT VALID, and the check is validated in its own statement. No
-- existing row changes: every place starts with feed false. It is safe to run
-- again.
DO $place_feed_guard$
BEGIN
  IF to_regclass('public.places') IS NULL THEN
    RAISE EXCEPTION 'place feed migration needs the places table';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'places'::regclass
      AND attname = 'quiet'
      AND atttypid = 'boolean'::regtype
      AND attnotnull
      AND NOT attisdropped
  ) THEN
    RAISE EXCEPTION 'place feed migration needs the not-null boolean places.quiet';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_attribute
    WHERE attrelid = 'places'::regclass
      AND attname = 'feed'
      AND NOT attisdropped
      AND (atttypid <> 'boolean'::regtype OR NOT attnotnull)
  ) THEN
    RAISE EXCEPTION 'places.feed already exists with a shape this migration does not know';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_feed_needs_quiet'
      AND pg_get_constraintdef(oid) IS DISTINCT FROM 'CHECK (((NOT feed) OR quiet))'
  ) THEN
    RAISE EXCEPTION 'places_feed_needs_quiet already exists with a different definition';
  END IF;
END
$place_feed_guard$;

DO $place_feed_column$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'places'::regclass
    AND conname = 'places_feed_needs_quiet') THEN
    ALTER TABLE places
      ADD COLUMN IF NOT EXISTS feed BOOLEAN NOT NULL DEFAULT FALSE,
      ADD CONSTRAINT places_feed_needs_quiet CHECK (NOT feed OR quiet) NOT VALID;
  END IF;
END
$place_feed_column$;

ALTER TABLE places VALIDATE CONSTRAINT places_feed_needs_quiet;

DO $place_feed_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_attribute attribute
    LEFT JOIN pg_attrdef default_value
      ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
    WHERE attribute.attrelid = 'places'::regclass
      AND attribute.attname = 'feed'
      AND attribute.atttypid = 'boolean'::regtype
      AND attribute.attnotnull
      AND NOT attribute.attisdropped
      AND pg_get_expr(default_value.adbin, default_value.adrelid) = 'false'
  ) THEN
    RAISE EXCEPTION 'places.feed is not the reviewed not-null boolean with default false';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'places'::regclass
      AND conname = 'places_feed_needs_quiet'
      AND contype = 'c'
      AND convalidated
      AND pg_get_constraintdef(oid) = 'CHECK (((NOT feed) OR quiet))'
  ) THEN
    RAISE EXCEPTION 'places_feed_needs_quiet is missing, not validated, or not the reviewed check';
  END IF;
END
$place_feed_shape$;

COMMIT;
