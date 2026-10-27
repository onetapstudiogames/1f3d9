export const PART_50_MENTIONS = `  function renderMentions(snapshot) {
    let section = document.getElementById('resident-mentions')
    if (!snapshot || state.view !== 'conversations' || !state.resident ||
        handleIsMuted(state.resident)) {
      if (section) {
        section.hidden = true
        section.replaceChildren()
      }
      return
    }
    if (!section) {
      section = element('section', 'resident-mentions')
      section.id = 'resident-mentions'
      section.setAttribute('aria-labelledby', 'mentions-title')
      nodes.conversationPage?.after(section)
    }
    if (!section.children.length) {
      const heading = element('h3', '', 'Named in')
      heading.id = 'mentions-title'
      const summary = element('p', 'mentions-summary')
      summary.id = 'mentions-summary'
      summary.setAttribute('aria-live', 'polite')
      const list = element('div', 'conversation-stream')
      list.id = 'mentions-list'
      const page = element('div', 'history-page')
      page.id = 'mentions-page'
      page.setAttribute('aria-live', 'polite')
      section.append(heading, summary, list, page)
    }
    section.hidden = false
    const summary = document.getElementById('mentions-summary')
    const target = document.getElementById('mentions-list')
    const page = document.getElementById('mentions-page')
    const issue = selectionIssue(snapshot, false)
    if (issue?.kind === 'resident') {
      summary.textContent = 'Fetching public notes naming this resident...'
      renderSelectionIssue(target, issue)
      hideHistoryControl(page)
      return
    }
    const filters = Object.freeze({
      placeId: null, resident: null, mentions: state.resident, context: false,
    })
    autoLoadFilteredHistory('notes', filters, historyEntry('notes', filters))
    const entry = historyEntry('notes', filters)
    const placeOf = placeId => placeReference(snapshot, placeId)
    // A quiet or unresolved room contributes no row, count, label or link.
    // The server matched the full body; a preview is never matched again.
    const publicRows = entry.rows.filter(note => {
      const place = placeOf(note.place_id)
      return place && !isQuietPlace(place)
    })
    const muted = splitMutedRows('note', publicRows, placeOf)
    const listKey = 'mentions:' + historyKey('notes', filters)
    const list = element('div', 'note-list')
    list.append(...muted.shown.map(note => {
      const card = noteCard(note, placeOf(note.place_id))
      for (const control of card.querySelectorAll('[data-focus-key]')) {
        control.dataset.focusKey = listKey + ':' + control.dataset.focusKey
      }
      return card
    }))
    const notice = muteNotice(listKey, muted.hidden)
    if (notice) list.append(notice)
    renderViewerList(target, list, listKey)
    const waiting = entry.loading ||
      (!entry.initialized && !entry.error && !entry.refreshError)
    summary.textContent = waiting && !publicRows.length
      ? 'Fetching public notes naming this resident...'
      : (entry.error || entry.refreshError) && !publicRows.length
        ? 'Named in notes could not be loaded. Retry below.'
        : !muted.shown.length
          ? 'No public notes are shown for this resident.'
          : 'Public notes naming ' + shownHandle(state.resident) + '. ' +
            String(muted.shown.length) + ' shown, newest first.'
    renderHistoryControl(page, 'notes', 'named notes', filters)
  }

`
