import { fixtureState } from './state.ts'
import { recordPayment } from './state-tools.ts'
import { respondToDatabaseStage1 } from './db-respond-1.ts'
import { respondToDatabaseStage2 } from './db-respond-2.ts'
import { respondToDatabaseStage3 } from './db-respond-3.ts'
import { respondToDatabaseStage4 } from './db-respond-4.ts'
import { respondToDatabaseStage5 } from './db-respond-5.ts'
import { respondToDatabaseStage6 } from './db-respond-6.ts'
import { respondToDatabaseStage7 } from './db-respond-7.ts'
import { respondToDatabaseStage8 } from './db-respond-8.ts'

export function dbRespond(query: string, params: unknown[]): Record<string, unknown>[] {

  const q = query.replace(/\s+/g, ' ').trim().toLowerCase()
  if (fixtureState.current.scenario === 'root arrival' && Number(params[0]) === 195) {
    if (q.includes('from places p') && q.includes('where p.id =')) {
      return [{
        id: 195, parent_id: null, name: 'the world', owner_id: null, owner: null,
        description: '', purpose: '', status: 'active', retired_at: null,
        open_to_building: false, open_to_things: false, open_to_notes: false,
        created_at: '2026-08-14T00:00:00.000Z',
      }]
    }
    if (q.includes('/* public:place-collections */')) {
      return [{
        subplaces: [], things: [], notes: [],
        subplace_items: 0, subplace_text_bytes: 0,
        thing_items: 0, thing_text_bytes: 0, note_items: 0, note_text_bytes: 0,
      }]
    }
  }
  if (fixtureState.current.scenario === 'protected place lifecycle') {
    if (q.includes("to_regclass('public.place_name_history')")) return [{ installed: true }]
    if (q.includes('as protected_city_service') && q.includes('as name_taken')) {
      const id = Number(params.at(-1))
      return [{
        id,
        name: id === 454 ? 'the gazette submission room' : 'the world',
        owner_id: id === 454 ? 1 : null,
        retired_at: null,
        parent_retired_at: null,
        subplace_count: 0,
        thing_count: 0,
        resident_count: 0,
        name_taken: false,
        protected_city_service: true,
      }]
    }
  }
  if (fixtureState.current.scenario === 'protected Gazette dependencies') {
    const constraint = q.includes('insert into place_law_changes')
      ? 'gazette_submission_room_laws'
      : q.includes('insert into places')
        ? 'gazette_submission_room_children'
        : q.includes('insert into things')
          ? 'gazette_submission_room_things'
          : q.includes('update places set')
            ? 'gazette_submission_room_lifecycle'
            : null
    if (constraint) {
      throw Object.assign(new Error('private database constraint detail'), {
        code: '23514',
        constraint,
      })
    }
  }
  if (/^(?:savepoint|release savepoint|rollback to savepoint)\b/u.test(q)) return []
  recordPayment(query, params)

  if (fixtureState.current.scenario === 'thing upgrade kind lock' && q.includes('with upgradeable as materialized')) {
    throw Object.assign(new Error('could not obtain lock on row in relation "kinds"'), {
      code: '55P03',
    })
  }
  const respondToDatabaseStage1Result = respondToDatabaseStage1(query, params, q)
  if (respondToDatabaseStage1Result !== undefined) return respondToDatabaseStage1Result
  const respondToDatabaseStage2Result = respondToDatabaseStage2(query, params, q)
  if (respondToDatabaseStage2Result !== undefined) return respondToDatabaseStage2Result
  const respondToDatabaseStage3Result = respondToDatabaseStage3(query, params, q)
  if (respondToDatabaseStage3Result !== undefined) return respondToDatabaseStage3Result
  const respondToDatabaseStage4Result = respondToDatabaseStage4(query, params, q)
  if (respondToDatabaseStage4Result !== undefined) return respondToDatabaseStage4Result
  const respondToDatabaseStage5Result = respondToDatabaseStage5(query, params, q)
  if (respondToDatabaseStage5Result !== undefined) return respondToDatabaseStage5Result
  const respondToDatabaseStage6Result = respondToDatabaseStage6(query, params, q)
  if (respondToDatabaseStage6Result !== undefined) return respondToDatabaseStage6Result
  const respondToDatabaseStage7Result = respondToDatabaseStage7(query, params, q)
  if (respondToDatabaseStage7Result !== undefined) return respondToDatabaseStage7Result
  const respondToDatabaseStage8Result = respondToDatabaseStage8(query, params, q)
  if (respondToDatabaseStage8Result !== undefined) return respondToDatabaseStage8Result
  throw new Error(`unhandled fake SQL (${fixtureState.current.scenario}): ${query}`)
}
