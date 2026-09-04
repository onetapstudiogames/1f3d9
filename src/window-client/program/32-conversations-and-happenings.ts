export const PART_32_CONVERSATIONS_AND_HAPPENINGS = `  function renderConversationMode() {
    if (!nodes.conversationMode) return
    if (!state.resident) {
      nodes.conversationMode.hidden = true
      nodes.conversationMode.replaceChildren()
      return
    }
    const question = element('p', 'conversation-question', state.conversationContext
      ? 'Question: What was said around ' + state.resident + '?'
      : 'Question: What did ' + state.resident + ' say?')
    const choices = element('div', 'conversation-choices')
    const residentOnly = element('button', 'conversation-mode-button',
      'What ' + state.resident + ' said')
    residentOnly.type = 'button'
    residentOnly.setAttribute('aria-pressed', String(!state.conversationContext))
    residentOnly.dataset.focusKey = 'conversation-mode:resident'
    residentOnly.addEventListener('click', () => navigate({ conversationContext: false }))
    const roomContext = element('button', 'conversation-mode-button',
      'What was said around ' + state.resident)
    roomContext.type = 'button'
    roomContext.setAttribute('aria-pressed', String(state.conversationContext))
    roomContext.dataset.focusKey = 'conversation-mode:context'
    roomContext.addEventListener('click', () => navigate({ conversationContext: true }))
    choices.append(residentOnly, roomContext)
    nodes.conversationMode.hidden = false
    nodes.conversationMode.replaceChildren(question, choices)
  }

  function renderConversations(snapshot) {
    if (!nodes.conversations) return
    renderConversationMode()
    // Following one resident defaults to only their authored notes. Room
    // context remains a separate, labelled question with its own cache key.
    const filters = Object.freeze({
      placeId: state.placeId,
      resident: state.resident,
      context: Boolean(state.resident && state.conversationContext),
    })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.conversations, issue)
      hideHistoryControl(nodes.conversationPage)
      return
    }
    const place = state.placeId
      ? placeReference(snapshot, state.placeId)
      : null
    if (isQuietPlace(place)) {
      renderQuietRoom(nodes.conversations, place)
      hideHistoryControl(nodes.conversationPage)
      return
    }
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const entry = historyEntry('notes', filters)
    const notes = entry.rows
    const placeOf = placeId => placeReference(snapshot, placeId)
    if (renderHistoryOutcome(nodes.conversations, entry, Object.freeze({
      loading: 'Fetching this conversation…',
      failure: 'Conversation could not be loaded. Retry below.',
      empty: 'No public conversation matches this selection.',
    }))) {
      renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
      return
    }
    if (place && !state.resident) {
      const group = element('section', 'conversation-group')
      const heading = element('header', '')
      heading.append(
        element('h3', '', 'Inside ' + place.name),
        element('span', 'place-facts', place.path + ' · ' + String(notes.length) + ' shown'),
      )
      const list = element('div', 'note-list')
      list.append(...notes.map(note => noteCard(note, placeReference(snapshot, note.place_id))))
      group.append(heading, list)
      nodes.conversations.replaceChildren(group)
    } else {
      // The server pages notes newest first, so retain that order and name each
      // room without regrouping. Only the explicit room-context question marks
      // neighbours; the resident-only default contains authored notes alone.
      const ownNotes = notes.filter(note => note.author === state.resident)
      const nearestOwn = note => ownNotes.reduce((closest, own) => {
        if (own.place_id !== note.place_id) return closest
        if (!closest) return own
        const candidate = Math.abs(new Date(own.created_at).getTime() - new Date(note.created_at).getTime())
        const held = Math.abs(new Date(closest.created_at).getTime() - new Date(note.created_at).getTime())
        return candidate < held ? own : closest
      }, null)
      const list = element('div', 'note-list')
      list.append(...notes.map(note => {
        const card = noteCard(note, placeOf(note.place_id))
        if (filters.context && note.author !== state.resident) {
          const anchor = nearestOwn(note)
          card.classList.add('context-note')
          card.append(element('span', 'context-mark', anchor
            ? relativeGap(note.created_at, anchor.created_at)
            : 'same room'))
        }
        return card
      }))
      nodes.conversations.replaceChildren(list)
    }
    renderHistoryControl(nodes.conversationPage, 'notes', 'conversations', filters)
  }

  function eventPlaceId(event, snapshot) {
    if (event.detail.to_place_id) return event.detail.to_place_id
    if (event.detail.place_id) return event.detail.place_id
    if (!snapshot) return null
    if (event.detail.thing_id) {
      return snapshot.things.find(thing => thing.id === event.detail.thing_id)?.place_id || null
    }
    if (event.detail.note_id) {
      return snapshot.notes.find(note => note.id === event.detail.note_id)?.place_id || null
    }
    return null
  }

  function actionVerb(action) {
    return {
      talk: 'talked',
      move: 'moved',
      use: 'used',
      give: 'gave',
      consume: 'consumed',
      make: 'made',
      go_home: 'went home',
    }[action] || action
  }

  function actionAttempt(action) {
    return action === 'go_home' ? 'go home' : action
  }

  function activitySemantics(event, snapshot) {
    const placeId = eventPlaceId(event, snapshot)
    const place = placeReference(snapshot, placeId)
    const location = windowPlaceLabel(placeId, place)
    let description = event.verb
    if (event.kind === 'action' && event.detail.action) {
      const applied = !event.detail.status || event.detail.status === 'applied'
      description = applied
        ? actionVerb(event.detail.action)
        : 'tried to ' + actionAttempt(event.detail.action)
      if ((event.detail.action === 'move' || event.detail.action === 'go_home') &&
          event.detail.from_place_id && event.detail.to_place_id) {
        const from = windowPlaceLabel(
          event.detail.from_place_id,
          placeReference(snapshot, event.detail.from_place_id),
        )
        const to = windowPlaceLabel(
          event.detail.to_place_id,
          placeReference(snapshot, event.detail.to_place_id),
        )
        if (from && to) description += ' from ' + from + ' to ' + to
      }
      if (applied && event.detail.mode === 'carry' && event.detail.thing_id) {
        description += ' carrying Thing #' + String(event.detail.thing_id)
      }
      if (event.detail.status) {
        description += ' · ' + (event.detail.status === 'noop'
          ? 'no change'
          : event.detail.status)
      }
      if (event.detail.status === 'blocked' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'thing_moved' && event.detail.mode === 'carry' &&
        event.detail.thing_id) {
      description = 'carried Thing #' + String(event.detail.thing_id) + ' with them'
      const from = windowPlaceLabel(
        event.detail.from_place_id,
        placeReference(snapshot, event.detail.from_place_id),
      )
      if (from && location) description += ' from ' + from + ' to ' + location
    } else if (event.kind === 'effect_resolved' && event.detail.status) {
      description += ' · ' + event.detail.status
      if (event.detail.status === 'skipped' || event.detail.status === 'failed') {
        description += ' — ' + eventCause(event.detail)
      }
    } else if (event.kind === 'gazette_printed') {
      const submissions = event.detail.entry_count === 1 ? 'submission' : 'submissions'
      description += ' · Issue ' + String(event.detail.issue_number) +
        ' · ' + String(event.detail.entry_count) + ' ' + submissions + ' from Room #454'
    }
    return Object.freeze({
      description,
      location,
      key: event.actor + '|' + description + '|' + String(location || '') +
        '|thing:' + String(activityThingId(event) || ''),
    })
  }

  function eventCause(detail) {
    const cause = detail.error || 'no cause was recorded'
    return detail.error_truncated
      ? cause + ' (cause excerpt; the rest is not shown in this window)'
      : cause
  }

  function collapseActivity(events, snapshot) {
    return events.reduce((groups, event) => {
      const semantics = activitySemantics(event, snapshot)
      const previous = groups.at(-1)
      if (previous?.semantics.key === semantics.key) {
        return [
          ...groups.slice(0, -1),
          Object.freeze({ ...previous, count: previous.count + 1 }),
        ]
      }
      return [...groups, Object.freeze({ event, semantics, count: 1 })]
    }, [])
  }

  function activityThingId(event) {
    if (event.detail.asset_type === 'thing' && event.detail.asset_id) return event.detail.asset_id
    return event.detail.thing_id || event.detail.source_thing_id || null
  }

  function namedThingReference(snapshot, id) {
    if (!id) return null
    const indexed = state.thingIndex.rows.find(thing => thing.id === id)
    if (indexed) return indexed
    const recent = snapshot.things.find(thing => thing.id === id)
    if (recent) return recent
    for (const place of snapshot.flatPlaces) {
      const heading = place.front_matter.find(thing => thing.id === id)
      if (heading) return heading
    }
    return null
  }

  function renderActivity(snapshot) {
    if (!nodes.activity) return
    const filters = Object.freeze({ placeId: state.placeId, resident: state.resident })
    const issue = selectionIssue(snapshot, false)
    if (issue) {
      renderSelectionIssue(nodes.activity, issue, 'li')
      hideHistoryControl(nodes.happeningsPage)
      return
    }
    // Kick the auto-load before reading the entry: loadHistory stores
    // loading:true synchronously, so this render already says "fetching"
    // instead of falsely reporting an empty view.
    autoLoadFilteredHistory('events', filters, historyEntry('events', filters))
    const entry = historyEntry('events', filters)
    const events = entry.rows
    if (renderHistoryOutcome(nodes.activity, entry, Object.freeze({
      loading: 'Fetching happenings that match this view…',
      failure: 'Happenings could not be loaded. Retry below.',
      empty: 'No public happening matches this selection.',
    }), 'li')) {
      renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
      return
    }
    const rows = collapseActivity(events, snapshot).map(group => {
      const event = group.event
      const row = element('li', 'activity-row')
      const copy = element('p', 'activity-copy')
      const description = element('span', '', ' ' + group.semantics.description)
      if (group.count > 1) {
        description.append(
          element('span', 'activity-count', ' · ' + String(group.count) + ' times'),
        )
      }
      description.append('.')
      copy.append(
        SAFE_SYSTEM_EVENT_ACTORS.has(event.actor)
          ? element('span', 'activity-actor activity-system-actor', event.actor)
          : residentNode(event.actor, 'activity-actor', 'activity-actor:' + String(event.id)),
        description,
      )
      row.append(copy, timeNode(event.at, 'activity-time'))
      const thingId = activityThingId(event)
      if (thingId) {
        const thing = namedThingReference(snapshot, thingId)
        const label = thing?.name || 'Thing #' + String(thingId)
        const reference = element('span', 'activity-thing-reference')
        reference.append(
          portraitNode('thing', thingId, label,
            thing ? thing.has_drawing === true : event.thingHasDrawing),
          openDetailLink('thing', thingId, label, 'detail-link activity-thing-link'),
        )
        row.append(reference)
      }
      if (group.semantics.location) {
        row.append(element('span', 'activity-context',
          'Observed at ' + group.semantics.location))
      }
      return row
    })
    nodes.activity.replaceChildren(...rows)
    renderHistoryControl(nodes.happeningsPage, 'events', 'happenings', filters)
  }

`
