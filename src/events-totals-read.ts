import { eventsTotalsTallyOn } from './events-totals-maintenance.ts'
import { EVENTS_TALLY_READER_TOTALS_SQL } from './events-totals-tally.ts'
import {
  eventTotalsFromKeptCount,
  loadPublicEventCollectionRows,
  loadPublicEventKeptCollectionRows,
  type PublicEventCollectionRows,
  type PublicEventFilters,
  type PublicPage,
  type PublicQueryExecutor,
} from './public-pagination.ts'

// The one reader of the kept events count (decision #196). GET /api/events, and so MCP
// browse view=events and the window's events history, take the unfiltered and kind-only
// totals from the count while its state row says it may be trusted, in the same statement
// and snapshot as the page. Otherwise, and for actor, place and time-window reads, they
// count the whole list exactly as before. Both statements go through the caller's
// executor, so the two exact-read slots and the 1.5 second limit apply to each; a busy
// kept read is busy, never retried the heavier way. EVENTS_TOTALS_TALLY=off turns these
// reads back to the full count at the next deploy, as it stops the maintenance step.

type Environment = Readonly<Record<string, string | undefined>>

export async function loadEventsListCollection(
  query: PublicQueryExecutor,
  filters: PublicEventFilters,
  page: PublicPage,
  environment: Environment,
): Promise<Readonly<PublicEventCollectionRows>> {
  if (eventsTotalsTallyOn(environment) && eventTotalsFromKeptCount(filters)) {
    const kept = await loadPublicEventKeptCollectionRows(query, filters, page, EVENTS_TALLY_READER_TOTALS_SQL)
    if (kept !== null) return kept
  }
  return await loadPublicEventCollectionRows(query, filters, page)
}
