import { DAY_MS, formatDay } from './dates.ts'
import { UMM_AL_QURA_OVERRIDES, type IslamicEvent } from './calendar-table.ts'

// Hebrew, Umm al-Qura and Persian dates read from the server's built-in Intl
// calendars by walking every UTC day of a Gregorian year once. Jewish and
// Islamic days begin at the previous sundown; the events table adds the eve.

export type YearDates = Readonly<{
  passover: string | null
  rosh: string | null
  yomkippur: string | null
  kislev25: string | null
  nowruz: string | null
  islamic: Readonly<Record<IslamicEvent, readonly string[]>>
}>

const HEBREW = new Intl.DateTimeFormat('en-u-ca-hebrew', { timeZone: 'UTC', month: 'long', day: 'numeric' })
const ISLAMIC = new Intl.DateTimeFormat('en-u-ca-islamic-umalqura', { timeZone: 'UTC', month: 'numeric', day: 'numeric' })
const PERSIAN = new Intl.DateTimeFormat('en-u-ca-persian', { timeZone: 'UTC', month: 'numeric', day: 'numeric' })

const ISLAMIC_DAYS: Readonly<Record<string, IslamicEvent>> = Object.freeze({
  '9/1': 'ramadan',
  '10/1': 'fitr',
  '12/10': 'adha',
  '1/10': 'ashura',
})

const MEMO_YEARS = 4
const memo = new Map<number, YearDates>()

function monthDay(format: Intl.DateTimeFormat, ms: number): string {
  let month = ''
  let day = ''
  for (const part of format.formatToParts(ms)) {
    if (part.type === 'month') month = part.value
    if (part.type === 'day') day = part.value
  }
  return `${month}/${day}`
}

function ummAlQura(event: IslamicEvent, intlDay: string): string {
  return UMM_AL_QURA_OVERRIDES.find(row => row.event === event && row.intl === intlDay)?.date ?? intlDay
}

function scanYear(year: number): YearDates {
  let passover: string | null = null
  let rosh: string | null = null
  let yomkippur: string | null = null
  let kislev25: string | null = null
  let nowruz: string | null = null
  const islamic: Record<IslamicEvent, string[]> = { ramadan: [], fitr: [], adha: [], ashura: [] }
  const end = Date.UTC(year + 1, 0, 1)
  for (let ms = Date.UTC(year, 0, 1); ms < end; ms += DAY_MS) {
    const day = formatDay(ms)
    const hebrew = monthDay(HEBREW, ms)
    if (hebrew === 'Nisan/15') passover = day
    else if (hebrew === 'Tishri/1') rosh = day
    else if (hebrew === 'Tishri/10') yomkippur = day
    else if (hebrew === 'Kislev/25') kislev25 = day
    const islamicEvent = ISLAMIC_DAYS[monthDay(ISLAMIC, ms)]
    if (islamicEvent) islamic[islamicEvent].push(ummAlQura(islamicEvent, day))
    if (monthDay(PERSIAN, ms) === '1/1') nowruz = day
  }
  return Object.freeze({
    passover,
    rosh,
    yomkippur,
    kislev25,
    nowruz,
    islamic: Object.freeze({
      ramadan: Object.freeze(islamic.ramadan),
      fitr: Object.freeze(islamic.fitr),
      adha: Object.freeze(islamic.adha),
      ashura: Object.freeze(islamic.ashura),
    }),
  })
}

export function yearDates(year: number): YearDates {
  const cached = memo.get(year)
  if (cached) return cached
  const dates = scanYear(year)
  memo.set(year, dates)
  if (memo.size > MEMO_YEARS) memo.delete(memo.keys().next().value!)
  return dates
}
