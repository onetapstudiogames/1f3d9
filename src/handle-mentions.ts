// Letters, digits and hyphens form one token in public note text.
// Browser readers use gi without u to preserve the PostgreSQL case behavior.
const HANDLE_MENTION_CHARACTERS = 'a-z0-9-'
export const HANDLE_MENTION_TOKEN_SOURCE = `[${HANDLE_MENTION_CHARACTERS}]+`

// The arguments are trusted SQL expressions, with caller values bound separately.
export function wholeHandleMentionSql(bodySql: string, handleSql: string): string {
  const boundary = `[^${HANDLE_MENTION_CHARACTERS}]`
  return `${bodySql} ~* ('(^|${boundary})' || ${handleSql} || '(${boundary}|$)')`
}
