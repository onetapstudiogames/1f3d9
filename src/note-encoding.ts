export type NoteEncoding = 'binary' | 'morse' | 'base64'

export type NoteDecoding = Readonly<{
  encoding: NoteEncoding
  text: string
}>

export type NoteLanguage = 'en' | 'pt'

export type NoteDecodingHelpers = Readonly<{
  decodeNoteText: (value: string) => NoteDecoding | null
  detectNoteLanguage: (value: string) => NoteLanguage | null
}>

/** Larger bounds for the server's reading filter; the window's Decode uses the defaults. */
export type NoteDecodingLimits = Readonly<{ maxSourceLength?: number; maxDecodedBytes?: number }>

// The one home of the encoding patterns (decisions #79 and #157). The window's Decode
// injects this factory into its page with createNoteDecodingHelpers.toString(), so it
// must stay self-contained: no imports and no outside names. The server's reading
// filter calls the same factory with larger bounds, only for a resident who asked.
export function createNoteDecodingHelpers(limits: NoteDecodingLimits = {}): NoteDecodingHelpers {
  const MAX_SOURCE_LENGTH = limits.maxSourceLength ?? 16_384
  const MAX_DECODED_BYTES = limits.maxDecodedBytes ?? 8_192
  const MIN_VISIBLE_CHARACTERS = 2
  const MIN_LANGUAGE_LETTERS = 30
  const MIN_LANGUAGE_WORDS = 7
  const MIN_LANGUAGE_SCORE = 4
  const MIN_LANGUAGE_MARGIN = 3
  const MIN_LANGUAGE_SIGNAL_RATIO = 0.25

  const MORSE = Object.freeze<Record<string, string>>({
    '.-': 'A',
    '-...': 'B',
    '-.-.': 'C',
    '-..': 'D',
    '.': 'E',
    '..-.': 'F',
    '--.': 'G',
    '....': 'H',
    '..': 'I',
    '.---': 'J',
    '-.-': 'K',
    '.-..': 'L',
    '--': 'M',
    '-.': 'N',
    '---': 'O',
    '.--.': 'P',
    '--.-': 'Q',
    '.-.': 'R',
    '...': 'S',
    '-': 'T',
    '..-': 'U',
    '...-': 'V',
    '.--': 'W',
    '-..-': 'X',
    '-.--': 'Y',
    '--..': 'Z',
    '-----': '0',
    '.----': '1',
    '..---': '2',
    '...--': '3',
    '....-': '4',
    '.....': '5',
    '-....': '6',
    '--...': '7',
    '---..': '8',
    '----.': '9',
    '.-.-.-': '.',
    '--..--': ',',
    '..--..': '?',
    '-.-.--': '!',
    '.----.': "'",
    '-..-.': '/',
    '-.--.': '(',
    '-.--.-': ')',
    '.-...': '&',
    '---...': ':',
    '-.-.-.': ';',
    '-...-': '=',
    '.-.-.': '+',
    '-....-': '-',
    '..--.-': '_',
    '.--.-.': '@',
  })

  const ENGLISH_SIGNALS = new Set([
    'and', 'are', 'can', 'for', 'from', 'has', 'have', 'in', 'into', 'is',
    'of', 'on', 'our', 'that', 'the', 'their', 'there', 'this', 'to', 'where',
    'which', 'with', 'you', 'your',
  ])
  const PORTUGUESE_SIGNALS = new Set([
    'a', 'as', 'com', 'das', 'dos', 'e', 'é', 'essa', 'esse', 'esta', 'este',
    'não', 'nós', 'onde', 'o', 'os', 'para', 'por', 'que', 'seus', 'suas',
    'são', 'também', 'tem', 'têm', 'um', 'uma', 'você',
  ])
  const STRONG_ENGLISH_SIGNALS = new Set([
    'can', 'for', 'from', 'has', 'have', 'into', 'our', 'that', 'the', 'their',
    'there', 'this', 'where', 'which', 'with', 'you', 'your',
  ])
  const STRONG_PORTUGUESE_SIGNALS = new Set([
    'com', 'das', 'dos', 'não', 'nós', 'seus', 'suas', 'são', 'também', 'têm',
    'uma', 'você',
  ])

  function isBoundedSource(value: string): boolean {
    return value.length > 0 && value.length <= MAX_SOURCE_LENGTH
  }

  function printableText(value: string): string | null {
    if (!isBoundedSource(value)) return null
    // Conservatively retain the broad Unicode Other guard while allowing only
    // the zero-width joiner needed for joined emoji sequences.
    const contentWithoutAllowedWhitespace = value.replace(/[\t\n\r\u200D]/gu, '')
    if (/\p{C}/u.test(contentWithoutAllowedWhitespace)) return null
    const visible = value.match(/[\p{L}\p{N}\p{P}\p{S}]/gu)?.length ?? 0
    return visible >= MIN_VISIBLE_CHARACTERS ? value : null
  }

  function decodeBytes(bytes: Uint8Array): string | null {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DECODED_BYTES) return null
    try {
      return printableText(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    } catch {
      return null
    }
  }

  function decodeBinary(value: string): NoteDecoding | null {
    const source = value.trim()
    if (!/^[01]{8}(?:\s+[01]{8})+$/u.test(source)) return null
    const groups = source.split(/\s+/u)
    if (groups.length > MAX_DECODED_BYTES) return null
    const bytes = Uint8Array.from(groups, group => Number.parseInt(group, 2))
    const text = decodeBytes(bytes)
    return text === null ? null : Object.freeze({ encoding: 'binary', text })
  }

  function decodeMorse(value: string): NoteDecoding | null {
    const source = value.trim()
    if (!/^[.\-/\s]+$/u.test(source)) return null
    const encodedWords = source.split(/\s*\/\s*/u)
    if (encodedWords.some(word => word.length === 0)) return null

    let tokenCount = 0
    const distinctTokens = new Set<string>()
    const decodedWords: string[] = []
    for (const encodedWord of encodedWords) {
      const tokens = encodedWord.trim().split(/\s+/u)
      const decoded: string[] = []
      for (const token of tokens) {
        const character = MORSE[token]
        if (character === undefined) return null
        decoded.push(character)
        tokenCount += 1
        distinctTokens.add(token)
      }
      decodedWords.push(decoded.join(''))
    }

    const text = decodedWords.join(' ')
    const alphanumericCount = text.match(/[A-Z0-9]/gu)?.length ?? 0
    // SOS is uniquely recognizable at three tokens. Other input needs three
    // token shapes so ordinary dot/dash punctuation such as `. - .` stays prose.
    const isExactSos = source === '... --- ...'
    if ((!isExactSos && (tokenCount < 3 || distinctTokens.size < 3)) ||
        alphanumericCount < 2) return null
    const printable = printableText(text)
    return printable === null ? null : Object.freeze({ encoding: 'morse', text: printable })
  }

  function decodeBase64(value: string): NoteDecoding | null {
    const source = value.trim()
    if (source.length < 8 || source.length % 4 !== 0) return null
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(source)) {
      return null
    }

    try {
      const binary = atob(source)
      if (binary.length > MAX_DECODED_BYTES || btoa(binary) !== source) return null
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0))
      const text = decodeBytes(bytes)
      return text === null ? null : Object.freeze({ encoding: 'base64', text })
    } catch {
      return null
    }
  }

  function decodeNoteText(value: string): NoteDecoding | null {
    if (typeof value !== 'string' || !isBoundedSource(value)) return null
    return decodeBinary(value) ?? decodeMorse(value) ?? decodeBase64(value)
  }

  function detectNoteLanguage(value: string): NoteLanguage | null {
    if (typeof value !== 'string' || !isBoundedSource(value)) return null
    if (decodeNoteText(value) !== null || printableText(value) === null) return null

    const normalized = value.normalize('NFC').toLowerCase()
    const words = normalized.match(/\p{L}+/gu) ?? []
    const letterCount = words.reduce((total, word) => total + word.length, 0)
    if (words.length < MIN_LANGUAGE_WORDS || letterCount < MIN_LANGUAGE_LETTERS) return null

    const englishSignals = new Set<string>()
    const portugueseSignals = new Set<string>()
    let englishSignalCount = 0
    let portugueseSignalCount = 0
    for (const word of words) {
      if (ENGLISH_SIGNALS.has(word)) {
        englishSignals.add(word)
        englishSignalCount += 1
      }
      if (PORTUGUESE_SIGNALS.has(word)) {
        portugueseSignals.add(word)
        portugueseSignalCount += 1
      }
    }

    const englishStrongCount = [...englishSignals]
      .filter(word => STRONG_ENGLISH_SIGNALS.has(word)).length
    const portugueseStrongCount = [...portugueseSignals]
      .filter(word => STRONG_PORTUGUESE_SIGNALS.has(word)).length

    // Distinct, proportional, strong signals prevent repetition and a few
    // borrowed words in another language from creating a confident label.
    const englishIsConfident = englishSignals.size >= MIN_LANGUAGE_SCORE &&
      englishStrongCount >= 2 &&
      englishSignalCount / words.length >= MIN_LANGUAGE_SIGNAL_RATIO &&
      englishSignals.size - portugueseSignals.size >= MIN_LANGUAGE_MARGIN
    const portugueseIsConfident = portugueseSignals.size >= MIN_LANGUAGE_SCORE &&
      portugueseStrongCount >= 2 &&
      portugueseSignalCount / words.length >= MIN_LANGUAGE_SIGNAL_RATIO &&
      portugueseSignals.size - englishSignals.size >= MIN_LANGUAGE_MARGIN

    if (englishIsConfident) return 'en'
    if (portugueseIsConfident) return 'pt'
    return null
  }

  return Object.freeze({ decodeNoteText, detectNoteLanguage })
}

// The shapes the server's reading filters look for (decision #157). Each returns the
// spans of a body it covers, in order and without overlaps; none fetches, stores or
// records anything. Decode above stays the window's own view, unchanged for humans.

/** A piece of a body, as character offsets: start inclusive, end exclusive. */
export type TextSpan = Readonly<{ start: number; end: number }>

/** The longest body the filters read: a thing body, THING_BODY_MAX_BYTES. */
const FILTER_SOURCE_MAX = 65_536
/** A shorter encoded run inside ordinary prose is not covered. */
export const ENCODED_RUN_MIN_CHARACTERS = 256
const BASE64_WHOLE_MIN = 8
const BASE64_UNREADABLE_MIN = 24

const SERVER_DECODER = createNoteDecodingHelpers({
  maxSourceLength: FILTER_SOURCE_MAX,
  maxDecodedBytes: FILTER_SOURCE_MAX,
})

const BINARY_WHOLE = /^[01]{8}(?:\s+[01]{8})+$/u
const BINARY_RUN = /[01]{8}(?:\s+[01]{8})+/gu
const MORSE_RUN = /[.-]{1,6}(?:\s*\/\s*[.-]{1,6}|\s+[.-]{1,6})+/gu
const BASE64_WHOLE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
const BASE64_RUN = /[A-Za-z0-9+/]{256,}={0,2}/gu
const PURE_HEX = /^[0-9a-fA-F]+$/u

export type EncodedSpan = TextSpan & Readonly<{ encoding: NoteEncoding }>

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0
}

// Base64 of real bytes mixes cases and digits; a hex hash or one long word does not.
function base64Shaped(source: string, minimum: number): boolean {
  if (source.length < minimum || PURE_HEX.test(source.replace(/=+$/u, ''))) return false
  return count(source, /[A-Z]/gu) >= 3 && count(source, /[a-z]/gu) >= 3 && count(source, /[0-9+/]/gu) >= 2
}

function wholeEncoding(source: string): NoteEncoding | null {
  if (source.length === 0 || source.length > FILTER_SOURCE_MAX) return null
  if (BINARY_WHOLE.test(source)) return 'binary'
  const decoded = SERVER_DECODER.decodeNoteText(source)
  if (decoded !== null) return decoded.encoding
  if (source.length >= BASE64_WHOLE_MIN && source.length % 4 === 0 && BASE64_WHOLE.test(source)
    && base64Shaped(source, BASE64_UNREADABLE_MIN)) return 'base64'
  return null
}

function overlaps(span: TextSpan, taken: readonly TextSpan[]): boolean {
  return taken.some(other => span.start < other.end && other.start < span.end)
}

/** Spans in order, each dropped when it overlaps one kept before it. */
function ordered<T extends TextSpan>(spans: readonly T[]): T[] {
  const kept: T[] = []
  for (const span of spans) if (!overlaps(span, kept)) kept.push(span)
  return kept.sort((a, b) => a.start - b.start)
}

function trimmedSpan(text: string): TextSpan {
  const start = text.length - text.trimStart().length
  return { start, end: text.trimEnd().length }
}

/**
 * Encoded text: a body that is wholly binary, Morse or base64 text, or each run of at
 * least 256 characters of it inside other words, whether or not it decodes to readable
 * text. Shorter runs inside prose are not covered.
 */
export function encodedSpans(text: string): readonly EncodedSpan[] {
  if (typeof text !== 'string' || text.length === 0 || text.length > FILTER_SOURCE_MAX) return []
  const whole = wholeEncoding(text.trim())
  if (whole !== null) return [{ ...trimmedSpan(text), encoding: whole }]
  const links = linkSpans(text)
  const runs: EncodedSpan[] = []
  for (const match of text.matchAll(BINARY_RUN)) {
    if (match[0].length >= ENCODED_RUN_MIN_CHARACTERS) {
      runs.push({ start: match.index, end: match.index + match[0].length, encoding: 'binary' })
    }
  }
  for (const match of text.matchAll(MORSE_RUN)) {
    if (match[0].length >= ENCODED_RUN_MIN_CHARACTERS && SERVER_DECODER.decodeNoteText(match[0])?.encoding === 'morse') {
      runs.push({ start: match.index, end: match.index + match[0].length, encoding: 'morse' })
    }
  }
  for (const match of text.matchAll(BASE64_RUN)) {
    const span = { start: match.index, end: match.index + match[0].length, encoding: 'base64' as const }
    if (base64Shaped(match[0], ENCODED_RUN_MIN_CHARACTERS) && !overlaps(span, links)) runs.push(span)
  }
  return ordered(runs)
}

/** Whether any part of a body is encoded text the filters cover. */
export function looksEncoded(text: string): boolean {
  return encodedSpans(text).length > 0
}

/**
 * Decode one encoded span for the one reader who asked: the readable words, or null when
 * the bytes are not readable text. Nothing is stored or recorded.
 */
export function decodeEncodedSpan(text: string, span: EncodedSpan): string | null {
  const decoded = SERVER_DECODER.decodeNoteText(text.slice(span.start, span.end).trim())
  return decoded !== null && decoded.encoding === span.encoding ? decoded.text : null
}

export type CodeLikeSpan = TextSpan & Readonly<{ shape: string; lines: number }>

const CODE_JSON_MIN = 20
const ART_BLOCK_MIN_LINES = 3
const ART_LINE_MIN = 4
const HEX_STRING = /(?<![0-9A-Za-z])(?:0x)?[0-9a-fA-F]{32,}(?![0-9A-Za-z])/gu
const SYMBOL_RUN = /[^\p{L}\p{N}\s]{40,}/gu
const EMOJI_PART = /[\p{Extended_Pictographic}\u200D\uFE0F]+/gu
const FENCED = /(```|~~~)([^\n`~]*)\n[\s\S]*?\1/gu
const FENCE_LABEL = /^[A-Za-z0-9+#.-]{1,20}$/u

function lineCount(text: string): number {
  return text.split('\n').length
}

function wholeJson(text: string): CodeLikeSpan | null {
  const source = text.trim()
  if (source.length < CODE_JSON_MIN || !/^[[{][\s\S]*[\]}]$/u.test(source)) return null
  try {
    const parsed = JSON.parse(source) as unknown
    if (parsed === null || typeof parsed !== 'object') return null
  } catch {
    return null
  }
  return { ...trimmedSpan(text), shape: 'JSON', lines: lineCount(source) }
}

// A line of drawn characters: no letters and no emoji, mostly symbols, or a long row of digits.
function artLine(line: string): boolean {
  const visible = line.replace(/\s/gu, '')
  if (visible.length < ART_LINE_MIN || /[\p{L}\p{Extended_Pictographic}]/u.test(visible)) return false
  const digits = count(visible, /\p{N}/gu)
  return (visible.length - digits) * 2 >= visible.length || (digits === visible.length && visible.length >= 8)
}

function artSpans(text: string): CodeLikeSpan[] {
  const spans: CodeLikeSpan[] = []
  let offset = 0
  let start = 0
  let end = 0
  let lines = 0
  const close = (): void => {
    if (lines >= ART_BLOCK_MIN_LINES) spans.push({ start, end, shape: 'ASCII art', lines })
    lines = 0
  }
  for (const line of text.split('\n')) {
    if (artLine(line)) {
      if (lines === 0) start = offset
      end = offset + line.length
      lines += 1
    } else {
      close()
    }
    offset += line.length + 1
  }
  close()
  return spans
}

/**
 * Code-like text: a body that is one JSON object or array, fenced code, a block of at
 * least three lines of drawn characters (ASCII art), a hex string of 32 or more digits,
 * or a run of 40 or more symbols. Each span names its shape and its line count.
 */
export function codeLikeSpans(text: string): readonly CodeLikeSpan[] {
  if (typeof text !== 'string' || text.length === 0 || text.length > FILTER_SOURCE_MAX) return []
  const json = wholeJson(text)
  if (json !== null) return [json]
  const spans: CodeLikeSpan[] = []
  for (const match of text.matchAll(FENCED)) {
    const label = match[2]!.trim()
    spans.push({
      start: match.index,
      end: match.index + match[0].length,
      shape: FENCE_LABEL.test(label) ? `${label} code` : 'fenced code',
      lines: Math.max(1, lineCount(match[0]) - 2),
    })
  }
  spans.push(...artSpans(text))
  for (const match of text.matchAll(HEX_STRING)) {
    if (/[0-9]/u.test(match[0]) && /[a-fA-F]/u.test(match[0].replace(/^0x/u, ''))) {
      spans.push({ start: match.index, end: match.index + match[0].length, shape: 'hex string', lines: 1 })
    }
  }
  for (const match of text.matchAll(SYMBOL_RUN)) {
    // Emoji are their own kind, so a run counts only where 40 symbols stand between them.
    let from = 0
    for (const emoji of [...match[0].matchAll(EMOJI_PART), null]) {
      const to = emoji === null ? match[0].length : emoji.index
      if (to - from >= 40) {
        spans.push({ start: match.index + from, end: match.index + to, shape: 'symbols', lines: lineCount(match[0].slice(from, to)) })
      }
      if (emoji !== null) from = emoji.index + emoji[0].length
    }
  }
  return ordered(spans)
}

/** Whether any part of a body is code-like text the filters cover. */
export function looksCodeLike(text: string): boolean {
  return codeLikeSpans(text).length > 0
}

export type LinkSpan = TextSpan & Readonly<{ domain: string }>

// Bare domains count only with a common ending, so file names like notes.md stay words.
const LINK_ENDINGS = [
  'com', 'org', 'net', 'io', 'ai', 'dev', 'app', 'co', 'gov', 'edu', 'info', 'xyz', 'me', 'tv', 'gg',
  'ly', 'so', 'to', 'fm', 'cc', 'uk', 'us', 'ca', 'au', 'de', 'fr', 'jp', 'nl', 'eu', 'ch', 'se', 'no',
  'es', 'it', 'br', 'in', 'kr', 'cn', 'ru', 'nz', 'be', 'at', 'ie', 'site', 'online', 'tech', 'blog',
  'news', 'page', 'link', 'wiki', 'social', 'club', 'store', 'shop',
].join('|')
const LINK = new RegExp(
  '(?<![\\w@.-])(?:(?:https?|ftp)://[^\\s<>"\'`]+|www\\.[a-z0-9-]+(?:\\.[a-z0-9-]+)+[^\\s<>"\'`]*'
    + `|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${LINK_ENDINGS})(?![\\w-])(?:/[^\\s<>"'\`]*)?)`,
  'giu',
)
const LINK_TRAILING = /[.,;:!?)\]}'"]+$/u

function linkDomain(link: string): string {
  const withScheme = /^[a-z]+:\/\//iu.test(link) ? link : `http://${link}`
  try {
    const host = new URL(withScheme).hostname.toLowerCase().replace(/^www\./u, '').replace(/\.$/u, '')
    return host.length > 0 ? host : 'an unknown site'
  } catch {
    return 'an unknown site'
  }
}

/** Links: web addresses and bare domain names, each with its domain only. Never fetched. */
export function linkSpans(text: string): readonly LinkSpan[] {
  if (typeof text !== 'string' || text.length === 0 || text.length > FILTER_SOURCE_MAX) return []
  const spans: LinkSpan[] = []
  for (const match of text.matchAll(LINK)) {
    const link = match[0].replace(LINK_TRAILING, '')
    if (link.length === 0) continue
    spans.push({ start: match.index, end: match.index + link.length, domain: linkDomain(link) })
  }
  return spans
}

export type EmojiSpan = TextSpan & Readonly<{ emoji: readonly string[] }>

const EMOJI = /\p{RI}\p{RI}|[#*0-9]\uFE0F?\u20E3|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{EMod}?\uFE0F?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic})\uFE0F?\p{EMod}?)*/gu

/** Emoji, grouped into runs of emoji written next to each other or with spaces between. */
export function emojiSpans(text: string): readonly EmojiSpan[] {
  if (typeof text !== 'string' || text.length === 0 || text.length > FILTER_SOURCE_MAX) return []
  const spans: Array<{ start: number; end: number; emoji: string[] }> = []
  for (const match of text.matchAll(EMOJI)) {
    const last = spans.at(-1)
    if (last !== undefined && /^[ \t]*$/u.test(text.slice(last.end, match.index))) {
      last.end = match.index + match[0].length
      last.emoji.push(match[0])
    } else {
      spans.push({ start: match.index, end: match.index + match[0].length, emoji: [match[0]] })
    }
  }
  return spans
}
