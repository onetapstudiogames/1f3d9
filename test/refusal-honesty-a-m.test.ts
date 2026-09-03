import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function source(name: string): string {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
}

function expects(name: string, messages: readonly string[]): void {
  const text = source(name)
  for (const message of messages) assert.ok(text.includes(message), `${name}: ${message}`)
}

test('city-credit refusals name the recovery path', () => {
  expects('city-credit-recovery.ts', [
    'automatic recovery deadline reached; city fee credit returned; use a new request id to try the action again',
  ])
  expects('city-credit.ts', [
    'city credit attempt is unavailable because its stored attempt id is missing; retry once, then contact the city operator',
    'city credit balance projection was not created because the balance record is missing; retry once, then contact the city operator',
    'city credit completion no longer owns this exact spend; retry the same request id without paying again',
    'city credit deadline return is not yet available; wait until the payment deadline, then retry the same request id',
    'city credit request conflicts with changed immutable credit terms; use the original terms with this request id, or use a new request id',
    'city credit spend is not ready for this request; retry the same request id after its current lease clears',
    'city credit target key must be 1 to 240 safe non-secret bytes',
    'completed city credit response is unavailable because its stored response is missing; retry once, then contact the city operator',
    'operation is not eligible for city fee credit; use frontier, kind_invention, kind_revision, place_rename, place_retire, or place_restore',
    'resident was not found or city credit issuance conflicted; re-read GET /api/residents and retry with a current resident and the original source terms',
    'returned city credit response is unavailable because its stored response is missing; retry once, then contact the city operator',
  ])
})

test('drawing and effect refusals name accepted retries', () => {
  expects('drawing.ts', [
    'request body could not be read; resend the documented drawing body',
  ])
  expects('engine-effects.ts', [
    'asset has an open transfer offer; cancel the offer or choose another owned asset',
    'database returned an invalid ${field}; retry once, then contact the city operator',
    'database returned an invalid result; retry once, then contact the city operator',
    'move destination is unavailable because the effect has no resolved destination; send to_place_id for move and retry',
    'payload exceeds ${MAX_JSON_BYTES} UTF-8 bytes; send a smaller payload',
    'thing has an open sale offer; cancel the offer or choose another active thing',
    'thing or destination changed before the move; re-read both and retry',
    'wait duration must be ${MIN_TIMER_SECONDS}-${MAX_TIMER_SECONDS} seconds',
  ])
})

test('target-scope refusals name the usable target state', () => {
  expects('engine-target-scope.ts', [
    'database returned an invalid ${field}; retry once, then contact the city operator',
    'database returned an invalid result; retry once, then contact the city operator',
    'kind target was not found; choose a current kind_id from GET /api/kinds',
    'resident presence was not found; reconnect with the current resident key and retry',
    'target kind is not owned by you; choose a kind you own',
    'target place_id ${target.id} cannot be used because place_id is unset; send place_id and retry',
    'target resident cannot be used because place_id is unset; send place_id and retry',
    'target thing cannot be used because place_id is unset; send place_id and retry',
  ])
})

test('timer and action refusals name a retry or accepted bound', () => {
  expects('engine-timer-store.ts', [
    'database returned an invalid ${field}; retry once, then contact the city operator',
    'database returned an invalid result; retry once, then contact the city operator',
    'pending effect counts are unavailable because the city could not read the queues; retry once, then contact the city operator',
    'pending effect limit reached for place; wait for a pending effect to finish or choose another place',
    'wait effect could not be scheduled because the city write returned no record; retry once, then contact the city operator',
    'you have reached the pending effect limit; wait for a pending effect to finish before retrying',
  ])
  expects('engine.ts', [
    'action is invalid; use talk, move, use, give, consume, make, or go_home',
    'carry_thing_id has an open sale offer or market lock; cancel the offer, wait for the lock to clear, or carry another owned thing',
    'payload exceeds ${MAX_JSON_BYTES} UTF-8 bytes; send a smaller payload',
    'resident has no current place; reconnect with the current resident key and retry, then contact the city operator',
    'thing_id has an open sale offer; cancel the offer or use another active thing',
    'you cannot carry a thing because your current place is unset; reconnect with the current resident key and retry',
  ])
})

test('Gazette, route, and later-holder refusals state cause and next step', () => {
  expects('gazette.ts', [
    'database returned an invalid Gazette ${field}; retry once, then contact the city operator',
    'Gazette issue was not stored because the print write returned no issue; retry once, then contact the city operator',
    'Gazette printer is unavailable because its database adapter cannot run transaction queries; configure transaction query support before printing',
  ])
  expects('index.ts', [
    '${RESIDENT_FLAGS_PER_HOUR} resident flag limit reached per UTC hour; retry after the next UTC hour begins',
    '${ANONYMOUS_FLAGS_PER_IP_HOUR} anonymous flag limit reached per IP per UTC hour; retry after the next UTC hour begins',
    'GET is not accepted by the MCP endpoint. POST JSON-RPC 2.0 messages here.',
    'GET is not accepted by the hosted-chat MCP connector. POST JSON-RPC 2.0 messages here.',
    'community tool review Content-Type must be application/json; send one application/json body',
    'founder PayPal dispute Content-Type must be application/json; send one application/json body',
  ])
  expects('later-holder.ts', [
    'notice body does not accept ${describeUnsupportedFields(rejectedNoticeFields)}; send only mode',
    'index body does not accept ${describeUnsupportedFields(rejectedIndexFields)}; send only mode, before, and limit',
  ])
})
