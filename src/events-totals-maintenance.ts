import { postgresErrorCode } from './core-primitives.ts'
import { checkKeptCountCheaply, foldSettledEvents, type EventsTotalsDatabase } from './events-totals-tally.ts'
import { runHourlyEventsTotalsCheck, type EventsTotalsObservation } from './events-totals-check.ts'

// The kept events tally's step on the five-minute maintenance cron (decision #196):
// fold newly settled events, run the cheap check, and once an hour the full check.
// It runs beside the two log purges of decision #141 and never answers a caller.
// EVENTS_TOTALS_TALLY=off stops the step at the next deploy; the operator's
// events_totals_state.paused stops it at once without a deploy.

export const EVENTS_TOTALS_SWITCH = 'EVENTS_TOTALS_TALLY'

type Environment = Readonly<Record<string, string | undefined>>

/** On when unset, empty or "on"; any other value turns the step off. */
export function eventsTotalsTallyOn(environment: Environment): boolean {
  const value = environment[EVENTS_TOTALS_SWITCH]?.trim() ?? ''
  return value === '' || value === 'on'
}

function writeLine(stream: 'info' | 'error', event: string, fields: Readonly<Record<string, unknown>>): void {
  try {
    const line = JSON.stringify({ event, ...fields })
    if (stream === 'error') console.error(event, line)
    else console.info(event, line)
  } catch {
    // A report must never stop the maintenance cron.
  }
}

function reportObservation(observation: EventsTotalsObservation, trusted: boolean, heldOff: boolean): void {
  const keptTimes = Object.values(observation.keptMs)
  writeLine('info', 'events_totals_check', {
    ok: observation.ok,
    trusted,
    held_off: heldOff,
    kept_change_id: observation.keptChangeId,
    caught_up: observation.caughtUp,
    kinds: observation.kinds,
    unlogged_events: observation.unloggedEvents,
    full_ms: observation.fullMs,
    kept_ms_max: keptTimes.length === 0 ? 0 : Math.max(...keptTimes),
    kept_ms: observation.keptMs,
    left_out_by_key: observation.leftOutByKey,
    things_moved_since_last_check: observation.thingsMovedSinceLastCheck,
    feed_rooms: observation.feedRoomIds.length,
    feed_rooms_changed: observation.feedRoomsChanged,
  })
  for (const mismatch of observation.mismatches) {
    writeLine('error', 'events_totals_mismatch', { check: 'full', kind: mismatch.kind, kept: mismatch.kept, full: mismatch.full })
  }
  if (observation.unloggedEvents > 0) {
    writeLine('error', 'events_totals_mismatch', { check: 'full', unlogged_events: observation.unloggedEvents })
  }
}

export type EventsTotalsMaintenanceResult = Readonly<{
  state: 'off' | 'paused' | 'busy' | 'ran'
}>

/** One maintenance run. Throws on a database failure; the cron reports it and goes on. */
export async function runEventsTotalsMaintenance(
  database: EventsTotalsDatabase,
  environment: Environment,
  now = new Date(),
): Promise<EventsTotalsMaintenanceResult> {
  if (!eventsTotalsTallyOn(environment)) return Object.freeze({ state: 'off' })
  const fold = await foldSettledEvents(database)
  if (fold.state !== 'folded') return Object.freeze({ state: fold.state })
  const cheap = await checkKeptCountCheaply(database)
  if (cheap.state === 'mismatch') {
    writeLine('error', 'events_totals_mismatch', {
      check: 'cheap',
      kept_change_id: cheap.keptChangeId.toString(),
      kept_items: cheap.keptItems,
      logged_changes: cheap.loggedChanges,
      held_off: cheap.heldOff,
    })
  }
  const hourly = await runHourlyEventsTotalsCheck(database, now)
  if (hourly.state === 'recorded') reportObservation(hourly.observation, hourly.trusted, hourly.heldOff)
  return Object.freeze({ state: 'ran' })
}

/** The step's own fixed failure line: the error name and PostgreSQL code only. */
export function reportEventsTotalsFailure(error: unknown): void {
  const errorName = error instanceof Error && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(error.name)
    ? error.name
    : 'Error'
  const errorCode = postgresErrorCode(error)
  writeLine('error', 'events_totals_failure', {
    error_name: errorName,
    ...(errorCode && /^[0-9A-Z]{5}$/u.test(errorCode) ? { error_code: errorCode } : {}),
  })
}
