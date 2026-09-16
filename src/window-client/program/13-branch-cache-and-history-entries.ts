export const PART_13_BRANCH_CACHE_AND_HISTORY_ENTRIES = `  function replaceBranch(placeId, entry) {
    const branches = { ...state.branches, [String(placeId)]: Object.freeze(entry) }
    const snapshot = state.snapshot
      ? withNavigation(state.snapshot, branches, state.snapshot.residents)
      : null
    state = { ...state, branches, snapshot }
  }

  function replaceBranchWithParent(placeId, entry, parent) {
    let branches = mergeParentIntoBranches(state.branches, parent)
    branches = { ...branches, [String(placeId)]: Object.freeze(entry) }
    const base = state.snapshot
      ? Object.freeze({
          ...state.snapshot,
          places: mergePlaceMetadata(state.snapshot.places, parent),
        })
      : null
    const snapshot = base ? withNavigation(base, branches, base.residents) : null
    state = { ...state, branches, snapshot }
  }

  function historyKey(collection, filters) {
    const place = collection === 'agreements' ? '' : String(filters.placeId || '')
    if (!place && !filters.resident) return 'all'
    return (filters.context ? 'context|' : '') +
      'place:' + place + '|resident:' + String(filters.resident || '')
  }

  function filterHistoryRows(collection, rows, filters, snapshot) {
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    if (collection === 'notes') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.author === filters.resident))
    if (collection === 'things') return rows.filter(row =>
      (!placeIds || placeIds.has(row.place_id)) &&
      (!filters.resident || row.owner === filters.resident))
    if (collection === 'agreements') return rows.filter(row => !filters.resident ||
      row.created_by === filters.resident || row.parties.includes(filters.resident) ||
      row.parties_truncated)
    return rows.filter(row =>
      (!filters.resident || row.actor === filters.resident) &&
      (!placeIds || placeIds.has(eventPlaceId(row, snapshot))))
  }

  function historyTotal(collection, filters) {
    const snapshot = state.snapshot
    if (!snapshot) return 0
    const placeIds = filters.placeId ? placeScopeSet(filters.placeId, snapshot) : null
    const places = placeIds
      ? snapshot.flatPlaces.filter(candidate => placeIds.has(candidate.id))
      : []
    if (collection === 'notes') return placeIds
      ? places.reduce((total, place) => total + place.notes, 0)
      : snapshot.totals.conversations
    if (collection === 'things') return placeIds
      ? places.reduce((total, place) => total + place.things, 0)
      : snapshot.totals.things
    if (collection === 'agreements') return snapshot.totals.agreements
    return snapshot.totals.events
  }

  function historyEntry(collection, filters) {
    const key = historyKey(collection, filters)
    const stored = state.histories[collection]?.[key]
    if (stored) return stored
    const global = state.histories[collection]?.all
    const snapshotRows = state.snapshot?.[collection] || []
    const rows = filterHistoryRows(collection, global?.rows || snapshotRows, filters, state.snapshot)
    return Object.freeze({
      rows,
      hasMore: historyTotal(collection, filters) > rows.length,
      nextBeforeId: null,
      automaticPageCount: 0,
      automaticPaused: false,
      initialized: false,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: false,
    })
  }

  function setHistoryEntry(collection, filters, entry) {
    const key = historyKey(collection, filters)
    state = {
      ...state,
      histories: {
        ...state.histories,
        [collection]: {
          ...state.histories[collection],
          [key]: Object.freeze({
            ...entry,
            filters: Object.freeze({
              placeId: filters.placeId,
              resident: filters.resident,
              context: filters.context === true,
            }),
          }),
        },
      },
    }
  }

  function historyViewerRecordKind(collection) {
    return collection === 'notes' ? 'note'
      : collection === 'things' ? 'thing'
        : collection === 'agreements' ? 'agreement' : 'event'
  }

  // The reader keeps what they scrolled to. Past the keep bound the oldest rows
  // go first, and a row the reader is holding open is never one of them.
  function keptHistoryRows(rows, heldKeys, kind) {
    if (rows.length <= WINDOW_HISTORY_KEEP_ROWS) return rows
    const kept = rows.slice(0, WINDOW_HISTORY_KEEP_ROWS)
    const heldBelow = rows.slice(WINDOW_HISTORY_KEEP_ROWS)
      .filter(row => heldKeys.has(kind + ':' + String(row.id)))
    return heldBelow.length ? kept.concat(heldBelow) : kept
  }

  // Load older always continues from the lowest connected row: the lowest
  // loaded row above the highest gap still waiting to be filled. With a gap
  // still waiting and no loaded row above it there is no connected row at all,
  // so the next read starts at the newest page and pages down to the gap rather
  // than resuming below it, which would join the two sides in silence.
  function connectedHistoryCursor(rows, waitingRows, fallbackId) {
    const highestWaitingId = waitingRows.reduce(
      (highest, row) => Math.max(highest, row.id), 0)
    const connected = rows.filter(row => row.id > highestWaitingId)
    if (connected.length) return connected[connected.length - 1].id
    return waitingRows.length ? null : fallbackId ?? null
  }

  // Load older has something to fetch when records older than the lowest loaded
  // row are still out there. A gap in the middle of a list forces that control
  // open too, so the list keeps the bottom-of-list answer separately and a
  // closed gap gives it back, instead of leaving a control that fetches nothing.
  function olderRowsRemain(entry) {
    return entry.olderRowsRemain === undefined
      ? entry.hasMore === true
      : entry.olderRowsRemain === true
  }

  // A waiting marker names the top row of a block with older records above it
  // still unloaded. When the marker's own row leaves the list, the gap above it
  // does not leave with it: the highest kept row still below that gap takes the
  // marker's place, so the two sides of the gap never join in silence.
  function carriedWaitingRows(deferredRows, rows, keptIds) {
    return deferredRows.flatMap(row => {
      if (keptIds.has(row.id)) return [row]
      const below = rows.filter(kept => kept.id < row.id)
      return below.length ? [below[0]] : []
    })
  }

  // Trimming at the keep bound leaves a hole above every row that survived the
  // trim because the reader is holding it open. Each such row is named, however
  // many there are and however deep they sit.
  function trimmedGapRows(merged, keptIds) {
    return merged.filter((row, index) => index > 0 &&
      keptIds.has(row.id) && !keptIds.has(merged[index - 1].id))
  }

  // One list across a changed refresh: every row the reader already loaded
  // stays, the newest page merges in, and the top row of any block the newest
  // page does not reach is recorded so the fill below can close that gap.
  function retainedHistoryEntry(
    collection, entry, freshRows, newestRows, heldKeys, invalidatedKeys,
  ) {
    const kind = historyViewerRecordKind(collection)
    const freshIds = new Set(freshRows.map(row => row.id))
    // The snapshot rows are the city's own newest page for the whole city, so a
    // loaded row above its oldest row and missing from it has left the city or
    // this list, rather than been paged out of sight.
    const removalFloorId = newestRows.length ? newestRows[newestRows.length - 1].id : 0
    const retainedRows = entry.rows.filter(row => !freshIds.has(row.id) &&
      row.id < removalFloorId &&
      !invalidatedKeys.has(kind + ':' + String(row.id)))
    if (!retainedRows.length) return null
    const merged = mergeWindowRows(retainedRows, freshRows)
    const rows = keptHistoryRows(merged, heldKeys, kind)
    const trimmed = rows.length < merged.length
    const keptIds = new Set(rows.map(row => row.id))
    // A newest page that still reaches the reader's own top row proves there is
    // nothing unloaded between them.
    const gapAboveKeptRows = removalFloorId > entry.rows[0].id
    const waitingRows = mergeWindowRows(
      carriedWaitingRows(entry.deferredRows || [], rows, keptIds),
      (gapAboveKeptRows ? [retainedRows[0]] : []).concat(trimmedGapRows(merged, keptIds)))
    return Object.freeze({
      ...entry,
      rows,
      deferredRows: waitingRows,
      // A gap already proved larger than one fill stays that way across a
      // refresh. A gap whose own marker row left the list is named again by the
      // row that takes its place, and that new name is read once more.
      beyondFillIds: Object.freeze(waitingRows
        .filter(row => (entry.beyondFillIds || []).includes(row.id))
        .map(row => row.id)),
      hasMore: waitingRows.length || trimmed ? true : olderRowsRemain(entry),
      // A trim drops the rows below the bound, so older records are certainly
      // out there. A gap in the middle says nothing about the bottom.
      olderRowsRemain: trimmed ? true : olderRowsRemain(entry),
      nextBeforeId: entry.initialized === true
        ? connectedHistoryCursor(rows, waitingRows, entry.nextBeforeId)
        : entry.nextBeforeId ?? null,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: false,
    })
  }

  // Keeping older rows is only honest while the window can still see what the
  // city changed. When the changes read could not be completed, a record the
  // city moderated or removed below the newest page cannot be named, and the
  // next read starts after it, so that refresh keeps nothing and shows the
  // city's own newest page. A null changes list says exactly that.
  function freshSnapshotHistories(snapshot, changes = null) {
    let histories = {}
    const changesKnown = Array.isArray(changes)
    const heldKeys = viewerHeldRecordKeys()
    const invalidatedKeys = changedViewerRecordKeys(changes || [])
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const page = snapshot.pages[collection]
      const previousEntries = changesKnown ? state.histories[collection] || {} : {}
      const entries = Object.fromEntries(Object.entries(previousEntries).flatMap(([key, entry]) => {
        if (!entry?.rows?.length || key === 'all') return []
        const freshRows = entry.filters
          ? filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
          : snapshot[collection]
        const retained = retainedHistoryEntry(
          collection, entry, freshRows, snapshot[collection], heldKeys, invalidatedKeys)
        return retained ? [[key, retained]] : []
      }))
      const previousAll = previousEntries.all
      const retainedAll = previousAll?.rows?.length
        ? retainedHistoryEntry(collection, previousAll, snapshot[collection],
            snapshot[collection], heldKeys, invalidatedKeys)
        : null
      histories = {
        ...histories,
        [collection]: {
          ...entries,
          all: retainedAll || Object.freeze({
            rows: snapshot[collection],
            deferredRows: [],
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
            refreshing: false,
            refreshError: false,
          }),
        },
      }
    }
    return histories
  }

  // The window closes a gap on its own before it asks the reader to. It pages
  // from the newest until it reaches the rows already loaded, and stops at the
  // fill bound so a browser waking after a long sleep never pulls the whole
  // sleep from the city in one burst.
  async function fillHistoryGap(
    collection, entry, filters, joinIds, marker, signal,
  ) {
    let read = await readGapPages(collection, entry, filters, joinIds, marker, signal)
    // The city changed between the snapshot read and this one. Read the gap
    // again from the marker the city has just reported, once, rather than
    // naming a gap the window could still close. The manual pager's
    // requireCurrentReadMarker cannot be used here: it calls refreshCity, which
    // is the refresh this fill is running inside.
    if (read.newerMarker) {
      read = await readGapPages(
        collection, entry, filters, joinIds, read.newerMarker, signal)
    }
    const closedIds = read.closed
      ? joinIds
      : new Set(read.rows.filter(row => joinIds.has(row.id)).map(row => row.id))
    return filledHistoryEntry(entry, closedIds, read.rows,
      read.failed || Boolean(read.newerMarker), read.spentBound)
  }

  // One pass of the fill. It pages older until it has reached every waiting row,
  // run out of city, or spent the fill bound, and it reports what it read rather
  // than throwing, so its caller can choose between reading again and a seam.
  async function readGapPages(collection, entry, filters, joinIds, marker, signal) {
    let rows = []
    // Starting under the lowest row still connected to the newest page keeps the
    // fill from spending a page on rows this refresh just delivered.
    let beforeId = connectedHistoryCursor(entry.rows, [...joinIds].map(id => ({ id })), null)
    const seenCursors = new Set()
    try {
      while (rows.length < WINDOW_HISTORY_FILL_ROWS) {
        const payload = await readGapPage(collection, filters, beforeId, marker, signal)
        const responseMarker = safeChangeMarker(payload?.change_marker)
        if (marker && responseMarker !== marker) {
          if (!markerCovers(responseMarker, marker)) {
            throw new Error('public read marker does not match its accepted rows')
          }
          return Object.freeze({
            rows, closed: false, newerMarker: responseMarker, failed: false, spentBound: false,
          })
        }
        const incoming = normalizeHistoryRows(collection, payload)
        rows = mergeWindowRows(rows, incoming)
        const hasMore = payload.has_more === true
        const nextBeforeId = hasMore ? safeId(payload.next_before_id) : null
        if (hasMore && (!nextBeforeId || seenCursors.has(nextBeforeId) ||
            (beforeId && nextBeforeId >= beforeId) ||
            !incoming.some(row => row.id === nextBeforeId))) {
          throw new Error('older public history cursor did not progress')
        }
        const joined = [...joinIds].every(id => rows.some(row => row.id === id))
        if (joined || !hasMore) {
          return Object.freeze({
            rows, closed: true, newerMarker: null, failed: false, spentBound: false,
          })
        }
        seenCursors.add(nextBeforeId)
        beforeId = nextBeforeId
      }
    } catch {
      return Object.freeze({
        rows, closed: false, newerMarker: null, failed: true, spentBound: false,
      })
    }
    // The loop stopped because it spent the whole fill bound without reaching
    // every waiting row.
    return Object.freeze({
      rows, closed: false, newerMarker: null, failed: false, spentBound: true,
    })
  }

  // One older page of one list, read under the marker the fill is working from.
  function readGapPage(collection, filters, beforeId, marker, signal) {
    const url = historyRequestUrl(collection, {
      initialized: Boolean(beforeId), nextBeforeId: beforeId,
    }, filters, marker)
    return fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    }).then(response => {
      if (!response.ok) throw new Error('older public history unavailable')
      return response.json()
    })
  }

  // A page closes only the part of a seam it actually covered. A reader holding
  // two rows open at different depths has a gap above each one, so the rows the
  // page reached join the list while the rows still below it keep waiting. A
  // page that stopped above a waiting row, or that lands entirely below it,
  // never reached that row and leaves its gap named.
  function seamRowsAfterPage(deferredRows, incoming, hasMore) {
    if (!deferredRows.length || !hasMore) return []
    const lowestReadId = incoming.reduce(
      (lowest, row) => Math.min(lowest, row.id), Infinity)
    return deferredRows.filter(row => row.id < lowestReadId ||
      !incoming.some(read => read.id >= row.id))
  }

  // The list after a fill. Rows the fill read join the list, a gap it closed
  // loses its name, and a gap still waiting keeps one so the list's own control
  // can close it. The older-history cursor resumes at the lowest row still
  // connected to the newest page rather than under a gap.
  function filledHistoryEntry(entry, closedIds, collected, readFailed, spentBound) {
    const rows = mergeWindowRows(entry.rows, collected)
    const waitingRows = (entry.deferredRows || []).filter(row => !closedIds.has(row.id))
    // A gap the fill walked its whole bound without reaching is larger than one
    // fill, and the next refresh cannot make it smaller. It keeps its name for
    // the list's own control, and the window stops spending a whole fill on it
    // again on every refresh for as long as the tab stays open.
    const beyondFill = new Set(entry.beyondFillIds || [])
    return Object.freeze({
      ...entry,
      rows,
      deferredRows: waitingRows,
      beyondFillIds: Object.freeze(waitingRows
        .filter(row => spentBound || beyondFill.has(row.id))
        .map(row => row.id)),
      // Only an unclosed gap promises that something older is still out there.
      // A fill that closed every gap hands the list its own bottom answer back,
      // rather than offering a page that would add nothing.
      hasMore: waitingRows.length > 0 ? true : olderRowsRemain(entry),
      olderRowsRemain: olderRowsRemain(entry),
      nextBeforeId: connectedHistoryCursor(rows, waitingRows, entry.nextBeforeId),
      initialized: true,
      loading: false,
      error: false,
      refreshing: false,
      refreshError: readFailed,
    })
  }

  // The window fills a gap it has not already proved larger than one fill. The
  // hole the keep bound leaves above a record held far below it is the usual
  // one: reading it means paging from the bound down to that record, which the
  // first fill already walked its whole bound without reaching.
  function fillableGapRows(entry) {
    const beyondFill = new Set(entry.beyondFillIds || [])
    return (entry.deferredRows || []).filter(row => !beyondFill.has(row.id))
  }

  // Every list the window pages rejoins itself after a changed refresh, whether
  // or not the reader is holding one of its records open.
  async function rejoinSnapshotHistories(histories, snapshot, marker, signal) {
    const reads = []
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      for (const [key, entry] of Object.entries(histories[collection] || {})) {
        const joinIds = new Set(fillableGapRows(entry).map(row => row.id))
        if (!joinIds.size) continue
        const filters = entry.filters || Object.freeze({
          placeId: null, resident: null, context: false,
        })
        reads.push((async () => Object.freeze({
          collection,
          key,
          entry: await fillHistoryGap(
            collection, entry, filters, joinIds, marker, signal),
        }))())
      }
    }
    const completed = await Promise.allSettled(reads)
    let reconciled = histories
    for (const completedRead of completed) {
      if (completedRead.status !== 'fulfilled') continue
      const result = completedRead.value
      reconciled = {
        ...reconciled,
        [result.collection]: {
          ...reconciled[result.collection],
          [result.key]: result.entry,
        },
      }
    }
    return reconciled
  }

  function mergeUnchangedSnapshotHistories(snapshot) {
    let histories = state.histories
    for (const collection of ['notes', 'things', 'agreements', 'events']) {
      const existing = histories[collection] || {}
      const refreshed = Object.fromEntries(Object.entries(existing).map(([key, entry]) => {
        if (key === 'all' || !entry?.filters) return [key, entry]
        const freshRows = filterHistoryRows(collection, snapshot[collection], entry.filters, snapshot)
        return [key, Object.freeze({ ...entry, rows: mergeWindowRows(entry.rows, freshRows) })]
      }))
      const current = existing.all
      const rows = mergeWindowRows(current?.rows || [], snapshot[collection])
      const page = snapshot.pages[collection]
      const entry = current
        ? { ...current, rows }
        : {
            rows,
            hasMore: page.hasMore,
            nextBeforeId: page.nextBeforeId,
            initialized: true,
            loading: false,
            error: false,
          }
      histories = {
        ...histories,
        [collection]: { ...refreshed, all: Object.freeze(entry) },
      }
    }
    return histories
  }

`
