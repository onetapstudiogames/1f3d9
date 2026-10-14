import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { WORD_KEYS, WORD_STYLES } from '../src/season/word-styles.ts'
import { wordImage, wordImageUrl, wordSvg } from '../src/season/words.ts'

const DIRECTORY = new URL('../src/assets/season-words/', import.meta.url)
const MANIFEST = JSON.parse(readFileSync(new URL('manifest.json', DIRECTORY), 'utf8')) as {
  words: Record<string, { word: string; file: string; family: string; weight: number; licence: string; sha256: string; width: number; height: number; baseline: number }>
}
const FONTS = JSON.parse(readFileSync(new URL('../scripts/season-fonts.json', import.meta.url), 'utf8')) as {
  commit: string
  fonts: { family: string; path: string; licence: string; sha256: string }[]
}

test('every slogan word has one committed outline image that matches the generator manifest', () => {
  assert.equal(WORD_KEYS.length, 26)
  assert.deepEqual(Object.keys(MANIFEST.words).sort(), [...WORD_KEYS].sort())
  const svgs = readdirSync(DIRECTORY).filter(name => name.endsWith('.svg')).sort()
  assert.deepEqual(svgs, WORD_KEYS.map(key => `${key}.svg`).sort())
  for (const key of WORD_KEYS) {
    const row = MANIFEST.words[key]!
    const svg = readFileSync(new URL(row.file, DIRECTORY), 'utf8')
    const style = WORD_STYLES[key]
    assert.equal(row.word, style.word, key)
    assert.equal(row.family, style.family, key)
    assert.equal(row.weight, style.weight, key)
    assert.equal(createHash('sha256').update(svg, 'utf8').digest('hex'), row.sha256, `${key}.svg matches the manifest`)
    assert.equal(wordSvg(key), svg)
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [0-9.]+ [0-9.]+" width="[0-9.]+" height="[0-9.]+">/u, key)
    // Outlines only: no text, fonts, styles, scripts, links or embedded data.
    const elements = [...svg.matchAll(/<([a-zA-Z]+)\b/gu)].map(match => match[1])
    assert.deepEqual([...new Set(elements)], ['svg', 'path'], key)
    assert.doesNotMatch(svg, /href|data:|<style|<script|<text|font/iu, key)
    assert.match(svg, new RegExp(`<path fill="${style.shadow}"`, 'u'), `${key} keeps its shadow color`)
    const paths = svg.match(/<path /gu)?.length ?? 0
    if (style.letters) {
      // One shadow path, then one path per letter, cycling the letter colors.
      const letters = style.word.replaceAll('-', '').length
      assert.equal(paths, letters + 1, key)
      style.letters.forEach(color => assert.match(svg, new RegExp(`fill="${color}"`, 'u'), `${key} ${color}`))
    } else {
      assert.equal(paths, 2, key)
      assert.match(svg, new RegExp(`<path fill="${style.color}"`, 'u'), key)
    }
    const image = wordImage(key)
    assert.equal(wordImageUrl(image), `/season/word/${key}.${row.sha256.slice(0, 10)}.svg`)
    assert.ok(image.heightEm > 0.9 && image.heightEm < 2.2, `${key} height ${image.heightEm}em`)
    assert.ok(image.dropEm >= 0 && image.dropEm < image.heightEm, key)
  }
})

test('Kwanzaa shows its word in capitals; both Easters share the word but not the font', () => {
  assert.equal(WORD_STYLES.kwanzaa.upper, true)
  assert.equal(WORD_STYLES.easter.word, WORD_STYLES.oeaster.word)
  assert.notEqual(WORD_STYLES.easter.family, WORD_STYLES.oeaster.family)
})

test('every font is pinned by hash and its licence ships beside the images', () => {
  assert.match(FONTS.commit, /^[0-9a-f]{40}$/u)
  const families = new Set(Object.values(WORD_STYLES).map(style => style.family))
  assert.equal(families.size, 24)
  assert.deepEqual(new Set(FONTS.fonts.map(font => font.family)), families)
  const licences = new URL('LICENSES/', DIRECTORY)
  for (const font of FONTS.fonts) {
    assert.match(font.sha256, /^[0-9a-f]{64}$/u, font.family)
    const apache = font.path.startsWith('apache/')
    assert.equal(font.licence, apache ? 'Apache-2.0' : 'OFL-1.1', font.family)
    const file = `${apache ? 'Apache-2.0' : 'OFL'}-${font.family.replaceAll(' ', '')}.txt`
    assert.ok(existsSync(new URL(file, licences)), file)
    assert.match(readFileSync(new URL(file, licences), 'utf8'), apache ? /Apache License/u : /SIL OPEN FONT LICENSE/iu, file)
  }
  assert.equal(FONTS.fonts.filter(font => font.licence === 'Apache-2.0').length, 2)
  const notice = readFileSync(new URL('NOTICE.txt', licences), 'utf8')
  for (const font of FONTS.fonts) assert.ok(notice.includes(font.path), font.path)
  assert.ok(notice.includes(FONTS.commit))
})
