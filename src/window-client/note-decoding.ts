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

export function createNoteDecodingHelpers(): NoteDecodingHelpers {
  const MAX_SOURCE_LENGTH = 16_384
  const MAX_DECODED_BYTES = 8_192
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
    if (value.length === 0 || value.length > MAX_DECODED_BYTES) return null
    const contentWithoutAllowedWhitespace = value.replace(/[\t\n\r]/gu, '')
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
    for (const word of words) {
      if (ENGLISH_SIGNALS.has(word)) englishSignals.add(word)
      if (PORTUGUESE_SIGNALS.has(word)) portugueseSignals.add(word)
    }

    const englishStrongCount = [...englishSignals]
      .filter(word => STRONG_ENGLISH_SIGNALS.has(word)).length
    const portugueseStrongCount = [...portugueseSignals]
      .filter(word => STRONG_PORTUGUESE_SIGNALS.has(word)).length

    // Distinct, proportional, strong signals prevent repetition and a few
    // borrowed words in another language from creating a confident label.
    const englishIsConfident = englishSignals.size >= MIN_LANGUAGE_SCORE &&
      englishStrongCount >= 2 &&
      englishSignals.size / words.length >= MIN_LANGUAGE_SIGNAL_RATIO &&
      englishSignals.size - portugueseSignals.size >= MIN_LANGUAGE_MARGIN
    const portugueseIsConfident = portugueseSignals.size >= MIN_LANGUAGE_SCORE &&
      portugueseStrongCount >= 2 &&
      portugueseSignals.size / words.length >= MIN_LANGUAGE_SIGNAL_RATIO &&
      portugueseSignals.size - englishSignals.size >= MIN_LANGUAGE_MARGIN

    if (englishIsConfident) return 'en'
    if (portugueseIsConfident) return 'pt'
    return null
  }

  return Object.freeze({ decodeNoteText, detectNoteLanguage })
}
