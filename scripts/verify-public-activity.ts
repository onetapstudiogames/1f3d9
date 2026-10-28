import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'
import { Client } from 'pg'
import { requireDirectPostgresUrl, requiredIdentifier, verifyNeonDatabaseTarget } from './database-target.ts'
import { verifyPreviewDatabaseTarget } from './migrate.ts'

type VerificationTarget = Readonly<{
  target: 'preview' | 'production'
  databaseUrl: string
  apiKey: string
  projectId: string
  branchId: string
  productionBranchId: string
}>
type QueryClient = Readonly<{
  query: (statement: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  end: () => Promise<void>
}>
type VerificationOperations = Readonly<{
  fetcher: typeof fetch
  connect: (databaseUrl: string) => Promise<QueryClient>
}>

export function resolvePublicActivityTarget(
  args: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
): VerificationTarget {
  if (args.length !== 2 || args[0] !== '--target' || !['preview', 'production'].includes(args[1] ?? '')) {
    throw new Error('public activity verification requires --target preview|production')
  }
  const target = args[1] as 'preview' | 'production'
  const projectId = requiredIdentifier(environment.NEON_PROJECT_ID, 'NEON_PROJECT_ID')
  const productionBranchId = requiredIdentifier(environment.NEON_PRODUCTION_BRANCH_ID, 'NEON_PRODUCTION_BRANCH_ID')
  const branchId = target === 'production'
    ? productionBranchId
    : requiredIdentifier(environment.NEON_PREVIEW_BRANCH_ID, 'NEON_PREVIEW_BRANCH_ID')
  if (target === 'preview' && branchId === productionBranchId) {
    throw new Error('preview branch must not be the production branch')
  }
  const apiKey = environment.NEON_API_KEY
  if (!apiKey?.trim()) throw new Error('public activity verification requires NEON_API_KEY')
  const variable = target === 'preview' ? 'PREVIEW_DATABASE_URL_UNPOOLED' : 'PRODUCTION_DATABASE_URL_UNPOOLED'
  return Object.freeze({ target, projectId, branchId, productionBranchId, apiKey,
    databaseUrl: requireDirectPostgresUrl(environment[variable], variable) })
}

const migration = readFileSync(new URL('../db/migrations/20261028_stored_public_activity.sql', import.meta.url), 'utf8')
const normalizedSqlType = (value: string) => value.replaceAll('timestamptz', 'timestamp with time zone').replace(/\s+/gu, ' ').trim()
const functionContracts = Object.fromEntries([...migration.matchAll(
  /CREATE OR REPLACE FUNCTION (\w+)\(([\s\S]*?)\)\s*RETURNS ([\s\S]*?)\s+LANGUAGE (\w+)([\s\S]*?)\bAS (\$\w*\$)([\s\S]*?)\6;/gu,
)].map(match => [match[1], {
  args: normalizedSqlType(match[2]!), result: normalizedSqlType(match[3]!), language: match[4],
  volatility: /IMMUTABLE/u.test(match[5]!) ? 'i' : /STABLE/u.test(match[5]!) ? 's' : 'v',
  body: match[7]!.replaceAll('\r\n', '\n').trim(),
}]))
if (Object.keys(functionContracts).length !== 16) throw new Error('public activity reviewed function inventory is incomplete')

const POSTCONDITIONS = `WITH RECURSIVE snapshot_relations(oid) AS (
  SELECT relation.oid FROM pg_class relation
  JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'city_snapshot' AND relation.relkind IN ('v', 'm')
  UNION
  SELECT dependency.refobjid FROM snapshot_relations relation
  JOIN pg_rewrite rewrite ON rewrite.ev_class = relation.oid
  JOIN pg_depend dependency ON dependency.objid = rewrite.oid
    AND dependency.classid = 'pg_rewrite'::regclass AND dependency.refclassid = 'pg_class'::regclass
), activity_columns AS (
  SELECT attribute.attrelid, attribute.attname, attribute.attnum,
    format_type(attribute.atttypid, attribute.atttypmod) AS column_type,
    attribute.attnotnull AS column_required, pg_get_expr(default_value.adbin, default_value.adrelid) AS column_default
  FROM pg_attribute attribute
  LEFT JOIN pg_attrdef default_value ON default_value.adrelid = attribute.attrelid AND default_value.adnum = attribute.attnum
  WHERE attribute.attrelid IN ('residents'::regclass,'places'::regclass,'resident_settings'::regclass)
    AND attribute.attname IN ('show_activity','last_public_action_at') AND NOT attribute.attisdropped
), expected_functions AS (
  SELECT key AS name,value AS contract FROM jsonb_each($1::jsonb)
), summaries AS MATERIALIZED (SELECT * FROM public_activity_summaries()), expected_triggers(name,relation,function_name,type_bits,columns,condition,deferred) AS (
  VALUES ('events_stamp_public_activity','events','stamp_public_activity',5,'','',true),
    ('events_guard_public_activity_time','events','guard_public_activity_time',7,'','',false),
    ('moderation_invalidate_public_activity','moderation_actions','invalidate_public_activity',5,'','',false),
    ('places_invalidate_public_activity','places','invalidate_public_activity',17,'feed','(old.feed IS DISTINCT FROM new.feed)',false),
    ('places_protect_topology_write','places','protect_place_topology',27,'','',false),
    ('places_protect_topology_insert','places','protect_place_topology',7,'','',false),
    ('gazette_submission_room_lifecycle','places','protect_gazette_submission_room',31,'','',false),
    ('places_reject_retired_parent','places','reject_retired_place_target',23,'parent_id,retired_at','',false),
    ('things_reject_retired_place','things','reject_retired_place_target',23,'place_id,withdrawn_at','',false),
    ('notes_reject_retired_place','notes','reject_retired_place_target',23,'place_id','',false),
    ('resident_presence_reject_retired_place','resident_presence','reject_retired_place_target',23,'current_place_id,home_place_id','',false)
), expected_receipt_columns(name,type,default_value,position) AS (
  VALUES ('singleton','boolean','true',1),('migration_identity','text',NULL,2),('schema_version','integer',NULL,3),
    ('cut_change_id','bigint',NULL,4),('backfilled_at','timestamp with time zone',NULL,5),('event_count','bigint',NULL,6),
    ('known_residents','bigint',NULL,7),('known_places','bigint',NULL,8),('no_history_residents','bigint',NULL,9),
    ('no_history_places','bigint',NULL,10),('unproved_residents','bigint',NULL,11),('unproved_places','bigint',NULL,12),
    ('unproved_candidates','bigint',NULL,13),('unproved_reasons','jsonb',NULL,14)
)
SELECT
  (SELECT count(*)=3 AND bool_and(CASE WHEN attname='last_public_action_at'
    THEN attrelid IN ('residents'::regclass,'places'::regclass) AND column_type='timestamp with time zone'
      AND NOT column_required AND column_default IS NULL
    ELSE attrelid='residents'::regclass AND column_type='boolean' AND column_required AND column_default='true' END)
    FROM activity_columns) AS columns_match,
  (SELECT count(*)=1 AND bool_and(singleton AND migration_identity='stored-public-activity' AND schema_version=1
    AND cut_change_id<=(SELECT current_change_id FROM public_change_state WHERE singleton)
    AND cut_change_id>=0 AND isfinite(backfilled_at) AND backfilled_at<=clock_timestamp()
    AND event_count>=0 AND event_count<=(SELECT count(*) FROM events)
    AND known_residents>=0 AND known_places>=0 AND no_history_residents>=0 AND no_history_places>=0
    AND unproved_residents>=0 AND unproved_places>=0 AND unproved_candidates>=0
    AND known_residents+no_history_residents+unproved_residents<=(SELECT count(*) FROM residents)
    AND known_places+no_history_places+unproved_places<=(SELECT count(*) FROM places)
    AND unproved_reasons=jsonb_build_object('missing_changed_or_room_evidence',unproved_candidates)) FROM public_activity_schema_state)
    AND (SELECT count(*)=14 AND coalesce(bool_and(expected.name IS NOT NULL AND attribute.attnum=expected.position AND attribute.attnotnull
      AND format_type(attribute.atttypid,attribute.atttypmod)=expected.type
      AND pg_get_expr(default_.adbin,default_.adrelid) IS NOT DISTINCT FROM expected.default_value),false)
      FROM pg_attribute attribute LEFT JOIN expected_receipt_columns expected ON expected.name=attribute.attname
      LEFT JOIN pg_attrdef default_ ON default_.adrelid=attribute.attrelid AND default_.adnum=attribute.attnum
      WHERE attribute.attrelid='public_activity_schema_state'::regclass AND attribute.attnum>0 AND NOT attribute.attisdropped)
    AND (SELECT count(*)=4 AND count(DISTINCT pg_get_constraintdef(oid))=4 AND bool_and(convalidated AND NOT condeferrable AND pg_get_constraintdef(oid) IN
      ('PRIMARY KEY (singleton)','CHECK (singleton)',
       'CHECK ((migration_identity = ''stored-public-activity''::text))','CHECK ((schema_version = 1))'))
      FROM pg_constraint WHERE conrelid='public_activity_schema_state'::regclass) AS receipt_matches,
  (SELECT count(*)=11 AND coalesce(bool_and(trigger.oid IS NOT NULL AND trigger.tgenabled='O'
    AND trigger.tgrelid=to_regclass('public.' || expected.relation)
    AND trigger.tgfoid=to_regprocedure('public.' || expected.function_name || '()')
    AND trigger.tgtype=expected.type_bits AND trigger.tgdeferrable=expected.deferred AND trigger.tginitdeferred=expected.deferred
    AND trigger.tgnargs=0 AND octet_length(trigger.tgargs)=0
    AND trigger.tgattr::text=CASE WHEN expected.columns='' THEN '' ELSE
      (SELECT string_agg(attribute.attnum::text,' ' ORDER BY listed.position)
        FROM unnest(string_to_array(expected.columns,',')) WITH ORDINALITY listed(name,position)
        JOIN pg_attribute attribute ON attribute.attrelid=trigger.tgrelid
          AND attribute.attname=listed.name AND NOT attribute.attisdropped) END
    AND CASE WHEN expected.condition='' THEN trigger.tgqual IS NULL ELSE
      substring(pg_get_triggerdef(trigger.oid,true) FROM ' WHEN (.*) EXECUTE FUNCTION ')=expected.condition END),false)
    FROM expected_triggers expected LEFT JOIN pg_trigger trigger ON trigger.tgname=expected.name AND NOT trigger.tgisinternal)
    AND NOT EXISTS (SELECT 1 FROM pg_trigger trigger WHERE trigger.tgfoid IN (
      SELECT to_regprocedure('public.' || function_name || '()') FROM expected_triggers)
      AND trigger.tgname NOT IN (SELECT name FROM expected_triggers)) AS triggers_match,
  (SELECT count(*)=16 AND coalesce(bool_and(function.oid IS NOT NULL
      AND btrim(replace(function.prosrc,E'\\r\\n',E'\\n'),E' \\t\\n')=expected.contract->>'body'
      AND pg_get_function_identity_arguments(function.oid)=expected.contract->>'args'
      AND pg_get_function_result(function.oid)=expected.contract->>'result'
      AND (SELECT lanname FROM pg_language WHERE oid=function.prolang)=expected.contract->>'language'
      AND function.provolatile::text=expected.contract->>'volatility'
      AND NOT function.prosecdef AND function.proconfig IS NULL AND NOT function.proisstrict
      AND function.pronargdefaults=0 AND function.proargdefaults IS NULL
      AND function.prokind='f' AND function.proparallel='u' AND NOT function.proleakproof
      AND function.prosupport=0 AND function.procost=100
      AND function.prorows=CASE WHEN expected.contract->>'result' LIKE 'TABLE(%' THEN 1000 ELSE 0 END),false)
    FROM expected_functions expected LEFT JOIN pg_proc function ON function.proname=expected.name
      AND function.pronamespace='public'::regnamespace) AS functions_match,
  NOT EXISTS (SELECT 1 FROM residents resident LEFT JOIN summaries summary ON summary.resident_id=resident.id
    WHERE resident.last_public_action_at IS DISTINCT FROM summary.last_at)
    AND NOT EXISTS (SELECT 1 FROM places room JOIN summaries summary ON room.id=summary.place_id
      WHERE room.last_public_action_at IS DISTINCT FROM summary.last_at) AS summaries_match,
  EXISTS (SELECT 1 FROM snapshot_relations WHERE oid = to_regclass('public.resident_settings')) AS private_settings_exported,
  EXISTS (SELECT 1 FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'city_snapshot' AND relation.relkind IN ('v', 'm')
      AND pg_get_viewdef(relation.oid) ~ '(show_activity|last_active|last_public_action_at|public_activity_schema_state)')
    OR EXISTS (SELECT 1 FROM snapshot_relations relation
      JOIN pg_rewrite rewrite ON rewrite.ev_class=relation.oid
      JOIN pg_depend dependency ON dependency.objid=rewrite.oid AND dependency.classid='pg_rewrite'::regclass
      JOIN activity_columns column_ ON dependency.refobjid=column_.attrelid AND dependency.refobjsubid=column_.attnum)
    OR EXISTS (SELECT 1 FROM snapshot_relations WHERE oid='public_activity_schema_state'::regclass) AS activity_fields_exported,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'city_snapshot_export') AS export_role_exists,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'city_snapshot_export') THEN
    has_table_privilege('city_snapshot_export', 'public.resident_settings', 'SELECT')
    OR has_any_column_privilege('city_snapshot_export', 'public.resident_settings', 'SELECT')
    OR has_table_privilege('city_snapshot_export', 'public.public_activity_schema_state', 'SELECT')
    OR has_any_column_privilege('city_snapshot_export', 'public.public_activity_schema_state', 'SELECT')
    OR EXISTS (SELECT 1 FROM activity_columns WHERE has_column_privilege('city_snapshot_export',attrelid,attnum,'SELECT'))
    OR EXISTS (SELECT 1 FROM expected_functions expected JOIN pg_proc function ON function.proname=expected.name
      AND function.pronamespace='public'::regnamespace WHERE expected.name NOT IN ('protect_place_topology','protect_gazette_submission_room','reject_retired_place_target')
      AND has_function_privilege('city_snapshot_export',function.oid,'EXECUTE'))
    ELSE true END AS export_has_select`

async function connect(databaseUrl: string): Promise<QueryClient> {
  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    return client
  } catch (error) {
    await client.end().catch(() => undefined)
    throw error
  }
}

export async function verifyPublicActivityClient(client: Pick<QueryClient, 'query'>): Promise<void> {
  try {
    await client.query('BEGIN READ ONLY')
    await client.query("SET LOCAL statement_timeout = '30s'")
    const { rows } = await client.query(POSTCONDITIONS, [JSON.stringify(functionContracts)])
    const row = rows[0]
    if (rows.length !== 1 || row?.columns_match !== true || row.receipt_matches !== true
      || row.triggers_match !== true || row.functions_match !== true || row.summaries_match !== true || row.private_settings_exported !== false
      || row.activity_fields_exported !== false || row.export_role_exists !== true || row.export_has_select !== false) {
      throw new Error('public activity postconditions did not match')
    }
    await client.query('COMMIT')
  } catch {
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error('public activity verification failed; no database changes were made')
  }
}

export async function verifyPublicActivity(
  target: VerificationTarget,
  operations: VerificationOperations = { fetcher: fetch, connect },
): Promise<Readonly<{ verified: true; target: 'preview' | 'production' }>> {
  let client: QueryClient | null = null
  try {
    if (target.target === 'preview') {
      await verifyPreviewDatabaseTarget(target, target.databaseUrl, target.apiKey, operations.fetcher)
    } else {
      await verifyNeonDatabaseTarget(target, target.databaseUrl, target.apiKey, 'production', operations.fetcher)
    }
    client = await operations.connect(target.databaseUrl)
    await verifyPublicActivityClient(client)
    return Object.freeze({ verified: true, target: target.target })
  } catch {
    throw new Error('public activity verification failed; no database changes were made')
  } finally {
    await client?.end().catch(() => undefined)
  }
}

async function main(): Promise<void> {
  const target = resolvePublicActivityTarget(process.argv.slice(2), process.env)
  console.log(JSON.stringify(await verifyPublicActivity(target)))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'public activity verification failed')
    process.exitCode = 1
  })
}
