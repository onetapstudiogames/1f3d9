import { addDays, nthWeekday, ymd } from './dates.ts'
import { orthodoxEaster, westernEaster } from './formulas.ts'
import { tableDay } from './calendar-table.ts'
import { yearDates } from './intl-calendars.ts'

// Every season, holiday and quiet day of one Gregorian year, in the approved
// design's order. A holiday's window is the day before and the day itself
// unless its row says otherwise. Order breaks ties between equal start days.

export const SEASON_KEYS = ['spooky', 'harvest', 'winter'] as const
export type SeasonKey = typeof SEASON_KEYS[number]

export const HOLIDAY_KEYS = [
  'newyear', 'lny', 'valentine', 'holi', 'nowruz', 'equinox', 'ramadan', 'fitr', 'adha',
  'passover', 'easter', 'oeaster', 'vesak', 'junsol', 'birthday', 'rosh', 'canthanks',
  'diwali', 'muertos', 'thanks', 'hanukkah', 'decsol', 'christmas', 'kwanzaa',
] as const
export type HolidayKey = typeof HOLIDAY_KEYS[number]

const QUIET_KEYS = ['yomkippur', 'goodfriday', 'ogoodfriday', 'ashura'] as const
export type QuietKey = typeof QUIET_KEYS[number]

export type CountUnit = 'night' | 'day'

export type SeasonEvent =
  | Readonly<{ kind: 'season'; key: SeasonKey; start: string; end: string }>
  | Readonly<{ kind: 'holiday'; key: HolidayKey; start: string; end: string; order: number; count: CountUnit | null }>
  | Readonly<{ kind: 'quiet'; key: QuietKey; start: string; end: string }>

// The city's mainland was created on 2026-08-12, so its first birthday is 2027.
const CITY_BIRTHDAY_FIRST_YEAR = 2027

export function eventsFor(year: number): readonly SeasonEvent[] {
  const events: SeasonEvent[] = []
  const holiday = (key: HolidayKey, start: string, end: string, count: CountUnit | null = null): void => {
    events.push({ kind: 'holiday', key, start, end, order: HOLIDAY_KEYS.indexOf(key), count })
  }
  // The day before and the main day, plus `after` more days.
  const around = (key: HolidayKey, main: string | null, before = 1, after = 0): void => {
    if (main !== null) holiday(key, addDays(main, -before), addDays(main, after))
  }
  const quiet = (key: QuietKey, day: string | null): void => {
    if (day !== null) events.push({ kind: 'quiet', key, start: day, end: day })
  }
  const dates = yearDates(year)
  const easter = westernEaster(year)
  const pascha = orthodoxEaster(year)
  const usThanksgiving = nthWeekday(year, 11, 4, 4)
  const canadianThanksgiving = nthWeekday(year, 10, 1, 2)

  events.push({ kind: 'season', key: 'spooky', start: ymd(year, 10, 1), end: ymd(year, 10, 31) })
  events.push({ kind: 'season', key: 'harvest', start: ymd(year, 11, 1), end: usThanksgiving })
  events.push({ kind: 'season', key: 'winter', start: ymd(year, 12, 1), end: ymd(year, 12, 25) })

  holiday('newyear', ymd(year, 12, 31), ymd(year + 1, 1, 1))
  around('lny', tableDay('lny', year))
  holiday('valentine', ymd(year, 2, 13), ymd(year, 2, 14))
  around('holi', tableDay('holi', year))
  around('nowruz', dates.nowruz)
  around('equinox', tableDay('marEquinox', year), 0)
  for (const day of dates.islamic.ramadan) around('ramadan', day)
  for (const day of dates.islamic.fitr) around('fitr', day, 1, 1)
  for (const day of dates.islamic.adha) around('adha', day, 1, 1)
  around('passover', dates.passover)
  holiday('easter', addDays(easter, -1), easter)
  holiday('oeaster', addDays(pascha, -1), pascha)
  around('vesak', tableDay('vesak', year))
  around('junsol', tableDay('junSolstice', year), 0)
  if (year >= CITY_BIRTHDAY_FIRST_YEAR) holiday('birthday', ymd(year, 8, 11), ymd(year, 8, 12))
  around('rosh', dates.rosh)
  around('equinox', tableDay('sepEquinox', year), 0)
  around('canthanks', canadianThanksgiving)
  around('diwali', tableDay('diwali', year), 2, 2)
  holiday('muertos', ymd(year, 11, 1), ymd(year, 11, 2))
  around('thanks', usThanksgiving)
  // The first candle is lit on the evening before 25 Kislev; eight nights follow.
  if (dates.kislev25 !== null) {
    const firstEvening = addDays(dates.kislev25, -1)
    holiday('hanukkah', firstEvening, addDays(firstEvening, 8), 'night')
  }
  around('decsol', tableDay('decSolstice', year), 0)
  holiday('christmas', ymd(year, 12, 24), ymd(year, 12, 25))
  holiday('kwanzaa', ymd(year, 12, 26), ymd(year + 1, 1, 1), 'day')

  quiet('yomkippur', dates.yomkippur)
  for (const day of dates.islamic.ashura) quiet('ashura', day)
  quiet('goodfriday', addDays(easter, -2))
  quiet('ogoodfriday', addDays(pascha, -2))
  return Object.freeze(events)
}
