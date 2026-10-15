import { createHash } from 'node:crypto'
import type { SeasonKey } from './events.ts'
import { WORD_KEYS } from './word-styles.ts'
import { wordImage } from './words.ts'

// The three season palettes from the approved design, byte for byte. Every
// page family maps its own color tokens onto these values; nothing here adds a
// new color. `am` colors the light guide pages, `wm` the dark window.

type LightPalette = Readonly<Record<'forest' | 'paper' | 'paper-light' | 'signal' | 'brick' | 'stone' | 'sky' | 'line', string>>
type DarkPalette = Readonly<Record<
  'night' | 'night-soft' | 'w-forest' | 'w-paper' | 'w-signal' | 'w-sky' | 'w-line' | 'w-brick' | 'w-glow' | 'w-panel' | 'w-edge',
  string
>>

export const PAL: Readonly<Record<SeasonKey, Readonly<{ name: string; am: LightPalette; wm: DarkPalette }>>> = Object.freeze({
  spooky: Object.freeze({
    name: 'pumpkin and midnight purple',
    am: Object.freeze({ forest: '#2d1b3d', paper: '#f5e6d3', 'paper-light': '#fffaf2', signal: '#f28c28', brick: '#7a3fa0', stone: '#c4b0d6', sky: '#eadcf3', line: '#9a8aa8' }),
    wm: Object.freeze({ night: '#0f0a14', 'night-soft': '#1b1224', 'w-forest': '#3a2250', 'w-paper': '#f1dfc8', 'w-signal': '#f28c28', 'w-sky': '#c9a8e6', 'w-line': '#2f2140', 'w-brick': '#7a3fa0', 'w-glow': '#4a2c63', 'w-panel': '#1e1229', 'w-edge': '#0b0610' }),
  }),
  harvest: Object.freeze({
    name: 'amber, rust and wheat',
    am: Object.freeze({ forest: '#5a3a1e', paper: '#f5e9d4', 'paper-light': '#fffbf2', signal: '#e0a040', brick: '#9c4115', stone: '#d8bf96', sky: '#f2e3c6', line: '#a08a68' }),
    wm: Object.freeze({ night: '#140d07', 'night-soft': '#21160c', 'w-forest': '#6b4320', 'w-paper': '#f2e2c4', 'w-signal': '#e0a040', 'w-sky': '#e2c08c', 'w-line': '#3a2a18', 'w-brick': '#a8461a', 'w-glow': '#6e4a26', 'w-panel': '#2a1b0e', 'w-edge': '#0e0904' }),
  }),
  winter: Object.freeze({
    name: 'winter night, gold lights, snow and holly red',
    am: Object.freeze({ forest: '#163a5e', paper: '#eef3f7', 'paper-light': '#ffffff', signal: '#f3d27a', brick: '#b3262c', stone: '#b8c9d6', sky: '#dfeaf3', line: '#8d9caa' }),
    wm: Object.freeze({ night: '#08111e', 'night-soft': '#0f1d30', 'w-forest': '#17406a', 'w-paper': '#e6eef5', 'w-signal': '#f3d27a', 'w-sky': '#a9c8e4', 'w-line': '#1d3350', 'w-brick': '#c0392b', 'w-glow': '#2a5a86', 'w-panel': '#0f2740', 'w-edge': '#06101c' }),
  }),
})

export type PageFamily = 'paper' | 'window' | 'gazette' | 'form'
export type TokenMap = Readonly<Record<string, string>>

function rgba(hex: string, alpha: number): string {
  const value = Number.parseInt(hex.slice(1), 16)
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

// The guide pages, /tools, /changelog, /terms, /privacy, /support, /treasury,
// /buy and /gift-redirect share these token names.
export function paperTokens(season: SeasonKey): TokenMap {
  const am = PAL[season].am
  return Object.freeze({
    '--forest': am.forest,
    '--paper': am.paper,
    '--paper-light': am['paper-light'],
    '--signal': am.signal,
    '--brick': am.brick,
    '--stone': am.stone,
    '--sky': am.sky,
    '--line': am.line,
    '--paper-wash': rgba(am.paper, 0.94),
    '--grid-line': rgba(am.forest, 0.15),
    '--grid-line-soft': rgba(am.forest, 0.11),
  })
}

export function windowTokens(season: SeasonKey): TokenMap {
  const wm = PAL[season].wm
  return Object.freeze({
    '--night': wm.night,
    '--night-soft': wm['night-soft'],
    '--forest': wm['w-forest'],
    '--paper': wm['w-paper'],
    '--signal': wm['w-signal'],
    '--sky': wm['w-sky'],
    '--line': wm['w-line'],
    '--brick': wm['w-brick'],
    '--forest-deep': wm['w-panel'],
    '--glow': wm['w-glow'],
    '--edge': wm['w-edge'],
    '--sign-strip': wm['w-glow'],
    '--search-panel': wm['w-forest'],
    '--filter-panel': wm['w-panel'],
    // The window's tab headings. Map, Things, Talk and Agreements already
    // follow --forest-deep and --signal; these dress the other five.
    '--heading-place': wm['w-forest'],
    '--heading-conversation': wm['w-brick'],
    '--heading-happening': wm['w-glow'],
    '--heading-archive': wm['w-line'],
    '--heading-gazette': wm['w-brick'],
  })
}

// The browser bar color for the window page.
export function windowThemeColor(season: SeasonKey): string {
  return PAL[season].wm.night
}

export function gazetteLightTokens(season: SeasonKey): TokenMap {
  const am = PAL[season].am
  return Object.freeze({ '--ground': am.paper, '--sheet': am['paper-light'], '--line': am.line, '--accent': am.brick })
}

export function gazetteDarkTokens(season: SeasonKey): TokenMap {
  const wm = PAL[season].wm
  return Object.freeze({
    '--ground': wm.night,
    '--sheet': wm['night-soft'],
    '--ink': wm['w-paper'],
    '--muted': wm['w-sky'],
    '--line': wm['w-line'],
    '--accent': wm['w-signal'],
  })
}

// The dark sign-in, consent, join, rotate and recovery pages.
export function formTokens(season: SeasonKey): TokenMap {
  const { am, wm } = PAL[season]
  return Object.freeze({
    '--bg': wm.night,
    '--panel': wm['night-soft'],
    '--border': wm['w-line'],
    '--text': wm['w-paper'],
    '--accent': wm['w-signal'],
    '--field-border': am.line,
  })
}

// The /live/ viewer's own six tokens (onetapstudiogames/1f3d9-live).
export function liveTokens(season: SeasonKey): TokenMap {
  const { am, wm } = PAL[season]
  return Object.freeze({
    '--frame': wm['night-soft'],
    '--frame-edge': am.line,
    '--control': wm['w-line'],
    '--control-hover': wm['w-forest'],
    '--accent': wm['w-signal'],
    '--quiet': am.stone,
  })
}

function rootBlock(tokens: TokenMap): string {
  return `:root{${Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(';')}}`
}

// Word image sizing. Pages whose policy allows only same-origin styles cannot
// size each word inline, so every word gets a class here. The doubled class
// outranks page rules such as `.guide-brand img`.
const WORD_CSS = [
  'img.season-word.season-word{display:inline-block;width:auto;max-width:none;margin:0 .06em;border:0;border-radius:0;box-shadow:none;filter:none}',
  ...WORD_KEYS.map(key => {
    const image = wordImage(key)
    return `img.season-word.season-word--${key}{height:${image.heightEm}em;vertical-align:-${image.dropEm}em}`
  }),
].join('\n')

export type PaletteVariant = SeasonKey | 'plain'

// The stylesheet text for one page family. 'plain' carries word sizing only,
// for a holiday outside the three seasons.
export function paletteCss(family: PageFamily, variant: PaletteVariant): string {
  const words = family === 'form' ? '' : `${WORD_CSS}\n`
  if (variant === 'plain') return words
  switch (family) {
    case 'paper': return `${words}${rootBlock(paperTokens(variant))}\n`
    case 'window': return `${words}${rootBlock(windowTokens(variant))}\n`
    case 'gazette': return `${words}${rootBlock(gazetteLightTokens(variant))}\n`
      + `@media (prefers-color-scheme:dark){${rootBlock(gazetteDarkTokens(variant))}}\n`
    case 'form': return `${rootBlock(formTokens(variant))}\n`
  }
}

export type LinkedFamily = 'paper' | 'window'
type Stylesheet = Readonly<{ name: string; css: string; url: string }>

function hashed(name: string, css: string): Stylesheet {
  const hash = createHash('sha256').update(css, 'utf8').digest('hex').slice(0, 10)
  return Object.freeze({ name, css, url: `/season/${name}.${hash}.css` })
}

const VARIANTS: readonly PaletteVariant[] = ['spooky', 'harvest', 'winter', 'plain']
const STYLESHEETS: readonly Stylesheet[] = Object.freeze((['paper', 'window'] as const).flatMap(family => (
  VARIANTS.map(variant => hashed(`${variant}-${family}`, paletteCss(family, variant)))
)))

export function stylesheetFor(family: LinkedFamily, variant: PaletteVariant): Stylesheet {
  return STYLESHEETS.find(sheet => sheet.name === `${variant}-${family}`)!
}

// The stylesheet a /season/<file> request names, or null.
export function stylesheetByFile(file: string): Stylesheet | null {
  return STYLESHEETS.find(sheet => file === sheet.url.slice('/season/'.length)) ?? null
}
