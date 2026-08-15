-- Additive indexes for descending-id public listing pages. Each index matches
-- an equality filter followed by the shared keyset cursor and sort order.
CREATE INDEX IF NOT EXISTS places_parent_id_desc ON places (parent_id, id DESC);

CREATE INDEX IF NOT EXISTS places_owner_id_desc ON places (owner_id, id DESC);

CREATE INDEX IF NOT EXISTS things_place_active_id_desc
  ON things (place_id, id DESC) WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS things_owner_active_id_desc
  ON things (owner_id, id DESC) WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS kinds_owner_id_desc ON kinds (owner_id, id DESC);

CREATE INDEX IF NOT EXISTS notes_place_id_desc ON notes (place_id, id DESC);

CREATE INDEX IF NOT EXISTS notes_author_id_desc ON notes (author_id, id DESC);

CREATE INDEX IF NOT EXISTS events_kind_id_desc ON events (kind, id DESC);

CREATE INDEX IF NOT EXISTS transfer_offers_seller_id_desc
  ON transfer_offers (seller_id, id DESC);

CREATE INDEX IF NOT EXISTS transfer_offers_buyer_id_desc
  ON transfer_offers (buyer_id, id DESC);
