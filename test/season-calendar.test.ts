import test from 'node:test'
import assert from 'node:assert/strict'
import { CALENDAR_TABLE, UMM_AL_QURA_OVERRIDES } from '../src/season/calendar-table.ts'
import { addDays, isDay, nthWeekday } from '../src/season/dates.ts'
import { eventsFor, type SeasonEvent } from '../src/season/events.ts'
import { orthodoxEaster, westernEaster } from '../src/season/formulas.ts'
import { yearDates } from '../src/season/intl-calendars.ts'

// Checked dates, 2026 to 2035. Hebrew and Persian dates as ICU 77.1 gives them;
// Islamic dates from the published Umm al-Qura table (api.aladhan.com, UAQ),
// which differs from ICU on six days listed in UMM_AL_QURA_OVERRIDES. 2026 to
// 2030 also match the checked research table (calendar.md with its corrections).
const PINNED: Readonly<Record<number, Readonly<{
  passover: string; rosh: string; yomkippur: string; kislev25: string; nowruz: string
  ramadan: readonly string[]; fitr: readonly string[]; adha: readonly string[]; ashura: readonly string[]
  easter: string; oeaster: string; usThanks: string; caThanks: string
}>>> = {
  2026: { passover: '04-02', rosh: '09-12', yomkippur: '09-21', kislev25: '12-05', nowruz: '03-21', ramadan: ['02-18'], fitr: ['03-20'], adha: ['05-27'], ashura: ['06-25'], easter: '04-05', oeaster: '04-12', usThanks: '11-26', caThanks: '10-12' },
  2027: { passover: '04-22', rosh: '10-02', yomkippur: '10-11', kislev25: '12-25', nowruz: '03-21', ramadan: ['02-08'], fitr: ['03-09'], adha: ['05-16'], ashura: ['06-15'], easter: '03-28', oeaster: '05-02', usThanks: '11-25', caThanks: '10-11' },
  2028: { passover: '04-11', rosh: '09-21', yomkippur: '09-30', kislev25: '12-13', nowruz: '03-20', ramadan: ['01-28'], fitr: ['02-26'], adha: ['05-05'], ashura: ['06-03'], easter: '04-16', oeaster: '04-16', usThanks: '11-23', caThanks: '10-09' },
  2029: { passover: '03-31', rosh: '09-10', yomkippur: '09-19', kislev25: '12-02', nowruz: '03-20', ramadan: ['01-16'], fitr: ['02-14'], adha: ['04-24'], ashura: ['05-23'], easter: '04-01', oeaster: '04-08', usThanks: '11-22', caThanks: '10-08' },
  2030: { passover: '04-18', rosh: '09-28', yomkippur: '10-07', kislev25: '12-21', nowruz: '03-21', ramadan: ['01-05', '12-26'], fitr: ['02-04'], adha: ['04-13'], ashura: ['05-12'], easter: '04-21', oeaster: '04-28', usThanks: '11-28', caThanks: '10-14' },
  2031: { passover: '04-08', rosh: '09-18', yomkippur: '09-27', kislev25: '12-10', nowruz: '03-21', ramadan: ['12-15'], fitr: ['01-24'], adha: ['04-02'], ashura: ['05-02'], easter: '04-13', oeaster: '04-13', usThanks: '11-27', caThanks: '10-13' },
  2032: { passover: '03-27', rosh: '09-06', yomkippur: '09-15', kislev25: '11-28', nowruz: '03-20', ramadan: ['12-04'], fitr: ['01-14'], adha: ['03-22'], ashura: ['04-20'], easter: '03-28', oeaster: '05-02', usThanks: '11-25', caThanks: '10-11' },
  2033: { passover: '04-14', rosh: '09-24', yomkippur: '10-03', kislev25: '12-17', nowruz: '03-20', ramadan: ['11-23'], fitr: ['01-02', '12-23'], adha: ['03-11'], ashura: ['04-10'], easter: '04-17', oeaster: '04-24', usThanks: '11-24', caThanks: '10-10' },
  2034: { passover: '04-04', rosh: '09-14', yomkippur: '09-23', kislev25: '12-07', nowruz: '03-21', ramadan: ['11-12'], fitr: ['12-12'], adha: ['03-01'], ashura: ['03-30'], easter: '04-09', oeaster: '04-09', usThanks: '11-23', caThanks: '10-09' },
  2035: { passover: '04-24', rosh: '10-04', yomkippur: '10-13', kislev25: '12-26', nowruz: '03-21', ramadan: ['11-01'], fitr: ['12-01'], adha: ['02-18'], ashura: ['03-20'], easter: '03-25', oeaster: '04-29', usThanks: '11-22', caThanks: '10-08' },
}

const day = (year: number, monthDay: string) => `${year}-${monthDay}`

function windowOf(events: readonly SeasonEvent[], key: string): readonly (readonly [string, string])[] {
  return events.filter(event => event.key === key).map(event => [event.start, event.end] as const)
}

test('day helpers accept only real calendar days and count across months and years', () => {
  assert.equal(isDay('2027-02-28'), true)
  assert.equal(isDay('2027-02-29'), false)
  assert.equal(isDay('2028-02-29'), true)
  assert.equal(isDay('2026-7-8'), false)
  assert.equal(isDay(20260708), false)
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
  assert.equal(nthWeekday(2026, 11, 4, 4), '2026-11-26')
})

test('Hebrew, Umm al-Qura and Persian dates match the checked table for 2026 to 2035', () => {
  for (const [yearText, pinned] of Object.entries(PINNED)) {
    const year = Number(yearText)
    const dates = yearDates(year)
    assert.equal(dates.passover, day(year, pinned.passover), `${year} Passover`)
    assert.equal(dates.rosh, day(year, pinned.rosh), `${year} Rosh Hashanah`)
    assert.equal(dates.yomkippur, day(year, pinned.yomkippur), `${year} Yom Kippur`)
    assert.equal(dates.kislev25, day(year, pinned.kislev25), `${year} 25 Kislev`)
    assert.equal(dates.nowruz, day(year, pinned.nowruz), `${year} Nowruz`)
    for (const event of ['ramadan', 'fitr', 'adha', 'ashura'] as const) {
      assert.deepEqual(dates.islamic[event], pinned[event].map(monthDay => day(year, monthDay)), `${year} ${event}`)
    }
  }
})

test('the six Umm al-Qura corrections are the published dates and each one is used', () => {
  assert.equal(UMM_AL_QURA_OVERRIDES.length, 6)
  for (const row of UMM_AL_QURA_OVERRIDES) {
    const year = Number(row.date.slice(0, 4))
    assert.ok(yearDates(year).islamic[row.event].includes(row.date), `${row.event} ${row.date}`)
    assert.ok(!yearDates(year).islamic[row.event].includes(row.intl), `${row.event} ${row.intl}`)
  }
})

test('Easter, Orthodox Easter and both Thanksgivings come from their formulas', () => {
  for (const [yearText, pinned] of Object.entries(PINNED)) {
    const year = Number(yearText)
    assert.equal(westernEaster(year), day(year, pinned.easter), `${year} Easter`)
    assert.equal(orthodoxEaster(year), day(year, pinned.oeaster), `${year} Orthodox Easter`)
    const events = eventsFor(year)
    assert.deepEqual(windowOf(events, 'thanks'), [[addDays(day(year, pinned.usThanks), -1), day(year, pinned.usThanks)]])
    assert.deepEqual(windowOf(events, 'canthanks'), [[addDays(day(year, pinned.caThanks), -1), day(year, pinned.caThanks)]])
    assert.deepEqual(windowOf(events, 'harvest'), [[day(year, '11-01'), day(year, pinned.usThanks)]])
    assert.deepEqual(windowOf(events, 'goodfriday'), [[addDays(day(year, pinned.easter), -2), addDays(day(year, pinned.easter), -2)]])
  }
})

test('every holiday window follows the approved rules', () => {
  const y2026 = eventsFor(2026)
  assert.deepEqual(windowOf(y2026, 'spooky'), [['2026-10-01', '2026-10-31']])
  assert.deepEqual(windowOf(y2026, 'winter'), [['2026-12-01', '2026-12-25']])
  assert.deepEqual(windowOf(y2026, 'diwali'), [['2026-11-06', '2026-11-10']])
  assert.deepEqual(windowOf(y2026, 'hanukkah'), [['2026-12-04', '2026-12-12']])
  assert.deepEqual(windowOf(y2026, 'kwanzaa'), [['2026-12-26', '2027-01-01']])
  assert.deepEqual(windowOf(y2026, 'newyear'), [['2026-12-31', '2027-01-01']])
  assert.deepEqual(windowOf(y2026, 'christmas'), [['2026-12-24', '2026-12-25']])
  assert.deepEqual(windowOf(y2026, 'fitr'), [['2026-03-19', '2026-03-21']])
  assert.deepEqual(windowOf(y2026, 'adha'), [['2026-05-26', '2026-05-28']])
  assert.deepEqual(windowOf(y2026, 'easter'), [['2026-04-04', '2026-04-05']])
  assert.deepEqual(windowOf(y2026, 'oeaster'), [['2026-04-11', '2026-04-12']])
  assert.deepEqual(windowOf(y2026, 'passover'), [['2026-04-01', '2026-04-02']])
  assert.deepEqual(windowOf(y2026, 'rosh'), [['2026-09-11', '2026-09-12']])
  assert.deepEqual(windowOf(y2026, 'muertos'), [['2026-11-01', '2026-11-02']])
  assert.deepEqual(windowOf(y2026, 'valentine'), [['2026-02-13', '2026-02-14']])
  assert.deepEqual(windowOf(y2026, 'ramadan'), [['2026-02-17', '2026-02-18']])
  assert.deepEqual(windowOf(y2026, 'equinox'), [['2026-03-20', '2026-03-20'], ['2026-09-23', '2026-09-23']])
  assert.deepEqual(windowOf(y2026, 'junsol'), [['2026-06-21', '2026-06-21']])
  assert.deepEqual(windowOf(y2026, 'decsol'), [['2026-12-21', '2026-12-21']])
  assert.deepEqual(windowOf(y2026, 'lny'), [['2026-02-16', '2026-02-17']])
  assert.deepEqual(windowOf(y2026, 'holi'), [['2026-03-03', '2026-03-04']])
  assert.deepEqual(windowOf(y2026, 'vesak'), [['2026-05-30', '2026-05-31']])
  assert.deepEqual(windowOf(y2026, 'nowruz'), [['2026-03-20', '2026-03-21']])
  assert.deepEqual(windowOf(y2026, 'yomkippur'), [['2026-09-21', '2026-09-21']])
  assert.deepEqual(windowOf(y2026, 'ashura'), [['2026-06-25', '2026-06-25']])
  assert.deepEqual(windowOf(y2026, 'ogoodfriday'), [['2026-04-10', '2026-04-10']])
  assert.deepEqual(windowOf(y2026, 'birthday'), [])
  assert.deepEqual(windowOf(eventsFor(2027), 'birthday'), [['2027-08-11', '2027-08-12']])
  // Hanukkah's first candle is the evening before 25 Kislev.
  assert.deepEqual(windowOf(eventsFor(2027), 'hanukkah'), [['2027-12-24', '2028-01-01']])
  // Ramadan begins twice in 2030 and Eid al-Fitr falls twice in 2033.
  assert.equal(windowOf(eventsFor(2030), 'ramadan').length, 2)
  assert.equal(windowOf(eventsFor(2033), 'fitr').length, 2)
})

test('a year past the table simply has no table holidays; nothing throws', () => {
  const later = eventsFor(2040)
  assert.deepEqual(windowOf(later, 'diwali'), [])
  assert.deepEqual(windowOf(later, 'lny'), [])
  assert.equal(windowOf(later, 'easter').length, 1)
})

test('the yearly table keeps at least three years ahead of today in every column', () => {
  const year = new Date().getUTCFullYear()
  for (const [column, years] of Object.entries(CALENDAR_TABLE)) {
    const last = Math.max(...Object.keys(years).map(Number))
    assert.ok(
      last - year >= 3,
      `${column} in src/season/calendar-table.ts ends in ${last}; add the next years from the cited source before ${last - 2}`,
    )
    for (const [tableYear, monthDay] of Object.entries(years)) {
      assert.ok(isDay(`${tableYear}-${monthDay}`), `${column} ${tableYear} ${monthDay}`)
    }
  }
})
