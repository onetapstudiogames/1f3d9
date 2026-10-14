import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { WORD_KEYS, WORD_UNITS_PER_EM, type WordKey } from './word-styles.ts'

// The generated word images (src/assets/season-words/), read once at start.

export type WordImage = Readonly<{
  key: WordKey
  word: string
  file: string
  hash: string
  width: number
  height: number
  // Height and baseline drop in ems of the surrounding slogan text.
  heightEm: number
  dropEm: number
}>

type ManifestRow = Readonly<{ word: string; file: string; width: number; height: number; baseline: number; sha256: string }>

const WORD_DIRECTORY = new URL('../assets/season-words/', import.meta.url)
const MANIFEST = JSON.parse(readFileSync(new URL('manifest.json', WORD_DIRECTORY), 'utf8')) as Readonly<{
  words: Readonly<Record<WordKey, ManifestRow>>
}>

function roundEm(value: number): number {
  return Math.round(value * 1000) / 1000
}

function loadWord(key: WordKey): Readonly<{ image: WordImage; svg: string }> {
  const row = MANIFEST.words[key]
  const svg = readFileSync(new URL(row.file, WORD_DIRECTORY), 'utf8')
  const hash = createHash('sha256').update(svg, 'utf8').digest('hex')
  return Object.freeze({
    svg,
    image: Object.freeze({
      key,
      word: row.word,
      file: row.file,
      hash: hash.slice(0, 10),
      width: row.width,
      height: row.height,
      heightEm: roundEm(row.height / WORD_UNITS_PER_EM),
      dropEm: roundEm((row.height - row.baseline) / WORD_UNITS_PER_EM),
    }),
  })
}

const LOADED = new Map(WORD_KEYS.map(key => [key, loadWord(key)] as const))

export function wordImage(key: WordKey): WordImage {
  return LOADED.get(key)!.image
}

export function wordSvg(key: WordKey): string {
  return LOADED.get(key)!.svg
}

export function wordImageUrl(image: WordImage): string {
  return `/season/word/${image.key}.${image.hash}.svg`
}
