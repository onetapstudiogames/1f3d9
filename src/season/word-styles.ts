import type { HolidayKey, SeasonKey } from './events.ts'

// The slogan words from the approved design: one word per holiday or season,
// each drawn in its own free font and colors. scripts/build-season-words.mjs
// turns these rows into the outline images in src/assets/season-words/; the
// pages load only those images, never a font. A word is laid out at
// WORD_UNITS_PER_EM units for each em of the slogan around it.

export const WORD_KEYS = [
  'spooky', 'harvest', 'winter', 'christmas', 'hanukkah', 'kwanzaa', 'diwali', 'newyear', 'lny',
  'valentine', 'holi', 'nowruz', 'fitr', 'adha', 'ramadan', 'passover', 'easter', 'oeaster',
  'vesak', 'rosh', 'thanks', 'muertos', 'decsol', 'junsol', 'equinox', 'birthday',
] as const
export type WordKey = typeof WORD_KEYS[number]

export type WordStyle = Readonly<{
  word: string
  family: string
  weight: number
  color: string | null
  letters: readonly string[] | null
  shadow: string
  size: number
  upper: boolean
}>

const INK = '#0b1714'

function style(
  word: string,
  family: string,
  options: Readonly<{ weight?: number; color?: string; letters?: readonly string[]; shadow?: string; size?: number; upper?: boolean }>,
): WordStyle {
  return Object.freeze({
    word,
    family,
    weight: options.weight ?? 400,
    color: options.color ?? null,
    letters: options.letters ? Object.freeze([...options.letters]) : null,
    shadow: options.shadow ?? INK,
    size: options.size ?? 1.35,
    upper: options.upper ?? false,
  })
}

export const WORD_STYLES: Readonly<Record<WordKey, WordStyle>> = Object.freeze({
  spooky: style('spooky', 'Creepster', { color: '#f28c28', shadow: '#5b2a86' }),
  harvest: style('cozy', 'Caveat Brush', { color: '#e0a040', shadow: '#6b3e1f', size: 1.5 }),
  winter: style('glowing', 'Snowburst One', { color: '#f3d27a', shadow: '#163a5e' }),
  christmas: style('jolly', 'Mountains of Christmas', { weight: 700, color: '#e63946', shadow: '#1f5c3a', size: 1.5 }),
  hanukkah: style('candlelit', 'Suez One', { color: '#8fbaff', shadow: '#0d2a5c' }),
  kwanzaa: style('united', 'Bungee', { letters: ['#e53935', '#f5f1e8', '#43a047'], upper: true }),
  diwali: style('lamp-lit', 'Yatra One', { color: '#ffb347', shadow: '#b0306a' }),
  newyear: style('sparkling', 'Monoton', { color: '#f3c74f', shadow: '#14213d' }),
  lny: style('lantern-lit', 'Kaushan Script', { color: '#f3c74f', shadow: '#c8202f' }),
  valentine: style('lovely', 'Great Vibes', { color: '#ff8fb1', shadow: '#a3214f', size: 1.7 }),
  holi: style('colorful', 'Baloo 2', { weight: 800, letters: ['#e84393', '#fdd835', '#43a047', '#1e88e5'] }),
  nowruz: style('new-day', 'Lalezar', { color: '#7ccf7f', shadow: '#1f5c2a' }),
  fitr: style('joyful', 'Reem Kufi', { weight: 700, color: '#e8b84f', shadow: '#1f7a4d' }),
  adha: style('generous', 'Reem Kufi', { weight: 700, color: '#e8b84f', shadow: '#1f7a4d' }),
  ramadan: style('moonlit', 'Aref Ruqaa', { weight: 700, color: '#f3e3a3', shadow: '#1d3557' }),
  passover: style('springtime', 'Frank Ruhl Libre', { weight: 700, color: '#9cc4ff', shadow: '#1b3f7a' }),
  easter: style('blooming', 'Dancing Script', { weight: 700, color: '#f7c6d9', shadow: '#7a4b8f', size: 1.5 }),
  oeaster: style('blooming', 'Cinzel Decorative', { weight: 700, color: '#ff8a80', shadow: '#7a1a1a' }),
  vesak: style('peaceful', 'Marcellus', { color: '#f5c26b', shadow: '#7a5a1f' }),
  rosh: style('sweet', 'Frank Ruhl Libre', { weight: 700, color: '#f6c453', shadow: '#8e1b2b' }),
  thanks: style('thankful', 'Amatic SC', { weight: 700, color: '#e0a040', shadow: '#6b3e1f', size: 1.6 }),
  muertos: style('remembering', 'Sancreek', { color: '#f7b733', shadow: '#8e44ad' }),
  decsol: style('starlit', 'Cinzel', { weight: 700, color: '#f3c74f', shadow: '#14213d' }),
  junsol: style('sunlit', 'Righteous', { color: '#f6c945', shadow: '#8a5a00' }),
  equinox: style('balanced', 'Josefin Sans', { weight: 700, color: '#dce9e3', shadow: '#183a30' }),
  birthday: style('birthday', 'Chewy', { letters: ['#e2b85e', '#ff8a65', '#dce9e3'] }),
})

// Both Thanksgivings share the one "thankful" image.
export function wordKeyFor(key: SeasonKey | HolidayKey): WordKey {
  return key === 'canthanks' ? 'thanks' : key
}

export const WORD_UNITS_PER_EM = 24
