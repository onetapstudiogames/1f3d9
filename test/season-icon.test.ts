import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { addDays } from '../src/season/dates.ts'
import {
  artRect,
  BASE_ICON,
  composeIcon,
  iconKey,
  iconSpec,
  parseIconKey,
  placeParts,
  WINDOW_RECTS,
  ZONES,
  type IconSpec,
} from '../src/season/icon.ts'
import { resolveDay } from '../src/season/resolve.ts'

type Box = readonly [number, number, number, number]

// The five roof caps drawn by the snow part, in icon units.
const SNOW_BOXES: readonly Box[] = [
  [82, 118, 156, 133], [239, 144, 332, 159], [350, 170, 463, 185], [50, 229, 90, 243], [148, 229, 246, 243],
]

function overlaps(a: Box, b: Box): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]
}

function everySpec(): ReadonlyMap<string, IconSpec> {
  const specs = new Map<string, IconSpec>()
  for (let date = '2026-01-01'; date <= '2035-12-31'; date = addDays(date, 1)) {
    const spec = iconSpec(resolveDay(date))
    if (spec.length > 0) specs.set(iconKey(spec), spec)
  }
  return specs
}

const SPECS = everySpec()

test(`every dressed icon from 2026 to 2035 renders, keeps its art apart, and leaves the real icon untouched (${SPECS.size} icons)`, () => {
  const background = '<rect width="512" height="512" rx="112" ry="112" fill="#183a30"/>\n'
  const lineGroup = '  <g id="line">'
  const [head, rest] = [BASE_ICON.slice(0, BASE_ICON.indexOf(background) + background.length), BASE_ICON.slice(BASE_ICON.indexOf(background) + background.length)]
  const [middle, tail] = [rest.slice(0, rest.indexOf(lineGroup)), rest.slice(rest.indexOf(lineGroup), rest.lastIndexOf('</svg>'))]
  for (const [key, spec] of SPECS) {
    const svg = composeIcon(spec)
    assert.ok(svg.startsWith(head), key)
    assert.ok(svg.includes(middle), key)
    assert.ok(svg.includes(tail), key)
    assert.ok(svg.endsWith('</svg>\n'), key)
    assert.doesNotMatch(svg, /<script|href|data:|foreignObject|<image|<text|on[a-z]+=/iu, key)
    for (const item of spec) {
      const attribute = ['spooky', 'harvest', 'winter'].includes(item.key) ? 'data-season' : 'data-holiday'
      assert.match(svg, new RegExp(`<g ${attribute}="${item.key}">`, 'u'), `${key}: ${item.key} has its own group`)
    }
    const placed = placeParts(spec)
    const rects = placed.filter(entry => entry.zone !== 'ROOFS').map(entry => ({ key: entry.key, rect: artRect(entry) }))
    const roofs = placed.some(entry => entry.zone === 'ROOFS')
    for (const { rect } of rects) {
      assert.ok(rect[0] >= 0 && rect[1] >= 0 && rect[2] <= 512 && rect[3] <= 512, `${key}: inside the tile`)
      if (roofs) for (const snow of SNOW_BOXES) assert.ok(!overlaps(rect, snow), `${key}: clear of the roof snow`)
    }
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        assert.ok(!overlaps(rects[i]!.rect, rects[j]!.rect), `${key}: ${rects[i]!.key} and ${rects[j]!.key} do not overlap`)
      }
    }
  }
})

test('two candle rows meet side by side at half width, Hanukkah on the left', () => {
  const placed = placeParts(parseIconKey('hanukkah3+kwanzaa1')!)
  const hanukkah = placed.find(entry => entry.key === 'hanukkah')!
  const kwanzaa = placed.find(entry => entry.key === 'kwanzaa')!
  const street = ZONES.STREET_C
  const half = (street[2] - street[0]) / 2
  assert.deepEqual(hanukkah.box, [street[0], street[1], street[0] + half, street[3]])
  assert.deepEqual(kwanzaa.box, [street[0] + half, street[1], street[2], street[3]])
  // Alone, the candle row takes the whole street.
  assert.deepEqual(placeParts(parseIconKey('hanukkah5')!)[0]!.box, street)
})

test('a later holiday takes its second zone, then shares its home zone', () => {
  // Christmas's tree wants the right street, then the left; Hanukkah holds both.
  const placed = placeParts(parseIconKey('hanukkah2+christmas')!)
  const tree = placed.filter(entry => entry.key === 'christmas' && entry.zone.startsWith('STREET'))
  assert.equal(tree.length, 1)
  assert.equal(placed.find(entry => entry.key === 'hanukkah')!.box[2], tree[0]!.box[0])
  // Eid's crescent wants the right sky, then the left; both are taken, so it shares the right sky.
  const three = placeParts(parseIconKey('lny+valentine+fitr')!)
  const rightSky = three.filter(entry => entry.zone === 'SKY_R')
  assert.deepEqual(rightSky.map(entry => entry.key), ['lny', 'fitr'])
  assert.ok(rightSky[0]!.box[2] <= rightSky[1]!.box[0])
})

test('Hanukkah lights one more candle each night and Kwanzaa one more each day', () => {
  for (let night = 1; night <= 8; night += 1) {
    const flames = composeIcon(parseIconKey(`hanukkah${night}`)!).match(/fill="#ffd34d"/gu) ?? []
    assert.equal(flames.length, night + 1, `night ${night} plus the helper candle`)
  }
  for (let day = 1; day <= 7; day += 1) {
    const flames = composeIcon(parseIconKey(`kwanzaa${day}`)!).match(/fill="#ffd34d"/gu) ?? []
    assert.equal(flames.length, day, `day ${day}`)
  }
})

test('the 16 window lights sit exactly in the real icon window frames', () => {
  assert.deepEqual(WINDOW_RECTS, [
    [54.5128, 28.9423, 56.4615, 33.8141], [60.359, 28.9423, 62.3077, 33.8141],
    [54.5128, 38.6859, 56.4615, 43.5577], [60.359, 38.6859, 62.3077, 43.5577],
    [27.2308, 37.7115, 29.1795, 42.5833], [33.0769, 37.7115, 35.0256, 42.5833],
    [27.2308, 47.4551, 29.1795, 52.3269], [33.0769, 47.4551, 35.0256, 52.3269],
    [15.5385, 37.7115, 17.4872, 42.5833], [21.3846, 37.7115, 23.3333, 42.5833],
    [15.5385, 47.4551, 17.4872, 52.3269], [9.6923, 37.7115, 11.641, 42.5833],
    [9.6923, 47.4551, 11.641, 52.3269], [21.3846, 47.4551, 23.3333, 52.3269],
    [54.5128, 48.4295, 56.4615, 53.3013], [60.359, 48.4295, 62.3077, 53.3013],
  ])
  assert.match(composeIcon(parseIconKey('spooky')!), /<g id="season-glow" fill="#f7a33a">(?:<rect [^>]+\/>){16}<\/g>/u)
  assert.doesNotMatch(composeIcon(parseIconKey('holi')!), /season-glow/u)
})

test('icon keys name only known holidays, counted where they count, without repeats', () => {
  assert.deepEqual(parseIconKey('hanukkah2+christmas'), [{ key: 'hanukkah', n: 2 }, { key: 'christmas', n: null }])
  assert.deepEqual(parseIconKey('spooky'), [{ key: 'spooky', n: null }])
  for (const bad of ['', 'hanukkah', 'hanukkah9', 'kwanzaa8', 'christmas2', 'spooky+diwali', 'easter+easter',
    'unknown', 'lny+valentine+fitr+holi+nowruz+equinox+diwali', 'Christmas', 'hanukkah0']) {
    assert.equal(parseIconKey(bad), null, bad)
  }
})

test('the decorations name no sacred symbols, figures or scripture', () => {
  const source = readFileSync(new URL('../src/season/motifs.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(
    source,
    /\b(?:cross(?:es)?|crucifix|nativity|manger|kaaba|quran|koran|bible|torah|scripture|buddha|deity|deities|god|goddess|ganesh|lakshmi|shiva|krishna|jesus|mary|angel|halo|om)\b/iu,
  )
})
