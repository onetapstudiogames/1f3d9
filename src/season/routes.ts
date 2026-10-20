import type { Context, Hono } from 'hono'
import { err } from '../core.ts'
import { allowedPublicQuery } from '../public-pagination.ts'
import { seasonDateNow } from './clock.ts'
import { addDays } from './dates.ts'
import type { QuietKey } from './events.ts'
import { dressName, iconGround, iconLabel, iconSpec, iconUrl, parseIconFileKey, renderedIcon } from './icon.ts'
import {
  formTokens,
  gazetteDarkTokens,
  gazetteLightTokens,
  liveTokens,
  paperTokens,
  stylesheetByFile,
  stylesheetFor,
  windowTokens,
} from './palettes.ts'
import { isDressed, resolveDay, type SeasonDay } from './resolve.ts'
import { sloganParts, sloganText } from './slogan.ts'
import { WORD_KEYS, type WordKey } from './word-styles.ts'
import { wordImage, wordImageUrl, wordSvg } from './words.ts'

// GET /api/season: today's theme for the window's date-change refresh and the
// /live/ viewer. GET /season/<file>: the content-hashed palette stylesheets,
// dressed icons and slogan word images every human page links.

const QUIET_NAMES: Readonly<Record<QuietKey, string>> = Object.freeze({
  yomkippur: 'Yom Kippur',
  goodfriday: 'Good Friday',
  ogoodfriday: 'Orthodox Good Friday',
  ashura: 'Ashura',
})

const SEASON_CACHE = 'public, max-age=60, s-maxage=300, stale-while-revalidate=60'
const ASSET_CACHE = 'public, max-age=31536000, immutable'
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'"
const HASHED_FILE = /^([a-z0-9+-]+)\.([0-9a-f]{10})\.svg$/u

function seasonPayload(day: SeasonDay) {
  const spec = iconSpec(day)
  const dressed = isDressed(day)
  const season = day.season
  return {
    date: day.date,
    timezone: 'UTC',
    next_change_at: `${addDays(day.date, 1)}T00:00:00Z`,
    quiet: day.quiet.length > 0,
    quiet_days: day.quiet.map(key => ({ key, name: QUIET_NAMES[key] })),
    season: season ? { key: season.key, name: dressName(season.key), starts: season.start, ends: season.end } : null,
    holidays: day.holidays.map(holiday => ({
      key: holiday.key,
      name: dressName(holiday.key),
      starts: holiday.start,
      ends: holiday.end,
      count: holiday.count,
    })),
    palette: season
      ? {
          season: season.key,
          paper: paperTokens(season.key),
          window: windowTokens(season.key),
          gazette_light: gazetteLightTokens(season.key),
          gazette_dark: gazetteDarkTokens(season.key),
          dark_form: formTokens(season.key),
          live: liveTokens(season.key),
        }
      : null,
    stylesheets: dressed
      ? { paper: stylesheetFor('paper', season?.key ?? 'plain').url, window: stylesheetFor('window', season?.key ?? 'plain').url }
      : null,
    icon: { url: iconUrl(spec, iconGround(day)), label: iconLabel(spec), dressed },
    slogan: {
      text: sloganText(day),
      parts: sloganParts(day).map(part => typeof part === 'string' ? part : {
        word: part.word,
        key: part.key,
        image: wordImageUrl(part),
        width: part.width,
        height: part.height,
        height_em: part.heightEm,
        drop_em: part.dropEm,
      }),
    },
  }
}

function assetHeaders(c: Context, contentType: string): void {
  c.header('Content-Type', contentType)
  c.header('Cache-Control', ASSET_CACHE)
  c.header('Cross-Origin-Resource-Policy', 'cross-origin')
  if (contentType === 'image/svg+xml') c.header('Content-Security-Policy', SVG_CSP)
}

export function mountSeasonRoutes(app: Hono): void {
  app.get('/api/season', c => {
    const allowed = allowedPublicQuery(c.req.queries(), [])
    if (!allowed.ok) return err(c, 400, allowed.error)
    c.header('Cache-Control', SEASON_CACHE)
    return c.json(seasonPayload(resolveDay(seasonDateNow())))
  })
  app.get('/season/icon/:file', c => {
    const match = HASHED_FILE.exec(c.req.param('file'))
    const dress = match ? parseIconFileKey(match[1]!) : null
    if (!match || !dress) return c.notFound()
    const icon = renderedIcon(dress.spec, dress.ground)
    if (icon.hash !== match[2]) return c.notFound()
    assetHeaders(c, 'image/svg+xml')
    return c.body(icon.svg)
  })
  app.get('/season/word/:file', c => {
    const match = HASHED_FILE.exec(c.req.param('file'))
    if (!match || !(WORD_KEYS as readonly string[]).includes(match[1]!)) return c.notFound()
    const key = match[1] as WordKey
    if (wordImage(key).hash !== match[2]) return c.notFound()
    assetHeaders(c, 'image/svg+xml')
    return c.body(wordSvg(key))
  })
  app.get('/season/:file', c => {
    const sheet = stylesheetByFile(c.req.param('file'))
    if (!sheet) return c.notFound()
    assetHeaders(c, 'text/css; charset=utf-8')
    return c.body(sheet.css)
  })
}
