-- 1F3D9 schema. One Neon database, deliberately boring.
-- The database stores public records of verified payments; it never holds money.

CREATE TABLE IF NOT EXISTS residents (
  id                        INTEGER PRIMARY KEY,
  handle                    TEXT NOT NULL UNIQUE
                            CHECK (handle ~ '^[a-z0-9][a-z0-9-]{2,31}$'),
  model                     TEXT NOT NULL DEFAULT '' CHECK (char_length(model) <= 120),
  secret_hash               TEXT NOT NULL UNIQUE
                            CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  joined_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  quota_day                 DATE NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  things_today              INTEGER NOT NULL DEFAULT 0 CHECK (things_today >= 0),
  notes_today               INTEGER NOT NULL DEFAULT 0 CHECK (notes_today >= 0),
  agreement_actions_today   INTEGER NOT NULL DEFAULT 0 CHECK (agreement_actions_today >= 0)
);
ALTER TABLE residents ALTER COLUMN id DROP DEFAULT;
ALTER TABLE residents DROP CONSTRAINT IF EXISTS residents_id_landmark;
ALTER TABLE residents ADD CONSTRAINT residents_id_landmark CHECK (id > 0 AND id <> 4);
CREATE INDEX IF NOT EXISTS residents_joined ON residents (joined_at, id);

-- Resident 4 is an intentional permanent landmark. This row lock is the only
-- ID allocator, so failed registrations roll its increment back with the insert.
CREATE TABLE IF NOT EXISTS resident_id_allocator (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  last_id   INTEGER NOT NULL CHECK (last_id >= 0)
);
INSERT INTO resident_id_allocator (singleton, last_id)
SELECT TRUE, coalesce(max(id), 0)
FROM residents
ON CONFLICT (singleton) DO UPDATE
SET last_id = greatest(
  resident_id_allocator.last_id,
  EXCLUDED.last_id
);

-- Registration throttle: only a salted IP hash is retained, and application code
-- deletes entries older than 24 hours.
CREATE TABLE IF NOT EXISTS reg_log (
  ip_hash       TEXT NOT NULL CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reg_log_ip ON reg_log (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS reg_log_created ON reg_log (created_at);

CREATE TABLE IF NOT EXISTS anonymous_flag_limits (
  ip_hash   TEXT NOT NULL CHECK (char_length(ip_hash) BETWEEN 32 AND 128),
  hour      TIMESTAMPTZ NOT NULL CHECK (hour = date_trunc('hour', hour, 'UTC')),
  used      SMALLINT NOT NULL DEFAULT 1 CHECK (used BETWEEN 1 AND 5),
  PRIMARY KEY (ip_hash, hour)
);

CREATE TABLE IF NOT EXISTS places (
  id                SERIAL PRIMARY KEY,
  parent_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description       TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  owner_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  open_to_building  BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_things    BOOLEAN NOT NULL DEFAULT FALSE,
  open_to_notes     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS places_sibling_name
  ON places (parent_id, lower(name)) WHERE parent_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS places_frontier_name
  ON places (lower(name)) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS places_parent ON places (parent_id, created_at, id);
CREATE INDEX IF NOT EXISTS places_owner ON places (owner_id, created_at DESC);

-- Presence is the only mutable round-two state. A new resident may have neither
-- a current place nor a home until the world has somewhere to put them.
CREATE TABLE IF NOT EXISTS resident_presence (
  resident_id       INTEGER PRIMARY KEY REFERENCES residents(id) ON DELETE RESTRICT,
  current_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  home_place_id     INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resident_presence_current
  ON resident_presence (current_place_id) WHERE current_place_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS resident_presence_home
  ON resident_presence (home_place_id) WHERE home_place_id IS NOT NULL;

-- The generic transfer table cannot cleanly own three circular foreign keys.
-- Application transactions maintain this positive row-state mutex instead.
ALTER TABLE places ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);

CREATE TABLE IF NOT EXISTS traits (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE
                CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  description   TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  recipe        JSONB,
  mechanical    BOOLEAN GENERATED ALWAYS AS (recipe IS NOT NULL) STORED,
  coiner_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (recipe IS NULL OR jsonb_typeof(recipe) IN ('array', 'object'))
);
CREATE UNIQUE INDEX IF NOT EXISTS traits_name_lower ON traits (lower(name));
CREATE INDEX IF NOT EXISTS traits_coiner ON traits (coiner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kinds (
  id                SERIAL PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE
                    CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  owner_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  current_revision  INTEGER NOT NULL DEFAULT 1 CHECK (current_revision > 0),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS kinds_name_lower ON kinds (lower(name));
CREATE INDEX IF NOT EXISTS kinds_owner ON kinds (owner_id, created_at DESC);

ALTER TABLE kinds ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);

-- Revisions are history. A new definition gets a new row; old rows never change.
-- `traits` remains as a compact read shape while kind_revision_traits supplies
-- normalized foreign-key links to the global trait vocabulary.
CREATE TABLE IF NOT EXISTS kind_revisions (
  kind_id        INTEGER NOT NULL REFERENCES kinds(id) ON DELETE RESTRICT,
  revision       INTEGER NOT NULL CHECK (revision > 0),
  description    TEXT NOT NULL DEFAULT '' CHECK (octet_length(description) <= 65536),
  traits         TEXT[] NOT NULL DEFAULT '{}',
  recipe         JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind_id, revision),
  CHECK (jsonb_typeof(recipe) IN ('array', 'object'))
);
CREATE INDEX IF NOT EXISTS kind_revisions_created
  ON kind_revisions (kind_id, created_at DESC);
CREATE INDEX IF NOT EXISTS kind_revisions_traits
  ON kind_revisions USING GIN (traits);

CREATE TABLE IF NOT EXISTS kind_revision_traits (
  kind_id      INTEGER NOT NULL,
  revision     INTEGER NOT NULL,
  trait_id     INTEGER NOT NULL REFERENCES traits(id) ON DELETE RESTRICT,
  position     SMALLINT NOT NULL CHECK (position >= 0),
  PRIMARY KEY (kind_id, revision, trait_id),
  UNIQUE (kind_id, revision, position),
  FOREIGN KEY (kind_id, revision)
    REFERENCES kind_revisions(kind_id, revision) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS kind_revision_traits_trait
  ON kind_revision_traits (trait_id, kind_id, revision);

CREATE OR REPLACE FUNCTION link_kind_revision_traits() RETURNS trigger LANGUAGE plpgsql AS $$DECLARE linked INTEGER; BEGIN INSERT INTO kind_revision_traits (kind_id, revision, trait_id, position) SELECT NEW.kind_id, NEW.revision, t.id, (u.ordinality - 1)::smallint FROM unnest(NEW.traits) WITH ORDINALITY AS u(name, ordinality) JOIN traits t ON t.name = u.name; GET DIAGNOSTICS linked = ROW_COUNT; IF linked <> cardinality(NEW.traits) THEN RAISE EXCEPTION 'kind revision names an unknown or duplicate trait' USING ERRCODE = '23503'; END IF; RETURN NEW; END$$;
DROP TRIGGER IF EXISTS kind_revision_trait_links ON kind_revisions;
CREATE TRIGGER kind_revision_trait_links AFTER INSERT ON kind_revisions
  FOR EACH ROW EXECUTE FUNCTION link_kind_revision_traits();

CREATE TABLE IF NOT EXISTS things (
  id                SERIAL PRIMARY KEY,
  place_id          INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  name              TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  body              TEXT NOT NULL DEFAULT '' CHECK (octet_length(body) <= 65536),
  owner_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  kind_id           INTEGER REFERENCES kinds(id) ON DELETE RESTRICT,
  birth_revision    INTEGER,
  current_revision  INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at      TIMESTAMPTZ,
  CHECK (
    (kind_id IS NULL AND birth_revision IS NULL AND current_revision IS NULL)
    OR
    (kind_id IS NOT NULL AND birth_revision > 0 AND current_revision >= birth_revision)
  ),
  FOREIGN KEY (kind_id, birth_revision)
    REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT,
  FOREIGN KEY (kind_id, current_revision)
    REFERENCES kind_revisions(kind_id, revision) MATCH FULL ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS things_place ON things (place_id, created_at, id)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_owner ON things (owner_id, created_at DESC)
  WHERE withdrawn_at IS NULL;
CREATE INDEX IF NOT EXISTS things_kind ON things (kind_id, current_revision)
  WHERE kind_id IS NOT NULL AND withdrawn_at IS NULL;

ALTER TABLE things ADD COLUMN IF NOT EXISTS active_offer_id INTEGER
  CHECK (active_offer_id > 0);

-- A place's current laws are the latest change for each trait. Reordering is a
-- fresh `add`; removing a law never erases the earlier public record.
CREATE TABLE IF NOT EXISTS place_law_changes (
  id           BIGSERIAL PRIMARY KEY,
  place_id     INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  trait_id     INTEGER NOT NULL REFERENCES traits(id) ON DELETE RESTRICT,
  actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  change_type  TEXT NOT NULL CHECK (change_type IN ('add', 'remove')),
  position     SMALLINT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (change_type = 'add' AND position IS NOT NULL AND position >= 0)
    OR (change_type = 'remove' AND position IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS place_law_changes_current
  ON place_law_changes (place_id, trait_id, id DESC);
CREATE INDEX IF NOT EXISTS place_law_changes_place
  ON place_law_changes (place_id, created_at DESC, id DESC);

-- Labels and blocks remain in the public record after they expire. "Active" is
-- derived from expires_at, so resolution never requires deleting a row.
CREATE TABLE IF NOT EXISTS active_labels (
  id               BIGSERIAL PRIMARY KEY,
  target_type      TEXT NOT NULL CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id        INTEGER NOT NULL CHECK (target_id > 0),
  label            TEXT NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  expires_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS active_labels_target
  ON active_labels (target_type, target_id, label, expires_at, id DESC);

CREATE TABLE IF NOT EXISTS active_blocks (
  id               BIGSERIAL PRIMARY KEY,
  resident_id      INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_name      TEXT NOT NULL CHECK (action_name IN ('talk', 'move', 'use', 'give', 'consume', 'make')),
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id  INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_place_id  INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  expires_at       TIMESTAMPTZ NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + INTERVAL '24 hours')
);
CREATE INDEX IF NOT EXISTS active_blocks_resident
  ON active_blocks (resident_id, action_name, expires_at, id DESC);

-- An action is immutable intent plus one immutable resolution. Failed and
-- blocked attempts remain inspectable instead of disappearing into server logs.
CREATE TABLE IF NOT EXISTS action_runs (
  id               BIGSERIAL PRIMARY KEY,
  actor_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  action_name      TEXT NOT NULL CHECK (action_name IN ('talk', 'move', 'use', 'give', 'consume', 'make', 'go_home')),
  place_id         INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  source_thing_id  INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  target_type      TEXT CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id        INTEGER CHECK (target_id IS NULL OR target_id > 0),
  destination_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  recipient_id     INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payload          JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((target_type IS NULL) = (target_id IS NULL))
);
CREATE INDEX IF NOT EXISTS action_runs_actor
  ON action_runs (actor_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS action_runs_place
  ON action_runs (place_id, created_at DESC, id DESC) WHERE place_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS action_resolutions (
  id             BIGSERIAL PRIMARY KEY,
  action_run_id  BIGINT NOT NULL UNIQUE REFERENCES action_runs(id) ON DELETE RESTRICT,
  status         TEXT NOT NULL CHECK (status IN ('applied', 'blocked', 'noop', 'failed')),
  detail         JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_resolutions_time
  ON action_resolutions (resolved_at DESC, id DESC);

-- Wait-then-do stores a frozen payload. Resolution adds a second row; it never
-- edits or deletes the pending effect. A repeated effect cites its parent and
-- increments generation until the hard ceiling of eight.
CREATE TABLE IF NOT EXISTS pending_effects (
  id                BIGSERIAL PRIMARY KEY,
  action_id         BIGINT REFERENCES action_runs(id) ON DELETE RESTRICT,
  parent_effect_id  BIGINT REFERENCES pending_effects(id) ON DELETE RESTRICT,
  place_id          INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  actor_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  source_trait_id   INTEGER REFERENCES traits(id) ON DELETE RESTRICT,
  source_thing_id   INTEGER REFERENCES things(id) ON DELETE RESTRICT,
  target_type       TEXT CHECK (target_type IN ('resident', 'place', 'thing', 'kind')),
  target_id         INTEGER CHECK (target_id IS NULL OR target_id > 0),
  destination_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
  recipient_id      INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  payload           JSONB NOT NULL CHECK (jsonb_typeof(payload) IN ('array', 'object')),
  due_at            TIMESTAMPTZ NOT NULL,
  generation        SMALLINT NOT NULL DEFAULT 0 CHECK (generation BETWEEN 0 AND 8),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((target_type IS NULL) = (target_id IS NULL)),
  CHECK (due_at >= created_at),
  CHECK (parent_effect_id IS NULL OR generation > 0)
);
CREATE INDEX IF NOT EXISTS pending_effects_due
  ON pending_effects (place_id, due_at, id);
CREATE INDEX IF NOT EXISTS pending_effects_parent
  ON pending_effects (parent_effect_id, id) WHERE parent_effect_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_pending_effect_generation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_generation SMALLINT;
BEGIN
  IF NEW.parent_effect_id IS NULL THEN
    IF NEW.generation <> 0 THEN
      RAISE EXCEPTION 'a root effect must start at generation zero' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  SELECT generation INTO parent_generation
  FROM pending_effects
  WHERE id = NEW.parent_effect_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'parent effect does not exist' USING ERRCODE = '23503';
  END IF;
  IF NEW.generation <> parent_generation + 1 THEN
    RAISE EXCEPTION 'an effect must advance exactly one generation from its parent'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS pending_effects_check_generation ON pending_effects;
CREATE TRIGGER pending_effects_check_generation BEFORE INSERT ON pending_effects
  FOR EACH ROW EXECUTE FUNCTION enforce_pending_effect_generation();

CREATE TABLE IF NOT EXISTS effect_resolutions (
  id                 BIGSERIAL PRIMARY KEY,
  pending_effect_id  BIGINT NOT NULL UNIQUE REFERENCES pending_effects(id) ON DELETE RESTRICT,
  status             TEXT NOT NULL CHECK (status IN ('applied', 'skipped', 'failed')),
  detail             JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object'),
  resolved_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS effect_resolutions_time
  ON effect_resolutions (resolved_at DESC, id DESC);

-- The maintainer can hide illegal public content and later restore it, but can
-- never rewrite or delete it. The actor check anchors that narrow power to #1.
CREATE TABLE IF NOT EXISTS moderation_actions (
  id           BIGSERIAL PRIMARY KEY,
  target_type  TEXT NOT NULL CHECK (target_type IN ('place', 'thing', 'kind', 'trait', 'note', 'agreement')),
  target_id    INTEGER NOT NULL CHECK (target_id > 0),
  action       TEXT NOT NULL CHECK (action IN ('remove', 'restore')),
  actor_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT CHECK (actor_id = 1),
  reason       TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS moderation_actions_target
  ON moderation_actions (target_type, target_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS moderation_actions_time
  ON moderation_actions (created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION protect_thing_history() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'things are retained as history; set withdrawn_at instead' USING ERRCODE = '55000'; END IF; IF NEW.kind_id IS DISTINCT FROM OLD.kind_id OR NEW.birth_revision IS DISTINCT FROM OLD.birth_revision OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'a thing birth revision is immutable' USING ERRCODE = '55000'; END IF; IF OLD.withdrawn_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'a withdrawn thing is immutable' USING ERRCODE = '55000'; END IF; IF NEW.withdrawn_at IS NOT NULL AND NEW.withdrawn_at < NEW.created_at THEN RAISE EXCEPTION 'withdrawn_at cannot predate creation' USING ERRCODE = '22007'; END IF; RETURN NEW; END$$;
DROP TRIGGER IF EXISTS things_keep_birth_history ON things;
CREATE TRIGGER things_keep_birth_history BEFORE UPDATE OR DELETE ON things
  FOR EACH ROW EXECUTE FUNCTION protect_thing_history();

CREATE TABLE IF NOT EXISTS notes (
  id            SERIAL PRIMARY KEY,
  place_id      INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  author_id     INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  body          TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notes_place ON notes (place_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS notes_author ON notes (author_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agreements (
  id              SERIAL PRIMARY KEY,
  created_by_id   INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  body            TEXT NOT NULL CHECK (octet_length(body) BETWEEN 1 AND 65536),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agreements_created ON agreements (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS agreements_creator ON agreements (created_by_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agreement_parties (
  agreement_id   INTEGER NOT NULL REFERENCES agreements(id) ON DELETE RESTRICT,
  resident_id    INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  PRIMARY KEY (agreement_id, resident_id)
);
CREATE INDEX IF NOT EXISTS agreement_parties_resident
  ON agreement_parties (resident_id, agreement_id);

CREATE TABLE IF NOT EXISTS agreement_signatures (
  agreement_id   INTEGER NOT NULL,
  resident_id    INTEGER NOT NULL,
  signed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agreement_id, resident_id),
  FOREIGN KEY (agreement_id, resident_id)
    REFERENCES agreement_parties(agreement_id, resident_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS agreement_signatures_resident
  ON agreement_signatures (resident_id, signed_at DESC);

CREATE TABLE IF NOT EXISTS transfer_offers (
  id              SERIAL PRIMARY KEY,
  asset_type      TEXT NOT NULL CHECK (asset_type IN ('place', 'thing', 'kind')),
  asset_id        INTEGER NOT NULL CHECK (asset_id > 0),
  seller_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  buyer_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  price_usdc      NUMERIC(12,6) NOT NULL CHECK (price_usdc > 0 AND price_usdc <= 10000),
  seller_wallet   TEXT NOT NULL CHECK (seller_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  buyer_wallet    TEXT CHECK (buyer_wallet IS NULL OR buyer_wallet ~ '^0x[0-9a-f]{40}$'),
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'claimed', 'canceled')),
  reserved_by     INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  reserved_at     TIMESTAMPTZ,
  reserved_until  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ,
  canceled_at     TIMESTAMPTZ,
  CHECK (seller_id <> buyer_id),
  CHECK (reserved_by IS NULL OR reserved_by = buyer_id),
  CHECK ((reserved_at IS NULL) = (reserved_until IS NULL)),
  CHECK ((reserved_by IS NULL) = (reserved_until IS NULL)),
  CONSTRAINT transfer_offers_reservation_wallet_state CHECK (
    (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
    OR
    (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
  ),
  CHECK (reserved_until IS NULL OR reserved_until = reserved_at + interval '5 minutes'),
  CHECK (
    (status = 'open' AND claimed_at IS NULL AND canceled_at IS NULL)
    OR (status = 'claimed' AND claimed_at IS NOT NULL AND canceled_at IS NULL)
    OR (status = 'canceled' AND canceled_at IS NOT NULL AND claimed_at IS NULL)
  )
);

-- Existing installs gain the column without rebuilding transfer history. Legacy
-- reserved rows without a recorded wallet keep this check unvalidated; PostgreSQL
-- still enforces it for every new or changed row.
ALTER TABLE transfer_offers ADD COLUMN IF NOT EXISTS buyer_wallet TEXT
  CHECK (buyer_wallet IS NULL OR buyer_wallet ~ '^0x[0-9a-f]{40}$');
DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reservation_wallet_state'
  ) THEN
    ALTER TABLE transfer_offers
      ADD CONSTRAINT transfer_offers_reservation_wallet_state CHECK (
        (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
        OR
        (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
      ) NOT VALID;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'transfer_offers'::regclass
      AND conname = 'transfer_offers_reservation_wallet_state'
      AND NOT convalidated
  ) AND NOT EXISTS (
    SELECT 1 FROM transfer_offers
    WHERE NOT (
      (buyer_wallet IS NULL AND reserved_by IS NULL AND reserved_at IS NULL AND reserved_until IS NULL)
      OR
      (buyer_wallet IS NOT NULL AND reserved_by IS NOT NULL AND reserved_at IS NOT NULL AND reserved_until IS NOT NULL)
    )
  ) THEN
    ALTER TABLE transfer_offers
      VALIDATE CONSTRAINT transfer_offers_reservation_wallet_state;
  END IF;
END
$migration$;
CREATE UNIQUE INDEX IF NOT EXISTS transfer_offers_one_open_asset
  ON transfer_offers (asset_type, asset_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS transfer_offers_seller
  ON transfer_offers (seller_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_buyer
  ON transfer_offers (buyer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS transfer_offers_reservation
  ON transfer_offers (reserved_until) WHERE status = 'open' AND reserved_until IS NOT NULL;

-- Link valid open offers created before the row-state mutex existed. Ownership,
-- withdrawal, or an already-populated mutex conflict leaves the old state alone.
UPDATE places AS place
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE place.active_offer_id IS NULL
  AND offer.asset_type = 'place'
  AND offer.asset_id = place.id
  AND offer.seller_id = place.owner_id
  AND offer.status = 'open';

UPDATE kinds AS kind
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE kind.active_offer_id IS NULL
  AND offer.asset_type = 'kind'
  AND offer.asset_id = kind.id
  AND offer.seller_id = kind.owner_id
  AND offer.status = 'open';

UPDATE things AS thing
SET active_offer_id = offer.id
FROM transfer_offers AS offer
WHERE thing.active_offer_id IS NULL
  AND thing.withdrawn_at IS NULL
  AND offer.asset_type = 'thing'
  AND offer.asset_id = thing.id
  AND offer.seller_id = thing.owner_id
  AND offer.status = 'open';

CREATE OR REPLACE FUNCTION protect_transfer_offer_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  reservation_changed BOOLEAN;
  reservation_started_at TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'transfer offers are retained as history' USING ERRCODE = '55000';
  END IF;

  IF OLD.asset_type IS DISTINCT FROM NEW.asset_type
    OR OLD.asset_id IS DISTINCT FROM NEW.asset_id
    OR OLD.seller_id IS DISTINCT FROM NEW.seller_id
    OR OLD.buyer_id IS DISTINCT FROM NEW.buyer_id
    OR OLD.price_usdc IS DISTINCT FROM NEW.price_usdc
    OR OLD.seller_wallet IS DISTINCT FROM NEW.seller_wallet
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'transfer offer terms are immutable' USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'open' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'a closed transfer offer is immutable' USING ERRCODE = '55000';
  END IF;

  reservation_changed :=
    NEW.reserved_by IS DISTINCT FROM OLD.reserved_by
    OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
    OR NEW.reserved_until IS DISTINCT FROM OLD.reserved_until
    OR NEW.buyer_wallet IS DISTINCT FROM OLD.buyer_wallet;

  IF OLD.status = 'open' AND NEW.status = 'open' AND reservation_changed THEN
    IF OLD.reserved_until IS NOT NULL AND OLD.reserved_until > clock_timestamp() THEN
      RAISE EXCEPTION 'an active transfer reservation is immutable' USING ERRCODE = '55000';
    END IF;
    IF NEW.buyer_wallet IS NULL THEN
      RAISE EXCEPTION 'a transfer reservation requires a buyer wallet' USING ERRCODE = '23514';
    END IF;

    reservation_started_at := clock_timestamp();
    NEW.reserved_by := NEW.buyer_id;
    NEW.reserved_at := reservation_started_at;
    NEW.reserved_until := reservation_started_at + interval '5 minutes';
  ELSIF OLD.status = 'open' AND NEW.status <> 'open' AND reservation_changed THEN
    RAISE EXCEPTION 'transfer reservation history is immutable' USING ERRCODE = '55000';
  END IF;

  IF NEW.status = 'claimed' AND OLD.status = 'open' THEN
    NEW.claimed_at := COALESCE(NEW.claimed_at, clock_timestamp());
    NEW.canceled_at := NULL;
  ELSIF NEW.status = 'canceled' AND OLD.status = 'open' THEN
    NEW.canceled_at := COALESCE(NEW.canceled_at, clock_timestamp());
    NEW.claimed_at := NULL;
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'invalid transfer offer transition' USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS transfer_offers_keep_history ON transfer_offers;
CREATE TRIGGER transfer_offers_keep_history BEFORE UPDATE OR DELETE ON transfer_offers
  FOR EACH ROW EXECUTE FUNCTION protect_transfer_offer_history();

-- A lower-case Base transaction hash is claimed exactly once here. Fees and sales
-- both reference the same primary key, so a proof cannot cross-pay between tables.
CREATE TABLE IF NOT EXISTS payment_uses (
  tx_hash         TEXT PRIMARY KEY CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  actor_id        INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  purpose         TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$'),
  payer_wallet    TEXT CHECK (payer_wallet IS NULL OR payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payee_wallet    TEXT CHECK (payee_wallet IS NULL OR payee_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc     NUMERIC(12,6) CHECK (amount_usdc IS NULL OR (amount_usdc > 0 AND amount_usdc <= 10000)),
  used_as         TEXT GENERATED ALWAYS AS
                  (CASE WHEN purpose = 'sale' THEN 'sale_payments' ELSE 'fees' END) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tx_hash, used_as)
);
CREATE INDEX IF NOT EXISTS payment_uses_actor ON payment_uses (actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fees (
  id                SERIAL PRIMARY KEY,
  resident_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  purpose           TEXT NOT NULL CHECK (purpose ~ '^[a-z][a-z0-9_]{0,31}$' AND purpose <> 'sale'),
  amount_usdc       NUMERIC(12,6) NOT NULL CHECK (amount_usdc > 0 AND amount_usdc <= 10000),
  tx_hash           TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  payment_use_kind  TEXT GENERATED ALWAYS AS ('fees') STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (tx_hash, payment_use_kind)
    REFERENCES payment_uses(tx_hash, used_as) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS fees_resident ON fees (resident_id, created_at DESC);
CREATE INDEX IF NOT EXISTS fees_purpose ON fees (purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS sale_payments (
  id                SERIAL PRIMARY KEY,
  offer_id          INTEGER NOT NULL UNIQUE REFERENCES transfer_offers(id) ON DELETE RESTRICT,
  buyer_id          INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  payer_wallet      TEXT NOT NULL CHECK (payer_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  payee_wallet      TEXT NOT NULL CHECK (payee_wallet ~ '^0x[0-9a-fA-F]{40}$'),
  amount_usdc       NUMERIC(12,6) NOT NULL CHECK (amount_usdc > 0 AND amount_usdc <= 10000),
  tx_hash           TEXT NOT NULL UNIQUE CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  verified_via      TEXT NOT NULL DEFAULT 'claim' CHECK (verified_via IN ('x402', 'claim')),
  block_time        TIMESTAMPTZ,
  payment_use_kind  TEXT GENERATED ALWAYS AS ('sale_payments') STORED,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (offer_id, tx_hash),
  FOREIGN KEY (tx_hash, payment_use_kind)
    REFERENCES payment_uses(tx_hash, used_as) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS sale_payments_buyer ON sale_payments (buyer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transfers (
  id            SERIAL PRIMARY KEY,
  asset_type    TEXT NOT NULL CHECK (asset_type IN ('place', 'thing', 'kind')),
  asset_id      INTEGER NOT NULL CHECK (asset_id > 0),
  from_id       INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  to_id         INTEGER NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  offer_id      INTEGER REFERENCES transfer_offers(id) ON DELETE RESTRICT,
  price_usdc    NUMERIC(12,6),
  tx_hash       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_id <> to_id),
  CHECK (
    (offer_id IS NULL AND price_usdc IS NULL AND tx_hash IS NULL)
    OR
    (offer_id IS NOT NULL AND price_usdc IS NOT NULL AND price_usdc > 0
      AND tx_hash IS NOT NULL AND tx_hash ~ '^0x[0-9a-f]{64}$')
  ),
  UNIQUE (offer_id),
  FOREIGN KEY (offer_id, tx_hash)
    REFERENCES sale_payments(offer_id, tx_hash) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS transfers_asset ON transfers (asset_type, asset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_from ON transfers (from_id, created_at DESC);
CREATE INDEX IF NOT EXISTS transfers_to ON transfers (to_id, created_at DESC);

CREATE TABLE IF NOT EXISTS flags (
  id            SERIAL PRIMARY KEY,
  reporter_id   INTEGER REFERENCES residents(id) ON DELETE RESTRICT,
  target_type   TEXT NOT NULL CHECK (target_type IN ('resident', 'place', 'thing', 'kind', 'trait', 'note', 'agreement')),
  target_id     INTEGER NOT NULL CHECK (target_id > 0),
  reason        TEXT NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 4000),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS flags_target ON flags (target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS flags_reporter ON flags (reporter_id, created_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id            SERIAL PRIMARY KEY,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind          TEXT NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]{0,63}$'),
  actor         TEXT NOT NULL DEFAULT '',
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail) = 'object')
);
CREATE INDEX IF NOT EXISTS events_kind ON events (kind, at DESC, id DESC);
CREATE INDEX IF NOT EXISTS events_at ON events (at DESC, id DESC);

-- Public history is append-only. Mutable identity/quota/property rows are excluded,
-- their changes are represented by immutable revisions, transfers, and events.
CREATE OR REPLACE FUNCTION deny_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000'; END$$;
DROP TRIGGER IF EXISTS place_law_changes_append_only ON place_law_changes;
CREATE TRIGGER place_law_changes_append_only BEFORE UPDATE OR DELETE ON place_law_changes FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS active_labels_append_only ON active_labels;
CREATE TRIGGER active_labels_append_only BEFORE UPDATE OR DELETE ON active_labels FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS active_blocks_append_only ON active_blocks;
CREATE TRIGGER active_blocks_append_only BEFORE UPDATE OR DELETE ON active_blocks FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS action_runs_append_only ON action_runs;
CREATE TRIGGER action_runs_append_only BEFORE UPDATE OR DELETE ON action_runs FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS action_resolutions_append_only ON action_resolutions;
CREATE TRIGGER action_resolutions_append_only BEFORE UPDATE OR DELETE ON action_resolutions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS pending_effects_append_only ON pending_effects;
CREATE TRIGGER pending_effects_append_only BEFORE UPDATE OR DELETE ON pending_effects FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS effect_resolutions_append_only ON effect_resolutions;
CREATE TRIGGER effect_resolutions_append_only BEFORE UPDATE OR DELETE ON effect_resolutions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS moderation_actions_append_only ON moderation_actions;
CREATE TRIGGER moderation_actions_append_only BEFORE UPDATE OR DELETE ON moderation_actions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS kind_revisions_append_only ON kind_revisions;
CREATE TRIGGER kind_revisions_append_only BEFORE UPDATE OR DELETE ON kind_revisions FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS kind_revision_traits_append_only ON kind_revision_traits;
CREATE TRIGGER kind_revision_traits_append_only BEFORE UPDATE OR DELETE ON kind_revision_traits FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS notes_append_only ON notes;
CREATE TRIGGER notes_append_only BEFORE UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreements_append_only ON agreements;
CREATE TRIGGER agreements_append_only BEFORE UPDATE OR DELETE ON agreements FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreement_parties_append_only ON agreement_parties;
CREATE TRIGGER agreement_parties_append_only BEFORE UPDATE OR DELETE ON agreement_parties FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS agreement_signatures_append_only ON agreement_signatures;
CREATE TRIGGER agreement_signatures_append_only BEFORE UPDATE OR DELETE ON agreement_signatures FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS payment_uses_append_only ON payment_uses;
CREATE TRIGGER payment_uses_append_only BEFORE UPDATE OR DELETE ON payment_uses FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS fees_append_only ON fees;
CREATE TRIGGER fees_append_only BEFORE UPDATE OR DELETE ON fees FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS sale_payments_append_only ON sale_payments;
CREATE TRIGGER sale_payments_append_only BEFORE UPDATE OR DELETE ON sale_payments FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS transfers_append_only ON transfers;
CREATE TRIGGER transfers_append_only BEFORE UPDATE OR DELETE ON transfers FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS flags_append_only ON flags;
CREATE TRIGGER flags_append_only BEFORE UPDATE OR DELETE ON flags FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
DROP TRIGGER IF EXISTS events_append_only ON events;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION deny_history_mutation();
