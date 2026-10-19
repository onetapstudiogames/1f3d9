// Full pages after hiding (decision #156, built in the fix batch of 2026-10-19). A
// signed-in list read drops what its reader muted; without more, a reader with many
// mutes got short pages. A page that dropped rows reads further rows, in the same order
// and under the same filters, until it holds its page size of shown rows, the list ends,
// or it has made PAGE_FILL_EXTRA_READS more reads of one page size each, whichever comes
// first. The page then ends at the last row it looked at, so its cursor names that row
// and the next page starts right after it, and every row it dropped while filling is
// counted. A reader with no mutes reads exactly as before.
import type { MuteItemType, MuteJudge } from './reader-mutes.ts'

/** The most further reads one page makes while filling, each of one page size. */
export const PAGE_FILL_EXTRA_READS = 4

/** Rows read in list order, and whether more follow the last of them. */
export type PageBatch<T> = Readonly<{ rows: readonly T[]; hasMore: boolean }>

export type FilledRows<T> = Readonly<{
  /** Every row the page looked at, shown and dropped, in list order. */
  rows: readonly T[]
  /** Whether more rows follow the last one it looked at. */
  hasMore: boolean
}>

/**
 * Read until the page holds limit shown rows. first is the page as first read (at most
 * limit rows); hidden says which rows of one batch are dropped; next reads up to size
 * rows after one row, in the same order.
 */
export async function fillPage<T>(input: Readonly<{
  limit: number
  first: PageBatch<T>
  hidden: (rows: readonly T[]) => Promise<readonly boolean[]>
  next: (after: T, size: number) => Promise<PageBatch<T>>
}>): Promise<FilledRows<T>> {
  const rows: T[] = []
  let shown = 0
  let batch = input.first
  for (let extraReads = 0; ; extraReads++) {
    const hidden = await input.hidden(batch.rows)
    for (const [index, row] of batch.rows.entries()) {
      rows.push(row)
      if (hidden[index] !== true) shown += 1
      if (shown >= input.limit) {
        return Object.freeze({ rows: Object.freeze(rows), hasMore: index < batch.rows.length - 1 || batch.hasMore })
      }
    }
    const last = rows.at(-1)
    if (!batch.hasMore || last === undefined || extraReads >= PAGE_FILL_EXTRA_READS) {
      return Object.freeze({ rows: Object.freeze(rows), hasMore: batch.hasMore })
    }
    batch = await input.next(last, input.limit)
  }
}

/** A paged list as most reads keep it: its rows, whether more follow, and the cursor. */
export type IdPage<T> = Readonly<{ items: readonly T[]; hasMore: boolean; nextCursor: number | null }>

function rowId(row: unknown, field: string): number | null {
  const value = row !== null && typeof row === 'object' ? Number((row as Record<string, unknown>)[field]) : NaN
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/**
 * Fill one page of items of one type the reader's mutes may hide, judged by id, newest
 * first with the cursor on the last row's id. The judge widens over each further batch,
 * so the one it returns covers every row on the filled page. A null judge (an anonymous
 * read, or a reader with nothing that could hide a row) leaves the page as it was.
 */
export async function fillMutedPage<T>(input: Readonly<{
  judge: MuteJudge | null
  type: MuteItemType
  limit: number
  page: IdPage<T>
  next: (afterId: number, size: number) => Promise<PageBatch<T>>
  idField?: string
}>): Promise<Readonly<{ page: IdPage<T>; judge: MuteJudge | null }>> {
  if (input.judge === null) return { page: input.page, judge: null }
  const field = input.idField ?? 'id'
  let judge: MuteJudge = input.judge
  const filled = await fillPage<T>({
    limit: input.limit,
    first: { rows: input.page.items, hasMore: input.page.hasMore },
    hidden: async rows => {
      const ids = rows.flatMap(row => rowId(row, field) ?? [])
      judge = await judge.widen({ [input.type]: ids })
      return rows.map(row => {
        const id = rowId(row, field)
        return id !== null && judge.hides(input.type, id)
      })
    },
    next: (after, size) => input.next(rowId(after, field) ?? 0, size),
  })
  const last = filled.rows.at(-1)
  return {
    page: Object.freeze({
      items: filled.rows,
      hasMore: filled.hasMore,
      nextCursor: filled.hasMore && last !== undefined ? rowId(last, field) : null,
    }),
    judge,
  }
}
