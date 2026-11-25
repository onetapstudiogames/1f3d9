import type { Context } from 'hono'
import { err } from './core.ts'
import type { PublicQueryExecutor } from './public-pagination.ts'
import {
  HIDDEN_REFUSAL,
  judgeRead,
  markReaderShaped,
  mutesFields,
  parseHidden,
  readerShape,
  splitMutedResidents,
} from './reader-filter.ts'
import type { HiddenOutline } from './reader-mutes.ts'
import { readResidentListening, type ListeningPage } from './talk-now.ts'
import { TALK_NOW_LISTENING_LIMIT } from './talk-watch-limits.ts'

export const RESIDENTS_LISTENING_OPTIONS_REFUSAL =
  `view=listening takes only hidden=outline; it lists everyone listening now, up to ${TALK_NOW_LISTENING_LIMIT}, with listening_page`

// GET /api/residents?view=listening, which browse resident_view=listening reads on every
// door: everyone listening right now, quiet rooms included, then the reader's own mutes,
// which leave a resident out and count it as on every residents list (decision 156). Like
// the cue itself, it records nothing and wakes nothing (decisions 122, 148 and 203).
export async function residentsListeningResponse(
  c: Context,
  query: Readonly<Record<string, readonly string[] | undefined>>,
  execute: PublicQueryExecutor,
): Promise<Response> {
  c.header('Cache-Control', 'no-store')
  if (Object.keys(query).some(name => name !== 'view' && name !== 'hidden')) {
    return err(c, 400, RESIDENTS_LISTENING_OPTIONS_REFUSAL)
  }
  const hiddenQuery = parseHidden(query)
  if (!hiddenQuery.ok) return err(c, 400, HIDDEN_REFUSAL)
  const reader = await readerShape(c, false)
  const judge = await judgeRead(reader, {})
  const page = await readResidentListening(execute)
  const shown: ListeningPage['listening'][number][] = []
  const hidden: HiddenOutline[] = []
  for (const row of page.listening) {
    const split = splitMutedResidents(judge, [{ id: row.resident_id, handle: row.handle }], row.place_id)
    if (split.hidden.length > 0) hidden.push(...split.hidden)
    else shown.push(row)
  }
  markReaderShaped(c, reader)
  return c.json({
    ...mutesFields(reader, hidden, hiddenQuery.outline),
    listening: shown,
    listening_page: { ...page.listening_page, returned_items: shown.length },
  })
}
