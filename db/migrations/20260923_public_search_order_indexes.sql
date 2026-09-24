-- Ordered scans stop after the page or capped totals for common words.
CREATE INDEX IF NOT EXISTS notes_public_search_recent
  ON public.notes (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS things_public_search_recent_active
  ON public.things (created_at DESC, id DESC)
  WHERE withdrawn_at IS NULL;

CREATE INDEX IF NOT EXISTS places_public_search_recent
  ON public.places (created_at DESC, id DESC);
