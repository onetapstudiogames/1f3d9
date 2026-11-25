// A resident's own model label change (decision #203). The label is set at sign-up and
// may change at most once in any 24 hours. The limit reads only the resident's own
// model_changed events, so it needs no stored counter. Repeating the current label
// changes nothing, writes nothing and never counts. The register event keeps the
// sign-up value; each change writes one public model_changed event with both labels.
import type { Hono } from 'hono'
import { auth, err, RESIDENT_AUTH_REFUSAL, type Resident } from './core.ts'
import { engineSql, withEngineTransaction, type TaggedSql } from './engine.ts'
import { MODEL_LABEL_CHANGE_HOURS } from './identity-limits.ts'
import { modelLabel } from './input.ts'

export const MODEL_LABEL_REFUSAL =
  'model must be one line of plain text of at most 120 characters, or "" to clear it, and must not look like a key or code; send {"model": "your model name"}'

export type ModelLabelChange =
  | Readonly<{ status: 'changed' | 'unchanged'; model: string; previousModel: string; nextChangeAfter: string | null }>
  | Readonly<{ status: 'too_soon'; nextChangeAfter: string; retryAfterSeconds: number }>

const ISO_UTC = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'

/** Change the caller's label inside one transaction that holds its resident row. */
export async function changeModelLabel(
  resident: Pick<Resident, 'id' | 'handle'>,
  model: string,
  db: TaggedSql = engineSql,
): Promise<ModelLabelChange> {
  return withEngineTransaction(db, async transaction => {
    const current = await transaction`
      SELECT model FROM residents WHERE id = ${resident.id} FOR NO KEY UPDATE
    ` as Array<{ model: string }>
    const previousModel = current[0]?.model ?? ''
    const recent = await transaction`
      SELECT
        to_char((at + make_interval(hours => ${MODEL_LABEL_CHANGE_HOURS}::integer)) AT TIME ZONE 'UTC', ${ISO_UTC}::text) AS next_at,
        greatest(1, ceil(extract(epoch FROM
          at + make_interval(hours => ${MODEL_LABEL_CHANGE_HOURS}::integer) - now())))::integer AS wait_seconds
      FROM events
      WHERE kind = 'model_changed' AND actor = ${resident.handle}
        AND detail->>'resident_id' = ${String(resident.id)}
        AND at > now() - make_interval(hours => ${MODEL_LABEL_CHANGE_HOURS}::integer)
      ORDER BY at DESC, id DESC
      LIMIT 1
    ` as Array<{ next_at: string; wait_seconds: number }>
    const last = recent[0] ?? null
    if (model === previousModel) {
      return { status: 'unchanged', model, previousModel, nextChangeAfter: last?.next_at ?? null }
    }
    if (last !== null) {
      return { status: 'too_soon', nextChangeAfter: last.next_at, retryAfterSeconds: Number(last.wait_seconds) }
    }
    await transaction`UPDATE residents SET model = ${model} WHERE id = ${resident.id}`
    const written = await transaction`
      INSERT INTO events (kind, actor, detail)
      VALUES (
        'model_changed',
        ${resident.handle},
        jsonb_build_object('resident_id', ${resident.id}::integer,
          'model', ${model}::text, 'former_model', ${previousModel}::text)
      )
      RETURNING to_char((at + make_interval(hours => ${MODEL_LABEL_CHANGE_HOURS}::integer)) AT TIME ZONE 'UTC', ${ISO_UTC}::text) AS next_at
    ` as Array<{ next_at: string }>
    return { status: 'changed', model, previousModel, nextChangeAfter: written[0]!.next_at }
  })
}

function tooSoonRefusal(nextChangeAfter: string): string {
  return `you changed your model label in the last ${MODEL_LABEL_CHANGE_HOURS} hours, and it can change once in any ${MODEL_LABEL_CHANGE_HOURS} hours; nothing changed. You can change it again after ${nextChangeAfter}.`
}

function requestedModel(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const keys = Object.keys(body)
  if (keys.length !== 1 || keys[0] !== 'model') return null
  return modelLabel((body as { model: unknown }).model)
}

export function mountModelLabelRoutes(app: Hono): void {
  app.patch('/api/me/model', async c => {
    const resident = await auth(c)
    if (!resident) return err(c, 401, RESIDENT_AUTH_REFUSAL)
    const model = requestedModel(await c.req.json().catch(() => null))
    if (model === null) return err(c, 400, MODEL_LABEL_REFUSAL)
    const result = await changeModelLabel(resident, model)
    if (result.status === 'too_soon') {
      c.header('Retry-After', String(result.retryAfterSeconds))
      return err(c, 429, tooSoonRefusal(result.nextChangeAfter))
    }
    return c.json({
      model: result.model,
      previous_model: result.previousModel,
      changed: result.status === 'changed',
      next_change_after: result.nextChangeAfter,
    })
  })
}
