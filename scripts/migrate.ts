// Apply the idempotent city schema to DATABASE_URL.
// Usage: DATABASE_URL=... npm run migrate
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { neon } from '@neondatabase/serverless'

type SqlMode = 'normal' | 'single-quote' | 'double-quote' | 'line-comment' | 'block-comment' | 'dollar-quote'

function dollarDelimiterAt(sql: string, offset: number): string | null {
  const match = sql.slice(offset).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)
  return match?.[0] ?? null
}

/**
 * Split trusted migration SQL without treating semicolons inside strings,
 * comments, identifiers, or PostgreSQL dollar-quoted bodies as boundaries.
 */
export function splitSqlStatements(ddl: string): string[] {
  const statements: string[] = []
  let statement = ''
  let mode: SqlMode = 'normal'
  let blockCommentDepth = 0
  let dollarDelimiter = ''

  const finishStatement = () => {
    const trimmed = statement.trim()
    if (trimmed) statements.push(trimmed)
    statement = ''
  }

  for (let index = 0; index < ddl.length; index += 1) {
    const character = ddl[index]!
    const next = ddl[index + 1]

    if (mode === 'normal') {
      if (character === '-' && next === '-') {
        statement += '--'
        index += 1
        mode = 'line-comment'
      } else if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth = 1
        mode = 'block-comment'
      } else if (character === "'") {
        statement += character
        mode = 'single-quote'
      } else if (character === '"') {
        statement += character
        mode = 'double-quote'
      } else if (character === '$') {
        const delimiter = dollarDelimiterAt(ddl, index)
        if (delimiter) {
          statement += delimiter
          index += delimiter.length - 1
          dollarDelimiter = delimiter
          mode = 'dollar-quote'
        } else {
          statement += character
        }
      } else if (character === ';') {
        finishStatement()
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'line-comment') {
      statement += character
      if (character === '\n') mode = 'normal'
      continue
    }

    if (mode === 'block-comment') {
      if (character === '/' && next === '*') {
        statement += '/*'
        index += 1
        blockCommentDepth += 1
      } else if (character === '*' && next === '/') {
        statement += '*/'
        index += 1
        blockCommentDepth -= 1
        if (blockCommentDepth === 0) mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    if (mode === 'dollar-quote') {
      if (ddl.startsWith(dollarDelimiter, index)) {
        statement += dollarDelimiter
        index += dollarDelimiter.length - 1
        dollarDelimiter = ''
        mode = 'normal'
      } else {
        statement += character
      }
      continue
    }

    statement += character
    if (mode === 'single-quote' && character === "'") {
      if (next === "'") {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    } else if (mode === 'double-quote' && character === '"') {
      if (next === '"') {
        statement += next
        index += 1
      } else {
        mode = 'normal'
      }
    }
  }

  if (mode === 'single-quote') throw new Error('migration SQL has an unterminated single-quoted string')
  if (mode === 'double-quote') throw new Error('migration SQL has an unterminated quoted identifier')
  if (mode === 'block-comment') throw new Error('migration SQL has an unterminated block comment')
  if (mode === 'dollar-quote') throw new Error(`migration SQL has an unterminated ${dollarDelimiter} block`)

  finishStatement()
  return statements
}

export async function applyMigration(databaseUrl: string, ddl: string): Promise<number> {
  const statements = splitSqlStatements(ddl)
  if (statements.length === 0) throw new Error('migration contains no SQL statements')

  const sql = neon(databaseUrl)
  await sql.transaction(transaction =>
    statements.map(statement => transaction.query(statement)),
  )
  return statements.length
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL not set')

  const requestedFile = process.argv[2] ?? 'db/schema.sql'
  if (requestedFile !== 'db/schema.sql') throw new Error('migration must be db/schema.sql')

  const ddl = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8')
  const statementCount = await applyMigration(databaseUrl, ddl)
  console.log(`applied ${statementCount} statements from db/schema.sql`)
}

const entrypoint = process.argv[1]
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : 'migration failed')
    process.exitCode = 1
  })
}
