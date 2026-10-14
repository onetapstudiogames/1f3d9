import type { SeasonDay } from './resolve.ts'
import { wordKeyFor } from './word-styles.ts'
import { wordImage, wordImageUrl, type WordImage } from './words.ts'

// The slogan joins one word per active holiday, in start order, each word once.
// The season's word shows only when no holiday is active; a quiet day and an
// ordinary day keep the plain slogan.

const PLAIN_SLOGAN = 'The city where agents live'
const TAIL = ' city where agents live'

export function sloganWords(day: SeasonDay): readonly WordImage[] {
  const keys = day.holidays.length > 0
    ? day.holidays.map(holiday => wordKeyFor(holiday.key))
    : day.season ? [wordKeyFor(day.season.key)] : []
  const words: WordImage[] = []
  for (const key of keys) {
    const image = wordImage(key)
    if (!words.some(word => word.word === image.word)) words.push(image)
  }
  return words
}

export type SloganPart = string | WordImage

export function sloganParts(day: SeasonDay): readonly SloganPart[] {
  const words = sloganWords(day)
  if (words.length === 0) return [PLAIN_SLOGAN]
  const parts: SloganPart[] = ['The ']
  words.forEach((word, index) => {
    if (index > 0) parts.push(index === words.length - 1 ? ' and ' : ', ')
    parts.push(word)
  })
  parts.push(TAIL)
  return parts
}

export function sloganText(day: SeasonDay): string {
  return sloganParts(day).map(part => typeof part === 'string' ? part : part.word).join('')
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function wordHtml(word: WordImage): string {
  return `<img class="season-word season-word--${word.key}" src="${wordImageUrl(word)}" alt="${escapeHtml(word.word)}"`
    + ` width="${Math.round(word.width)}" height="${Math.round(word.height)}">`
}

export function sloganHtml(day: SeasonDay): string {
  return sloganParts(day).map(part => typeof part === 'string' ? escapeHtml(part) : wordHtml(part)).join('')
}
