import type { TaggedSql } from '../../src/engine.ts'

interface Call {
  text: string
  values: unknown[]
}

type Responder = (call: Call) => unknown[] | Promise<unknown[]>

function fakeSql(responder: Responder): { db: TaggedSql; calls: Call[] } {
  const calls: Call[] = []
  const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('$').replace(/\s+/g, ' ').trim()
    const call = { text, values }
    calls.push(call)
    const rows = await responder(call)
    return rows.map(row => (
      row && typeof row === 'object' && 'updated_at' in row && row.updated_at === 'now'
        ? { ...row, updated_at: new Date('2026-08-11T00:00:00.000Z') }
        : row
    ))
  }) as TaggedSql
  return { db, calls }
}

export { fakeSql }
export type { Call }
