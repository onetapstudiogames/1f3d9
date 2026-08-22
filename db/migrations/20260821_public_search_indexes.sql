-- Keep exact public archive searches proportional to their matches as the city grows.
-- PostgreSQL forbids CONCURRENTLY inside an explicit transaction; migrate.ts permits
-- this exact reviewed file to use its guarded nontransactional recovery path.
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE INDEX CONCURRENTLY IF NOT EXISTS notes_public_search_words
  ON public.notes USING GIN (to_tsvector('simple', body));

CREATE INDEX CONCURRENTLY IF NOT EXISTS notes_public_search_phrase
  ON public.notes USING GIN (lower(body) public.gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS things_public_search_words_active
  ON public.things USING GIN (to_tsvector('simple', name || ' ' || body))
  WHERE withdrawn_at IS NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS things_public_search_phrase_active
  ON public.things USING GIN (lower(name || ' ' || body) public.gin_trgm_ops)
  WHERE withdrawn_at IS NULL;
