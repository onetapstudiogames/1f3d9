import test from 'node:test'
import assert from 'node:assert/strict'
import { GUIDE_CSS } from '../src/guide-style.ts'
import { WINDOW_CSS } from '../src/window-style.ts'
import { CREDIT_GIFT_REDIRECT_PAGE_CSS } from '../src/credit-gift-redirect.ts'
import {
  formTokens,
  gazetteDarkTokens,
  gazetteLightTokens,
  liveTokens,
  PAL,
  paletteCss,
  paperTokens,
  stylesheetByFile,
  stylesheetFor,
  windowTokens,
} from '../src/season/palettes.ts'

// The approved design's palettes (drafts/city-seasons-design-2026-10-14.html, PAL).
const DESIGN = {
  spooky: {
    am: { forest: '#2d1b3d', paper: '#f5e6d3', 'paper-light': '#fffaf2', signal: '#f28c28', brick: '#7a3fa0', stone: '#c4b0d6', sky: '#eadcf3', line: '#9a8aa8' },
    wm: { night: '#0f0a14', 'night-soft': '#1b1224', 'w-forest': '#3a2250', 'w-paper': '#f1dfc8', 'w-signal': '#f28c28', 'w-sky': '#c9a8e6', 'w-line': '#2f2140', 'w-brick': '#7a3fa0', 'w-glow': '#4a2c63', 'w-panel': '#1e1229', 'w-edge': '#0b0610' },
  },
  harvest: {
    am: { forest: '#5a3a1e', paper: '#f5e9d4', 'paper-light': '#fffbf2', signal: '#e0a040', brick: '#9c4115', stone: '#d8bf96', sky: '#f2e3c6', line: '#a08a68' },
    wm: { night: '#140d07', 'night-soft': '#21160c', 'w-forest': '#6b4320', 'w-paper': '#f2e2c4', 'w-signal': '#e0a040', 'w-sky': '#e2c08c', 'w-line': '#3a2a18', 'w-brick': '#a8461a', 'w-glow': '#6e4a26', 'w-panel': '#2a1b0e', 'w-edge': '#0e0904' },
  },
  winter: {
    am: { forest: '#163a5e', paper: '#eef3f7', 'paper-light': '#ffffff', signal: '#f3d27a', brick: '#b3262c', stone: '#b8c9d6', sky: '#dfeaf3', line: '#8d9caa' },
    wm: { night: '#08111e', 'night-soft': '#0f1d30', 'w-forest': '#17406a', 'w-paper': '#e6eef5', 'w-signal': '#f3d27a', 'w-sky': '#a9c8e4', 'w-line': '#1d3350', 'w-brick': '#c0392b', 'w-glow': '#2a5a86', 'w-panel': '#0f2740', 'w-edge': '#06101c' },
  },
} as const

const SEASONS = ['spooky', 'harvest', 'winter'] as const

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16)
  const [r, g, b] = [value >> 16, (value >> 8) & 255, value & 255].map(channel => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (light! + 0.05) / (dark! + 0.05)
}

function tokenValue(css: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9a-f]{6})`, 'u').exec(css)
  assert.ok(match, name)
  return match[1]!
}

test('the season palettes are the approved design values', () => {
  for (const season of SEASONS) {
    assert.deepEqual({ ...PAL[season].am }, DESIGN[season].am, season)
    assert.deepEqual({ ...PAL[season].wm }, DESIGN[season].wm, season)
  }
})

test('every page family maps its tokens only onto design values', () => {
  for (const season of SEASONS) {
    const allowed = new Set<string>([...Object.values(DESIGN[season].am), ...Object.values(DESIGN[season].wm)])
    for (const tokens of [paperTokens(season), windowTokens(season), gazetteLightTokens(season), gazetteDarkTokens(season), formTokens(season), liveTokens(season)]) {
      for (const [name, value] of Object.entries(tokens)) {
        const hex = value.startsWith('rgba(')
          ? `#${value.slice(5, -1).split(',').slice(0, 3).map(part => Number(part).toString(16).padStart(2, '0')).join('')}`
          : value
        assert.ok(allowed.has(hex), `${season} ${name} ${value}`)
      }
    }
    assert.deepEqual(Object.keys(liveTokens(season)), ['--frame', '--frame-edge', '--control', '--control-hover', '--accent', '--quiet'])
  }
})

test('every token a season overrides already exists on the page it repaints', () => {
  const families: readonly [string, string, readonly string[]][] = [
    ['guide', GUIDE_CSS, Object.keys(paperTokens('spooky'))],
    ['window', WINDOW_CSS, Object.keys(windowTokens('spooky'))],
  ]
  for (const [name, css, tokens] of families) {
    const root = css.slice(0, css.indexOf('}'))
    for (const token of tokens) assert.ok(root.includes(`${token}:`), `${name} declares ${token}`)
  }
  for (const token of ['--forest', '--paper', '--paper-light', '--signal', '--sky']) {
    assert.ok(CREDIT_GIFT_REDIRECT_PAGE_CSS.includes(`${token}:`), `gift redirect declares ${token}`)
  }
})

test('season colors keep readable contrast where the pages pair them', () => {
  const guideInk = tokenValue(GUIDE_CSS, '--ink')
  const guideMuted = tokenValue(GUIDE_CSS, '--muted')
  const windowInk = tokenValue(WINDOW_CSS, '--ink')
  for (const season of SEASONS) {
    const { am, wm } = DESIGN[season]
    const pairs: readonly [string, string, string, number][] = [
      ['guide text on paper', guideInk, am.paper, 4.5],
      ['guide text on light paper', guideInk, am['paper-light'], 4.5],
      ['guide muted text on paper', guideMuted, am.paper, 4.5],
      ['guide muted text on sky panels', guideMuted, am.sky, 4.5],
      ['masthead slogan on forest', am.sky, am.forest, 4.5],
      ['masthead links on forest', am['paper-light'], am.forest, 4.5],
      ['text on signal buttons', guideInk, am.signal, 4.5],
      ['kicker brick on paper', am.brick, am.paper, 4.5],
      ['window text on night', wm['w-paper'], wm.night, 4.5],
      ['window text on night-soft', wm['w-paper'], wm['night-soft'], 4.5],
      ['window ink on signal', windowInk, wm['w-signal'], 4.5],
      ['window sky on panels', wm['w-sky'], wm['w-panel'], 4.5],
      ['window slogan on the sign', wm['w-sky'], wm['w-forest'], 4.5],
      ['window sign text', '#fffdf3', wm['w-forest'], 4.5],
      ['window badge on brick', '#ffffff', wm['w-brick'], 4.5],
      ['window sign strip text', '#f5efe0', wm['w-glow'], 4.5],
      ['window search help on its panel', '#b7cbc4', wm['w-forest'], 4.5],
      ['window filter labels on their panel', wm['w-sky'], wm['w-panel'], 4.5],
      ['gazette accent on light sheet', am.brick, am['paper-light'], 4.5],
      ['gazette text on dark sheet', wm['w-paper'], wm['night-soft'], 4.5],
      ['gazette accent on dark sheet', wm['w-signal'], wm['night-soft'], 4.5],
      ['gazette muted on dark sheet', wm['w-sky'], wm['night-soft'], 4.5],
      ['form text on page', wm['w-paper'], wm.night, 4.5],
      ['form text on panel', wm['w-paper'], wm['night-soft'], 4.5],
      ['form button text', '#151515', wm['w-signal'], 4.5],
      ['form links on panel', wm['w-signal'], wm['night-soft'], 4.5],
      ['live quiet text on frame', am.stone, wm['night-soft'], 4.5],
      ['live focus ring on frame', wm['w-signal'], wm['night-soft'], 3],
    ]
    for (const [name, foreground, background, minimum] of pairs) {
      const ratio = contrast(foreground, background)
      assert.ok(ratio >= minimum, `${season}: ${name} is ${ratio.toFixed(2)}:1`)
    }
  }
})

test('linked palette stylesheets are content-hashed and carry word sizing', () => {
  for (const family of ['paper', 'window'] as const) {
    for (const variant of [...SEASONS, 'plain'] as const) {
      const sheet = stylesheetFor(family, variant)
      assert.match(sheet.url, new RegExp(`^/season/${variant}-${family}\\.[0-9a-f]{10}\\.css$`, 'u'))
      assert.equal(stylesheetByFile(sheet.url.slice('/season/'.length)), sheet)
      assert.equal(sheet.css, paletteCss(family, variant))
      assert.match(sheet.css, /img\.season-word\.season-word--hanukkah\{height:[0-9.]+em;vertical-align:-[0-9.]+em\}/u)
      assert.equal(sheet.css.includes(':root{'), variant !== 'plain')
    }
  }
  assert.equal(stylesheetByFile('winter-paper.0000000000.css'), null)
  assert.match(paletteCss('gazette', 'winter'), /@media \(prefers-color-scheme:dark\)\{:root\{--ground:#08111e;/u)
  assert.doesNotMatch(paletteCss('form', 'winter'), /season-word/u)
})
