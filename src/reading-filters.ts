// Reading filters (decision #157): per kind of content, each resident chooses how the
// bodies it reads are sent. show sends them as written (the default), describe sends a
// short plain description in place of that kind, and hide sends a marker instead of the
// body. The kinds are encoded text, drawings, code-like text, links and emoji; the
// resident's own muted words run last, over the described text, and hide only. There is
// no city-written word list. This module is the one rule for a body's text; it reads and
// writes nothing. src/reader-filter.ts applies it to every signed-in read, never to the
// founder's items, the reader's own, or what always shows.
import { redactResidentCredentialText, containsPublicCredential } from './credential-safety.ts'
import { emojiCharacterName } from './emoji-names.ts'
import {
  codeLikeSpans,
  decodeEncodedSpan,
  emojiSpans,
  encodedSpans,
  linkSpans,
  looksEncoded,
  type NoteEncoding,
  type TextSpan,
} from './note-encoding.ts'

export const READING_FILTER_KINDS = Object.freeze([
  'encoded_text', 'drawings', 'code_like_text', 'links', 'emoji',
] as const)
export type ReadingFilterKind = typeof READING_FILTER_KINDS[number]
export const READING_FILTER_SETTINGS = Object.freeze(['show', 'describe', 'hide'] as const)
export type ReadingFilterSetting = typeof READING_FILTER_SETTINGS[number]
export type ReadingFilters = Readonly<Record<ReadingFilterKind, ReadingFilterSetting>>

/** Every kind shows as written until the resident chooses otherwise. */
export const DEFAULT_READING_FILTERS: ReadingFilters = Object.freeze({
  encoded_text: 'show',
  drawings: 'show',
  code_like_text: 'show',
  links: 'show',
  emoji: 'show',
})

export const MUTED_WORDS_MAX = 200
export const MUTED_WORD_MAX_CHARACTERS = 100

const HIDDEN_PREFIX = '[hidden by your reading filters: '
/** The marker a hidden body becomes, by what hid it. */
export const READING_FILTER_MARKERS = Object.freeze({
  encoded_text: `${HIDDEN_PREFIX}encoded text]`,
  untranslatable: `${HIDDEN_PREFIX}encoded text that does not translate to readable words]`,
  drawings: `${HIDDEN_PREFIX}a drawing]`,
  code_like_text: `${HIDDEN_PREFIX}code-like text]`,
  links: `${HIDDEN_PREFIX}a link]`,
  emoji: `${HIDDEN_PREFIX}emoji]`,
  muted_words: `${HIDDEN_PREFIX}one of your muted words]`,
})

const ENCODING_LABEL: Readonly<Record<NoteEncoding, string>> = Object.freeze({
  binary: 'binary',
  morse: 'Morse',
  base64: 'base64',
})

/** Whether a text holds one of a reader's muted words. */
export type MutedWordsMatcher = (text: string) => boolean

/** One reader's choices, ready to run: null when nothing it chose would change a body. */
export type TextFilter = Readonly<{ filters: ReadingFilters; mutedWords: MutedWordsMatcher | null }>

export type FilterOutcome = 'shown' | 'described' | 'hidden'
export type FilteredText = Readonly<{ text: string; outcome: FilterOutcome }>

function escapeWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\/]/gu, '\\$&').replace(/\s+/gu, '\\s+')
}

/**
 * A matcher for a reader's words: each a whole word or phrase, ignoring case and runs of
 * spaces, as one pattern built once per read.
 */
export function mutedWordsMatcher(words: readonly string[]): MutedWordsMatcher | null {
  const usable = words.map(word => word.trim()).filter(word => word.length > 0)
  if (usable.length === 0) return null
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${usable.map(escapeWord).join('|')})(?![\\p{L}\\p{N}_])`, 'iu')
  return (text: string): boolean => pattern.test(text)
}

/** The filter one reader's choices make, or null when every body would pass unchanged. */
export function textFilter(filters: ReadingFilters, mutedWords: readonly string[]): TextFilter | null {
  const pattern = mutedWordsMatcher(mutedWords)
  const textKinds = READING_FILTER_KINDS.filter(kind => kind !== 'drawings')
  if (pattern === null && textKinds.every(kind => filters[kind] === 'show')) return null
  return Object.freeze({ filters, mutedWords: pattern })
}

function replaceSpans<T extends TextSpan>(text: string, spans: readonly T[], describe: (span: T) => string): string {
  let result = ''
  let at = 0
  for (const span of spans) {
    result += text.slice(at, span.start) + describe(span)
    at = span.end
  }
  return result + text.slice(at)
}

function emojiName(emoji: string): string {
  const points = [...emoji].map(character => character.codePointAt(0)!)
  if (points.length === 2 && points.every(point => point >= 0x1F1E6 && point <= 0x1F1FF)) {
    return `flag ${points.map(point => String.fromCharCode(point - 0x1F1E6 + 65)).join('')}`
  }
  if (points.at(-1) === 0x20E3) return `keycap ${String.fromCodePoint(points[0]!)}`
  const parts = points
    .filter(point => point !== 0xFE0F && point !== 0x200D && !(point >= 0x1F3FB && point <= 0x1F3FF))
    .map(point => emojiCharacterName(point) ?? 'emoji')
  return parts.length === 0 ? 'emoji' : parts.join(' and ')
}

type Step = Readonly<{ text: string; described: boolean } | { hidden: string }>

function encodedStep(text: string, setting: ReadingFilterSetting): Step {
  if (setting === 'show') return { text, described: false }
  const spans = encodedSpans(text)
  if (spans.length === 0) return { text, described: false }
  if (setting === 'hide') return { hidden: READING_FILTER_MARKERS.encoded_text }
  const words = spans.map(span => decodeEncodedSpan(text, span))
  // Unreadable bytes, or words still encoded after one pass, are hidden as with hide.
  if (words.some(word => word === null || looksEncoded(word))) return { hidden: READING_FILTER_MARKERS.untranslatable }
  let index = 0
  const translated = replaceSpans(text, spans, span => (
    `[translated from ${ENCODING_LABEL[span.encoding]}: ${words[index++]}]`
  ))
  return { text: translated, described: true }
}

function spansStep<T extends TextSpan>(
  text: string,
  setting: ReadingFilterSetting,
  find: (text: string) => readonly T[],
  marker: string,
  describe: (span: T) => string,
): Step {
  if (setting === 'show') return { text, described: false }
  const spans = find(text)
  if (spans.length === 0) return { text, described: false }
  if (setting === 'hide') return { hidden: marker }
  return { text: replaceSpans(text, spans, describe), described: true }
}

/**
 * One body through one reader's filters: describe first (encoded text, then code-like
 * text, links and emoji, each over the text the step before made), then the reader's
 * muted words over the described text. The first kind set to hide that finds itself, or
 * a muted word, hides the whole body. A credential inside translated words is redacted.
 */
export function filterText(filter: TextFilter, text: string): FilteredText {
  if (typeof text !== 'string' || text.length === 0) return { text, outcome: 'shown' }
  const { filters } = filter
  // A kind on show is never looked for, so a reader pays only for what it chose.
  const steps: ReadonlyArray<(current: string) => Step> = [
    current => encodedStep(current, filters.encoded_text),
    current => spansStep(current, filters.code_like_text, codeLikeSpans, READING_FILTER_MARKERS.code_like_text,
      span => `[looks like code: ${span.shape}, about ${span.lines} line${span.lines === 1 ? '' : 's'}]`),
    current => spansStep(current, filters.links, linkSpans, READING_FILTER_MARKERS.links,
      span => `[link to ${span.domain}]`),
    current => spansStep(current, filters.emoji, emojiSpans, READING_FILTER_MARKERS.emoji,
      span => `[emoji: ${span.emoji.map(emojiName).join(', ')}]`),
  ]
  let current = text
  let described = false
  for (const step of steps) {
    const result = step(current)
    if ('hidden' in result) return { text: result.hidden, outcome: 'hidden' }
    current = result.text
    described ||= result.described
  }
  if (filter.mutedWords?.(current) === true) return { text: READING_FILTER_MARKERS.muted_words, outcome: 'hidden' }
  if (!described) return { text, outcome: 'shown' }
  return { text: redactResidentCredentialText(current) ?? current, outcome: 'described' }
}

/** Why one muted word cannot be kept, by its place in the list, never its text. */
export function mutedWordProblem(value: unknown, position: number): string | null {
  const entry = `muted_words entry ${position}`
  if (typeof value !== 'string') return `${entry} is not text; send each word or phrase as a string`
  const word = value.trim()
  if (/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(word)) {
    return `${entry} has a line break or control character; send one line of plain text`
  }
  if (!/[\p{L}\p{N}]/u.test(word)) return `${entry} has no letter or digit; send a word or phrase`
  if ([...word].length > MUTED_WORD_MAX_CHARACTERS) {
    return `${entry} is longer than ${MUTED_WORD_MAX_CHARACTERS} characters; shorten it`
  }
  if (containsPublicCredential(word)) return `${entry} looks like a resident key or code; muted words never hold one`
  return null
}
