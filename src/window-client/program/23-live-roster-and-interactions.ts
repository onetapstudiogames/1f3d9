export const PART_23_LIVE_ROSTER_AND_INTERACTIONS = `  function renderLiveResidentPage() {
    if (!nodes.liveResidentPage) return
    const entry = state.residentPaging
    if (!entry.hasMore && !entry.loading && !entry.error) {
      nodes.liveResidentPage.hidden = true
      nodes.liveResidentPage.replaceChildren()
      return
    }
    const parts = []
    if (entry.error) {
      const message = element('p', 'navigation-error', 'Could not load more residents.')
      message.setAttribute('role', 'alert')
      parts.push(message)
    }
    const button = element('button', 'resident-load', entry.loading
      ? 'Loading more residents…'
      : entry.error ? 'Retry loading residents' : 'Load more residents')
    button.type = 'button'
    button.dataset.focusKey = 'live-resident-page'
    button.dataset.focusFallbackId = 'live-roster'
    button.setAttribute('aria-busy', String(entry.loading))
    button.setAttribute('aria-controls', 'live-roster')
    button.addEventListener('click', () => void loadResidents())
    parts.push(button)
    nodes.liveResidentPage.hidden = false
    nodes.liveResidentPage.replaceChildren(...parts)
  }

  function liveFocusInteractionsPanel(snapshot, focus, records, interactionThings) {
    const handle = state.live.focusResident
    if (!handle) return null
    const partnerIds = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const focused = displayedResidents(snapshot).find(resident => resident.handle === handle)
    if (focused) partnerIds.delete(focused.id)
    const things = interactionThings || liveFocusInteractionThings(snapshot, focus, records)
    const panel = element('section', 'live-focus-interactions')
    panel.id = 'live-focus-interactions'
    panel.append(
      element('p', 'block-number', 'FOCUS / INTERACTIONS'),
      element('h3', '', handle),
      element('p', 'live-focus-interactions-copy',
        String(partnerIds.size) + ' resident ' + (partnerIds.size === 1 ? 'partner stays' : 'partners stay') +
        ' marked in the complete roster. Every safely identified thing stays listed here.'),
    )
    const focusScope = placeScopeSet(focus.id, snapshot)
    if (focused && !focusScope.has(focused.current_place_id)) {
      const currentPlace = focused.current_place_id
        ? placeReference(snapshot, focused.current_place_id)
        : null
      // Third review pass: the focused resident is already an identified,
      // viewer-chosen handle, so the card may still name them here — but
      // their location text must not name a quiet place just because this
      // panel resolves it directly instead of going through a roster row
      // that already knows to check.
      const quiet = isQuietPlace(currentPlace)
      const location = quiet
        ? null
        : currentPlace
          ? currentPlace.name
          : focused.current_place_id ? 'Place #' + String(focused.current_place_id) : 'Between places'
      const card = element('div', 'live-focus-resident-card')
      card.dataset.liveFocusResident = focused.handle
      card.dataset.liveResidentHandle = focused.handle
      card.dataset.liveResidentScope = 'outside'
      card.setAttribute('aria-label', focused.handle + (quiet
        ? ' is outside this plate, in a room its owner keeps private.'
        : ' is outside this plate at ' + location))
      const copy = element('span', 'live-focus-resident-card-copy')
      copy.append(
        element('strong', 'live-focus-resident-card-name', focused.handle),
        element('span', 'live-focus-resident-card-location', quiet
          ? 'Outside this plate'
          : 'Outside this plate · ' + location),
      )
      card.append(
        portraitNode(
          'resident', focused.id, focused.handle, focused.has_drawing, 'live-entity-portrait',
        ),
        copy,
        openDrawingDetailButton(
          'resident',
          focused.id,
          focused.handle,
          'resident-drawing-detail drawing-detail-open',
        ),
      )
      if (quiet) card.append(quietRoomNotice(currentPlace))
      panel.append(card)
    }
    if (!things.length) {
      panel.append(element('p', 'empty-row', 'No exact thing interaction is on this plate.'))
      return panel
    }
    const list = element('div', 'live-focus-thing-list')
    for (const thing of things) {
      const place = placeReference(snapshot, thing.place_id)
      const recordedPlace = placeReference(snapshot, thing.recorded_place_id)
      // Third review pass: a thing currently sitting in a quiet place, or
      // whose interaction was recorded in one, must collapse the same way
      // liveLedgerQuietPlace collapses a ledger row — never print the thing's
      // name or either place's name once either resolved place is quiet.
      const quietPlace = isQuietPlace(place) ? place : isQuietPlace(recordedPlace) ? recordedPlace : null
      if (quietPlace) {
        const quietCard = element('div', 'live-focus-thing-card live-focus-thing-card-quiet')
        quietCard.append(quietRoomNotice(quietPlace))
        list.append(quietCard)
        continue
      }
      const location = place ? place.name : 'place #' + String(thing.place_id)
      const recordedLocation = recordedPlace
        ? recordedPlace.name
        : 'place #' + String(thing.recorded_place_id)
      const movedSinceInteraction = thing.loaded && thing.place_id !== thing.recorded_place_id
      const label = thing.loaded
        ? thing.name + (movedSinceInteraction
          ? ' · now in ' + location + ' · recorded in ' + recordedLocation
          : ' · ' + location)
        : 'Thing #' + String(thing.id) + ' · recorded in ' + recordedLocation
      const link = element('a', 'live-focus-thing-card', label)
      link.href = '/api/thing/' + String(thing.id)
      link.title = thing.loaded ? 'Read ' + thing.name : 'Read Thing #' + String(thing.id)
      link.dataset.focusKey = 'live-focus-thing:' + String(thing.id)
      link.dataset.liveFocusThing = String(thing.id)
      const pulse = Object.values(state.live.replayActive).find(active =>
        active.type === 'use' && active.record.detail.source_thing_id === thing.id &&
        active.record.detail.place_id === thing.recorded_place_id)
      if (pulse) {
        link.classList.add('live-pulse')
        link.dataset.livePulseFor = pulse.key
        bindLiveHighlight(link, pulse.key, 'pulse')
      }
      link.prepend(portraitNode(
        'thing',
        thing.id,
        thing.loaded ? thing.name : 'Thing #' + String(thing.id),
        thing.has_drawing,
        'live-entity-portrait',
      ))
      list.append(link)
    }
    panel.append(list)
    return panel
  }

  function renderLiveRoster(snapshot, focus, records, interactionThings) {
    if (!nodes.liveRoster) return
    if (focus && focus.quiet) {
      renderQuietRoom(nodes.liveRoster, focus)
      return
    }
    renderLiveResidentPage()
    const scope = placeScopeSet(focus.id, snapshot)
    const residents = displayedResidents(snapshot).filter(resident =>
      scope.has(resident.current_place_id) &&
      (!state.resident || resident.handle === state.resident))
    const pinned = new Set(livePinnedResidentIds(snapshot, records, focus.id))
    const parts = []
    const focusPanel = liveFocusInteractionsPanel(snapshot, focus, records, interactionThings)
    if (focusPanel) parts.push(focusPanel)
    if (!residents.length) {
      const empty = element('p', 'empty-row', 'Nobody is here right now. The room keeps its things.')
      empty.setAttribute('role', 'status')
      nodes.liveRoster.replaceChildren(...parts, empty)
      return
    }
    const list = element('div', 'live-roster-list')
    for (const resident of [...residents.filter(row => !row.asleep),
      ...residents.filter(row => row.asleep)]) {
      const row = element('div', resident.asleep ? 'resident-row asleep' : 'resident-row')
      const place = placeReference(snapshot, resident.current_place_id)
      if (isQuietPlace(place)) {
        row.classList.add('resident-row-quiet')
        row.append(quietRoomNotice(place))
        list.append(row)
        continue
      }
      // Fourth review pass on row 75: the dataset markers below must be set
      // only after the quiet check above returns, never before — a quiet
      // resident's row is replaced with quietRoomNotice(place) and the loop
      // continues before reaching here, so their handle never lands in
      // data-live-focus-resident/-partner on a suppressed row's own element.
      if (state.live.focusResident === resident.handle) {
        row.dataset.liveFocusResident = resident.handle
      } else if (pinned.has(resident.id)) {
        row.dataset.liveFocusPartner = resident.handle
      }
      const follow = element('button', 'resident-follow', resident.handle)
      follow.type = 'button'
      follow.dataset.focusKey = 'live-roster:' + resident.handle
      follow.dataset.liveResidentHandle = resident.handle
      follow.setAttribute('aria-pressed', String(state.live.focusResident === resident.handle))
      follow.addEventListener('click', () => toggleLiveFocusResident(resident.handle))
      const location = place ? place.name : resident.current_place_id
        ? 'Place #' + String(resident.current_place_id)
        : 'Between places'
      row.append(
        portraitNode(
          'resident', resident.id, resident.handle, resident.has_drawing, 'live-entity-portrait',
        ),
        follow,
        element('span', 'resident-number', location + (resident.asleep ? ' · asleep' : '')),
        openDrawingDetailButton(
          'resident',
          resident.id,
          resident.handle,
          'resident-drawing-detail drawing-detail-open',
        ),
      )
      list.append(row)
    }
    nodes.liveRoster.replaceChildren(...parts, list)
  }

`
