import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { HOLIDAY_KEYS, SEASON_KEYS, type HolidayKey, type SeasonKey } from './events.ts'
import { motifParts, type ArtKey, type Part, type ZoneId } from './motifs.ts'
import { PAL } from './palettes.ts'
import type { SeasonDay } from './resolve.ts'

// The real skyline icon (src/assets/1f3d9-icon.svg) dressed for a day. Every
// active holiday's art is drawn at once, each in its own group and its own
// place: a part takes its home zone, else its second zone, else it shares its
// home zone side by side with what is already there. Nothing is blended.

export const BASE_ICON = readFileSync(new URL('../assets/1f3d9-icon.svg', import.meta.url), 'utf8')
const PLAIN_ICON_URL = '/favicon.svg'
export const PLAIN_ICON_LABEL = 'The 1F3D9 skyline'

type DressKey = SeasonKey | HolidayKey
export type IconSpec = readonly Readonly<{ key: DressKey; n: number | null }>[]
// The season whose colors the icon's tile takes, or null for the real green.
export type Ground = SeasonKey | null
type Box = readonly [number, number, number, number]

// Zones in the icon's 512-unit space, clear of the buildings' outlines.
export const ZONES: Readonly<Record<Exclude<ZoneId, 'ROOFS'>, Box>> = Object.freeze({
  SKY_L: [36, 28, 120, 116],
  SKY_C: [160, 24, 330, 140],
  SKY_R: [340, 26, 480, 136],
  MAST: [122, 60, 158, 129],
  STRING: [150, 140, 239, 216],
  LEDGE_LOW: [158, 217, 240, 238],
  LEDGE_R: [362, 140, 455, 168],
  FACADE: [60, 248, 455, 366],
  STREET_L: [52, 392, 250, 468],
  STREET_R: [262, 392, 460, 468],
  STREET_C: [70, 392, 442, 468],
})

const BACK_ZONES = new Set<ZoneId>(['SKY_L', 'SKY_C', 'SKY_R', 'MAST'])
const MAX_SCALE = 4

const NAMES: Readonly<Record<DressKey, string>> = Object.freeze({
  spooky: 'spooky season', harvest: 'harvest season', winter: 'the season of lights',
  newyear: 'New Year', lny: 'Lunar New Year', valentine: "Valentine's Day", holi: 'Holi', nowruz: 'Nowruz',
  equinox: 'the equinox', ramadan: 'the start of Ramadan', fitr: 'Eid al-Fitr', adha: 'Eid al-Adha',
  passover: 'Passover', easter: 'Easter', oeaster: 'Orthodox Easter', vesak: 'Vesak', junsol: 'the June solstice',
  birthday: "the city's birthday", rosh: 'Rosh Hashanah', canthanks: 'Canadian Thanksgiving', diwali: 'Diwali',
  muertos: 'Día de los Muertos', thanks: 'Thanksgiving', hanukkah: 'Hanukkah', decsol: 'the December solstice',
  christmas: 'Christmas', kwanzaa: 'Kwanzaa',
})

const GLOW: Readonly<Partial<Record<DressKey, string>>> = Object.freeze({
  spooky: '#f7a33a', harvest: '#f1c27d', winter: '#ffe39a', diwali: '#ffb347', hanukkah: '#ffe39a', kwanzaa: '#ffe39a',
  newyear: '#ffe9a8', lny: '#ffd27a', valentine: '#ffc2d4', fitr: '#ffe39a', adha: '#ffe39a', rosh: '#f6c453',
  canthanks: '#f1c27d', thanks: '#f1c27d', christmas: '#ffe39a', ramadan: '#f7e0a3', muertos: '#ffb347', decsol: '#ffe39a',
})

export function dressName(key: DressKey): string {
  return NAMES[key]
}

function artKey(key: DressKey): ArtKey {
  if (key === 'canthanks' || key === 'thanks') return 'harvest'
  if (key === 'fitr' || key === 'adha') return 'eid'
  return key
}

// The tile behind the skyline. On a season day it takes the season's forest,
// the color of the guide masthead it sits on, so the old green never shows
// against a season header. A holiday outside the seasons, a quiet day and an
// ordinary day keep the real icon's green.
export const PLAIN_GROUND = '#183a30'

export function groundColor(ground: Ground): string {
  return ground === null ? PLAIN_GROUND : PAL[ground].am.forest
}

export function iconGround(day: SeasonDay): Ground {
  return day.season?.key ?? null
}

function isSeason(key: string): key is SeasonKey {
  return (SEASON_KEYS as readonly string[]).includes(key)
}

// A season's own icon stands on that season's ground; holidays alone stand on
// the real green unless a ground is named.
function ownGround(spec: IconSpec): Ground {
  const only = spec.length === 1 ? spec[0]!.key : null
  return only !== null && isSeason(only) ? only : null
}

export function iconSpec(day: SeasonDay): IconSpec {
  if (day.holidays.length > 0) return day.holidays.map(holiday => ({ key: holiday.key, n: holiday.count?.n ?? null }))
  return day.season ? [{ key: day.season.key, n: null }] : []
}

function joinNames(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export function iconLabel(spec: IconSpec): string {
  return spec.length === 0 ? PLAIN_ICON_LABEL : `${PLAIN_ICON_LABEL}, dressed for ${joinNames(spec.map(item => NAMES[item.key]))}`
}

// A holiday inside a season names the season's ground first: "harvest-diwali".
export function iconKey(spec: IconSpec, ground: Ground = ownGround(spec)): string {
  const dress = spec.map(item => `${item.key}${item.n ?? ''}`).join('+')
  return ground !== null && ground !== ownGround(spec) ? `${ground}-${dress}` : dress
}

const MAX_PARTS = 6
const COUNTED: Readonly<Partial<Record<DressKey, number>>> = Object.freeze({ hanukkah: 8, kwanzaa: 7 })
const KEY_PART = /^([a-z]+?)([1-8]?)$/u

// The spec a /season/icon/<key>.<hash>.svg key names, or null.
export function parseIconKey(key: string): IconSpec | null {
  const parts = key.split('+')
  if (parts.length === 0 || parts.length > MAX_PARTS) return null
  const spec: { key: DressKey; n: number | null }[] = []
  for (const part of parts) {
    const match = KEY_PART.exec(part)
    if (!match) return null
    const name = match[1] as DressKey
    const isSeason = (SEASON_KEYS as readonly string[]).includes(name)
    if (!isSeason && !(HOLIDAY_KEYS as readonly string[]).includes(name)) return null
    if (isSeason && parts.length !== 1) return null
    const max = COUNTED[name]
    const n = match[2] ? Number(match[2]) : null
    if (max === undefined ? n !== null : n === null || n > max) return null
    if (spec.some(item => item.key === name)) return null
    spec.push({ key: name, n })
  }
  return spec
}

// The spec and ground a /season/icon/<key>.<hash>.svg key names, or null.
export function parseIconFileKey(key: string): Readonly<{ spec: IconSpec; ground: Ground }> | null {
  const dash = key.indexOf('-')
  if (dash === -1) {
    const spec = parseIconKey(key)
    return spec && spec.length > 0 ? Object.freeze({ spec, ground: ownGround(spec) }) : null
  }
  const ground = key.slice(0, dash)
  const spec = parseIconKey(key.slice(dash + 1))
  if (!isSeason(ground) || !spec || spec.length === 0 || ownGround(spec) !== null) return null
  return Object.freeze({ spec, ground })
}

type Placed = Readonly<{ key: DressKey; part: Part; zone: ZoneId; box: Box }>
type Lane = { readonly id: ZoneId; readonly items: { key: DressKey; part: Part; zone: ZoneId }[] }

function laneOf(zone: ZoneId): ZoneId {
  return zone === 'STREET_L' || zone === 'STREET_R' ? 'STREET_C' : zone
}

function isFree(lanes: ReadonlyMap<ZoneId, Lane>, zone: ZoneId): boolean {
  const items = lanes.get(laneOf(zone))?.items ?? []
  if (zone === 'STREET_L' || zone === 'STREET_R') return items.every(item => item.zone !== zone && item.zone !== 'STREET_C')
  return items.length === 0
}

function slices(box: Box, count: number): readonly Box[] {
  const width = (box[2] - box[0]) / count
  return Array.from({ length: count }, (_, i) => [box[0] + width * i, box[1], box[0] + width * (i + 1), box[3]] as const)
}

function layoutLane(lane: Lane): readonly Placed[] {
  const { items } = lane
  const ownBoxes = lane.id === 'STREET_C'
    && items.length <= 2
    && items.every(item => item.zone !== 'STREET_C')
    && new Set(items.map(item => item.zone)).size === items.length
  if (items.length === 1 || ownBoxes) {
    return items.map(item => ({ key: item.key, part: item.part, zone: item.zone, box: ZONES[item.zone as keyof typeof ZONES] }))
  }
  const boxes = slices(ZONES[lane.id as keyof typeof ZONES], items.length)
  return items.map((item, i) => ({ key: item.key, part: item.part, zone: item.zone, box: boxes[i]! }))
}

// Where every part of every active holiday goes. Exported for the tests.
export function placeParts(spec: IconSpec): readonly Placed[] {
  const lanes = new Map<ZoneId, Lane>()
  const overlays: Placed[] = []
  for (const item of spec) {
    for (const part of motifParts(artKey(item.key), item.n ?? 1)) {
      if (part.home === 'ROOFS') {
        overlays.push({ key: item.key, part, zone: 'ROOFS', box: [0, 0, 512, 512] })
        continue
      }
      const zone = isFree(lanes, part.home) ? part.home
        : part.second !== null && isFree(lanes, part.second) ? part.second
        : part.home
      const lane = lanes.get(laneOf(zone)) ?? { id: laneOf(zone), items: [] }
      lane.items.push({ key: item.key, part, zone })
      lanes.set(lane.id, lane)
    }
  }
  return [...[...lanes.values()].flatMap(layoutLane), ...overlays]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

// Where a part's art lands: its frame scaled to fit its box (at most
// MAX_SCALE icon units per art unit), centered across, aligned as it asks.
export function artRect(placed: Placed): Box {
  const [x0, y0, x1, y1] = placed.part.src
  const [bx0, by0, bx1, by1] = placed.box
  // Roof snow and facade splashes are drawn in icon units already.
  const limit = placed.zone === 'ROOFS' || placed.zone === 'FACADE' ? 1 : MAX_SCALE
  const scale = Math.min((bx1 - bx0) / (x1 - x0), (by1 - by0) / (y1 - y0), limit)
  const width = (x1 - x0) * scale
  const height = (y1 - y0) * scale
  const left = bx0 + ((bx1 - bx0) - width) / 2
  const free = (by1 - by0) - height
  const top = by0 + (placed.part.align === 'top' ? 0 : placed.part.align === 'center' ? free / 2 : free)
  return [left, top, left + width, top + height]
}

function placedArt(placed: Placed): string {
  const [x0, y0, x1] = placed.part.src
  const [left, top, right] = artRect(placed)
  const scale = (right - left) / (x1 - x0)
  return `<g transform="translate(${round(left - x0 * scale)} ${round(top - y0 * scale)}) scale(${round(scale)})">${placed.part.art}</g>`
}

function layer(placed: readonly Placed[], back: boolean, spec: IconSpec): string {
  return spec.map(item => {
    const own = placed.filter(entry => entry.key === item.key && BACK_ZONES.has(entry.zone) === back)
    if (own.length === 0) return ''
    const attribute = (SEASON_KEYS as readonly string[]).includes(item.key) ? 'data-season' : 'data-holiday'
    return `<g ${attribute}="${item.key}">${own.map(placedArt).join('')}</g>`
  }).join('')
}

// The 16 windows: the L-shaped polylines one window wide and tall.
export const WINDOW_RECTS: readonly Box[] = Object.freeze([...BASE_ICON.matchAll(/<polyline[^>]*points="([^"]+)"/gu)]
  .map(match => match[1]!.trim().split(/\s+/u).map(Number))
  .filter(p => p.length === 6 && p[1] === p[3] && p[2] === p[4] && p[0]! - p[2]! > 1.9 && p[0]! - p[2]! < 2 && p[3]! - p[5]! > 4.8 && p[3]! - p[5]! < 4.9)
  .map(p => [p[2]!, p[5]!, p[0]!, p[1]!] as const))

const BACKGROUND = '<rect width="512" height="512" rx="112" ry="112" fill="#183a30"/>\n'
const LINE_GROUP = '  <g id="line">'
const CLOSE = '</svg>'

// The real icon's green, as the tile and as the see-through holes (TILE) in motifs.ts.
const PLAIN_TILE_FILL = `fill="${PLAIN_GROUND}"`

export function composeIcon(spec: IconSpec, ground: Ground = ownGround(spec)): string {
  const placed = placeParts(spec)
  const glow = spec.map(item => GLOW[item.key]).find(color => color !== undefined)
  const windows = glow
    // Each window is an open L of two frame lines; the light spills a little
    // past the open right side so it reads at small sizes.
    ? `<g id="season-glow" fill="${glow}">${WINDOW_RECTS.map(([x0, y0, x1, y1]) => `<rect x="${x0}" y="${y0}" width="${round(x1 - x0 + 1)}" height="${round(y1 - y0)}"/>`).join('')}</g>\n`
    : ''
  const back = `<defs><clipPath id="season-tile"><rect width="512" height="512" rx="112" ry="112"/></clipPath></defs>`
    + `<g id="season-back" clip-path="url(#season-tile)">${layer(placed, true, spec)}</g>\n`
  const front = `<g id="season-front" clip-path="url(#season-tile)">${layer(placed, false, spec)}</g>\n`
  return BASE_ICON
    .replace(BACKGROUND, `${BACKGROUND}  ${back}`)
    .replace(LINE_GROUP, `  ${windows}${LINE_GROUP}`)
    .replace(CLOSE, `${front}${CLOSE}`)
    .replaceAll(PLAIN_TILE_FILL, `fill="${groundColor(ground)}"`)
}

type Rendered = Readonly<{ svg: string; hash: string }>
const LRU_SIZE = 64
const rendered = new Map<string, Rendered>()

export function renderedIcon(spec: IconSpec, ground: Ground = ownGround(spec)): Rendered {
  const key = iconKey(spec, ground)
  const cached = rendered.get(key)
  if (cached) {
    rendered.delete(key)
    rendered.set(key, cached)
    return cached
  }
  const svg = composeIcon(spec, ground)
  const value = Object.freeze({ svg, hash: createHash('sha256').update(svg, 'utf8').digest('hex').slice(0, 10) })
  rendered.set(key, value)
  if (rendered.size > LRU_SIZE) rendered.delete(rendered.keys().next().value!)
  return value
}

export function iconUrl(spec: IconSpec, ground: Ground = ownGround(spec)): string {
  return spec.length === 0 ? PLAIN_ICON_URL : `/season/icon/${iconKey(spec, ground)}.${renderedIcon(spec, ground).hash}.svg`
}
