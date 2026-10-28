// Reconstruct the reviewed earlier bytes so upgrade coverage keeps a pinned baseline.
export function earlierStoredActivityMigration(migration: string): string {
  const columns = migration.match(/ALTER TABLE residents ADD COLUMN IF NOT EXISTS last_public_action_at[\s\S]*?(?=DROP TRIGGER IF EXISTS events_guard_public_activity_time)/u)?.[0]
  if (!columns) throw new Error('stored activity column block is missing')
  return migration
    .replace(/CREATE OR REPLACE FUNCTION public_activity_history\(\)[\s\S]*?(?=CREATE OR REPLACE FUNCTION public_activity_summaries)/u, `CREATE OR REPLACE FUNCTION public_activity_history()
RETURNS TABLE(event_at timestamptz, actor_handle text, place_id integer, proved boolean)
LANGUAGE sql STABLE AS $f$
  SELECT event.at,activity.actor_handle,activity.place_id,activity.proved FROM events event
  CROSS JOIN LATERAL public_activity_candidates(event.id,event.kind,event.actor,event.detail) activity
$f$;

`)
    .replace(/DO \$backfill\$[\s\S]*?(?=DROP TRIGGER IF EXISTS events_guard_public_activity_time)/u, '')
    .replace('CREATE TABLE IF NOT EXISTS public_activity_schema_state', columns + 'CREATE TABLE IF NOT EXISTS public_activity_schema_state')
    .replace(/-- The expensive work is complete;[\s\S]*?(?=REVOKE ALL ON FUNCTION)/u, `DO $backfill$
DECLARE counts jsonb;
BEGIN
  IF EXISTS (SELECT 1 FROM public_activity_schema_state) THEN
    IF (SELECT count(*) FROM public_activity_schema_state WHERE singleton AND schema_version=1
      AND migration_identity='stored-public-activity')<>1 THEN RAISE EXCEPTION 'stored activity receipt mismatch'; END IF;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM events WHERE public_activity_potential_kind(kind)
    AND (NOT isfinite(at) OR at>clock_timestamp() + interval '5 seconds')) THEN
    RAISE EXCEPTION 'public activity backfill has future or non-finite history';
  END IF;
  counts := recompute_public_activity(NULL,NULL,NULL);
  INSERT INTO public_activity_schema_state
  SELECT true,'stored-public-activity',1,(SELECT current_change_id FROM public_change_state WHERE singleton),
    statement_timestamp(),(SELECT count(*) FROM events),
    (counts->>'known_residents')::bigint,(counts->>'known_places')::bigint,
    (counts->>'no_history_residents')::bigint,(counts->>'no_history_places')::bigint,
    (counts->>'unproved_residents')::bigint,(counts->>'unproved_places')::bigint,
    (counts->>'unproved_candidates')::bigint,
    jsonb_build_object('missing_changed_or_room_evidence',(counts->>'unproved_candidates')::bigint);
END $backfill$;

`)
}
