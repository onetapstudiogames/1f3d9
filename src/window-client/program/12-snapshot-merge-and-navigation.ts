export const PART_12_SNAPSHOT_MERGE_AND_NAVIGATION = `  function flattenPlaces(values, ancestors) {
    return values.flatMap(place => {
      const path = [...ancestors, place.name]
      const flat = [{ ...place, path: path.join(' / ') }]
      return [...flat, ...flattenPlaces(place.children, path)]
    })
  }

  function normalizePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSubplacePage(raw, rows, total) {
    const source = raw && typeof raw === 'object' ? raw : null
    const hasMore = source ? source.has_more === true : total > rows.length
    const cursor = safeId(source?.next_before_subplace_id) || safeId(rows.at(-1)?.id)
    return Object.freeze({
      hasMore: Boolean(hasMore && cursor),
      nextBeforeSubplaceId: hasMore && cursor ? cursor : null,
    })
  }

  function normalizeSnapshot(payload) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public snapshot')
    const places = normalizePlaces(payload.places, 0, new Set())
    const residents = normalizeResidents(payload.residents)
    const notes = normalizeNotes(payload.notes)
    const things = normalizeThings(payload.things)
    const agreements = normalizeAgreements(payload.agreements)
    const events = normalizeEvents(payload.events)
    const liveSurvey = normalizeLiveSurvey(payload.live_survey)
    const shown = {
      places: flattenPlaces(places, []).length,
      residents: residents.length,
      conversations: notes.length,
      things: things.length,
      agreements: agreements.length,
      events: events.length,
    }
    const rawTotals = payload.totals && typeof payload.totals === 'object' ? payload.totals : {}
    const totals = Object.fromEntries(Object.entries(shown).map(([key, visible]) => [
      key,
      Math.max(safeCount(rawTotals[key]), visible),
    ]))
    const rawPages = payload.pages && typeof payload.pages === 'object' ? payload.pages : {}
    const pages = Object.freeze({
      places: normalizeSubplacePage(rawPages.places, places[0]?.children || [], totals.places),
      residents: normalizePage(rawPages.residents, residents, totals.residents),
      notes: normalizePage(rawPages.notes, notes, totals.conversations),
      things: normalizePage(rawPages.things, things, totals.things),
      agreements: normalizePage(rawPages.agreements, agreements, totals.agreements),
      events: normalizePage(rawPages.events, events, totals.events),
    })
    const rawBodyLimits = payload.body_limits && typeof payload.body_limits === 'object'
      ? payload.body_limits
      : {}
    const bodyLimits = Object.freeze({
      notes: safeId(rawBodyLimits.notes),
      things: safeId(rawBodyLimits.things),
      agreements: safeId(rawBodyLimits.agreements),
    })
    const hasBodyLimits = bodyLimits.notes && bodyLimits.things && bodyLimits.agreements
    return Object.freeze({
      places,
      flatPlaces: flattenPlaces(places, []),
      residents,
      notes,
      things,
      agreements,
      events,
      liveSurvey,
      shown,
      totals,
      pages,
      bodyLimits: hasBodyLimits ? bodyLimits : null,
      view: payload.view === 'outline' ? 'outline' : 'full',
      changeMarker: safeChangeMarker(payload.change_marker),
      refreshedAt: safeDate(payload.refreshed_at),
    })
  }

  function mergePlaceRows(currentChildren, incomingChildren) {
    const currentById = new Map(currentChildren.map(place => [place.id, place]))
    const incomingById = new Map(incomingChildren.map(place => [place.id, place]))
    return mergeWindowRows(currentChildren, incomingChildren).map(place => {
      const current = currentById.get(place.id)
      const incoming = incomingById.get(place.id)
      return Object.freeze({
        ...(current || {}),
        ...(incoming || place),
        children: mergePlaceRows(current?.children || [], incoming?.children || []),
      })
    })
  }

  function mergePlaceMetadata(values, incoming) {
    return values.map(place => Object.freeze({
      ...(place.id === incoming.id
        ? { ...place, ...incoming, children: place.children }
        : place),
      children: mergePlaceMetadata(place.children, incoming),
    }))
  }

  function mergeParentIntoBranches(branches, parent) {
    return Object.fromEntries(Object.entries(branches).map(([key, entry]) => [
      key,
      Object.freeze({ ...entry, rows: mergePlaceMetadata(entry.rows, parent) }),
    ]))
  }

  function materializePlaces(values, branches, depth, seen) {
    if (!Array.isArray(values) || depth >= 32) return []
    return values.flatMap(place => {
      if (!place || seen.has(place.id)) return []
      const entry = branches[String(place.id)]
      const source = entry?.loaded ? entry.rows : place.children
      return [Object.freeze({
        ...place,
        children: materializePlaces(source, branches, depth + 1, new Set([...seen, place.id])),
      })]
    })
  }

  function withNavigation(snapshot, branches, residents) {
    const places = materializePlaces(snapshot.places, branches, 0, new Set())
    const flatPlaces = flattenPlaces(places, [])
    return Object.freeze({
      ...snapshot,
      places,
      flatPlaces,
      residents,
      shown: Object.freeze({
        ...snapshot.shown,
        places: flatPlaces.length,
        residents: residents.length,
      }),
      totals: Object.freeze({
        ...snapshot.totals,
        places: Math.max(snapshot.totals.places, flatPlaces.length),
        residents: Math.max(snapshot.totals.residents, residents.length),
      }),
    })
  }

  function branchPageFromPayload(payload, placeId) {
    if (!payload || typeof payload !== 'object') throw new Error('invalid public map branch')
    const [parent] = normalizePlaces([payload.place], 0, new Set())
    if (!parent || parent.id !== placeId) throw new Error('wrong public map branch')
    const rows = normalizePlaces(payload.subplaces, 0, new Set([placeId]))
      .filter(child => child.parent_id === placeId)
    const page = normalizeSubplacePage(payload.subplaces_page, rows, parent.places)
    if (payload.subplaces_page?.has_more === true &&
        (!page.nextBeforeSubplaceId || !rows.some(row => row.id === page.nextBeforeSubplaceId))) {
      throw new Error('invalid public map cursor')
    }
    return Object.freeze({ parent, rows, page })
  }

  function branchCursorProgressed(requested, next, seen, rows) {
    return Boolean(next && rows.some(row => row.id === next) &&
      (!requested || next < requested) && !seen.includes(next))
  }

  function residentComesBefore(candidate, boundary) {
    const timeDifference = candidate.joined_at.getTime() - boundary.joined_at.getTime()
    return timeDifference < 0 || (timeDifference === 0 && candidate.id < boundary.id)
  }

  function residentCursorProgressed(requested, next, seen, rows, knownRows) {
    if (!next || seen.includes(next)) return false
    const nextResident = rows.find(row => row.id === next)
    if (!nextResident) return false
    if (!requested) return true
    const boundary = knownRows.find(row => row.id === requested)
    return requested !== next && Boolean(boundary && residentComesBefore(nextResident, boundary))
  }

  async function fetchBranchForwardPage(placeId, beforeId, minimumMarker, signal) {
    const url = branchRequestUrl(placeId, {
      initialized: Boolean(beforeId), nextBeforeSubplaceId: beforeId,
    }, minimumMarker)
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public map branch unavailable')
    const payload = await response.json()
    requireExactReadMarker(payload?.change_marker, minimumMarker)
    return branchPageFromPayload(payload, placeId)
  }

  async function forwardReconcileBranch(
    placeId, current, firstPage, minimumMarker, signal, takeBudget,
  ) {
    const oldIds = new Set(current.rows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = []
    let pageResult = firstPage
    let lastParent = firstPage?.parent || null
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      if (!pageResult && !takeBudget()) break
      const result = pageResult || await fetchBranchForwardPage(
        placeId, beforeId, minimumMarker, signal)
      pageResult = null
      lastParent = result.parent
      const next = result.page.nextBeforeSubplaceId
      if (result.page.hasMore &&
          !branchCursorProgressed(beforeId, next, seen, result.rows)) {
        throw new Error('public map cursor did not progress')
      }
      collected = mergePlaceRows(collected, result.rows)
      const overlap = result.rows.some(row => oldIds.has(row.id))
      if (overlap || !result.page.hasMore) {
        return Object.freeze({
          parent: result.parent,
          rows: mergePlaceRows(current.rows, collected),
          complete: true,
        })
      }
      seen = [...seen, next]
      beforeId = next
    }
    if (lastParent && collected.length && beforeId) {
      return Object.freeze({
        parent: lastParent,
        rows: collected,
        complete: false,
        nextBeforeSubplaceId: beforeId,
        seenBeforeSubplaceIds: seen,
        deferredRows: current.rows,
      })
    }
    throw new Error('public map reconciliation limit reached')
  }

  async function fetchResidentForwardPage(beforeId, minimumMarker, signal) {
    const url = residentRequestUrl(
      { initialized: Boolean(beforeId), nextBeforeId: beforeId },
      minimumMarker,
    )
    const response = await fetch(url.pathname + url.search, {
      credentials: 'omit',
      headers: { Accept: 'application/json' },
      mode: 'same-origin',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      signal,
    })
    if (!response.ok) throw new Error('public resident page unavailable')
    const payload = await response.json()
    if (!payload || typeof payload !== 'object') throw new Error('invalid public resident page')
    requireExactReadMarker(payload.change_marker, minimumMarker)
    const rows = normalizeResidents(payload.residents)
    const page = Object.freeze({
      hasMore: payload.has_more === true,
      nextBeforeId: payload.has_more === true ? safeId(payload.next_before_id) : null,
    })
    return Object.freeze({ rows, page })
  }

  async function forwardReconcileResidents(snapshot, previousRows, signal, takeBudget) {
    if (!previousRows.length) return Object.freeze({ rows: snapshot.residents, complete: true })
    const oldIds = new Set(previousRows.map(row => row.id))
    let seen = []
    let beforeId = null
    let collected = snapshot.residents
    let rows = snapshot.residents
    let page = snapshot.pages.residents
    for (let pageCount = 0; pageCount < MAX_FORWARD_RECONCILE_PAGES; pageCount += 1) {
      const knownRows = mergeResidentRows(previousRows, collected)
      if (page.hasMore &&
          !residentCursorProgressed(beforeId, page.nextBeforeId, seen, rows, knownRows)) {
        throw new Error('public resident cursor did not progress')
      }
      const overlap = rows.some(row => oldIds.has(row.id))
      if (overlap || !page.hasMore) {
        return Object.freeze({ rows: mergeResidentRows(previousRows, collected), complete: true })
      }
      seen = [...seen, page.nextBeforeId]
      beforeId = page.nextBeforeId
      if (!takeBudget()) break
      const next = await fetchResidentForwardPage(beforeId, snapshot.changeMarker, signal)
      rows = next.rows
      page = next.page
      collected = mergeResidentRows(collected, rows)
    }
    if (collected.length && beforeId) {
      return Object.freeze({
        rows: collected,
        complete: false,
        nextBeforeId: beforeId,
        seenBeforeIds: seen,
        deferredResidents: previousRows,
      })
    }
    throw new Error('public resident reconciliation limit reached')
  }

  async function mergeFreshNavigation(snapshot, signal) {
    const previousBranches = state.branches
    let remainingReconcilePages = MAX_FORWARD_RECONCILE_PAGES
    const takeReconcileBudget = () => {
      if (remainingReconcilePages <= 0) return false
      remainingReconcilePages -= 1
      return true
    }
    let branches = { ...previousBranches }
    let refreshedPlaces = snapshot.places
    const rootIds = new Set(snapshot.places.map(root => root.id))

    for (const [index, root] of snapshot.places.entries()) {
      const current = previousBranches[String(root.id)]
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      if (!current) {
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            rows: root.children,
            loaded: true,
            initialized: true,
            hasMore: page.hasMore,
            nextBeforeSubplaceId: page.nextBeforeSubplaceId,
            seenBeforeSubplaceIds: [],
            loading: false,
            error: false,
          }),
        }
        continue
      }
      if (current.loading || (current.deferredRows || []).length) continue
      try {
        const reconciled = await forwardReconcileBranch(
          root.id,
          current,
          Object.freeze({ parent: root, rows: root.children, page }),
          snapshot.changeMarker,
          signal,
          takeReconcileBudget,
        )
        branches = {
          ...branches,
          [String(root.id)]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
      } catch {
        // Keep the last contiguous root page; the next bounded refresh retries.
      }
    }

    const nestedBranches = Object.entries(previousBranches).filter(([key, current]) => {
      const placeId = safeId(key)
      return placeId && !rootIds.has(placeId) && current.loaded && current.initialized &&
        !current.loading && !(current.deferredRows || []).length
    })
    const branchCount = Math.min(2, nestedBranches.length)
    const selectedBranches = Array.from({ length: branchCount }, (_, index) =>
      nestedBranches[(branchRefreshOffset + index) % nestedBranches.length])
    if (nestedBranches.length) branchRefreshOffset = (branchRefreshOffset + branchCount) % nestedBranches.length
    for (const [key, current] of selectedBranches) {
      const placeId = safeId(key)
      if (!placeId) continue
      try {
        const reconciled = await forwardReconcileBranch(
          placeId, current, null, snapshot.changeMarker, signal, takeReconcileBudget)
        branches = mergeParentIntoBranches(branches, reconciled.parent)
        branches = {
          ...branches,
          [key]: Object.freeze({
            ...current,
            rows: reconciled.rows,
            ...(reconciled.complete
              ? { deferredRows: [] }
              : {
                  deferredRows: reconciled.deferredRows,
                  hasMore: true,
                  nextBeforeSubplaceId: reconciled.nextBeforeSubplaceId,
                  seenBeforeSubplaceIds: reconciled.seenBeforeSubplaceIds,
                }),
            loading: false,
            error: false,
          }),
        }
        refreshedPlaces = mergePlaceMetadata(refreshedPlaces, reconciled.parent)
      } catch {
        // Silent revalidation never discards an already contiguous branch.
      }
    }

    let residents = snapshot.residents
    let residentPaging = state.residentPaging.initialized
      ? state.residentPaging
      : Object.freeze({
          initialized: true,
          hasMore: snapshot.pages.residents.hasMore,
          nextBeforeId: snapshot.pages.residents.nextBeforeId,
          seenBeforeIds: [],
          automaticPageCount: 0,
          automaticPaused: false,
          loading: false,
          error: false,
        })
    if ((state.residentPaging.deferredResidents || []).length) {
      residents = state.snapshot?.residents || snapshot.residents
    } else {
      try {
        const reconciled = await forwardReconcileResidents(
          snapshot, state.snapshot?.residents || [], signal, takeReconcileBudget)
        residents = reconciled.rows
        if (!reconciled.complete) {
          residentPaging = Object.freeze({
            ...residentPaging,
            hasMore: true,
            nextBeforeId: reconciled.nextBeforeId,
            seenBeforeIds: reconciled.seenBeforeIds,
            deferredResidents: reconciled.deferredResidents,
            error: false,
          })
        } else if (residentPaging.deferredResidents) {
          residentPaging = Object.freeze({ ...residentPaging, deferredResidents: [] })
        }
      } catch {
        residents = state.snapshot?.residents || snapshot.residents
      }
    }
    const refreshedSnapshot = Object.freeze({ ...snapshot, places: refreshedPlaces })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(refreshedSnapshot, branches, residents),
    })
  }

  function freshSnapshotNavigation(snapshot) {
    const branches = Object.fromEntries(snapshot.places.map((root, index) => {
      const page = index === 0
        ? snapshot.pages.places
        : normalizeSubplacePage(null, root.children, root.places)
      return [String(root.id), Object.freeze({
        rows: root.children,
        loaded: true,
        initialized: true,
        hasMore: page.hasMore,
        nextBeforeSubplaceId: page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: [],
        loading: false,
        error: false,
      })]
    }))
    const residentPaging = Object.freeze({
      initialized: true,
      hasMore: snapshot.pages.residents.hasMore,
      nextBeforeId: snapshot.pages.residents.nextBeforeId,
      seenBeforeIds: [],
      automaticPageCount: 0,
      automaticPaused: false,
      loading: false,
      error: false,
    })
    return Object.freeze({
      branches,
      residentPaging,
      snapshot: withNavigation(snapshot, branches, snapshot.residents),
    })
  }

`
