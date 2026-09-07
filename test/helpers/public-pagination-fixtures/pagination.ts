import assert from 'node:assert/strict'
import { parsePublicPage, type PublicPage } from '../../../src/public-pagination.ts'

export function page(cursor: number | null = null, limit: number | null = null): PublicPage {
  const parsed = parsePublicPage(
    {
      ...(cursor === null ? {} : { before_id: [String(cursor)] }),
      ...(limit === null ? {} : { limit: [String(limit)] }),
    },
    'before_id',
    'limit',
  )
  assert.equal(parsed.ok, true)
  return parsed as PublicPage
}

export function rowIds(rows: readonly Record<string, unknown>[]): number[] {
  return rows.map(row => Number(row.id))
}
