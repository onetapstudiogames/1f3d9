// Regenerates the slogan word images in src/assets/season-words/ (one SVG of
// outlines per word, manifest.json, and LICENSES/) from the pinned Google Fonts
// files in scripts/season-fonts.json. Run it by hand with network access after
// changing a word in src/season/word-styles.ts:
//
//   npm run season:words
//
// It is never run in CI or on the server; the pages load only the committed
// images, never a font. Each font file must match its pinned sha256.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create } from 'fontkit'
import { WORD_KEYS, WORD_STYLES, WORD_UNITS_PER_EM } from '../src/season/word-styles.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT = join(ROOT, 'src', 'assets', 'season-words')
const LICENSES = join(OUT, 'LICENSES')
const CACHE = join(tmpdir(), '1f3d9-season-fonts')
const PAD = 2
const PINS = JSON.parse(readFileSync(join(ROOT, 'scripts', 'season-fonts.json'), 'utf8'))

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function download(path) {
  const url = PINS.source + path.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`could not download ${url}: HTTP ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

async function pinnedFont(pin) {
  mkdirSync(CACHE, { recursive: true })
  const cached = join(CACHE, `${pin.sha256}.ttf`)
  const bytes = existsSync(cached) ? readFileSync(cached) : await download(pin.path)
  if (sha256(bytes) !== pin.sha256) throw new Error(`${pin.path} does not match its pinned sha256`)
  writeFileSync(cached, bytes)
  return bytes
}

function number(value) {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

function pathData(commands, place) {
  const letters = { moveTo: 'M', lineTo: 'L', quadraticCurveTo: 'Q', bezierCurveTo: 'C', closePath: 'Z' }
  return commands.map(({ command, args }) => {
    const points = []
    for (let index = 0; index < args.length; index += 2) {
      const [x, y] = place(args[index], args[index + 1])
      points.push(`${number(x)} ${number(y)}`)
    }
    return letters[command] + points.join(' ')
  }).join('')
}

function layoutWord(font, style) {
  const text = style.upper ? style.word.toUpperCase() : style.word
  const fontSize = WORD_UNITS_PER_EM * style.size
  const scale = fontSize / font.unitsPerEm
  const run = font.layout(text)
  let pen = 0
  const glyphs = run.glyphs.map((glyph, index) => {
    const position = run.positions[index]
    const originX = pen + position.xOffset
    const originY = position.yOffset
    pen += position.xAdvance
    const place = (x, y) => [(originX + x) * scale, -(originY + y) * scale]
    const box = glyph.path.bbox
    const [left, bottom] = place(box.minX, box.minY)
    const [right, top] = place(box.maxX, box.maxY)
    return { commands: glyph.path.commands, place, left, right, top, bottom }
  })
  return { glyphs, fontSize }
}

function renderWord(font, style) {
  const { glyphs, fontSize } = layoutWord(font, style)
  const drawn = glyphs.filter(glyph => glyph.commands.length > 0)
  const shadow = Math.round((fontSize / 16) * 100) / 100
  const minX = Math.min(...drawn.map(glyph => glyph.left)) - PAD
  const minY = Math.min(...drawn.map(glyph => glyph.top)) - PAD
  const maxX = Math.max(...drawn.map(glyph => glyph.right)) + shadow + PAD
  const maxY = Math.max(...drawn.map(glyph => glyph.bottom)) + shadow + PAD
  const width = Math.round((maxX - minX) * 100) / 100
  const height = Math.round((maxY - minY) * 100) / 100
  const at = (glyph, dx) => pathData(glyph.commands, (x, y) => {
    const [px, py] = glyph.place(x, y)
    return [px - minX + dx, py - minY + dx]
  })
  const shadowPath = `<path fill="${style.shadow}" d="${drawn.map(glyph => at(glyph, shadow)).join('')}"/>`
  const facePaths = style.letters
    ? drawn.map((glyph, index) => `<path fill="${style.letters[index % style.letters.length]}" d="${at(glyph, 0)}"/>`).join('')
    : `<path fill="${style.color}" d="${drawn.map(glyph => at(glyph, 0)).join('')}"/>`
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${number(width)} ${number(height)}" width="${number(width)}" height="${number(height)}">${shadowPath}${facePaths}</svg>\n`
  return { svg, width, height, baseline: Math.round(-minY * 100) / 100 }
}

function fontFor(bytes, weight) {
  const font = create(bytes)
  return font.variationAxes && font.variationAxes.wght ? font.getVariation({ wght: weight }) : font
}

function licenceName(pin) {
  return `${pin.licence === 'Apache-2.0' ? 'Apache-2.0' : 'OFL'}-${pin.family.replaceAll(' ', '')}.txt`
}

async function main() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(LICENSES, { recursive: true })
  const pins = new Map(PINS.fonts.map(pin => [pin.family, pin]))
  const words = {}
  for (const key of WORD_KEYS) {
    const style = WORD_STYLES[key]
    const pin = pins.get(style.family)
    if (!pin) throw new Error(`no pinned font for ${style.family}`)
    const word = renderWord(fontFor(await pinnedFont(pin), style.weight), style)
    const file = `${key}.svg`
    writeFileSync(join(OUT, file), word.svg)
    words[key] = {
      word: style.word,
      file,
      width: word.width,
      height: word.height,
      baseline: word.baseline,
      family: style.family,
      weight: style.weight,
      licence: pin.licence,
      sha256: sha256(Buffer.from(word.svg, 'utf8')),
    }
  }
  const notice = [
    'The slogan word images in this folder are outlines generated by scripts/build-season-words.mjs',
    'from the fonts below. No font file is shipped or loaded by any page.',
    `Source: github.com/google/fonts at commit ${PINS.commit}.`,
    '',
  ]
  for (const pin of PINS.fonts) {
    const licence = await download(`${pin.path.split('/').slice(0, 2).join('/')}/${pin.licenceFile}`)
    writeFileSync(join(LICENSES, licenceName(pin)), licence)
    notice.push(`${pin.family}: ${pin.path} (${pin.licence}), licence in ${licenceName(pin)}`)
  }
  writeFileSync(join(LICENSES, 'NOTICE.txt'), `${notice.join('\n')}\n`)
  const manifest = { generator: 'scripts/build-season-words.mjs', fontsCommit: PINS.commit, unitsPerEm: WORD_UNITS_PER_EM, words }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

await main()
