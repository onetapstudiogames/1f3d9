import { seasonDateNow } from './clock.ts'
import { iconLabel, iconSpec, iconUrl } from './icon.ts'
import { paletteCss, stylesheetFor, type PageFamily } from './palettes.ts'
import { isDressed, resolveDay, type SeasonDay } from './resolve.ts'
import { escapeHtml, sloganHtml } from './slogan.ts'

// Writes today's theme into a human page as it is sent, so pages that run no
// scripts wear it too. Only our own templates carry these markers:
//   <!-- season:head -->                  the date, and the palette link
//   /* season:style */                    inside an inline <style>, the palette
//   <img data-season-icon ...>            the dressed icon and its label
//   <link data-season-icon rel="icon" ...>
//   <span data-season-slogan>...</span>   the slogan with its word images
// On a plain or quiet day the icon and slogan markup is left exactly as written.

const HEAD_MARKER = '<!-- season:head -->'
const STYLE_MARKER = '/* season:style */'
const ICON_TAG = /<(?:img|link)\b[^>]*\bdata-season-icon\b[^>]*>/gu
const SLOGAN = /(<(span|small|p)\b[^>]*\bdata-season-slogan\b[^>]*>)[^<]*(<\/\2>)/gu

function variantFor(day: SeasonDay) {
  return day.season?.key ?? 'plain'
}

function headHtml(day: SeasonDay, family: PageFamily): string {
  const meta = `<meta name="1f3d9-season-date" content="${day.date}">`
  if (!isDressed(day) || (family !== 'paper' && family !== 'window')) return meta
  return `${meta}\n  <link id="season-style" rel="stylesheet" href="${stylesheetFor(family, variantFor(day)).url}">`
}

function styleText(day: SeasonDay, family: PageFamily): string {
  if (!isDressed(day) || family === 'paper' || family === 'window') return ''
  if (family === 'form' && day.season === null) return ''
  return paletteCss(family, variantFor(day))
}

function dressIcon(tag: string, url: string, label: string): string {
  const withSource = tag.replace(/\s(src|href)="[^"]*"/u, (_, name: string) => ` ${name}="${url}"`)
  return withSource.startsWith('<img') ? withSource.replace(/\salt="[^"]*"/u, ` alt="${escapeHtml(label)}"`) : withSource
}

export function stampSeason(html: string, family: PageFamily, day: SeasonDay = resolveDay(seasonDateNow())): string {
  const stamped = html
    .replace(HEAD_MARKER, headHtml(day, family))
    .replace(STYLE_MARKER, styleText(day, family))
  if (!isDressed(day)) return stamped
  const spec = iconSpec(day)
  const url = iconUrl(spec)
  const label = iconLabel(spec)
  const slogan = sloganHtml(day)
  return stamped
    .replace(ICON_TAG, tag => dressIcon(tag, url, label))
    .replace(SLOGAN, (_, open: string, _name: string, close: string) => `${open}${slogan}${close}`)
}
