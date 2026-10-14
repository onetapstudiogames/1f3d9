import { diffDays } from './dates.ts'
import {
  eventsFor,
  type CountUnit,
  type HolidayKey,
  type QuietKey,
  type SeasonEvent,
  type SeasonKey,
} from './events.ts'

// One UTC day resolved into what every human page wears. A quiet day takes
// everything down. Otherwise the season (if any) sets the palette and every
// active holiday is listed in start order; nothing rotates.

export type ActiveSeason = Readonly<{ key: SeasonKey; start: string; end: string }>
export type ActiveHoliday = Readonly<{
  key: HolidayKey
  start: string
  end: string
  count: Readonly<{ unit: CountUnit; n: number }> | null
}>

export type SeasonDay = Readonly<{
  date: string
  quiet: readonly QuietKey[]
  season: ActiveSeason | null
  holidays: readonly ActiveHoliday[]
}>

const COUNT_MAX: Readonly<Record<CountUnit, number>> = Object.freeze({ night: 8, day: 7 })
const MEMO_DAYS = 4
const memo = new Map<string, SeasonDay>()

function covers(event: SeasonEvent, date: string): boolean {
  return event.start <= date && date <= event.end
}

function resolveUncached(date: string): SeasonDay {
  const year = Number(date.slice(0, 4))
  const active = [...eventsFor(year - 1), ...eventsFor(year)].filter(event => covers(event, date))
  const quiet = active.flatMap(event => event.kind === 'quiet' ? [event.key] : [])
  if (quiet.length > 0) return Object.freeze({ date, quiet: Object.freeze(quiet), season: null, holidays: Object.freeze([]) })
  const seasonEvent = active.find(event => event.kind === 'season')
  const season = seasonEvent
    ? Object.freeze({ key: seasonEvent.key as SeasonKey, start: seasonEvent.start, end: seasonEvent.end })
    : null
  const holidays = active
    .flatMap(event => event.kind === 'holiday' ? [event] : [])
    .sort((a, b) => a.start === b.start ? a.order - b.order : a.start < b.start ? -1 : 1)
    .map(event => Object.freeze({
      key: event.key,
      start: event.start,
      end: event.end,
      count: event.count === null
        ? null
        : Object.freeze({ unit: event.count, n: Math.min(COUNT_MAX[event.count], diffDays(date, event.start) + 1) }),
    }))
  return Object.freeze({ date, quiet: Object.freeze([]), season, holidays: Object.freeze(holidays) })
}

export function resolveDay(date: string): SeasonDay {
  const cached = memo.get(date)
  if (cached) return cached
  const day = resolveUncached(date)
  memo.set(date, day)
  if (memo.size > MEMO_DAYS) memo.delete(memo.keys().next().value!)
  return day
}

// A day wears decorations when a season or a holiday is active.
export function isDressed(day: SeasonDay): boolean {
  return day.season !== null || day.holidays.length > 0
}
