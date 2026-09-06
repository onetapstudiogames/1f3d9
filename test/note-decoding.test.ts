import assert from 'node:assert/strict'
import test from 'node:test'
import { createNoteDecodingHelpers } from '../src/window-client/note-decoding.ts'

const { decodeNoteText, detectNoteLanguage } = createNoteDecodingHelpers()

function binaryBytes(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map(byte => byte.toString(2).padStart(8, '0'))
    .join(' ')
}

function base64Utf8(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
}

test('note decoding factory remains self-contained for browser embedding', () => {
  const embeddedFactory = Function(
    `return (${createNoteDecodingHelpers.toString()})`,
  )() as typeof createNoteDecodingHelpers

  const embedded = embeddedFactory()
  assert.deepEqual(
    embedded.decodeNoteText('01001111 01001011'),
    { encoding: 'binary', text: 'OK' },
  )
  assert.deepEqual(
    embedded.decodeNoteText('... --- ...'),
    { encoding: 'morse', text: 'SOS' },
  )
  assert.deepEqual(
    embedded.decodeNoteText(' SGVsbG8h '),
    { encoding: 'base64', text: 'Hello!' },
  )
  assert.equal(
    embedded.detectNoteLanguage('This is a clear note for the people who live in this city.'),
    'en',
  )
})

test('decodes complete binary byte groups as printable UTF-8', () => {
  assert.deepEqual(
    decodeNoteText(binaryBytes('Olá, cidade!')),
    { encoding: 'binary', text: 'Olá, cidade!' },
  )
})

test('binary recognition rejects prose, partial bytes, controls, and invalid UTF-8', () => {
  assert.equal(decodeNoteText('There are 10 lamps and 1 gate.'), null)
  assert.equal(decodeNoteText('0100100 01100101 01101100'), null)
  assert.equal(decodeNoteText('01000001 00000000 01000010'), null)
  assert.equal(decodeNoteText('11000011 00101000'), null)
})

test('decodes recognizable Morse letters, digits, punctuation, and word gaps', () => {
  assert.deepEqual(
    decodeNoteText('.... . .-.. .-.. --- / .-- --- .-. .-.. -.. -.-.--'),
    { encoding: 'morse', text: 'HELLO WORLD!' },
  )
  assert.deepEqual(
    decodeNoteText('.--. .-.. --- - / ....- ..---'),
    { encoding: 'morse', text: 'PLOT 42' },
  )
})

test('Morse recognition rejects incomplete, unknown, and punctuation-only input', () => {
  assert.equal(decodeNoteText('...'), null)
  assert.equal(decodeNoteText('... ...'), null)
  assert.equal(decodeNoteText('-- --'), null)
  assert.equal(decodeNoteText('. - .'), null)
  assert.equal(decodeNoteText('.. -- ..'), null)
  assert.equal(decodeNoteText('.... . .-.. .-.. --- ..--..-'), null)
  assert.equal(decodeNoteText('... --- ... ordinary words'), null)
  assert.equal(decodeNoteText('.-.-.- --..--'), null)
})

test('decodes canonical base64 containing printable UTF-8', () => {
  assert.deepEqual(
    decodeNoteText(base64Utf8('A praça está tranquila.')),
    { encoding: 'base64', text: 'A praça está tranquila.' },
  )
  assert.deepEqual(
    decodeNoteText(' SGVsbG8h '),
    { encoding: 'base64', text: 'Hello!' },
  )
})

test('base64 recognition rejects malformed, non-canonical, control, and binary payloads', () => {
  assert.equal(decodeNoteText('SGVsbG8*'), null)
  assert.equal(decodeNoteText('SGVsbG8==='), null)
  assert.equal(decodeNoteText('SGVsbG8'), null)
  assert.equal(decodeNoteText('Zh=='), null)
  assert.equal(decodeNoteText(base64Utf8('hello\u0000world')), null)
  assert.equal(decodeNoteText('/wABgA=='), null)
})

test('language detection labels only sufficiently evidenced English and Portuguese prose', () => {
  assert.equal(
    detectNoteLanguage('This city has a quiet square where the residents can talk with their neighbors.'),
    'en',
  )
  assert.equal(
    detectNoteLanguage('Esta cidade tem uma praça tranquila para os residentes conversarem com seus vizinhos.'),
    'pt',
  )
})

test('language detection declines short, ambiguous, mixed, and encoded notes', () => {
  assert.equal(detectNoteLanguage('Casa nova'), null)
  assert.equal(detectNoteLanguage('This cidade is para residents and vizinhos'), null)
  assert.equal(detectNoteLanguage('1234 0101 9999'), null)
  assert.equal(
    detectNoteLanguage('the the the the wunderbare fremde Wörter bleiben völlig unklar'),
    null,
  )
  assert.equal(
    detectNoteLanguage('a a a a palavras inventadas repetidas ficam totalmente sem contexto'),
    null,
  )
  assert.equal(
    detectNoteLanguage('the und der ist eine fremde Sprache mit vielen langen Wörtern'),
    null,
  )
  assert.equal(
    detectNoteLanguage('Esta ciudad tiene una plaza para los residentes que pasan por este barrio.'),
    null,
  )
  assert.equal(
    detectNoteLanguage(base64Utf8('This city has a quiet square where the residents can talk.')),
    null,
  )
  assert.equal(
    detectNoteLanguage(binaryBytes('Esta cidade tem uma praça para os residentes.')),
    null,
  )
})

test('decoding and language work are bounded', () => {
  const oversized = 'A'.repeat(20_000)
  assert.equal(decodeNoteText(oversized), null)
  assert.equal(detectNoteLanguage(oversized), null)
})
