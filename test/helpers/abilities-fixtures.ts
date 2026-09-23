// Shared helpers for the copy, reach, and convert suites against real PostgreSQL
// (docs/DECISIONS.md rows 111 to 115). They talk to the database the note-suite
// fixture started and to the city app through its real routes.
import { bearer, connectedDatabase } from './note-suite-fixtures/postgres.ts'

export const FOUNDER = Object.freeze({ id: 1, handle: 'founder', secret: `1f3d9_sk_${'1'.repeat(48)}` })
export const GROWER = Object.freeze({ id: 2, handle: 'seed-keeper', secret: `1f3d9_sk_${'2'.repeat(48)}` })
export const NEIGHBOUR = Object.freeze({ id: 3, handle: 'next-door', secret: `1f3d9_sk_${'3'.repeat(48)}` })

export type CityApp = Readonly<{ request: (input: string, init?: RequestInit) => Response | Promise<Response> }>
export type Json = Record<string, unknown>

export async function call(
  app: CityApp,
  secret: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<Readonly<{ status: number; json: Json }>> {
  const response = await app.request(`http://city.test${path}`, {
    method,
    headers: secret === null ? {} : bearer(secret),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  return Object.freeze({ status: response.status, json: text ? JSON.parse(text) as Json : {} })
}

export async function coin(app: CityApp, secret: string, name: string, recipe: unknown) {
  return call(app, secret, 'POST', '/api/trait', { name, description: `${name} for the copy, reach, and convert suite`, recipe })
}

export async function traitId(name: string): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(
    'SELECT id FROM traits WHERE name = $1', [name],
  )).rows[0]!.id)
}

/** A kind at revision 1 listing the given traits, owned by `ownerId`, without a fee. */
export async function seedKind(ownerId: number, name: string, traitIds: readonly number[]): Promise<number> {
  const db = connectedDatabase()
  const kindId = Number((await db.query<{ id: number }>(
    'INSERT INTO kinds (name, owner_id) VALUES ($1, $2) RETURNING id', [name, ownerId],
  )).rows[0]!.id)
  await addRevision(kindId, 1, traitIds)
  return kindId
}

/**
 * Add one more revision of a kind listing the given traits, and make it current.
 * A later revision carries a refused drawing, so an upgrade to it is a real
 * drawing change (drawing_revisions refuses a revision that changes nothing).
 */
export async function addRevision(kindId: number, revision: number, traitIds: readonly number[]): Promise<void> {
  const db = connectedDatabase()
  const names = (await db.query<{ name: string }>(
    'SELECT name FROM traits WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)', [traitIds],
  )).rows.map(row => row.name)
  await db.query(`
    INSERT INTO kind_revisions (kind_id, revision, traits, drawing_state, drawing_description)
    VALUES ($1, $2, $3::text[], coalesce($4::text, 'undrawn'), $5)
  `, [kindId, revision, names, revision > 1 ? 'refused' : null, revision > 1 ? 'a picture is on its way' : null])
  await db.query('UPDATE kinds SET current_revision = $2 WHERE id = $1', [kindId, revision])
}

/** One thing of the kind, owned and made by `ownerId`, standing in `placeId`. */
export async function seedThing(
  ownerId: number,
  placeId: number,
  kindId: number | null,
  name: string,
  switches: Readonly<{ openToReach?: boolean; openToConvert?: boolean; openToUse?: boolean }> = {},
): Promise<number> {
  return Number((await connectedDatabase().query<{ id: number }>(`
    INSERT INTO things (
      place_id, name, body, owner_id, maker_id, kind_id, birth_revision, current_revision,
      open_to_reach, open_to_convert, open_to_use
    )
    VALUES ($1, $2, '', $3, $3, $4, $5, $5, $6, $7, $8) RETURNING id
  `, [
    placeId, name, ownerId, kindId, kindId === null ? null : 1,
    switches.openToReach === true, switches.openToConvert === true, switches.openToUse === true,
  ])).rows[0]!.id)
}

export async function use(app: CityApp, secret: string, thingId: number, target?: Json) {
  return call(app, secret, 'POST', '/api/action', { action: 'use', thing_id: thingId, ...(target ?? {}) })
}
