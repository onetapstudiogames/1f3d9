// The yearly table for dates no formula or built-in calendar gives reliably.
// Every value is the Gregorian month-day of the holiday's main day. Extend each
// column before test/season-calendar.test.ts warns that fewer than three years
// are left, and cite the source beside the column.

type YearTable = Readonly<Record<number, string>>

export type TableColumn =
  | 'lny'
  | 'diwali'
  | 'holi'
  | 'vesak'
  | 'marEquinox'
  | 'junSolstice'
  | 'sepEquinox'
  | 'decSolstice'

export const CALENDAR_TABLE: Readonly<Record<TableColumn, YearTable>> = Object.freeze({
  // First day of the 1st lunar month, Hong Kong Observatory yearly tables
  // https://www.hko.gov.hk/en/gts/time/calendar/text/files/T<year>e.txt.
  // ICU's chinese calendar is a day off in 2027 and 2030, so it is not used.
  lny: Object.freeze({
    2026: '02-17', 2027: '02-06', 2028: '01-26', 2029: '02-13', 2030: '02-03',
    2031: '01-23', 2032: '02-11', 2033: '01-31', 2034: '02-19', 2035: '02-08',
  }),
  // Lakshmi Puja day for New Delhi, drikpanchang Diwali Puja calendar
  // (geoname-id 1261481). drikpanchang puts later years behind a reCAPTCHA
  // and no other source reached lists them, so the column ends at 2031.
  diwali: Object.freeze({
    2026: '11-08', 2027: '10-29', 2028: '10-17', 2029: '11-05', 2030: '10-26',
    2031: '11-14',
  }),
  // Rangwali Holi (the colours day) for New Delhi, drikpanchang Holika Dahan
  // pages (geoname-id 1261481). Later years are behind the same reCAPTCHA.
  holi: Object.freeze({
    2026: '03-04', 2027: '03-22', 2028: '03-11', 2029: '03-01', 2030: '03-20',
    2031: '03-09',
  }),
  // Vesak by the Singapore and Malaysia rule: the 15th day of the 4th lunar
  // month, from the same Hong Kong Observatory tables. Theravada countries
  // that follow the May full moon can differ, notably in 2031 and 2034.
  vesak: Object.freeze({
    2026: '05-31', 2027: '05-20', 2028: '05-09', 2029: '05-27', 2030: '05-16',
    2031: '06-04', 2032: '05-23', 2033: '05-13', 2034: '06-01', 2035: '05-22',
  }),
  // Equinoxes and solstices as UTC days, US Naval Observatory
  // https://aa.usno.navy.mil/api/seasons?year=<year>.
  marEquinox: Object.freeze({
    2026: '03-20', 2027: '03-20', 2028: '03-20', 2029: '03-20', 2030: '03-20',
    2031: '03-20', 2032: '03-20', 2033: '03-20', 2034: '03-20', 2035: '03-20',
  }),
  junSolstice: Object.freeze({
    2026: '06-21', 2027: '06-21', 2028: '06-20', 2029: '06-21', 2030: '06-21',
    2031: '06-21', 2032: '06-20', 2033: '06-21', 2034: '06-21', 2035: '06-21',
  }),
  sepEquinox: Object.freeze({
    2026: '09-23', 2027: '09-23', 2028: '09-22', 2029: '09-22', 2030: '09-22',
    2031: '09-23', 2032: '09-22', 2033: '09-22', 2034: '09-22', 2035: '09-23',
  }),
  decSolstice: Object.freeze({
    2026: '12-21', 2027: '12-22', 2028: '12-21', 2029: '12-21', 2030: '12-21',
    2031: '12-22', 2032: '12-21', 2033: '12-21', 2034: '12-21', 2035: '12-22',
  }),
})

export type IslamicEvent = 'ramadan' | 'fitr' | 'adha' | 'ashura'

type UmmAlQuraOverride = Readonly<{ event: IslamicEvent; intl: string; date: string }>

// Days where the server's Intl islamic-umalqura calendar (ICU 77.1) is one day
// later than the published Umm al-Qura table at api.aladhan.com
// (/v1/hToG/<day>-<month>-<year>?calendarMethod=UAQ). The published table wins.
export const UMM_AL_QURA_OVERRIDES: readonly UmmAlQuraOverride[] = Object.freeze([
  Object.freeze({ event: 'ashura', intl: '2030-05-13', date: '2030-05-12' }),
  Object.freeze({ event: 'ramadan', intl: '2031-12-16', date: '2031-12-15' }),
  Object.freeze({ event: 'fitr', intl: '2033-01-03', date: '2033-01-02' }),
  Object.freeze({ event: 'adha', intl: '2033-03-12', date: '2033-03-11' }),
  Object.freeze({ event: 'ashura', intl: '2034-03-31', date: '2034-03-30' }),
  Object.freeze({ event: 'adha', intl: '2035-02-19', date: '2035-02-18' }),
])

export function tableDay(column: TableColumn, year: number): string | null {
  const monthDay = CALENDAR_TABLE[column][year]
  return monthDay === undefined ? null : `${year}-${monthDay}`
}
