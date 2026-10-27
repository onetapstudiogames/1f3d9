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
      const check = element('div', 'history-page')
      check.id = 'mentions-check'
      check.setAttribute('aria-live', 'polite')
      section.append(heading, summary, list, page, check)
    }
    section.hidden = false
    const summary = document.getElementById('mentions-summary')
    const target = document.getElementById('mentions-list')
    const page = document.getElementById('mentions-page')
    const check = document.getElementById('mentions-check')
    const issue = selectionIssue(snapshot, false)
    if (issue?.kind === 'resident') {
      summary.textContent = 'Fetching public notes naming this resident...'
      renderSelectionIssue(target, issue)
      hideHistoryControl(page)
      hideHistoryControl(check)
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
    // Neither continuation nor gap markers prove that another public row exists.
    // Keep the same neutral action even for a completed empty read; concealed
    // matches cannot create a control, label or disabled state.
    const control = muted.shown.length ? page : check
    hideHistoryControl(muted.shown.length ? check : page)
    const failed = entry.error || entry.refreshError || entry.newestReadFailed
    const message = element('p', failed ? 'navigation-error' : 'seam-row', failed
      ? 'Public notes could not be checked. Try again.'
      : 'Shown notes may have gaps. Each check reads one page and may find no additional public notes.')
    if (failed) message.setAttribute('role', 'alert')
    const button = element('button', 'history-load', entry.loading
      ? 'Checking public notes...'
      : failed ? 'Retry checking public notes' : 'Check public notes')
    button.type = 'button'
    button.setAttribute('aria-busy', String(Boolean(entry.loading)))
    button.dataset.focusKey = 'load:notes:' + historyKey('notes', filters)
    button.dataset.focusFallbackId = 'mentions-list'
    button.addEventListener('click', () => void loadHistory('notes', filters))
    control.hidden = false
    control.replaceChildren(message, button)
  }

`
