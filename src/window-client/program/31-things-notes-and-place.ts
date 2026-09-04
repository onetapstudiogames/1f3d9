export const PART_31_THINGS_NOTES_AND_PLACE = `  // Decision #75: quiet resolves at the thing's own place_id, the same
  // pattern noteCard uses, so every caller — the Rooms tab and the
  // place-scoped or city-wide Things list — inherits it uniformly.
  function renderThings(target, things, placeOf) {
    if (!target) return
    if (!things.length) {
      renderEmpty(target, 'empty-row', 'No public thing matches this selection.')
      return
    }
    const list = element('ul', 'thing-list')
    list.append(...things.map(thing => {
      const item = element('li', 'thing-card')
      const resolvedPlace = placeOf ? placeOf(thing.place_id) : null
      if (isQuietPlace(resolvedPlace)) {
        item.classList.add('thing-card-quiet')
        item.append(quietRoomNotice(resolvedPlace))
        return item
      }
      const thingMeta = element('p', 'thing-meta')
      thingMeta.append(document.createTextNode('made by '))
      thingMeta.append(thing.made_by
        ? residentNode(thing.made_by, 'thing-maker', 'thing-maker:' + String(thing.id))
        : document.createTextNode('maker unavailable'))
      thingMeta.append(
        document.createTextNode(' · currently owned by '),
        residentNode(thing.current_owner, 'thing-owner', 'thing-owner:' + String(thing.id)),
      )
      if (thing.kind) {
        thingMeta.append(document.createTextNode(' · kind: '))
        if (thing.kind_id) {
          thingMeta.append(portraitNode('kind', thing.kind_id, thing.kind, true, 'kind-portrait'))
        }
        thingMeta.append(document.createTextNode(thing.kind))
      } else {
        thingMeta.append(document.createTextNode(' · one of a kind'))
      }
      thingMeta.append(document.createTextNode(
        thing.open_to_use ? ' · open to shared use' : ' · owner use only'))
      const location = windowPlaceLabel(
        thing.place_id,
        placeOf ? placeOf(thing.place_id) : null,
      )
      if (location) {
        thingMeta.append(
          document.createTextNode(' · at '),
          element('span', 'thing-location', location),
        )
      }
      const heading = element('h4', '')
      heading.append(
        portraitNode('thing', thing.id, thing.name, thing.has_drawing),
        openDetailLink('thing', thing.id, thing.name, 'detail-link thing-detail-link'),
      )
      item.append(heading, thingMeta)
      if (thing.body) item.append(renderExpandableBody('thing', thing.id, thing.body, thing.truncated))
      const traits = element('div', 'trait-list')
      if (thing.traits.length) {
        traits.append(...thing.traits.map(trait => {
          const chip = element('span', 'trait-chip', trait)
          chip.dataset.moderated = String(trait === MODERATED_TEXT)
          return chip
        }))
      } else {
        traits.append(element('span', 'thing-meta', 'no public traits'))
      }
      item.append(traits)
      if (thing.moderated || thing.kind_moderated) {
        item.append(element('span', 'moderated-mark', 'Maintainer removal shown as a tombstone'))
      }
      return item
    }))
    target.replaceChildren(list)
  }

  // Decision #75: every note card resolves quiet at its own place_id, never
  // at whatever place happens to be selected. This is the one place that
  // check runs, so every list that renders notes through noteCard — the
  // Rooms tab, the Conversations tab (with or without a resident filter),
  // and any place-scoped or city-wide feed — inherits it for free.
  function noteCard(note, place) {
    if (isQuietPlace(place)) {
      const card = element('article', 'note-card note-card-quiet')
      card.append(quietRoomNotice(place))
      return card
    }
    const card = element('article', 'note-card')
    const meta = element('p', 'note-meta')
    meta.append(
      residentNode(note.author, 'note-author', 'note-author:' + String(note.id)),
      document.createTextNode(' · '),
      timeNode(note.created_at, ''),
    )
    const location = windowPlaceLabel(note.place_id, place)
    if (location) {
      meta.append(
        document.createTextNode(' · '),
        element('span', 'note-location', location),
      )
    }
    meta.append(
      document.createTextNode(' · '),
      openDetailLink(
        'note', note.id, 'Open note #' + String(note.id), 'detail-link note-detail-link',
      ),
    )
    card.append(meta, renderExpandableBody('note', note.id, note.body, note.truncated))
    if (note.moderated) card.append(element('span', 'moderated-mark', 'Removed text retained as a tombstone'))
    return card
  }

  function renderNotes(target, notes, emptyMessage, placeOf) {
    if (!target) return
    if (!notes.length) {
      renderEmpty(target, 'empty-row', emptyMessage)
      return
    }
    const list = element('div', 'note-list')
    list.append(...notes.map(note => noteCard(
      note,
      typeof placeOf === 'function' ? placeOf(note.place_id) : placeOf,
    )))
    target.replaceChildren(list)
  }

  function renderHistoryOutcome(target, entry, messages, itemTag) {
    if (!target || entry.rows.length) return false
    const waiting = entry.loading || entry.refreshing ||
      (!entry.initialized && !entry.error && !entry.refreshError)
    const failed = entry.error || entry.refreshError
    const message = waiting
      ? messages.loading
      : failed
        ? messages.failure
        : messages.empty
    const className = failed ? 'error-row' : waiting ? 'loading-row' : 'empty-row'
    target.replaceChildren(element(itemTag || 'p', className, message))
    return true
  }

  function hideHistoryControl(target) {
    if (!target) return
    target.hidden = true
    target.replaceChildren()
  }

  function renderOccupants(snapshot, place) {
    const occupants = residentsAt(snapshot, place.id)
    const completePresence = displayedResidents(snapshot).length >= snapshot.totals.residents
    if (occupants.length) {
      renderPeople(nodes.occupants, occupants,
        placeId => placeReference(snapshot, placeId))
    } else {
      renderEmpty(nodes.occupants, 'empty-row', completePresence
        ? 'No public resident is standing inside this place.'
        : 'No resident from the bounded presence view is shown inside this place.')
    }
    if (!completePresence && nodes.occupants) {
      nodes.occupants.append(element('p', 'presence-boundary',
        'Other occupants may be omitted: no narrow place-specific presence read exists yet.'))
    }
  }

  function renderPlaceOrientation(place) {
    if (nodes.placePurposeLabel) nodes.placePurposeLabel.textContent = 'Owner-written purpose'
    if (nodes.placeFrontMatterLabel) {
      nodes.placeFrontMatterLabel.textContent = 'Owner-chosen front matter'
    }
    if (!place) {
      renderEmpty(nodes.placeDescription, 'empty-row', 'No loaded place description is available.')
      renderEmpty(nodes.placePurpose, 'empty-row', 'No loaded place purpose is available.')
      renderEmpty(nodes.placeFrontMatter, 'empty-row', 'No loaded front matter is available.')
      return
    }
    const description = state.details['place:' + String(place.id)]
    if (place.moderated) {
      renderEmpty(nodes.placeDescription, 'place-description-text', MODERATED_TEXT)
    } else if (!description || description.loading) {
      renderEmpty(nodes.placeDescription, 'loading-row', 'Reading the owner-written description…')
      if (!description) window.queueMicrotask(() => void ensureDetail(false, place.id))
    } else if (description.notFound) {
      renderEmpty(nodes.placeDescription, 'empty-row', 'This public place is not available now.')
    } else if (description.error || !description.record) {
      const message = element('p', 'error-row', 'The place description could not be read.')
      const retry = element('button', 'detail-retry', 'Retry reading this description')
      retry.type = 'button'
      retry.dataset.focusKey = 'place-description-retry:' + String(place.id)
      retry.dataset.focusFallbackId = 'place-description-title'
      retry.addEventListener('click', () => void ensureDetail(true, place.id))
      nodes.placeDescription?.replaceChildren(message, retry)
    } else {
      renderEmpty(nodes.placeDescription,
        description.record.description ? 'place-description-text' : 'empty-row',
        description.record.description || 'No owner-written description is set for this place.')
    }
    if (nodes.placePurpose) {
      nodes.placePurpose.replaceChildren(element(
        'p',
        place.purpose ? 'place-purpose-text' : 'empty-row',
        place.purpose || 'No owner-written purpose is set for this place.',
      ))
    }
    if (!nodes.placeFrontMatter) return
    // Fourth review pass on row 75: the Place tab renders front matter
    // before the occupants/things/conversation panels below apply their own
    // quiet checks — this block must resolve quiet for itself instead of
    // assuming an earlier check in renderPlace already covered it, or a
    // quiet place's own owner-chosen thing names and maker/owner handles
    // would still print here.
    if (isQuietPlace(place)) {
      renderQuietRoom(nodes.placeFrontMatter, place)
      return
    }
    if (!place.front_matter.length) {
      renderEmpty(
        nodes.placeFrontMatter,
        'empty-row',
        'No owner-chosen front matter is available.',
      )
      return
    }
    const list = element('ol', 'front-matter-list')
    list.setAttribute('aria-labelledby', 'place-front-matter-title')
    list.append(...place.front_matter.map(heading => {
      const item = element('li', 'front-matter-heading')
      const link = openDetailLink(
        'thing', heading.id, heading.name, 'front-matter-link detail-link',
      )
      const meta = element('p', 'front-matter-meta thing-meta')
      meta.append(
        document.createTextNode('made by '),
        residentNode(heading.made_by, 'thing-maker', 'front-matter-maker:' + String(heading.id)),
        document.createTextNode(' · currently owned by '),
        residentNode(
          heading.current_owner,
          'thing-owner',
          'front-matter-owner:' + String(heading.id),
        ),
        document.createTextNode(' · ' + String(heading.body_text_bytes) + ' UTF-8 bytes'),
      )
      const title = element('span', 'front-matter-title')
      title.append(portraitNode('thing', heading.id, heading.name, heading.has_drawing), link)
      item.append(title, meta)
      return item
    }))
    nodes.placeFrontMatter.replaceChildren(list)
  }

  function renderPlace(snapshot) {
    const followed = selectedResident(snapshot)
    const place = selectedPlace(snapshot) ||
      (!state.resident && !state.placeId ? snapshot.flatPlaces[0] || null : null)
    if (!place) {
      const issue = selectionIssue(snapshot, true)
      if (issue) {
        const issueTitle = issue.status === 'not-found'
          ? issue.kind === 'resident' ? 'No public resident was found' : 'No public place was found'
          : issue.status === 'error'
            ? issue.kind === 'resident' ? 'Public resident could not be loaded' : 'Public place could not be loaded'
            : issue.kind === 'resident' ? 'Loading public resident…' : 'Loading public place…'
        if (nodes.placeTitle) nodes.placeTitle.textContent = issueTitle
        if (nodes.placeSummary) nodes.placeSummary.textContent = issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? issueTitle + '. Use Retry to try the focused read again.'
            : issueTitle + ' The requested content will follow that focused read.'
        if (nodes.placePurpose) {
          renderSelectionIssue(nodes.placePurpose, issue, null, 'place-focus-title')
        }
        renderEmpty(nodes.placeDescription, issue.status === 'error' ? 'error-row' :
          issue.status === 'not-found' ? 'empty-row' : 'loading-row',
        issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? 'The description is unavailable until the focused read succeeds.'
            : 'Waiting for the focused read before reading the description…')
        renderEmpty(nodes.placeFrontMatter, issue.status === 'error' ? 'error-row' :
          issue.status === 'not-found' ? 'empty-row' : 'loading-row',
        issue.status === 'not-found'
          ? issueTitle + ' for this selection.'
          : issue.status === 'error'
            ? 'Front matter is unavailable until the focused read succeeds.'
            : 'Loading public front matter…')
        for (const target of [nodes.occupants, nodes.placeThings, nodes.placeConversation]) {
          renderEmpty(target, issue.status === 'error' ? 'error-row' :
            issue.status === 'not-found' ? 'empty-row' : 'loading-row',
          issue.status === 'not-found'
            ? issueTitle + ' for this selection.'
            : issue.status === 'error'
              ? 'This section is unavailable until the focused read succeeds.'
              : 'Waiting for the focused read…')
        }
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (followed?.current_place_id === null) {
        if (nodes.placeTitle) nodes.placeTitle.textContent = followed.handle + ' is between places'
        if (nodes.placeSummary) {
          nodes.placeSummary.textContent = 'This resident is not currently standing in a public place.'
        }
        renderPlaceOrientation(null)
        renderEmpty(nodes.occupants, 'empty-row', 'There is no doorway around this resident right now.')
        renderEmpty(nodes.placeThings, 'empty-row', 'No current public place is available for visible things.')
        renderEmpty(nodes.placeConversation, 'empty-row', 'No current public place is available for conversation.')
        hideHistoryControl(nodes.placeThingsPage)
        hideHistoryControl(nodes.placeNotesPage)
        return
      }
      if (nodes.placeTitle) nodes.placeTitle.textContent = 'No public place is selected'
      if (nodes.placeSummary) nodes.placeSummary.textContent = 'Choose a public place to inspect it.'
      renderPlaceOrientation(null)
      renderEmpty(nodes.occupants, 'empty-row', 'No public place is selected for occupants.')
      renderEmpty(nodes.placeThings, 'empty-row', 'No public place is selected for visible things.')
      renderEmpty(nodes.placeConversation, 'empty-row', 'No public place is selected for conversation.')
      hideHistoryControl(nodes.placeThingsPage)
      hideHistoryControl(nodes.placeNotesPage)
      return
    }
    if (nodes.placeTitle) nodes.placeTitle.textContent = place.name +
      (place.status === 'retired' ? ' · retired' : '')
    if (nodes.placeSummary) {
      if (place.status === 'retired' && place.retiredAt) {
        const history = place.nameHistory.length
          ? ' Name history: ' + place.nameHistory.map(span => span.name + ' (' +
            span.startedAt.toLocaleDateString() + '–' +
            (span.endedAt ? span.endedAt.toLocaleDateString() : 'current') + ')').join(' → ') + '.'
          : ''
        nodes.placeSummary.textContent = 'This place was retired ' +
          place.retiredAt.toLocaleString() + '. Founding name: ' + place.foundingName + '.' + history +
          ' Its stable address is place #' + String(place.id) + '; its notes remain public below.'
      } else {
        nodes.placeSummary.textContent = place.path + (place.owner
          ? ' · kept by ' + place.owner
          : ' · nobody owns it · transit only') +
          (state.placeId ? ' · showing this place and everything inside it' : '')
      }
    }
    renderPlaceOrientation(place)
    if (isQuietPlace(place)) {
      renderQuietRoom(nodes.occupants, place)
      renderQuietRoom(nodes.placeThings, place)
      renderQuietRoom(nodes.placeConversation, place)
      hideHistoryControl(nodes.placeThingsPage)
      hideHistoryControl(nodes.placeNotesPage)
      return
    }
    renderOccupants(snapshot, place)
    const filters = Object.freeze({ placeId: place.id, resident: state.resident })
    autoLoadFilteredHistory('things', filters, historyEntry('things', filters))
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const thingsEntry = historyEntry('things', filters)
    const notesEntry = historyEntry('notes', filters)
    if (!renderHistoryOutcome(nodes.placeThings, thingsEntry, Object.freeze({
      loading: 'Fetching things that match this place…',
      failure: 'Things could not be loaded. Retry below.',
      empty: 'No public thing matches this selection.',
    }))) {
      renderThings(nodes.placeThings, thingsEntry.rows,
        placeId => placeReference(snapshot, placeId))
    }
    if (!renderHistoryOutcome(nodes.placeConversation, notesEntry, Object.freeze({
      loading: 'Fetching conversation that matches this place…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this place selection.',
    }))) {
      renderNotes(nodes.placeConversation, notesEntry.rows,
        'No public conversation matches this place selection.',
        placeId => placeReference(snapshot, placeId))
    }
    renderHistoryControl(nodes.placeThingsPage, 'things', 'things', filters)
    renderHistoryControl(nodes.placeNotesPage, 'notes', 'notes', filters)
  }

`
