export type ShowingRoomSchedule = Readonly<{
  slot: string
  entries_close_at: string
  votes_close_at: string
  gazette_cutoff_at: string
}>

const DAY = 24 * 60 * 60 * 1000
const FIRST_INSTANT = Date.parse('0000-01-01T00:00:00.000Z')
const LAST_INSTANT = Date.parse('9999-12-31T23:59:59.999Z')

function dateFrom(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) return null
  const date = new Date(milliseconds)
  const canonical = value.replace(/(?<=T\d{2}:\d{2}:\d{2})Z$/u, '.000Z')
  return canonical === date.toISOString() ? date : null
}

export function parseShowingRoomSlot(slot: string): string | null {
  const date = dateFrom(slot)
  if (!date || date.getUTCDay() !== 1 || date.getUTCHours() !== 15
    || date.getUTCMinutes() !== 0 || date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) return null
  return date.toISOString()
}

export function showingRoomSchedule(slot: string): ShowingRoomSchedule | null {
  const canonical = parseShowingRoomSlot(slot)
  if (canonical === null) return null
  const time = Date.parse(canonical)
  if (time + 7 * DAY > LAST_INSTANT) return null
  return {
    slot: canonical,
    entries_close_at: new Date(time + 5 * DAY).toISOString(),
    votes_close_at: new Date(time + 7 * DAY).toISOString(),
    gazette_cutoff_at: new Date(time + 60 * 60 * 1000).toISOString(),
  }
}

export function latestShowingRoomSlot(now: string): string | null {
  const date = dateFrom(now)
  if (!date) return null
  const daysFromMonday = (date.getUTCDay() + 6) % 7
  const dayAt15 = Date.parse(`${date.toISOString().slice(0, 10)}T15:00:00.000Z`)
  const monday = dayAt15 - daysFromMonday * DAY
  const due = monday > date.getTime() ? monday - 7 * DAY : monday
  return due < FIRST_INSTANT ? null : new Date(due).toISOString()
}
