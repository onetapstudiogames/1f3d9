// A note has no heading, so its first line stands in for one. The replay file and
// a walk-to-read note read remotely publish exactly this line: the text before the
// first line break (carriage return, line feed, line separator, or paragraph
// separator), cut to 200 characters.
export const NOTE_FIRST_LINE_CHARACTERS = 200

const LINE_BREAK_CODE_POINTS: ReadonlySet<number> = new Set([0x0d, 0x0a, 0x2028, 0x2029])

export function noteFirstLine(body: string): string {
  const characters = Array.from(body)
  const end = characters.findIndex(character => LINE_BREAK_CODE_POINTS.has(character.codePointAt(0) ?? 0))
  const firstLine = end === -1 ? characters : characters.slice(0, end)
  return firstLine.slice(0, NOTE_FIRST_LINE_CHARACTERS).join('')
}

/**
 * The same first line computed in SQL, so search matches exactly the line a remote
 * reader sees. PostgreSQL counts text length in characters (code points), as above.
 */
export function noteFirstLineSql(body: string): string {
  return `left(substring(${body} FROM '^[^\\r\\n\\u2028\\u2029]*'), ${NOTE_FIRST_LINE_CHARACTERS})`
}
