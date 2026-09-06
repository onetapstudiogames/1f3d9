import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitSqlStatements } from '../../../scripts/migrate.ts'

export const schemaDdl = readFileSync(new URL('../../../db/schema.sql', import.meta.url), 'utf8')

export function migrationDdl(file: string): string {
  return readFileSync(new URL(`../../../${file}`, import.meta.url), 'utf8')
}

export function schemaStatement(table: string): string {
  const statement = splitSqlStatements(schemaDdl).find(candidate =>
    new RegExp(`CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+${table}\\b`, 'i').test(candidate)
  )
  assert.ok(statement, `missing idempotent ${table} table`)
  return statement
}
