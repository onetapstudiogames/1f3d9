import test from 'node:test'
import assert from 'node:assert/strict'
import { iconKey, iconLabel, iconSpec, iconUrl, PLAIN_ICON_LABEL } from '../src/season/icon.ts'
import { isDressed, resolveDay } from '../src/season/resolve.ts'
import { sloganParts, sloganText, sloganWords } from '../src/season/slogan.ts'

function summary(date: string) {
  const day = resolveDay(date)
  return {
    quiet: day.quiet,
    season: day.season?.key ?? null,
    holidays: day.holidays.map(holiday => holiday.key + (holiday.count ? holiday.count.n : '')),
    slogan: sloganText(day),
    label: iconLabel(iconSpec(day)),
    key: iconKey(iconSpec(day)),
  }
}

test('a quiet day takes every decoration and the season palette down, even inside a season', () => {
  // 2027-10-11 is Yom Kippur, Canadian Thanksgiving, and inside spooky season.
  for (const date of ['2027-10-11', '2026-04-03', '2026-04-10', '2026-06-25', '2030-05-12', '2026-09-21']) {
    const day = resolveDay(date)
    assert.ok(day.quiet.length > 0, date)
    assert.equal(day.season, null, date)
    assert.deepEqual(day.holidays, [], date)
    assert.equal(isDressed(day), false, date)
    assert.equal(sloganText(day), 'The city where agents live', date)
    assert.equal(iconUrl(iconSpec(day)), '/favicon.svg', date)
    assert.equal(iconLabel(iconSpec(day)), PLAIN_ICON_LABEL, date)
  }
  assert.deepEqual(resolveDay('2027-10-11').quiet, ['yomkippur'])
  assert.deepEqual(resolveDay('2026-04-03').quiet, ['goodfriday'])
  assert.deepEqual(resolveDay('2026-04-10').quiet, ['ogoodfriday'])
  assert.deepEqual(resolveDay('2030-05-12').quiet, ['ashura'])
  // The day after the corrected Ashura is an ordinary day.
  assert.equal(isDressed(resolveDay('2030-05-13')), false)
  assert.deepEqual(resolveDay('2030-05-13').quiet, [])
})

test('Christmas and Hanukkah 2027 share the icon and the slogan in start order', () => {
  assert.deepEqual(summary('2027-12-25'), {
    quiet: [],
    season: 'winter',
    holidays: ['hanukkah2', 'christmas'],
    slogan: 'The candlelit and jolly city where agents live',
    label: 'The 1F3D9 skyline, dressed for Hanukkah and Christmas',
    key: 'hanukkah2+christmas',
  })
})

test('13 February 2029 shows three holidays at once with one word each', () => {
  assert.deepEqual(summary('2029-02-13'), {
    quiet: [],
    season: null,
    holidays: ['lny', 'valentine', 'fitr'],
    slogan: 'The lantern-lit, lovely and joyful city where agents live',
    label: "The 1F3D9 skyline, dressed for Lunar New Year, Valentine's Day and Eid al-Fitr",
    key: 'lny+valentine+fitr',
  })
  const parts = sloganParts(resolveDay('2029-02-13'))
  assert.deepEqual(parts.map(part => typeof part === 'string' ? part : `[${part.word}]`), [
    'The ', '[lantern-lit]', ', ', '[lovely]', ' and ', '[joyful]', ' city where agents live',
  ])
})

test('both Easters on one day show the word "blooming" once', () => {
  for (const date of ['2028-04-16', '2031-04-13', '2034-04-09']) {
    const day = resolveDay(date)
    assert.deepEqual(day.holidays.map(holiday => holiday.key), ['easter', 'oeaster'], date)
    assert.deepEqual(sloganWords(day).map(word => [word.key, word.word]), [['easter', 'blooming']], date)
    assert.equal(sloganText(day), 'The blooming city where agents live', date)
    assert.equal(iconLabel(iconSpec(day)), 'The 1F3D9 skyline, dressed for Easter and Orthodox Easter', date)
  }
})

test('US Thanksgiving shows only "thankful"; the next day is ordinary', () => {
  assert.deepEqual(summary('2026-11-26'), {
    quiet: [],
    season: 'harvest',
    holidays: ['thanks'],
    slogan: 'The thankful city where agents live',
    label: 'The 1F3D9 skyline, dressed for Thanksgiving',
    key: 'thanks',
  })
  const after = resolveDay('2026-11-27')
  assert.equal(isDressed(after), false)
  assert.equal(sloganText(after), 'The city where agents live')
  // Canadian Thanksgiving in spooky season shares the "thankful" image.
  assert.deepEqual(sloganWords(resolveDay('2026-10-12')).map(word => word.key), ['thanks'])
})

test('Hanukkah counts nights and Kwanzaa counts days, across the new year', () => {
  for (let night = 1; night <= 8; night += 1) {
    const date = `2026-12-${String(3 + night).padStart(2, '0')}`
    assert.deepEqual(resolveDay(date).holidays.find(holiday => holiday.key === 'hanukkah')?.count, { unit: 'night', n: night }, date)
  }
  assert.deepEqual(resolveDay('2026-12-12').holidays.find(holiday => holiday.key === 'hanukkah')?.count, { unit: 'night', n: 8 })
  assert.equal(resolveDay('2026-12-13').holidays.some(holiday => holiday.key === 'hanukkah'), false)
  const kwanzaa = ['2026-12-26', '2026-12-27', '2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']
  kwanzaa.forEach((date, index) => {
    assert.deepEqual(resolveDay(date).holidays.find(holiday => holiday.key === 'kwanzaa')?.count, { unit: 'day', n: index + 1 }, date)
  })
  assert.deepEqual(summary('2026-12-31').holidays, ['kwanzaa6', 'newyear'])
  assert.deepEqual(summary('2027-01-01').holidays, ['kwanzaa7', 'newyear'])
  assert.equal(summary('2027-01-01').season, null)
})

test('Hanukkah and Kwanzaa together keep both candle rows', () => {
  assert.deepEqual(summary('2027-12-26'), {
    quiet: [],
    season: null,
    holidays: ['hanukkah3', 'kwanzaa1'],
    slogan: 'The candlelit and united city where agents live',
    label: 'The 1F3D9 skyline, dressed for Hanukkah and Kwanzaa',
    key: 'hanukkah3+kwanzaa1',
  })
})

test("the city's birthday starts in 2027", () => {
  assert.deepEqual(summary('2026-08-12').holidays, [])
  assert.deepEqual(summary('2027-08-11').holidays, ['birthday'])
  assert.deepEqual(summary('2027-08-12').holidays, ['birthday'])
  assert.equal(summary('2027-08-12').slogan, 'The birthday city where agents live')
})

test('an ordinary day is plain and a season day wears the season word', () => {
  assert.deepEqual(summary('2026-07-08'), {
    quiet: [], season: null, holidays: [], slogan: 'The city where agents live', label: 'The 1F3D9 skyline', key: '',
  })
  assert.deepEqual(summary('2026-10-14'), {
    quiet: [],
    season: 'spooky',
    holidays: [],
    slogan: 'The spooky city where agents live',
    label: 'The 1F3D9 skyline, dressed for spooky season',
    key: 'spooky',
  })
  // Diwali inside harvest season: the palette stays, the holiday's word takes the slogan.
  assert.deepEqual(summary('2026-11-08').holidays, ['diwali'])
  assert.equal(summary('2026-11-08').season, 'harvest')
  assert.equal(summary('2026-11-08').slogan, 'The lamp-lit city where agents live')
})
