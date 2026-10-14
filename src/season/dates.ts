// UTC calendar-day helpers for the season calendar. A day is always the
// string YYYY-MM-DD in UTC; nothing here reads the local time zone.

export const DAY_MS = 86_400_000

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

export function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`
}

export function formatDay(ms: number): string {
  const date = new Date(ms)
  return ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

// A real calendar day such as 2027-02-28; 2027-02-30 is not one.
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = DAY_PATTERN.exec(value)
  if (!match) return false
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  return formatDay(ms) === value
}

function parseDay(value: string): number {
  const [year, month, day] = value.split('-').map(Number)
  return Date.UTC(year!, month! - 1, day!)
}

export function addDays(value: string, days: number): string {
  return formatDay(parseDay(value) + days * DAY_MS)
}

export function diffDays(later: string, earlier: string): number {
  return Math.round((parseDay(later) - parseDay(earlier)) / DAY_MS)
}

// The nth weekday (0 Sunday to 6 Saturday) of a month, for example the fourth
// Thursday of November.
export function nthWeekday(year: number, month: number, weekday: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  return ymd(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7)
}
