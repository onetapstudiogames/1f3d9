type ActivityScope = Readonly<{ installed: boolean }>

function scopeSql(installed: boolean): string {
  return installed
    ? 'SELECT resident_id,place_id FROM public_activity_invalidation_scope($1,$2,$3)'
    : `SELECT $1::integer AS resident_id,NULL::integer AS place_id
      UNION SELECT NULL::integer,id FROM places WHERE $2::text='place' AND id=$3::integer`
}

function scopeCtes(installed: boolean, acquire: boolean): string {
  return `activity_scope AS MATERIALIZED (${scopeSql(installed)}),
    activity_resident_locks AS MATERIALIZED (
      SELECT resident.id FROM residents resident
      WHERE resident.id=$1 OR EXISTS (SELECT 1 FROM activity_scope scope WHERE scope.resident_id=resident.id)
      ORDER BY resident.id ${acquire ? 'FOR NO KEY UPDATE OF resident' : ''}
    ), activity_place_depths AS MATERIALIZED (
      WITH RECURSIVE tree AS (
        SELECT place.id AS origin,place.id,place.parent_id,0 AS up FROM places place
        WHERE EXISTS (SELECT 1 FROM activity_scope scope WHERE scope.place_id=place.id)
        UNION ALL SELECT tree.origin,parent.id,parent.parent_id,tree.up+1
        FROM tree JOIN places parent ON parent.id=tree.parent_id
      ) SELECT origin,max(up) AS depth FROM tree GROUP BY origin
    ), activity_place_locks AS MATERIALIZED (
      SELECT place.id FROM places place JOIN activity_place_depths planned ON planned.origin=place.id
      WHERE true
        AND (SELECT count(*) FROM activity_resident_locks)>=0
      ORDER BY planned.depth,place.id ${acquire ? 'FOR NO KEY UPDATE OF place' : ''}
    )`
}

class PublicActivityLockChangedError extends Error {
  readonly code = '40001'

  constructor() {
    super('public activity sources changed while preparing the write')
    this.name = 'PublicActivityLockChangedError'
  }
}

type ActivityLockQuery = (statement: string, values?: readonly unknown[]) => Promise<unknown>
type LockSet = Readonly<{ resident_ids: number[]; place_ids: number[] }>

const lockSetSelect = `SELECT ARRAY(SELECT id FROM activity_resident_locks ORDER BY id) AS resident_ids,
  ARRAY(SELECT id FROM activity_place_locks ORDER BY id) AS place_ids`

function resultSet(result: unknown): LockSet {
  const rows = Array.isArray(result) ? result : (result as { rows: unknown[] }).rows
  return rows[0] as LockSet
}

/** Caller holds one transaction across both snapshots and the later write. */
export async function lockPublicActivityInvalidation(
  query: ActivityLockQuery, actorId: number, type: string, id: number,
): Promise<void> {
  const catalog = await query(`SELECT to_regprocedure('public.public_activity_invalidation_scope(integer,text,integer)') IS NOT NULL AS installed`)
  const catalogRows = Array.isArray(catalog) ? catalog : (catalog as { rows: ActivityScope[] }).rows
  const installed = (catalogRows[0] as ActivityScope).installed
  const values = [actorId, type, id]
  const held = resultSet(await query(`/* public activity acquire */ WITH
    ${scopeCtes(installed, true)} ${lockSetSelect}`, values))
  const required = resultSet(await query(`/* public activity validate */ WITH
    ${scopeCtes(installed, false)} ${lockSetSelect}`, values))
  if (required.resident_ids.some(value => !held.resident_ids.includes(value))
    || required.place_ids.some(value => !held.place_ids.includes(value))) {
    throw new PublicActivityLockChangedError()
  }
}

/** A changed source set is detected before any mutation and retries the whole transaction. */
export async function withPublicActivityInvalidationRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work() } catch (error) {
      if (!(error instanceof PublicActivityLockChangedError) || attempt >= 2) throw error
    }
  }
}
