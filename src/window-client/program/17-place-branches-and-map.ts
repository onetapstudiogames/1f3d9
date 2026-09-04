export const PART_17_PLACE_BRANCHES_AND_MAP = `  function togglePlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const entry = branchEntry(place)
    if (!entry.loaded) {
      if (!entry.loading) void loadPlaceBranch(placeId)
      return
    }
    const collapsedPlaceIds = state.collapsedPlaceIds.includes(placeId)
      ? state.collapsedPlaceIds.filter(id => id !== placeId)
      : [...state.collapsedPlaceIds, placeId]
    state = { ...state, collapsedPlaceIds }
    if (state.snapshot) renderAll()
  }

  function branchRequestUrl(placeId, entry, minimumMarker) {
    const url = new URL('/api/map', window.location.origin)
    url.searchParams.set('view', 'outline')
    url.searchParams.set('parent_id', String(placeId))
    if (entry.initialized && entry.nextBeforeSubplaceId) {
      url.searchParams.set('before_subplace_id', String(entry.nextBeforeSubplaceId))
    }
    url.searchParams.set('subplace_limit', '25')
    if (minimumMarker) url.searchParams.set('after_change_marker', minimumMarker)
    return url
  }

  async function loadPlaceBranch(placeId) {
    const place = state.snapshot?.flatPlaces.find(candidate => candidate.id === placeId)
    if (!place) return
    const current = branchEntry(place)
    if (current.loading || (current.initialized && !current.hasMore && !current.error)) return
    const requestAuthoredRevision = authoredRevision
    const requestMarker = state.changeMarker
    navigationRevision += 1
    const collapsedPlaceIds = state.collapsedPlaceIds.filter(id => id !== placeId)
    state = { ...state, collapsedPlaceIds }
    replaceBranch(placeId, { ...current, loading: true, error: false })
    renderAll()

    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    try {
      const requestEntry = state.branches[String(placeId)] || current
      const url = branchRequestUrl(placeId, requestEntry, requestMarker)
      const response = await fetch(url.pathname + url.search, {
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        mode: 'same-origin',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal,
      })
      if (!response.ok) throw new Error('public map branch unavailable')
      const payload = await response.json()
      if (authoredRevision !== requestAuthoredRevision) return
      requireCurrentReadMarker(payload?.change_marker, requestMarker)
      const result = branchPageFromPayload(payload, placeId)
      const requestedCursor = requestEntry.initialized
        ? requestEntry.nextBeforeSubplaceId
        : null
      const seenBeforeSubplaceIds = requestEntry.seenBeforeSubplaceIds || []
      if (result.page.hasMore && !branchCursorProgressed(
        requestedCursor,
        result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds,
        result.rows,
      )) throw new Error('public map cursor did not progress')
      const latest = state.branches[String(placeId)] || current
      const deferredRows = latest.deferredRows || []
      const reachedDeferred = result.rows.some(row =>
        deferredRows.some(deferred => deferred.id === row.id))
      const visibleRows = mergePlaceRows(latest.rows, result.rows)
      const reconcileComplete = reachedDeferred || !result.page.hasMore
      replaceBranchWithParent(placeId, {
        rows: reconcileComplete ? mergePlaceRows(deferredRows, visibleRows) : visibleRows,
        deferredRows: reconcileComplete ? [] : deferredRows,
        loaded: true,
        initialized: true,
        hasMore: result.page.hasMore,
        nextBeforeSubplaceId: result.page.nextBeforeSubplaceId,
        seenBeforeSubplaceIds: requestedCursor
          ? [...new Set([...seenBeforeSubplaceIds, requestedCursor])]
          : seenBeforeSubplaceIds,
        loading: false,
        error: false,
      }, result.parent)
      if (state.snapshot) populateFilters(state.snapshot)
    } catch {
      if (authoredRevision !== requestAuthoredRevision) return
      const latest = state.branches[String(placeId)] || current
      replaceBranch(placeId, { ...latest, loading: false, error: true })
    } finally {
      window.clearTimeout(timeout)
      navigationRevision += 1
      renderAll()
    }
  }

  function branchPage(place, entry, childrenId) {
    const item = element('li', 'branch-page')
    if (entry.error) {
      item.setAttribute('role', 'alert')
      item.append(element('p', '', 'Could not load places inside ' + place.name + '.'))
      const retry = element('button', 'branch-load', 'Retry loading places inside ' + place.name)
      retry.type = 'button'
      retry.dataset.focusKey = 'branch-page:' + String(place.id)
      retry.dataset.focusFallbackKey = 'branch:' + String(place.id)
      retry.setAttribute('aria-busy', 'false')
      retry.setAttribute('aria-controls', childrenId)
      retry.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(retry)
      return item
    }
    if (entry.loading && !entry.loaded) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'Loading places inside ' + place.name + '…'))
      return item
    }
    if (entry.loaded && entry.hasMore) {
      const load = element('button', 'branch-load', entry.loading
        ? 'Loading more places inside ' + place.name + '…'
        : 'Load more places inside ' + place.name)
      load.type = 'button'
      load.dataset.focusKey = 'branch-page:' + String(place.id)
      load.dataset.focusFallbackKey = 'branch:' + String(place.id)
      load.setAttribute('aria-busy', String(entry.loading))
      load.setAttribute('aria-controls', childrenId)
      load.addEventListener('click', () => void loadPlaceBranch(place.id))
      item.append(load)
      return item
    }
    if (entry.loaded && !entry.rows.length) {
      item.setAttribute('role', 'status')
      item.append(element('p', '', 'No more public places were found inside ' + place.name + '.'))
    }
    return item
  }

  function placeList(values, snapshot, depth) {
    const list = element('ul', 'place-tree')
    if (!Array.isArray(values) || depth >= 32) return list
    for (const place of values) {
      const node = element('li', 'place-node')
      const card = element('article', 'place-card')
      card.dataset.watched = String(state.placeId === place.id)
      const hasChildren = place.places > 0
      const branch = branchEntry(place)
      const expanded = hasChildren && (branch.loaded || branch.loading || branch.error) &&
        !state.collapsedPlaceIds.includes(place.id)
      const watch = element('button', 'place-watch place-name', place.name)
      watch.type = 'button'
      watch.dataset.focusKey = 'watch:' + String(place.id)
      watch.addEventListener('click', () => choosePlace(place.id, true))
      const occupants = residentsAt(snapshot, place.id)
      const owner = element('span', 'place-owner')
      if (place.owner) {
        owner.append(
          document.createTextNode('kept by '),
          residentNode(place.owner, 'place-owner-resident',
            'place-owner:' + String(place.id)),
        )
      } else {
        owner.textContent = 'unowned · transit only'
      }
      card.append(
        portraitNode('place', place.id, place.name, true, 'place-portrait'),
        watch,
        owner,
        element('span', 'place-facts', String(place.places) +
          (place.places === 1 ? ' place inside · ' : ' places inside · ') +
          String(occupants.length) +
          (occupants.length === 1 ? ' resident shown inside · ' : ' residents shown inside · ') +
          String(place.things) + ' things · ' + String(place.notes) + ' notes'),
      )
      // Fourth review pass on row 75: owner-chosen front matter names things
      // exactly like the occupant and thing lists do, so a quiet place's own
      // front matter must collapse behind the same honest notice instead of
      // naming those things unconditionally.
      if (place.front_matter.length) {
        if (isQuietPlace(place)) {
          card.append(quietRoomNotice(place))
        } else {
          const headings = element('ul', 'place-card-things')
          headings.setAttribute('aria-label', 'Owner-chosen thing headings')
          headings.append(...place.front_matter.map(thing => {
            const item = element('li', 'place-card-thing')
            item.append(
              portraitNode('thing', thing.id, thing.name, thing.has_drawing),
              openDetailLink(
                'thing', thing.id, thing.name, 'detail-link place-card-thing-link',
              ),
            )
            return item
          }))
          card.append(headings)
        }
      }
      if (place.status === 'retired' && place.retiredAt) {
        card.append(element(
          'p',
          'moderated-mark',
          'Retired ' + place.retiredAt.toLocaleString() +
            ' · founding name ' + place.foundingName + ' · stable place #' + String(place.id),
        ))
      }
      if (hasChildren) {
        const childrenId = 'place-children-' + String(place.id)
        const disclosure = element('button', 'place-disclosure', expanded ? 'Collapse inside' : 'Show inside')
        disclosure.type = 'button'
        disclosure.dataset.focusKey = 'branch:' + String(place.id)
        disclosure.setAttribute('aria-expanded', String(expanded))
        disclosure.setAttribute('aria-busy', String(branch.loading && !branch.loaded))
        disclosure.setAttribute('aria-controls', childrenId)
        disclosure.setAttribute('aria-label', (expanded ? 'Collapse' : 'Show') + ' places inside ' + place.name)
        disclosure.addEventListener('click', () => togglePlaceBranch(place.id))
        card.append(disclosure)
      }
      if (occupants.length) {
        card.append(occupantLine(place, occupants, placeId => placeReference(snapshot, placeId)))
      }
      node.append(card)
      if (hasChildren) {
        const children = placeList(branch.rows, snapshot, depth + 1)
        children.id = 'place-children-' + String(place.id)
        children.hidden = !expanded
        if (expanded) {
          const page = branchPage(place, branch, children.id)
          if (page.childNodes.length) children.append(page)
        }
        node.append(children)
      }
      list.append(node)
    }
    return list
  }

  function mapRoots(snapshot) {
    const focus = selectedPlace(snapshot)
    if (focus) return [focus]
    const focused = focusedPlace(state.placeId)
    if (focused) return [focused]
    return state.placeId || state.resident ? [] : snapshot.places
  }

  function renderMap(snapshot) {
    if (!nodes.map) return
    const issue = selectionIssue(snapshot, true)
    if (issue) {
      renderSelectionIssue(nodes.map, issue)
      return
    }
    const roots = mapRoots(snapshot)
    if (!roots.length) {
      const missing = state.resident
        ? state.resident + ' is not currently standing in a public place.'
        : 'No public place in the currently loaded view matches this filter.'
      renderEmpty(nodes.map, 'empty-row', missing)
      return
    }
    nodes.map.replaceChildren(placeList(roots, snapshot, 0))
  }

`
