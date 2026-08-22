-- Keep the bounded presence lookup proportional to the requested residents
-- without taking the longer affordable-reading backfill transaction's lock.
-- PostgreSQL forbids CONCURRENTLY inside an explicit transaction; migrate.ts
-- permits this exact reviewed file to use its dedicated nontransactional path.
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_actor_at_desc ON public.events (actor, at DESC);
